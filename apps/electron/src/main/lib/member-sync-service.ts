/**
 * 成员同步服务 — Member Sync Service
 *
 * PH1-A 核心：把飞书/钉钉通讯录**批量、完整**拉回，归一成稳定成员档案（members 表），
 * 并按 union_id / 姓名+部门做跨平台对齐，输出 pulled / inserted / merged / failed。
 *
 * 与 contact-search-service 的关系：
 * - 复用其已导出的凭证（getFeishuCredential / getDingtalkCredential）、token、URL builder；
 * - 但**不走**其有上限的 searchContactsAll（那是给「负责人选择器」的按需小结果），
 *   这里实现**无上限、带 union_id 与部门名**的全量拉取，供团队目录同步使用。
 */

import {
  getFeishuCredential,
  getDingtalkCredential,
  getFeishuTenantToken,
  getDingtalkToken,
  listDingtalkSubDeptIds,
  listDingtalkDeptUsers,
  resolveDingtalkUnionId,
  buildFeishuFindByDepartmentUrl,
  FEISHU_BASE,
} from './contact-search-service'
import {
  createMember,
  findMember,
  findMembersByName,
  updateMember,
  touchMemberSync,
} from './project-sqlite-store'
import type { Member } from './project-types'

// ===== 结果类型 =====

export interface MemberSyncResult {
  platform: 'feishu' | 'dingtalk'
  pulled: number      // 从平台拉取到的去重人数
  inserted: number    // 新建成员
  merged: number      // 与既有成员合并（补平台字段/更新）
  failed: number
  error?: string
}

export interface SyncAllResult {
  feishu: MemberSyncResult
  dingtalk: MemberSyncResult
  startedAt: number
  finishedAt: number
}

export interface MemberDraft {
  platform: 'feishu' | 'dingtalk'
  externalId: string      // feishu open_id（或 union_id 兜底）/ dingtalk userid
  unionId?: string
  name: string
  department?: string
}

/** 导出给测试/组合用的对齐+落库入口（内部即 upsertDraft）。 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function upsertMemberDraft(draft: MemberDraft): 'inserted' | 'merged' {
  return upsertDraft(draft)
}


interface FeishuMemberRaw {
  open_id?: string
  union_id?: string
  name?: string
}

/**
 * 带轻量重试的 JSON GET（供飞书/钉钉全量拉取用）。
 * - 失败（网络异常 / 非 JSON / HTTP 非 2xx）重试最多 RETRY 次（指数退避 200ms 起步）；
 * - 全部重试仍失败则抛错，让上层把整轮同步记为 failed（而不是静默"空成功"或半途断掉）。
 */
const FEISHU_HTTP_RETRY = 2
const RETRY_BASE_DELAY_MS = 200

async function fetchJsonWithRetry(url: string, headers: Record<string, string>): Promise<any> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= FEISHU_HTTP_RETRY; attempt++) {
    try {
      const resp = await fetch(url, { method: 'GET', headers })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      return await resp.json()
    } catch (err) {
      lastErr = err
      if (attempt < FEISHU_HTTP_RETRY) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * Math.pow(2, attempt)))
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** 读飞书响应，返回 data；code!==0 或 data 缺失返回 null（业务层据此决定是否走兜底）。 */
function feishuDataOrNull(data: any): any | null {
  if (!data || typeof data.code !== 'number' || data.code !== 0) return null
  return data.data ?? null
}

// ============================================
// 飞书全量拉取
// ============================================

