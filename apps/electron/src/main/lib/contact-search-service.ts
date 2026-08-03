/**
 * 外部通讯录搜索服务 — Contact Search Service
 *
 * 核心职责：
 * - 对接内网常用通讯录（飞书 / 钉钉），按负责人姓名/关键字搜索用户
 * - 返回带平台真实 ID（飞书 open_id / 钉钉 userid + unionid）的用户列表
 * - 供前端「负责人」选择器使用：选中后写入 user_mappings，任务同步即无需手工填平台 ID
 *
 * 凭证来源：
 * - 复用 Bot Hub 的配置：飞书取 `feishuTodo.botId` 对应 Bot 的 appId + 解密后的 appSecret；
 *   钉钉取 `dingtalkTodo.botId` 对应 Bot 的 clientId + 解密后的 clientSecret。
 *   与 todo-provider 工厂完全同源，避免 settings.json 留存第二份明文 Secret。
 *
 * API 方案：
 * - 飞书：POST /open-apis/contact/v3/users/search 按姓名关键字搜，返回 open_id/union_id。
 * - 钉钉：遍历部门 topapi/v2/department/listsub + topapi/v2/user/list，本地按 name 过滤；
 *   再用 topapi/v2/user/get 解析 unionid。
 */

// ===== 结果类型 =====

export interface ContactSearchResult {
  platform: 'feishu' | 'dingtalk'
  userId: string // 平台真实 ID：飞书 open_id；钉钉 userid
  unionId?: string // 飞书 union_id / 钉钉 unionid
  name: string
  department?: string
}

interface BotCredential {
  appId?: string
  appSecret?: string
}

// ===== 凭证获取 =====

/** 解析 settings 中已连接的飞书 Bot 凭证（appId + 解密后的 appSecret）。 */
function getFeishuCredential(): BotCredential | null {
  try {
    const { getFeishuMultiBotConfig, getDecryptedBotAppSecret } = require('./feishu-config')
    const { getSettings } = require('./settings-service')
    const settings = getSettings() as Record<string, any>
    const feishuTodo = settings.feishuTodo as { enabled?: boolean; botId?: string } | undefined
    if (!feishuTodo?.enabled || !feishuTodo.botId) return null

    const config = getFeishuMultiBotConfig()
    const bot = config.bots.find(
      (b: { id: string; enabled?: boolean; appId?: string; appSecret?: string }) =>
        b.id === feishuTodo.botId && b.enabled && b.appId
    )
    if (!bot) return null
    const appSecret = getDecryptedBotAppSecret(bot.id)
    if (!appSecret) return null
    return { appId: bot.appId, appSecret }
  } catch (err) {
    console.warn('[ContactSearch] 读取飞书凭证失败:', err)
    return null
  }
}

/** 解析 settings 中已连接的钉钉 Bot 凭证（clientId + 解密后的 clientSecret）。 */
function getDingtalkCredential(): BotCredential | null {
  try {
    const { getDingTalkBotById, getDecryptedBotClientSecret } = require('./dingtalk-config')
    const { getSettings } = require('./settings-service')
    const settings = getSettings() as Record<string, any>
    const dingtalkTodo = settings.dingtalkTodo as { enabled?: boolean; botId?: string } | undefined
    if (!dingtalkTodo?.enabled || !dingtalkTodo.botId) return null

    const bot = getDingTalkBotById(dingtalkTodo.botId)
    const appSecret = bot ? getDecryptedBotClientSecret(bot.id) : ''
    if (!bot?.clientId || !appSecret) return null
    return { appId: bot.clientId, appSecret }
  } catch (err) {
    console.warn('[ContactSearch] 读取钉钉凭证失败:', err)
    return null
  }
}

// ===== 飞书实现 =====

const feishuTokenCache = new Map<string, { token: string; expiresAt: number }>()
const dingtalkTokenCache = new Map<string, { token: string; expiresAt: number }>()

