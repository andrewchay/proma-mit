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
  const rootResp = await fetch(
    `${FEISHU_BASE}/open-apis/contact/v3/departments/0/children?fetch_child=false&page_size=50`,
    { method: 'GET', headers: { Authorization: `Bearer ${token}` } }
  )
  const rootData = await rootResp.json()
  const rootItems = ((rootData?.data?.items ?? []) as Array<{ department?: { department_id?: string; open_department_id?: string; name?: string } }>)
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
      // 子部门入队
      const childResp = await fetch(
        `${FEISHU_BASE}/open-apis/contact/v3/departments/${encodeURIComponent(dept.id)}/children?fetch_child=false&page_size=50`,
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } }
      )
      const childData = await childResp.json()
      if (childData?.code === 0) {
        const childItems = ((childData?.data?.items ?? []) as Array<{ department?: { department_id?: string; name?: string } }>)
        for (const ci of childItems) {
          const cid = String(ci.department?.department_id ?? '')
          if (cid) deptQueue.push({ id: cid, name: ci.department?.name ?? '' })
        }
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
        const url = buildFeishuFindByDepartmentUrl({ idType: idKey.idType, value: idKey.value, pageToken: pageToken || undefined })
        const resp = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })
        const data = await resp.json()
        if ((data as any)?.code !== 0) break
        const items = ((data?.data?.items ?? []) as FeishuMemberRaw[])
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
        pageToken = (data as any)?.data?.page_token ?? ''
        if (!pageToken || !(data as any)?.data?.has_more) break
      }
    }
  }

  // 3) 兜底：部门拉取为空时用裸 /users
  if (drafts.length === 0) {
    let pageToken = ''
    let guard = 0
    while (guard < 50) {
      guard++
      const url = `${FEISHU_BASE}/open-apis/contact/v3/users?page_size=50${pageToken ? `&page_token=${pageToken}` : ''}`
      const resp = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })
      const data = await resp.json()
      if ((data as any)?.code !== 0) break
      const items = ((data?.data?.items ?? []) as FeishuMemberRaw[])
      for (const u of items) {
        if (!u.name) continue
        const externalId = u.open_id || u.union_id
        if (!externalId || seenUser.has(externalId)) continue
        seenUser.add(externalId)
        drafts.push({ platform: 'feishu', externalId, unionId: u.union_id, name: u.name })
      }
      pageToken = (data as any)?.data?.page_token ?? ''
      if (!pageToken || !(data as any)?.data?.has_more) break
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

  // ② 按姓名匹配（plain_name 精确），有 union 字段的空缺才补
  const byName = findMember({ displayName: draft.name })
  if (byName) {
    const hasSamePlatformField =
      (draft.platform === 'feishu' && byName.feishuUserId) ||
      (draft.platform === 'dingtalk' && byName.dingtalkUserId)
    // 同平台已有 field：视为同一人重复，直接补 union 缺失字段
    if (hasSamePlatformField || platformFieldEmpty(byName, draft.platform)) {
      mergeInto(byName, draft)
      return 'merged'
    }
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
  const [feishu, dingtalk] = await Promise.all([syncPlatform('feishu'), syncPlatform('dingtalk')])
  return { feishu, dingtalk, startedAt, finishedAt: Date.now() }
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

/**
 * 带节流的定时/启动同步：
 * - 默认冷却窗口 MEMBER_SYNC_COOLDOWN_MS 内不重复拉取，避免启动+定时击穿 API；
 * - 并发保护（上次未结束前不重入）；
 * - 幂等（upsertDraft 已保证不重复建）。
 */
export const MEMBER_SYNC_COOLDOWN_MS = 6 * 60 * 60 * 1000 // 6 小时

/** 距上次同步是否仍在冷却期内。 */
export function isMemberSyncCooldownActive(platform: 'feishu' | 'dingtalk'): boolean {
  return Date.now() - lastSyncAt[platform] < MEMBER_SYNC_COOLDOWN_MS
}

/** 当前是否有同步在执行。 */
export function isMemberSyncInFlight(): boolean {
  return syncInFlight
}

/** 最近一次各平台同步时间戳（用于状态展示）。 */
export function getLastMemberSyncAt(platform: 'feishu' | 'dingtalk'): number {
  return lastSyncAt[platform]
}

/**
 * 定时/启动用同步入口：带冷却与并发保护。
 * 若在冷却期内则跳过（返回 null）；否则执行并刷新时间戳。
 */
export async function syncMembersIfCooldownElapsed(platform: 'feishu' | 'dingtalk'): Promise<MemberSyncResult | null> {
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
    lastSyncAt[platform] = Date.now()
    return result
  } finally {
    syncInFlight = false
  }
}

