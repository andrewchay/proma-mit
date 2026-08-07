/**
 * 钉钉 Todo Provider — 通过钉钉开放平台 Todo API 操作任务
 *
 * 使用方式：
 * ```typescript
 * const provider = new DingtalkTodoProvider({ appKey: 'xxx', appSecret: 'xxx' })
 * registerTodoProvider(provider)
 * ```
 */

import type { TodoProvider } from './project-sync-service'
import type { Task } from './project-service'

interface DingtalkTodoConfig {
  appKey: string
  appSecret: string
}

interface TokenCache {
  token: string
  expiresAt: number
}

const DINGTALK_API_BASE = 'https://api.dingtalk.com/v1.0'
const DINGTALK_OAPI_BASE = 'https://oapi.dingtalk.com'

// 缓存 access_token（全局，按 appKey 隔离）
const tokenCacheMap = new Map<string, TokenCache>()

// 缓存 userid -> unionid 解析结果（按 appKey 隔离，避免重复调用通讯录接口）
const unionIdCacheMap = new Map<string, Map<string, string>>()

export class DingtalkTodoProvider implements TodoProvider {
  readonly name: 'dingtalk' = 'dingtalk'
  private appKey: string
  private appSecret: string

  constructor(config: DingtalkTodoConfig) {
    this.appKey = config.appKey
    this.appSecret = config.appSecret
  }

  // ===== 创建 Todo =====
  async createTodo(
    task: Task,
    userId: string,
    options?: { unionId?: string }
  ): Promise<{ taskId: string; status: string; unionId?: string }> {
    let unionId: string | undefined = options?.unionId

    // 如果调用方没有传 unionId，但传了 dingtalkUserId，尝试解析出 unionId
    if (!unionId && userId) {
      try {
        const resolved = await this.resolveUnionId(userId)
        if (resolved) unionId = resolved
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[DingtalkTodoProvider] 无法从 dingtalkUserId 解析 unionId: ${message}`)
      }
    }

    if (unionId) {
      return this.createWorkTodo(task, unionId)
    }

    return this.createPersonalTodo(task)
  }

  // ===== 更新 Todo 状态 =====
  async updateTodoStatus(
    taskId: string,
    status: string,
    options?: { unionId?: string }
  ): Promise<boolean> {
    const token = await this.getAccessToken()
    const unionId = options?.unionId

    if (unionId) {
      const path = `/todo/users/${encodeURIComponent(unionId)}/tasks/${encodeURIComponent(taskId)}/status`
      const resp = await this.dingtalkApi('PUT', path, token, { isDone: status === 'completed' })
      return resp.result === true || resp.success === true
    }

    // 无 unionId 时回退到个人待办
    const path = `/todo/users/me/tasks/${encodeURIComponent(taskId)}`
    const resp = await this.dingtalkApi('PUT', path, token, { isDone: status === 'completed' })
    return resp.result === true || resp.success === true
  }

  // ===== 查询 Todo 状态 =====
  async queryTodoStatus(taskId: string, options?: { unionId?: string }): Promise<string | null> {
    const token = await this.getAccessToken()

    const unionId = options?.unionId
    const path = unionId
      ? `/todo/users/${encodeURIComponent(unionId)}/tasks/${encodeURIComponent(taskId)}`
      : `/todo/users/me/tasks/${encodeURIComponent(taskId)}`

    try {
      const resp = await this.dingtalkApi('GET', path, token)
      return this.parseTodoStatus(resp)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[DingtalkTodoProvider] 查询任务失败: ${message}`)
      return null
    }
  }

  // ===== 用户 ID 映射 =====
  async getUserIdByPaaUserId(paaUserId: string): Promise<string | null> {
    // PH1-A：优先从成员目录反向解析钉钉 unionid（工作待办用）；找不到则回退原值
    try {
      const { resolvePlatformForPaaUser } = await import('./member-sync-service')
      const resolved = resolvePlatformForPaaUser(paaUserId, 'dingtalk')
      return resolved ?? paaUserId
    } catch {
      return paaUserId
    }
  }

