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

    // ⚠ 飞书 Task v2 的负责人不是顶级 assignee 字段，而是 members 列表中的
    //    role='assignee' 项；直接传 assignee 会导致任务创建后无执行者，
    //    从而不出现在任何人的飞书 Todo「我的任务」里（用户反映"同步了但飞书看不到"）。
    //    user_id_type=open_id 与用户映射中保存的 feishuUserId(ou_...) 呼应。
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
        members: [{ id: userId, role: 'assignee' }],
      }),
    }

    // user_id_type=open_id 显式声明 userId 为 open_id，避免飞书按默认 user_id 解析导致成员无法匹配
    const resp = await this.feishuApi('POST', '/open-apis/task/v2/tasks?user_id_type=open_id', token, body)

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
      if (resp.code !== 0) {
        throw new Error(`飞书完成任务失败: ${resp.msg} (code: ${resp.code})`)
      }
      return true
    }

    // 其他状态：使用 PATCH 更新（把任务恢复为未完成，清空 completed_at）。
    // ⚠ 飞书 Task v2 更新接口要求用 task 字段包裹新值：{ task: {...}, update_fields: [...] }。
    //   直接平铺 completed_at/update_fields 会报 "Invalid Param 'task', must not be empty"。
    //   update_fields 列出字段但 task 中不给新值 = 清空该字段（官方"关于资源的更新"语义）。
    const resp = await this.feishuApi('PATCH', `/open-apis/task/v2/tasks/${taskId}`, token, {
      task: {},
      update_fields: ['completed_at'],
    })

    if (resp.code !== 0) {
      throw new Error(`飞书更新任务状态失败: ${resp.msg} (code: ${resp.code})`)
    }

    return true
  }

  /** PH2 修复：更新飞书 Todo 的截止时间（编辑任务改截止日期后同步生效） */
  async updateTodoDue(taskId: string, dueTimestampMs: number): Promise<boolean> {
    const token = await this.getTenantAccessToken()
    const resp = await this.feishuApi('PATCH', `/open-apis/task/v2/tasks/${taskId}`, token, {
      task: { due: { timestamp: String(Math.floor(dueTimestampMs / 1000)), is_all_day: true } },
      update_fields: ['due'],
    })
    if (resp.code !== 0) {
      throw new Error(`飞书更新截止失败: ${resp.msg} (code: ${resp.code})`)
    }
    return true
  }

  // ===== 查询 Todo 状态 =====
  async queryTodoStatus(taskId: string, _options?: { unionId?: string }): Promise<string | null> {
    const token = await this.getTenantAccessToken()

    const resp = await this.feishuApi('GET', `/open-apis/task/v2/tasks/${taskId}`, token)

    if (resp.code !== 0) {
      throw new Error(`飞书查询任务失败: ${resp.msg} (code: ${resp.code})`)
    }

    const taskData = resp.data?.task
    if (!taskData) return null

    // 检查 completed_at 字段判断状态
    const completedAt = taskData.completed_at
    return completedAt ? 'completed' : (taskData.status ?? 'pending')
  }

  // ===== 用户 ID 映射 =====
  async getUserIdByPaaUserId(paaUserId: string): Promise<string | null> {
    // PH1-A：优先从成员目录（稳定档案）按 paa-<name> 反向解析飞书 open_id；找不到则回退原值
    try {
      const { resolvePlatformForPaaUser } = await import('./member-sync-service')
      const resolved = resolvePlatformForPaaUser(paaUserId, 'feishu')
      return resolved ?? paaUserId
    } catch {
      return paaUserId
    }
  }

  // ===== 内部 HTTP 请求 =====
  private async feishuApi(
    method: string,
    path: string,
    token: string,
    body?: unknown,
    isRetry = false
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

    // 权限不足（99991672）：通常是权限刚开通但 token 缓存还是旧的。
    // 自动清除缓存并换取新 token 重试一次，避免用户开通权限后仍需等 2 小时。
    if (!isRetry && data?.code === 99991672) {
      console.warn(`[FeishuTodoProvider] 权限不足（code=99991672），清除 token 缓存后重试一次: ${data?.msg}`)
      tokenCacheMap.delete(this.appId)
      const freshToken = await this.getTenantAccessToken()
      return this.feishuApi(method, path, freshToken, body, true)
    }

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
