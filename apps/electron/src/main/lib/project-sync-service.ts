/**
 * 项目同步服务 — Project Sync Service
 *
 * 核心职责：
 * - 将 PAA 任务同步到飞书/钉钉 Todo
 * - 更新外部任务状态（与本地状态保持一致）
 * - 查询外部任务完成状态
 * - 提供 TodoProvider 接口，便于扩展更多平台
 *
 * 调用模式：
 * ```typescript
 * const result = await syncTaskToExternal(task, 'feishu', feishuTodoProvider)
 * ```
 */

import {
  getUserMapping,
  type Task,
  type TaskStatus,
  updateTask,
  getTask,
} from './project-service'

// ===== Provider 注册表 =====

const providers = new Map<string, TodoProvider>()

/** 注册 Todo Provider */
export function registerTodoProvider(provider: TodoProvider): void {
  providers.set(provider.name, provider)
  console.log(`[ProjectSync] 已注册 ${provider.name} Todo Provider`)
}

/** 注销 Todo Provider */
export function unregisterTodoProvider(name: string): void {
  providers.delete(name)
  console.log(`[ProjectSync] 已注销 ${name} Todo Provider`)
}

/** 获取已注册的 Provider */
export function getTodoProvider(platform: string): TodoProvider | undefined {
  return providers.get(platform)
}

/** 检查 Provider 是否已注册 */
export function hasTodoProvider(platform: string): boolean {
  return providers.has(platform)
}

// ===== Provider 接口 =====

export interface TodoProvider {
  /** 平台标识 */
  name: 'feishu' | 'dingtalk' | 'agent'
  /** 创建 Todo，返回外部 taskId */
  createTodo(
    task: Task,
    userId: string,
    options?: { unionId?: string }
  ): Promise<{ taskId: string; status: string; unionId?: string }>
  /** 更新 Todo 状态 */
  updateTodoStatus(taskId: string, status: string, options?: { unionId?: string }): Promise<boolean>
  /** 查询 Todo 状态 */
  queryTodoStatus(taskId: string, options?: { unionId?: string }): Promise<string | null>
  /** 将 PAA userId 转换为平台用户 ID */
  getUserIdByPaaUserId(paaUserId: string): Promise<string | null>
}

// ===== 同步结果 =====

export interface SyncResult {
  success: boolean
  taskId?: string
  status?: string
  error?: string
}

// ===== 外部同步状态 =====

export type ExternalSyncStatus = string | null

// ===== 核心同步逻辑 =====

/**
 * 将任务同步到外部 Todo 平台
 *
 * @param task 本地任务
 * @param platform 目标平台标识
 * @param provider Todo Provider 实例
 * @returns 同步结果
 */
export async function syncTaskToExternal(
  task: Task,
  platform: 'feishu' | 'dingtalk',
  provider: TodoProvider
): Promise<SyncResult> {
  try {
    // 1. 检查任务是否分配了负责人
    if (!task.assignee) {
      return { success: false, error: '任务未分配负责人，无法同步' }
    }

    // 2. 查找用户映射
    const userMapping = await getUserMapping(task.assignee.userId)
    if (!userMapping) {
      return { success: false, error: `未找到用户映射: ${task.assignee.userId}` }
    }

    // 3. 获取平台用户 ID（优先使用用户映射中保存的平台真实 ID）
    const platformUserId = platform === 'feishu'
      ? userMapping.feishuUserId
      : (userMapping.dingTalkUnionId ?? userMapping.dingtalkUserId)

    if (!platformUserId) {
      return { success: false, error: `未找到 ${platform} 用户映射` }
    }

    // 4. 创建外部 Todo（钉钉优先使用 unionId 调用工作待办接口）
    const createOptions = platform === 'dingtalk'
      ? { unionId: userMapping.dingTalkUnionId }
      : undefined
    const result = await provider.createTodo(task, platformUserId, createOptions)

    // 5. 更新本地任务的外部同步记录
    const existingTask = await getTask(task.id)
    if (existingTask) {
      const externalSync = { ...(existingTask.externalSync || {}) }
      const dingTalkUnionId = result.unionId ?? userMapping.dingTalkUnionId
      externalSync[platform] = {
        taskId: result.taskId,
        status: result.status,
        syncedAt: Date.now(),
        ...(platform === 'dingtalk' && dingTalkUnionId
          ? { unionId: dingTalkUnionId }
          : {}),
      }
      await updateTask(task.id, { externalSync })
    }

    return { success: true, taskId: result.taskId, status: result.status }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, error: `同步失败: ${message}` }
  }
}