async function getFeishuTenantToken(appId: string, appSecret: string): Promise<string> {
  const cached = feishuTokenCache.get(appId)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token

  // 直接用 fetch 调 token 接口（与 curl 验证一致）。
  // 注意：新版飞书接口把 tenant_access_token 放在响应顶层，SDK 的 resp.data 可能为 undefined。
  const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const data = (await resp.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
  if (data.code !== 0) {
    throw new Error(`飞书 Token 获取失败: ${data.msg} (code: ${data.code})`)
  }
  const token = data.tenant_access_token
  if (!token) throw new Error('飞书 Token 获取失败: 响应缺少 tenant_access_token')
  const expire = data.expire || 7200
  feishuTokenCache.set(appId, { token, expiresAt: Date.now() + expire * 1000 })
  return token
}

const FEISHU_BASE = 'https://open.feishu.cn'

/** 飞书：获取某部门下的直属子部门。根部门 id 传 0。 */
async function listFeishuSubDeptIds(token: string, deptId: number): Promise<number[]> {
  const resp = await fetch(`${FEISHU_BASE}/open-apis/contact/v3/departments/${deptId}/children?fetch_child=false`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = (await resp.json()) as any
  if (data.code !== 0) {
    // 99991672 = 无通讯录权限；99991663 = token 无效
    throw new Error(`飞书获取子部门失败: ${data.msg} (code: ${data.code})`)
  }
  return (data.data?.children as Array<{ department_id?: number }> | undefined)
    ?.map((d) => d.department_id)
    .filter((id): id is number => typeof id === 'number') ?? []
}

/** 飞书：获取某部门下的直属成员（open_id）。 */
async function listFeishuDeptMembers(token: string, deptId: number): Promise<ContactSearchResult[]> {
  const resp = await fetch(
    `${FEISHU_BASE}/open-apis/contact/v3/departments/${deptId}/members?page_size=50&member_id_type=open_id`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }
  )
  const data = (await resp.json()) as any
  if (data.code !== 0) {
    throw new Error(`飞书获取部门成员失败: ${data.msg} (code: ${data.code})`)
  }
  const items = data.data?.items as Array<{ open_id?: string; union_id?: string; name?: string }> | undefined
  return (items ?? [])
    .filter((m) => m.open_id && m.name)
    .map((m) => ({
      platform: 'feishu' as const,
      userId: m.open_id!,
      unionId: m.union_id,
      name: m.name!,
    }))
}

/** 飞书：遍历根部门及子部门成员，本地按姓名关键字过滤。
 * 使用 tenant_access_token 可访问的部门成员接口（users/search 需要 user_access_token）。 */
async function searchFeishuContacts(keyword: string): Promise<ContactSearchResult[]> {
  const cred = getFeishuCredential()
  if (!cred?.appId || !cred.appSecret) {
    throw new Error('未找到已连接的飞书 Bot 凭证，请在「设置 → 飞书 Todo」完成配置')
  }
  const token = await getFeishuTenantToken(cred.appId, cred.appSecret)
  const kw = keyword.trim().toLowerCase()

  // 遍历根部门（0）及一层子部门
  const deptIds = [0]
  try {
    deptIds.push(...(await listFeishuSubDeptIds(token, 0)))
  } catch (err) {
    console.warn('[ContactSearch] 获取飞书子部门失败，仅搜索根部门:', err)
  }

  const collected: ContactSearchResult[] = []
  const seen = new Set<string>()
  for (const deptId of deptIds.slice(0, 30)) {
    try {
      const members = await listFeishuDeptMembers(token, deptId)
      for (const m of members) {
        if (seen.has(m.userId)) continue
        seen.add(m.userId)
        if (!kw || m.name.toLowerCase().includes(kw)) {
          collected.push(m)
        }
        if (collected.length >= 20) break
      }
    } catch (err) {
      console.warn(`[ContactSearch] 飞书部门 ${deptId} 成员获取失败，跳过:`, err)
    }
  }
  return collected
}

// ===== 钉钉实现 =====

const DINGTALK_OAPI_BASE = 'https://oapi.dingtalk.com'

async function getDingtalkToken(appKey: string, appSecret: string): Promise<string> {
  const cached = dingtalkTokenCache.get(appKey)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token

  const url = `${DINGTALK_OAPI_BASE}/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`
  const resp = await fetch(url, { method: 'GET' })
  const data = (await resp.json()) as { errcode: number; errmsg: string; access_token?: string; expires_in?: number }
  if (data.errcode !== 0) {
    throw new Error(`钉钉 Token 获取失败: ${data.errmsg} (errcode: ${data.errcode})`)
  }
  const expire = data.expires_in || 7200
  dingtalkTokenCache.set(appKey, { token: data.access_token!, expiresAt: Date.now() + expire * 1000 })
  return data.access_token!
}

/** 钉钉：取某部门下所有直属子部门 ID。 */
async function listDingtalkSubDeptIds(token: string, deptId: number): Promise<number[]> {
  const resp = await fetch(`${DINGTALK_OAPI_BASE}/topapi/v2/department/listsub`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dept_id: deptId }),
  })
  const data = (await resp.json()) as any
  if (data.errcode !== 0) {
    throw new Error(`钉钉获取子部门失败: ${data.errmsg} (errcode: ${data.errcode})`)
  }
  return (data.result?.result as Array<{ dept_id: number }> | undefined)?.map((d) => d.dept_id) ?? []
}

