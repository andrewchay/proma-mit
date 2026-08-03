/**
 * 飞书 Todo Provider — 通过飞书开放平台 Task v2 API 操作任务
 *
 * 依赖：@larksuiteoapi/node-sdk（项目已安装）
 *
 * 使用方式：
 * ```typescript
 * const provider = new FeishuTodoProvider({ appId: 'xxx', appSecret: 'xxx' })
 * registerTodoProvider(provider)
 * ```
 */

import type { TodoProvider } from './project-sync-service'
import type { Task } from './project-service'

interface FeishuTodoConfig {
  appId: string
  appSecret: string
}

interface TokenCache {
  token: string
  expiresAt: number
}

// 缓存 tenant_access_token（全局，按 appId 隔离）
const tokenCacheMap = new Map<string, TokenCache>()

export class FeishuTodoProvider implements TodoProvider {
  readonly name: 'feishu' = 'feishu'
  private appId: string
  private appSecret: string

  constructor(config: FeishuTodoConfig) {
    this.appId = config.appId
    this.appSecret = config.appSecret
  }

  // ===== 创建 Todo =====
  async createTodo(
    task: Task,
    userId: string
  ): Promise<{ taskId: string; status: string }> {
    const token = await this.getTenantAccessToken()

    const body = {
      summary: task.title,
      description: task.description,
      ...(task.dueDate && {
        due: {
          timestamp: String(Math.floor(task.dueDate / 1000)),
          is_all_day: true,
        },
      }),
      ...(userId && {
        assignee: { id: userId, type: 'user' },
      }),
    }

    const resp = await this.feishuApi('POST', '/open-apis/task/v2/tasks', token, body)

    if (resp.code !== 0) {
      throw new Error(`飞书创建任务失败: ${resp.msg} (code: ${resp.code})`)
    }

    const taskGuid = resp.data?.task?.guid as string
    if (!taskGuid) {
      throw new Error('飞书创建任务返回缺少 task.guid')
    }

    return { taskId: taskGuid, status: 'pending' }
  }

  // ===== 更新 Todo 状态 =====
  async updateTodoStatus(taskId: string, status: string): Promise<boolean> {
    const token = await this.getTenantAccessToken()

    if (status === 'completed') {
      // 标记完成
      const resp = await this.feishuApi(
        'POST',
        `/open-apis/task/v2/tasks/${taskId}/complete`,
        token
      )
      return resp.code === 0
    }

    // 其他状态：使用 PATCH 更新
    const completedAt = status === 'completed' ? String(Math.floor(Date.now() / 1000)) : null
    const updateFields = ['completed_at']

    const resp = await this.feishuApi('PATCH', `/open-apis/task/v2/tasks/${taskId}`, token, {
      completed_at: completedAt,
      update_fields: updateFields,
    })

    return resp.code === 0
  }

  // ===== 查询 Todo 状态 =====
  async queryTodoStatus(taskId: string, _options?: { unionId?: string }): Promise<string | null> {
    const token = await this.getTenantAccessToken()

    const resp = await this.feishuApi('GET', `/open-apis/task/v2/tasks/${taskId}`, token)

    if (resp.code !== 0) {
      console.error(`[FeishuTodoProvider] 查询任务失败: ${resp.msg}`)
      return null
    }

    const taskData = resp.data?.task
    if (!taskData) return null

    // 检查 completed_at 字段判断状态
    const completedAt = taskData.completed_at
    return completedAt ? 'completed' : (taskData.status ?? 'pending')
  }

  // ===== 用户 ID 映射 =====
  async getUserIdByPaaUserId(paaUserId: string): Promise<string | null> {
    // 假设用户映射中存储的就是飞书 open_id
    // 如果存储的是其他格式，需要在这里转换
    // 目前直接返回用户映射中的 feishuUserId
    return paaUserId
  }

  // ===== 内部 HTTP 请求 =====
  private async feishuApi(
    method: string,
    path: string,
    token: string,
    body?: unknown
  ): Promise<any> {
    const url = `https://open.feishu.cn${path}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    }

    const resp = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    const data = await resp.json()
    return data
  }

  // ===== Token 管理 =====
  private async getTenantAccessToken(): Promise<string> {
    const cacheKey = `${this.appId}`
    const cached = tokenCacheMap.get(cacheKey)

    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.token
    }

    // 使用 SDK 获取 token（SDK 已处理签名等）
    // 直接用 fetch 调 token 接口（与 curl 验证一致）。
    // 注意：新版飞书接口把 tenant_access_token 放在响应顶层，SDK 的 resp.data 可能为 undefined。
    const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    })
    const data = (await resp.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number }

    if (data.code !== 0) {
      throw new Error(`飞书 Token 获取失败: ${data.msg} (code: ${data.code})`)
    }

    const token = data.tenant_access_token
    if (!token) throw new Error('飞书 Token 获取失败: 响应缺少 tenant_access_token')
    const expire = data.expire || 7200

    tokenCacheMap.set(cacheKey, {
      token,
      expiresAt: Date.now() + expire * 1000,
    })

    return token
  }
}

/**
 * 从配置中创建 Feishu Todo Provider
 *
 * 如果配置不存在，返回 null
 */
export function createFeishuTodoProviderFromConfig(): FeishuTodoProvider | null {
  try {
    const { getSettings } = require('./settings-service')
    const settings = getSettings() as import('../../types').AppSettings

    const feishuTodo = settings.feishuTodo
    if (!feishuTodo?.enabled) {
      console.log('[FeishuTodoProvider] 飞书 Todo 同步未启用')
      return null
    }

    // 获取飞书 Bot 配置
    const { getFeishuMultiBotConfig, getDecryptedBotAppSecret } = require('./feishu-config')
    const config = getFeishuMultiBotConfig()
    const bot = config.bots.find((b: any) => b.id === feishuTodo.botId && b.enabled && b.appId && b.appSecret)
    if (!bot) {
      console.log(`[FeishuTodoProvider] 未找到 Bot ${feishuTodo.botId}`)
      return null
    }

    // 注意：bot.appSecret 是 safeStorage 加密后的密文，必须解密后才能用于
    // tenant_access_token 换取；否则飞书返回 10014 app secret invalid。
    const decryptedSecret = getDecryptedBotAppSecret(bot.id)
    if (!decryptedSecret) {
      console.warn(`[FeishuTodoProvider] Bot ${feishuTodo.botId} 的 App Secret 解密后为空`)
      return null
    }

    return new FeishuTodoProvider({
      appId: bot.appId,
      appSecret: decryptedSecret,
    })
  } catch (error) {
    console.error('[FeishuTodoProvider] 创建 Provider 失败:', error)
    return null
  }
}