/**
 * 更新外部 Todo 状态（本地状态变更时调用）
 *
 * @param taskId 外部 taskId
 * @param status 目标状态
 * @param provider Todo Provider 实例
 * @returns 是否成功
 */
export async function updateExternalTaskStatus(
  taskId: string,
  status: string,
  provider: TodoProvider,
  options?: { unionId?: string }
): Promise<boolean> {
  try {
    return await provider.updateTodoStatus(taskId, status, options)
  } catch (error) {
    console.error(`[${provider.name}] 更新外部任务状态失败:`, error)
    return false
  }
}

/**
 * 查询外部 Todo 状态
 *
 * @param taskId 外部 taskId
 * @param provider Todo Provider 实例
 * @returns 状态字符串或 null
 */
export async function getExternalSyncStatus(
  taskId: string,
  provider: TodoProvider,
  options?: { unionId?: string }
): Promise<ExternalSyncStatus> {
  try {
    return await provider.queryTodoStatus(taskId, options)
  } catch (error) {
    console.error(`[${provider.name}] 查询外部任务状态失败:`, error)
    return null
  }
}

// ===== 批量同步工具 =====

/**
 * 同步任务状态到所有已配置的外部平台
 *
 * @param task 本地任务
 * @param providers 已配置的 Provider 列表
 * @returns 各平台同步结果
 */
export async function syncTaskToAllPlatforms(
  task: Task,
  providers: Array<{ platform: 'feishu' | 'dingtalk'; provider: TodoProvider }>
): Promise<Record<string, SyncResult>> {
  const results: Record<string, SyncResult> = {}

  for (const { platform, provider } of providers) {
    results[platform] = await syncTaskToExternal(task, platform, provider)
  }

  return results
}

/**
 * 按任务 ID 同步到外部平台（IPC 友好接口）
 *
 * @param taskId 本地任务 ID
 * @param platform 目标平台
 * @returns 同步结果
 */
export async function syncTaskById(
  taskId: string,
  platform: 'feishu' | 'dingtalk'
): Promise<SyncResult> {
  const task = await getTask(taskId)
  if (!task) {
    return { success: false, error: '任务不存在' }
  }

  const provider = getTodoProvider(platform)
  if (!provider) {
    return { success: false, error: `${platform} Todo Provider 未配置` }
  }

  return syncTaskToExternal(task, platform, provider)
}

/**
 * 按任务 ID 查询外部同步状态（IPC 友好接口）
 *
 * @param taskId 本地任务 ID
 * @param platform 目标平台
 * @returns 外部状态或 null
 */
export async function getSyncStatusById(
  taskId: string,
  platform: 'feishu' | 'dingtalk'
): Promise<ExternalSyncStatus> {
  const task = await getTask(taskId)
  if (!task || !task.externalSync) {
    return null
  }

  const platformSync = task.externalSync[platform]
  if (!platformSync) {
    return null
  }

  const provider = getTodoProvider(platform)
  if (!provider) {
    return null
  }

  return getExternalSyncStatus(platformSync.taskId, provider, {
    unionId: (platformSync as { unionId?: string }).unionId,
  })
}

/**
 * 获取任务的外部同步信息（不查询平台，仅读取本地记录）
 *
 * @param taskId 本地任务 ID
 * @returns 各平台同步记录
 */
export async function getTaskExternalSyncInfo(taskId: string): Promise<Record<string, { taskId: string; status: string; syncedAt: number; unionId?: string }> | null> {
  const task = await getTask(taskId)
  if (!task || !task.externalSync) {
    return null
  }
  return task.externalSync
}
