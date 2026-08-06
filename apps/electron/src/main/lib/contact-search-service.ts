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
 * - 飞书：GET /open-apis/contact/v3/users 分页拉取全企业成员，本地按关键词过滤，返回 open_id/union_id。
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

// ===== 响应解析容错 =====

/** 安全解析飞书/钉钉响应：先读原文再 JSON.parse。
 * 部分被网关拦截/权限异常的路径可能返回非 JSON（如 HTML、纯文本、空响应），
 * 直接 `resp.json()` 会二次抛 `SyntaxError` 掩盖真实原因；这里改为抛出包含
 * HTTP 状态码 + 原文前段的可读错误，方便一线排查。
 */
async function safeJson<T = any>(res: Response): Promise<T> {
  const text = await res.text().catch(() => '')
  if (!text) {
    throw new Error(`接口返回空响应 (HTTP ${res.status})`)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`接口返回非 JSON (HTTP ${res.status}, ${res.url})\n原始内容: ${text.slice(0, 160)}`)
  }
}

/** 飞书业务错误统一包装：code=40004 时补充可操作排查提示。 */
function feishuError(code: number | undefined, detail: string): Error {
  const base = `飞书${detail} (code: ${code ?? '?'})`
  if (code === 40004) {
    return new Error(
      `${base}\n提示：该飞书应用无此部门的访问权限。请在飞书开放平台确认：` +
        `① 权限管理已勾选 contact:department.base:readonly 与 contact:contact.base:readonly；` +
        `② 在「版本管理与发布」提交新版本并由企业管理员审核通过（改权限后必须重新发布才生效）；` +
        `③ 企业管理员已为该应用授权通讯录可见范围（至少包含根部门/目标部门）。`
    )
  }
  return new Error(base)
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
  const data = await safeJson<{ code?: number; msg?: string; tenant_access_token?: string; expire?: number }>(resp)
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

/** 飞书：分页拉取全部用户（用 tenant_access_token），按姓名关键字本地过滤。
 * 使用 GET /contact/v3/users，可一次遍历全企业成员，避免按部门遍历时
 * 根部门(0)成员接口 404 且子部门层级/分页不全导致漏人的问题。 */
async function searchFeishuContacts(keyword: string): Promise<ContactSearchResult[]> {
  const cred = getFeishuCredential()
  if (!cred?.appId || !cred.appSecret) {
    throw new Error('未找到已连接的飞书 Bot 凭证，请在「设置 → 飞书 Todo」完成配置')
  }
  const token = await getFeishuTenantToken(cred.appId, cred.appSecret)
  const kw = keyword.trim().toLowerCase()

  const collected: ContactSearchResult[] = []
  const seen = new Set<string>()
  const errors: string[] = []

  // 分页拉取全企业用户（最多拉 5 页 × 50 = 250 人，超过则截断）
  let pageToken = ''
  let feishuUsersRaw = ''
  for (let page = 0; page < 5; page++) {
    try {
      const url = `${FEISHU_BASE}/open-apis/contact/v3/users?page_size=50${pageToken ? `&page_token=${pageToken}` : ''}`
      const resp = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })
      const data = await safeJson<any>(resp)
      if (page === 0) feishuUsersRaw = JSON.stringify(data).slice(0, 400)
      if (data.code !== 0) {
        throw feishuError(data.code, `获取用户失败: ${data.msg ?? '未知错误'}`)
      }
      const items = (data.data?.items as Array<{ name?: string; open_id?: string; union_id?: string; department_ids?: string[] }> | undefined) ?? []
      console.log(`[ContactSearch] 飞书用户分页第${page + 1}页: code=${data.code} items=${items.length} has_more=${data.data?.has_more} total=${data.data?.total}`)
      console.log('[ContactSearch] users 原始响应:', JSON.stringify(data).slice(0, 600))
      for (const u of items) {
        if (!u.name) continue
        const userId = u.open_id || u.union_id
        if (!userId || seen.has(userId)) continue
        seen.add(userId)
        if (!kw || u.name.toLowerCase().includes(kw)) {
          collected.push({ platform: 'feishu', userId, name: u.name })
        }
        if (collected.length >= 20) return collected
      }
      pageToken = data.data?.page_token ?? ''
      if (!pageToken || !data.data?.has_more) break
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
      console.warn('[ContactSearch] 飞书用户分页获取失败，暂停:', err)
      break
    }
  }

  // 一个成员都没有但有错误 → 抛出，让前端显示具体原因
  if (collected.length === 0 && errors.length > 0) {
    throw new Error(`飞书通讯录获取失败: ${errors.join('; ')}`)
  }
  // 一个成员都没有但无错误 → 探针诊断：拉取根部门子部门，区分是「可见范围」还是「权限」问题
  if (collected.length === 0) {
    try {
      const deptResp = await fetch(`${FEISHU_BASE}/open-apis/contact/v3/departments/0/children?fetch_child=false&page_size=50`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      })
      const deptData = await safeJson<any>(deptResp)
      // 飞书 v3 /departments/children 返回结构：data.items[]（每项含 department），不是 data.children
      const deptItems = ((deptData.data?.items ?? []) as Array<{ department?: { department_id?: string | number; name?: string } }>)
      const deptNames = deptItems.map((i) => i.department?.name).filter(Boolean) as string[]
      console.log(`[ContactSearch] 探针: 根部门子部门接口 code=${deptData.code} 子部门数=${deptItems.length} 部门=${deptNames.join(',')}`)
      console.log('[ContactSearch] departments 原始响应:', JSON.stringify(deptData).slice(0, 600))
      if (deptData.code !== 0) {
        throw feishuError(deptData.code, `读取根部门/部门失败: ${deptData.msg ?? '未知错误'}`)
      }
      const childrenCount = deptItems.length
      const probeInfo = `users响应[${feishuUsersRaw}] dept响应[${JSON.stringify(deptData).slice(0, 200)}]`
      if (childrenCount === 0) {
        throw new Error(
          `飞书通讯录为空：接口已连通，但根部门下子部门为 0。${probeInfo} ` +
            `说明应用在通讯录数据层面看不到任何部门 → 多为「通讯录数据权限范围」未覆盖组织架构：` +
            `请到飞书开放平台该应用权限设置中，找到通讯录相关权限的数据范围/可见范围，授予包含你所在部门的组织架构节点（至少根部门），重新发布审核。`
        )
      }
      throw new Error(
        `飞书通讯录为空：users 接口返回 0 个用户，但根部门下有子部门。${probeInfo} ` +
            `请到飞书开放平台确认 contact:user.base:readonly 权限已授予并发布审核通过，且可见范围包含这些部门节点。`
      )
    } catch (err) {
      if (err instanceof Error && /飞书通讯录为空/.test(err.message)) {
        throw err
      }
      throw new Error(`飞书通讯录获取失败: ${err instanceof Error ? err.message : String(err)}`)
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
  const data = await safeJson<{ errcode: number; errmsg: string; access_token?: string; expires_in?: number }>(resp)
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
  const data = await safeJson<any>(resp)
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
  const data = await safeJson<any>(resp)
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
  const data = await safeJson<any>(resp)
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