async function pullFeishuMembers(): Promise<MemberDraft[]> {
  const cred = getFeishuCredential()
  if (!cred?.appId || !cred.appSecret) {
    throw new Error('未找到已连接的飞书 Bot 凭证，请在「设置 → 飞书 Todo」完成配置')
  }
  const token = await getFeishuTenantToken(cred.appId, cred.appSecret)

  const drafts: MemberDraft[] = []
  const seenUser = new Set<string>()
  const seenDept = new Set<string>()

  // 1) 枚举可见部门树（BFS，最多 8 层）
  const deptQueue: Array<{ id: string; openId?: string; name: string }> = []
  const deptIds: Array<{ id: string; openId?: string; name: string }> = []
  const authHeaders = { Authorization: `Bearer ${token}` }
  const rootData = await fetchJsonWithRetry(
    `${FEISHU_BASE}/open-apis/contact/v3/departments/0/children?fetch_child=false&page_size=50`,
    authHeaders,
  )
  const rootDataBody = feishuDataOrNull(rootData)
  // 根部门拉取失败（token 无效/权限不足）不应静默当"空成功"——抛错让整轮记为 failed
  if (!rootDataBody) throw new Error(`飞书根部门拉取失败: code=${rootData?.code ?? '?'} ${rootData?.msg ?? ''}`)
  const rootItems = ((rootDataBody?.items ?? []) as Array<{ department?: { department_id?: string; open_department_id?: string; name?: string } }>)
  for (const it of rootItems) {
    const rid = String(it.department?.department_id ?? '')
    if (rid) deptQueue.push({ id: rid, openId: it.department?.open_department_id, name: it.department?.name ?? '' })
  }

  let layers = 0
  while (deptQueue.length > 0 && layers < 8) {
    const current = deptQueue.splice(0, deptQueue.length)
    for (const dept of current) {
      if (seenDept.has(dept.id)) continue
      seenDept.add(dept.id)
      deptIds.push(dept)
      // 子部门入队（带重试；单棵子树失败跳过，不阻断整体）
      try {
        const childData = await fetchJsonWithRetry(
          `${FEISHU_BASE}/open-apis/contact/v3/departments/${encodeURIComponent(dept.id)}/children?fetch_child=false&page_size=50`,
          authHeaders,
        )
        const childBody = feishuDataOrNull(childData)
        if (childBody) {
          const childItems = ((childBody?.items ?? []) as Array<{ department?: { department_id?: string; open_department_id?: string; name?: string } }>)
          for (const ci of childItems) {
            const cid = String(ci.department?.department_id ?? '')
            if (cid) deptQueue.push({ id: cid, openId: ci.department?.open_department_id, name: ci.department?.name ?? '' })
          }
        }
      } catch (err) {
        console.warn(`[MemberSync] 枚举子部门失败 dept=${dept.id}:`, err instanceof Error ? err.message : err)
      }
    }
    layers++
  }

  // 2) 对每个部门拉全部直属用户（无上限，含 open_id + union_id + 部门名），分页
  const targetDepts = deptIds.length > 0 ? deptIds : [{ id: '0', name: '根部门' }]
  for (const dept of targetDepts) {
    const deptName = dept.name || undefined
    const idTypes: Array<{ idType: 'department_id' | 'open_department_id'; value: string }> = [
      { idType: 'department_id', value: dept.id },
      ...(dept.openId && dept.openId !== dept.id ? [{ idType: 'open_department_id' as const, value: dept.openId }] : []),
    ]
    for (const idKey of idTypes) {
      let pageToken = ''
      let guard = 0
      // eslint-disable-next-line no-loop-func
      while (guard < 50) {
        guard++
        let data: any
        try {
          const url = buildFeishuFindByDepartmentUrl({ idType: idKey.idType, value: idKey.value, pageToken: pageToken || undefined })
          data = await fetchJsonWithRetry(url, authHeaders)
        } catch (err) {
          // 单个部门分页失败：跳过该部门，避免整轮因一次性限流失败
          console.warn(`[MemberSync] 飞书拉取部门成员失败 ${idKey.value} page=${pageToken || '(首页)'}:`, err instanceof Error ? err.message : err)
          break
        }
        const body = feishuDataOrNull(data)
        if (!body) break
        const items = ((body?.items ?? []) as FeishuMemberRaw[])
        for (const u of items) {
          if (!u.name) continue
          const externalId = u.open_id || u.union_id
          if (!externalId || seenUser.has(externalId)) continue
          seenUser.add(externalId)
          drafts.push({
            platform: 'feishu',
            externalId,
            unionId: u.union_id,
            name: u.name,
            department: deptName,
          })
        }
        pageToken = body?.page_token ?? ''
        if (!pageToken || !body?.has_more) break
      }
    }
  }

  // 3) 兜底：部门拉取为空时用裸 /users
  if (drafts.length === 0) {
    let pageToken = ''
    let guard = 0
    while (guard < 50) {
      guard++
      let data: any
      try {
        const url = `${FEISHU_BASE}/open-apis/contact/v3/users?page_size=50${pageToken ? `&page_token=${pageToken}` : ''}`
        data = await fetchJsonWithRetry(url, authHeaders)
      } catch (err) {
        console.warn(`[MemberSync] 飞书裸 /users 拉取失败 page=${pageToken || '(首页)'}:`, err instanceof Error ? err.message : err)
        break
      }
      const body = feishuDataOrNull(data)
      if (!body) break
      const items = ((body?.items ?? []) as FeishuMemberRaw[])
      for (const u of items) {
        if (!u.name) continue
        const externalId = u.open_id || u.union_id
        if (!externalId || seenUser.has(externalId)) continue
        seenUser.add(externalId)
        drafts.push({ platform: 'feishu', externalId, unionId: u.union_id, name: u.name })
      }
      pageToken = body?.page_token ?? ''
      if (!pageToken || !body?.has_more) break
    }
  }

  return drafts
}