  // ===== 工作待办创建 =====
  private async createWorkTodo(
    task: Task,
    unionId: string
  ): Promise<{ taskId: string; status: string; unionId: string }> {
    const token = await this.getAccessToken()

    const body: Record<string, unknown> = {
      subject: task.title,
      executorIds: [unionId],
      sourceId: `paa-task-${task.id}`,
    }
    if (task.description) body.description = task.description
    if (task.dueDate) body.dueTime = task.dueDate

    const path = `/todo/users/${encodeURIComponent(unionId)}/tasks`
    const resp = await this.dingtalkApi('POST', path, token, body)

    const taskId = (resp.taskId ?? resp.id) as string | undefined
    if (!taskId) {
      throw new Error(`钉钉创建工作待办失败: 响应缺少 taskId, ${JSON.stringify(resp)}`)
    }

    return { taskId, status: 'pending', unionId }
  }

  // ===== 个人待办创建（无 unionId 时的降级方案） =====
  private async createPersonalTodo(task: Task): Promise<{ taskId: string; status: string }> {
    const token = await this.getAccessToken()

    const body: Record<string, unknown> = { subject: task.title }
    if (task.description) body.description = task.description
    if (task.dueDate) body.dueTime = task.dueDate

    const resp = await this.dingtalkApi('POST', '/todo/users/me/personalTasks', token, body)

    const taskId = (resp.taskId ?? resp.id) as string | undefined
    if (!taskId) {
      throw new Error(`钉钉创建个人待办失败: 响应缺少 taskId, ${JSON.stringify(resp)}`)
    }

    return { taskId, status: 'pending' }
  }

  // ===== 状态解析 =====
  private parseTodoStatus(resp: any): string | null {
    if (resp.isDone === true || resp.done === true || resp.status === 'COMPLETED') return 'completed'
    if (resp.isDone === false || resp.done === false || resp.status === 'INIT') return 'pending'

    const executorStatusList = resp.executorStatusList as Array<{
      isDone?: boolean
      done?: boolean
      status?: string
    }> | undefined
    if (executorStatusList && executorStatusList.length > 0) {
      const first = executorStatusList[0]
      if (first) {
        if (first.isDone === true || first.done === true || first.status === 'COMPLETED') {
          return 'completed'
        }
        return 'pending'
      }
    }

    return 'pending'
  }

  // ===== 通过 userid 解析 unionId =====
  private async resolveUnionId(userid: string): Promise<string | null> {
    const cache = unionIdCacheMap.get(this.appKey)
    if (cache) {
      const cached = cache.get(userid)
      if (cached) return cached
    }

    const token = await this.getAccessToken()
    const url = `${DINGTALK_OAPI_BASE}/topapi/v2/user/get?access_token=${encodeURIComponent(token)}`

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userid }),
    })

    const data = (await resp.json()) as any
    this.checkApiError(data, '解析钉钉 unionId')

    const unionid = data?.result?.unionid as string | undefined
    if (!unionid) {
      throw new Error(`钉钉通讯录接口未返回 unionid: ${JSON.stringify(data)}`)
    }

    if (!unionIdCacheMap.has(this.appKey)) {
      unionIdCacheMap.set(this.appKey, new Map())
    }
    unionIdCacheMap.get(this.appKey)!.set(userid, unionid)

    return unionid
  }

  // ===== 内部 HTTP 请求 =====
  private async dingtalkApi(
    method: string,
    path: string,
    token: string,
    body?: unknown
  ): Promise<any> {
    const url = `${DINGTALK_API_BASE}${path}`
    const headers: Record<string, string> = {
      'x-acs-dingtalk-access-token': token,
      'Content-Type': 'application/json; charset=utf-8',
    }

    const resp = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    const data = await resp.json()
    this.checkApiError(data, '钉钉 API')
    return data
  }

  // ===== 错误检查 =====
  private checkApiError(data: any, action: string): void {
    if (!data || typeof data !== 'object') return

    const errcode = data.errcode
    if (typeof errcode === 'number' && errcode !== 0) {
      throw new Error(`${action}失败: ${data.errmsg || ''} (errcode: ${errcode})`)
    }

    const code = data.code
    if (typeof code === 'string' && code !== '0' && code.toLowerCase() !== 'ok') {
      throw new Error(
        `${action}失败: ${data.message || data.msg || data.subMessage || JSON.stringify(data)} (code: ${code})`
      )
    }
  }

  // ===== Token 管理 =====
  private async getAccessToken(): Promise<string> {
    const cacheKey = `${this.appKey}`
    const cached = tokenCacheMap.get(cacheKey)

    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.token
    }

    const url = `${DINGTALK_OAPI_BASE}/gettoken?appkey=${encodeURIComponent(this.appKey)}&appsecret=${encodeURIComponent(this.appSecret)}`

    const resp = await fetch(url, { method: 'GET' })
    const data = (await resp.json()) as {
      errcode: number
      errmsg: string
      access_token?: string
      expires_in?: number
    }

    if (data.errcode !== 0) {
      throw new Error(`钉钉 Token 获取失败: ${data.errmsg} (errcode: ${data.errcode})`)
    }

    const token = data.access_token!
    const expire = data.expires_in || 7200

    tokenCacheMap.set(cacheKey, {
      token,
      expiresAt: Date.now() + expire * 1000,
    })

    return token
  }
}

