/**
 * 项目外部状态轮询服务 — Project Polling Service
 *
 * 核心职责：
 * - 定期轮询飞书/钉钉 Todo 的完成状态
 * - 检测到外部完成后，自动更新本地任务状态
 * - 可选：自动触发风险评估（高风险任务不自动完成）
 *
 * 调用模式：
 * ```typescript
 * const result = await pollExternalTaskStatus(taskId, 'feishu', provider, { autoAssessRisk: true, llmCaller })
 * if (result.changed && result.riskAssessed) {
 *   // 需要用户填写完成纪要
 * }
 * ```
 */

import { getTask, updateTask, listTasks, type Task, type TaskStatus } from './project-service'
import { assessTaskRisk, requiresCompletionNotes } from './project-risk-service'
import type { LLMCaller } from './project-risk-service'

// ===== Provider 接口 =====

export interface ExternalTaskStatusProvider {
  name: 'feishu' | 'dingtalk'
  /** 查询外部任务状态 */
  queryStatus(externalTaskId: string, options?: { unionId?: string }): Promise<string | null>
}

// ===== 轮询结果 =====

export interface PollResult {
  /** 状态是否变化 */
  changed: boolean
  /** 新状态（变化时有效） */
  newStatus: string | null
  /** 是否触发了风险评估 */
  riskAssessed?: boolean
  /** 错误信息 */
  error?: string
}

// ===== 轮询选项 =====

export interface PollOptions {
  /** 是否自动触发风险评估 */
  autoAssessRisk?: boolean
  /** LLM 调用器（autoAssessRisk 为 true 时需要） */
  llmCaller?: LLMCaller
}

// ===== 核心轮询逻辑 =====

/**
 * 轮询单个任务的外部状态
 *
 * @param taskId 本地任务 ID（或 Task 对象）
 * @param platform 目标平台
 * @param provider 状态查询 Provider
 * @param options 轮询选项
 * @returns 轮询结果
 */
export async function pollExternalTaskStatus(
  taskId: string | Task,
  platform: 'feishu' | 'dingtalk',
  provider: ExternalTaskStatusProvider,
  options: PollOptions = {}
): Promise<PollResult> {
  try {
    const task = typeof taskId === 'string' ? await getTask(taskId) : taskId
    if (!task) {
      return { changed: false, newStatus: null, error: '任务不存在' }
    }

    // 检查是否有外部同步记录
    if (!task.externalSync || !task.externalSync[platform]) {
      return { changed: false, newStatus: null, error: `任务未同步到 ${platform}` }
    }

    const externalSync = task.externalSync[platform]!
    const externalTaskId = externalSync.taskId
    const localStatus = externalSync.status
    const unionId = platform === 'dingtalk' ? (externalSync as { unionId?: string }).unionId : undefined

    // 查询外部状态
    let externalStatus: string | null
    try {
      externalStatus = await provider.queryStatus(externalTaskId, { unionId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { changed: false, newStatus: null, error: `外部状态查询失败: ${message}` }
    }

    if (externalStatus === null) {
      return { changed: false, newStatus: null, error: '外部任务不存在' }
    }

    // 状态未变化
    if (externalStatus === localStatus) {
      return { changed: false, newStatus: null }
    }

    // 状态变化了，更新本地记录
    const externalSyncUpdate = { ...task.externalSync }
    externalSyncUpdate[platform] = {
      ...externalSync,
      status: externalStatus,
      syncedAt: Date.now(),
    }

    // 映射外部状态到本地状态
    const localStatusMap: Record<string, TaskStatus> = {
      pending: 'pending',
      in_progress: 'in_progress',
      completed: 'completed',
    }
    const newLocalStatus = localStatusMap[externalStatus] || task.status

    // 如果外部完成，且开启了自动风险评估
    let riskAssessed = false
    if (externalStatus === 'completed' && options.autoAssessRisk && options.llmCaller) {
      try {
        const riskResult = await assessTaskRisk(task.id, options.llmCaller)
        riskAssessed = true

        // 如果风险评估认为需要完成纪要，不自动标记为 completed，保持当前状态
        const shouldWaitForNotes = requiresCompletionNotes(riskResult.riskLevel)

        await updateTask(task.id, {
          externalSync: externalSyncUpdate,
          riskLevel: riskResult.riskLevel,
          status: shouldWaitForNotes ? task.status : newLocalStatus,
        })

        return {
          changed: true,
          newStatus: externalStatus,
          riskAssessed: true,
        }
      } catch (error) {
        // 风险评估失败，回退到普通状态更新
        console.error(`[ProjectPolling] 风险评估失败:`, error)
      }
    }

    // 普通状态更新（无风险评估或风险评估失败）
    await updateTask(task.id, {
      externalSync: externalSyncUpdate,
      status: newLocalStatus,
    })

    return {
      changed: true,
      newStatus: externalStatus,
      riskAssessed,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { changed: false, newStatus: null, error: `轮询异常: ${message}` }
  }
}

/**
 * 批量轮询项目中所有有外部同步的任务
 *
 * @param projectId 项目 ID
 * @param platform 目标平台
 * @param provider 状态查询 Provider
 * @param options 轮询选项
 * @returns 各任务轮询结果
 */
export async function pollAllExternalTasks(
  projectId: string,
  platform: 'feishu' | 'dingtalk',
  provider: ExternalTaskStatusProvider,
  options: PollOptions = {}
): Promise<PollResult[]> {
  const tasks = await listTasks(projectId)
  const syncedTasks = tasks
    .filter((task) => task.externalSync && task.externalSync[platform])
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))

  const results: PollResult[] = []

  for (const task of syncedTasks) {
    const result = await pollExternalTaskStatus(task, platform, provider, options)
    results.push(result)
  }

  return results
}

// ===== 定时轮询工具 =====

/**
 * 创建定时轮询器
 *
 * @param projectId 项目 ID
 * @param platform 目标平台
 * @param provider 状态查询 Provider
 * @param intervalMs 轮询间隔（毫秒）
 * @param options 轮询选项
 * @returns 停止函数
 */
export function createPollingTimer(
  projectId: string,
  platform: 'feishu' | 'dingtalk',
  provider: ExternalTaskStatusProvider,
  intervalMs: number = 30000,
  options: PollOptions = {}
): () => void {
  let stopped = false
  let isRunning = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const scheduleNext = () => {
    if (stopped) return
    timer = setTimeout(tick, intervalMs)
  }

  const tick = async () => {
    if (stopped || isRunning) return
    isRunning = true
    try {
      await pollAllExternalTasks(projectId, platform, provider, options)
    } catch (error) {
      console.error(`[ProjectPolling] 定时轮询失败:`, error)
    } finally {
      isRunning = false
      if (!stopped) {
        scheduleNext()
      }
    }
  }

  // 立即执行一次（使用 scheduleNext 保证链式执行）
  scheduleNext()

  // 返回停止函数
  return () => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
}

// ===== Provider 注册表 =====

const pollingProviders = new Map<string, ExternalTaskStatusProvider>()

/** 注册 Polling Provider */
export function registerPollingProvider(provider: ExternalTaskStatusProvider): void {
  pollingProviders.set(provider.name, provider)
  console.log(`[ProjectPolling] 已注册 ${provider.name} Polling Provider`)
}

/** 注销 Polling Provider */
export function unregisterPollingProvider(name: string): void {
  pollingProviders.delete(name)
}

/** 获取已注册的 Polling Provider */
export function getPollingProvider(platform: string): ExternalTaskStatusProvider | undefined {
  return pollingProviders.get(platform)
}