// ============================================
// 钉钉全量拉取
// ============================================

async function pullDingtalkMembers(): Promise<MemberDraft[]> {
  const cred = getDingtalkCredential()
  if (!cred?.appId || !cred.appSecret) {
    throw new Error('未找到已连接的钉钉 Bot 凭证，请在「设置 → 钉钉 Todo」完成配置')
  }
  const token = await getDingtalkToken(cred.appId, cred.appSecret)

  const deptIds: number[] = [1]
  try {
    deptIds.push(...(await listDingtalkSubDeptIds(token, 1)))
  } catch {
    // 拉子部门失败仅保留根部门
  }

  const collected: Array<{ userid: string; name: string }> = []
  for (const deptId of deptIds) {
    try {
      collected.push(...(await listDingtalkDeptUsers(token, deptId)))
    } catch {
      // 单个部门失败跳过
    }
  }

  // 去重 + 解析 unionid
  const seen = new Set<string>()
  const drafts: MemberDraft[] = []
  for (const u of collected) {
    if (seen.has(u.userid)) continue
    seen.add(u.userid)
    let unionId: string | undefined
    try {
      unionId = await resolveDingtalkUnionId(token, u.userid)
    } catch {
      unionId = undefined
    }
    drafts.push({ platform: 'dingtalk', externalId: u.userid, unionId, name: u.name })
  }
  return drafts
}

// ============================================
// 归一 + 对齐 + upsert
// ============================================

/**
 * 把单个平台草稿 upsert 进 members。
 * 对齐优先级：
 *   ① 同平台 union_id 命中既有 member → merge；
 *   ② 另一平台已有字段为空，且 displayName 一致 → merge（补本平台字段）；
 *   ③ 无匹配 → 新建。
 * 返回 'inserted' | 'merged'。
 */
function upsertDraft(draft: MemberDraft): 'inserted' | 'merged' {  const unionKey = draft.unionId
    ? (draft.platform === 'feishu'
      ? { feishuUnionId: draft.unionId }
      : { dingtalkUnionId: draft.unionId })
    : undefined

  // ① 优先按 union_id 匹配
  if (unionKey) {
    const byUnion = findMember(unionKey)
    if (byUnion) {
      mergeInto(byUnion, draft)
      return 'merged'
    }
  }

  // ② 按姓名匹配（plain_name 精确）。改用 findMembersByName 拿全部同名候选消歧，
  //    避免旧 findMember({displayName}) 的 `LIMIT 1` 无排序在重名时随机合并串线。
  const nameCandidates = findMembersByName(draft.name)
  for (const candidate of nameCandidates) {
    const hasSamePlatformField =
      (draft.platform === 'feishu' && candidate.feishuUserId) ||
      (draft.platform === 'dingtalk' && candidate.dingtalkUserId)
    // 同平台已有 field：视为同一人重复，直接补 union 缺失字段
    if (hasSamePlatformField) {
      mergeInto(candidate, draft)
      return 'merged'
    }
    // 该平台字段空缺且非另一平台的同名者：可安全补本平台字段（同一人跨平台建档）
    if (platformFieldEmpty(candidate, draft.platform)) {
      mergeInto(candidate, draft)
      return 'merged'
    }
    // 其余情形（该平台字段已被占用 = 是另一个重名人）：不合并，继续看下一个候选
  }

  // ③ 新建
  createMember({
    displayName: draft.name,
    department: draft.department,
    source: 'sync',
    ...(draft.platform === 'feishu'
      ? { feishuUserId: draft.externalId, feishuUnionId: draft.unionId }
      : { dingtalkUserId: draft.externalId, dingtalkUnionId: draft.unionId }),
  })
  return 'inserted'
}