/**
 * 从配置中创建钉钉 Todo Provider
 *
 * 如果配置不存在，返回 null
 */
export function createDingtalkTodoProviderFromConfig(): DingtalkTodoProvider | null {
  try {
    const { getSettings } = require('./settings-service')
    const settings = getSettings() as Record<string, any>

    const dingtalkTodo = settings.dingtalkTodo as { enabled?: boolean; botId?: string; appKey?: string; appSecret?: string } | undefined
    if (!dingtalkTodo?.enabled) {
      console.log('[DingtalkTodoProvider] 钉钉 Todo 同步未启用或未配置凭证')
      return null
    }

    // 新配置统一复用 Bot Hub 的加密凭证，避免 settings.json 留存第二份 Secret。
    if (dingtalkTodo.botId) {
      const { getDingTalkBotById, getDecryptedBotClientSecret } = require('./dingtalk-config')
      const bot = getDingTalkBotById(dingtalkTodo.botId)
      const appSecret = bot ? getDecryptedBotClientSecret(bot.id) : ''
      if (!bot?.clientId || !appSecret) {
        console.log('[DingtalkTodoProvider] 已选择的钉钉 Bot 凭证不完整')
        return null
      }
      return new DingtalkTodoProvider({ appKey: bot.clientId, appSecret })
    }

    // 旧版设置的兼容路径：下一次通过设置页保存后会迁移到 Bot Hub。
    if (!dingtalkTodo.appKey || !dingtalkTodo.appSecret) {
      console.log('[DingtalkTodoProvider] 钉钉 Todo 同步未启用或未配置凭证')
      return null
    }

    return new DingtalkTodoProvider({
      appKey: dingtalkTodo.appKey,
      appSecret: dingtalkTodo.appSecret,
    })
  } catch (error) {
    console.error('[DingtalkTodoProvider] 创建 Provider 失败:', error)
    return null
  }
}

/**
 * 发送钉钉群机器人消息（项目摘要 / 完成纪要提醒等通知）。
 *
 * 配置来源：设置 → 钉钉 Todo → 群机器人 Webhook（可加签）。
 * 加签方式：timestamp + "\n" + secret 的 HMAC-SHA256，base64 后 URL 编码。
 */
export async function sendDingTalkRobotMessage(input: {
  title: string
  text: string
}): Promise<{ success: boolean; error?: string }> {
  try {
    const { getSettings } = await import('./settings-service')
    const settings = getSettings()
    const todoConfig = settings.dingtalkTodo
    const webhook = todoConfig?.robotWebhook
    if (!webhook) {
      return { success: false, error: '未配置钉钉群机器人 Webhook（设置 → 钉钉 Todo → 群机器人 Webhook）' }
    }

    let targetUrl = webhook
    const secret = todoConfig?.robotWebhookSecret
    if (secret) {
      const timestamp = Date.now()
      const sign = await signRobotSecret(timestamp, secret)
      targetUrl = `${webhook}${webhook.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`
    }

    const resp = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { title: input.title, text: input.text },
      }),
    })
    const data = (await resp.json()) as { errcode?: number; errmsg?: string }
    if (data.errcode && data.errcode !== 0) {
      return { success: false, error: `钉钉机器人发送失败: ${data.errmsg ?? data.errcode}` }
    }
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, error: message }
  }
}

async function signRobotSecret(timestamp: number, secret: string): Promise<string> {
  const { createHmac } = await import('node:crypto')
  const stringToSign = `${timestamp}\n${secret}`
  const hmac = createHmac('sha256', stringToSign)
  return hmac.digest('base64')
}