/** 钉钉：取某部门下所有直属成员。 */
async function listDingtalkDeptUsers(token: string, deptId: number): Promise<Array<{ userid: string; name: string }>> {
  const resp = await fetch(`${DINGTALK_OAPI_BASE}/topapi/v2/user/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dept_id: deptId, cursor: 0, size: 100 }),
  })
  const data = (await resp.json()) as any
  if (data.errcode !== 0) {
    throw new Error(`钉钉获取部门成员失败: ${data.errmsg} (errcode: ${data.errcode})`)
  }
  const list = data.result?.list as Array<{ userid?: string; name?: string }> | undefined
  return (list ?? []).filter((u) => u.userid && u.name).map((u) => ({ userid: u.userid!, name: u.name! }))
}

/** 钉钉：用 userid 解析 unionid。 */
async function resolveDingtalkUnionId(token: string, userid: string): Promise<string | undefined> {
  const resp = await fetch(`${DINGTALK_OAPI_BASE}/topapi/v2/user/get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userid }),
  })
  const data = (await resp.json()) as any
  if (data.errcode !== 0) return undefined
  return data.result?.unionid as string | undefined
}

/** 钉钉：遍历根部门及一层子部门，本地按姓名关键字过滤。 */
async function searchDingtalkContacts(keyword: string): Promise<ContactSearchResult[]> {
  const cred = getDingtalkCredential()
  if (!cred?.appId || !cred.appSecret) {
    throw new Error('未找到已连接的钉钉 Bot 凭证，请在「设置 → 钉钉 Todo」完成配置')
  }
  const token = await getDingtalkToken(cred.appId, cred.appSecret)
  const kw = keyword.trim().toLowerCase()
  const collected: Array<{ userid: string; name: string }> = []

  const deptIds = [1]
  try {
    deptIds.push(...(await listDingtalkSubDeptIds(token, 1)))
  } catch (err) {
    console.warn('[ContactSearch] 获取钉钉子部门失败，仅搜索根部门:', err)
  }

  for (const deptId of deptIds.slice(0, 30)) {
    try {
      collected.push(...(await listDingtalkDeptUsers(token, deptId)))
    } catch (err) {
      console.warn(`[ContactSearch] 钉钉部门 ${deptId} 成员获取失败，跳过:`, err)
    }
  }

  const seen = new Set<string>()
  const matched: ContactSearchResult[] = []
  for (const u of collected) {
    if (seen.has(u.userid)) continue
    seen.add(u.userid)
    if (!kw || u.name.toLowerCase().includes(kw)) {
      matched.push({ platform: 'dingtalk', userId: u.userid, name: u.name })
    }
    if (matched.length >= 20) break
  }

  // 并行解析 unionid（点选后用于工作待办同步），单个失败不影响整体
  await Promise.all(
    matched.map(async (m) => {
      try {
        m.unionId = await resolveDingtalkUnionId(token, m.userId)
      } catch {
        // 忽略单个解析失败
      }
    })
  )
  return matched
}

// ===== 聚合入口 =====

export interface ContactSearchAllResult {
  feishu: { ok: boolean; users: ContactSearchResult[]; error?: string }
  dingtalk: { ok: boolean; users: ContactSearchResult[]; error?: string }
}

/**
 * 同时搜索飞书与钉钉通讯录（各自独立失败不影响整体）。
 * @param keyword 负责人姓名关键字；为空则返回各自前若干成员。
 */
export async function searchContactsAll(keyword = ''): Promise<ContactSearchAllResult> {
  const kw = (keyword ?? '').trim()
  const [feishu, dingtalk] = await Promise.all([
    (async () => {
      try {
        return { ok: true as const, users: await searchFeishuContacts(kw) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false as const, users: [], error: message }
      }
    })(),
    (async () => {
      try {
        return { ok: true as const, users: await searchDingtalkContacts(kw) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false as const, users: [], error: message }
      }
    })(),
  ])
  return { feishu, dingtalk }
}