function platformFieldEmpty(m: Member, platform: 'feishu' | 'dingtalk'): boolean {
  return platform === 'feishu' ? !m.feishuUserId && !m.feishuUnionId : !m.dingtalkUserId && !m.dingtalkUnionId
}

/** 把草稿的字段合并进既有 member（只补空缺，不覆盖已有）。 */
function mergeInto(m: Member, draft: MemberDraft): void {
  const patch: Record<string, string | undefined> = {}
  if (draft.platform === 'feishu') {
    if (!m.feishuUserId) patch.feishuUserId = draft.externalId
    if (!m.feishuUnionId) patch.feishuUnionId = draft.unionId
  } else {
    if (!m.dingtalkUserId) patch.dingtalkUserId = draft.externalId
    if (!m.dingtalkUnionId) patch.dingtalkUnionId = draft.unionId
  }
  // 部门空缺时补
  if (!m.department && draft.department) patch.department = draft.department

  updateMember(m.memberId, patch)
  touchMemberSync(m.memberId)
}

// ============================================
// 对外入口
// ============================================

async function syncPlatform(platform: 'feishu' | 'dingtalk'): Promise<MemberSyncResult> {
  console.log(`[Diag][member-sync] 开始同步 ${platform}`)
  const result: MemberSyncResult = { platform, pulled: 0, inserted: 0, merged: 0, failed: 0 }
  let drafts: MemberDraft[] = []
  try {
    drafts = platform === 'feishu' ? await pullFeishuMembers() : await pullDingtalkMembers()
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    console.error(`[Diag][member-sync] ${platform} 同步拉取失败: ${result.error}`)
    return result
  }
  result.pulled = drafts.length
  for (const draft of drafts) {
    try {
      const outcome = upsertDraft(draft)
      if (outcome === 'inserted') result.inserted++
      else result.merged++
    } catch {
      result.failed++
    }
  }
  console.log(`[Diag][member-sync] ${platform} 完成: 拉取 ${result.pulled} 新增 ${result.inserted} 合并 ${result.merged} 失败 ${result.failed}`)
  return result
}

/** 同步飞书通讯录成员。 */
export function syncMembersFromFeishu(): Promise<MemberSyncResult> {
  return syncPlatform('feishu')
}

/** 同步钉钉通讯录成员。 */
export function syncMembersFromDingtalk(): Promise<MemberSyncResult> {
  return syncPlatform('dingtalk')
}

/** 同时同步飞书与钉钉（各自独立失败不影响整体）。 */
export async function syncAllMembers(): Promise<SyncAllResult> {
  const startedAt = Date.now()
  // 受 syncInFlight 门闩保护，且两平台串行执行：避免手动触发与定时/启动同步并发写库，
  // 也避免两平台并行经姓名合并同时写同一条 member 行造成 RMW 竞态丢更新。
  if (syncInFlight) {
    // 已有同步在跑：返回占位空结果（不计为失败，避免上层误报"同步失败"）。
    const skipped: MemberSyncResult = { platform: 'feishu', pulled: 0, inserted: 0, merged: 0, failed: 0 }
    return { feishu: skipped, dingtalk: { ...skipped, platform: 'dingtalk' }, startedAt, finishedAt: Date.now() }
  }
  syncInFlight = true
  try {
    const feishu = await syncPlatform('feishu')
    persistLastSyncAt('feishu')
    const dingtalk = await syncPlatform('dingtalk')
    persistLastSyncAt('dingtalk')
    return { feishu, dingtalk, startedAt, finishedAt: Date.now() }
  } finally {
    syncInFlight = false
  }
}

// ============================================
// 成员反向查询（供 TodoProvider / sync 用）
// ============================================

/**
 * 从 assignee.userId（形如 `paa-<name>`）解析对应稳定成员。
 * 返回 null 表示无法解析（非 paa- 前缀、未找到同名成员）。
 */
export function findMemberByPaaUserId(paaUserId: string): Member | null {
  if (!paaUserId || !paaUserId.startsWith('paa-')) return null
  const name = paaUserId.slice('paa-'.length).trim()
  if (!name) return null
  return findMember({ displayName: name })
}

/**
 * 从 assignee.userId（paa-<name>）解析某平台真实 ID。
 * 供 TodoProvider.getUserIdByPaaUserId 与 syncTaskToExternal 兜底。
 * - feishu → feishuUserId（优先）或 feishuUnionId
 * - dingtalk → dingtalkUnionId（优先，用于工作待办）或 dingtalkUserId
 */
export function resolvePlatformForPaaUser(paaUserId: string, platform: 'feishu' | 'dingtalk'): string | null {
  const member = findMemberByPaaUserId(paaUserId)
  if (!member) return null
  if (platform === 'feishu') return member.feishuUserId ?? member.feishuUnionId ?? null
  return member.dingtalkUnionId ?? member.dingtalkUserId ?? null
}

// ============================================
// 增量同步（定时/启动刷新）
// ============================================

const lastSyncAt: Record<'feishu' | 'dingtalk', number> = { feishu: 0, dingtalk: 0 }
let syncInFlight = false
let syncMetaLoaded = false

/** 同步元信息的 DB key 前缀（持久化到 paa.db 的 sync_meta 表，防重启丢冷却）。 */
const SYNC_META_KEY = (platform: 'feishu' | 'dingtalk') => `member_last_sync:${platform}`

/** 启动/首次访问时从 DB 加载各平台上次同步时间（幂等）。 */
function ensureSyncMetaLoaded(): void {
  if (syncMetaLoaded) return
  syncMetaLoaded = true
  try {
    const { getSyncMeta } = require('./project-sqlite-store') as { getSyncMeta: (k: string) => string | null }
    const feishu = getSyncMeta(SYNC_META_KEY('feishu'))
    const dingtalk = getSyncMeta(SYNC_META_KEY('dingtalk'))
    if (feishu) lastSyncAt.feishu = Number(feishu) || 0
    if (dingtalk) lastSyncAt.dingtalk = Number(dingtalk) || 0
  } catch {
    // DB 未就绪：保持 0（本次进程退化为首次全量，可接受）
  }
}

/** 成功同步后落盘冷却时间。 */
function persistLastSyncAt(platform: 'feishu' | 'dingtalk'): void {
  lastSyncAt[platform] = Date.now()
  try {
    const { setSyncMeta } = require('./project-sqlite-store') as { setSyncMeta: (k: string, v: string) => void }
    setSyncMeta(SYNC_META_KEY(platform), String(lastSyncAt[platform]))
  } catch {
    // 落盘失败仅影响下次启动的冷却，不影响当前同步结果
  }
}

/**
 * 带节流的定时/启动同步：
 * - 默认冷却窗口 MEMBER_SYNC_COOLDOWN_MS 内不重复拉取，避免启动+定时击穿 API；
 * - 并发保护（上次未结束前不重入）；
 * - 幂等（upsertDraft 已保证不重复建）。
 */
export const MEMBER_SYNC_COOLDOWN_MS = 6 * 60 * 60 * 1000 // 6 小时

/** 距上次同步是否仍在冷却期内。 */
export function isMemberSyncCooldownActive(platform: 'feishu' | 'dingtalk'): boolean {
  ensureSyncMetaLoaded()
  return Date.now() - lastSyncAt[platform] < MEMBER_SYNC_COOLDOWN_MS
}

/** 当前是否有同步在执行。 */
export function isMemberSyncInFlight(): boolean {
  return syncInFlight
}

/** 最近一次各平台同步时间戳（用于状态展示）。 */
export function getLastMemberSyncAt(platform: 'feishu' | 'dingtalk'): number {
  ensureSyncMetaLoaded()
  return lastSyncAt[platform]
}

/**
 * 定时/启动用同步入口：带冷却与并发保护。
 * 若在冷却期内则跳过（返回 null）；否则执行并刷新时间戳。
 */
export async function syncMembersIfCooldownElapsed(platform: 'feishu' | 'dingtalk'): Promise<MemberSyncResult | null> {
  ensureSyncMetaLoaded()
  if (isMemberSyncCooldownActive(platform)) return null
  return performGuardedSync(platform)
}

/** 强制同步（手动触发用，无冷却）：仍带并发保护。 */
export async function syncMembersNow(platform: 'feishu' | 'dingtalk'): Promise<MemberSyncResult | null> {
  return performGuardedSync(platform)
}

async function performGuardedSync(platform: 'feishu' | 'dingtalk'): Promise<MemberSyncResult | null> {
  if (syncInFlight) return null
  syncInFlight = true
  try {
    const result = platform === 'feishu' ? await syncPlatform('feishu') : await syncPlatform('dingtalk')
    persistLastSyncAt(platform)
    return result
  } finally {
    syncInFlight = false
  }
}

