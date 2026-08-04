/**
 * 项目外部平台自动同步 — Project Auto Sync
 *
 * 本地化替代原 NocoBase 插件 hook（workflow-automation）：
 * - 任务/子任务创建或草稿确认 → 自动推送到已配置的外部平台（飞书/钉钉）
 * - 任务状态更新 → 自动回写外部平台待办状态
 * - 失败写入本地 outbox，供重试入口消费
 *
 * 通过 project-service 的 onTaskChange 回调解耦，不侵入数据层。
 * 支持多平台并行：只要注册了对应 provider（飞书/钉钉）就同步。
 */

import { onTaskChange, type Task } from './project-service'
import { getTodoProvider, syncTaskToExternal, updateExternalTaskStatus } from './project-sync-service'
import { enqueueOutboxEvent } from './project-sqlite-store'
import type { TodoRetryEvent } from './project-types'

/** 已支持的外部平台 */
const PLATFORMS = ['dingtalk', 'feishu'] as const
type Platform = (typeof PLATFORMS)[number]

/** 注册自动同步（返回取消函数）。应用启动时调用一次。 */
export function registerProjectAutoSync(): () => void {
  const unsubscribe = onTaskChange((task, action) => {
    if (!task) return

    // 草稿创建不推送；确认后才推送，避免半成品进入同学待办
    if (action === 'created' && task.status === 'draft') return
    if (action === 'created' || action === 'draft_confirmed') {
      syncCreatedTask(task).catch((error) => {
        console.error('[ProjectAutoSync] 创建外部待办失败:', error)
      })
      // 核心任务：触发钉钉 brief 回执（仅钉钉）
      maybeCreateBrief(task).catch((error) => {
        console.error('[ProjectAutoSync] 创建 brief 回执失败:', error)
      })
      return
    }

    if (action === 'updated') {
      // 改派给 AI 员工：无进行中执行时才幂等派发（避免重复 execution），否则仍回写外部状态
      import('./agent-employee-service').then(({ isAgentAssignee, dispatchTaskToAgentIfIdle }) => {
        if (!isAgentAssignee(task)) {
          syncUpdatedTaskStatus(task).catch((error) => {
            console.error('[ProjectAutoSync] 回写外部状态失败:', error)
          })
          return
        }
        dispatchTaskToAgentIfIdle(task).catch((error) => {
          enqueueOutboxEvent({
            projectId: task.projectId,
            entityType: 'task',
            entityId: task.id,
            eventType: 'agent.dispatch' as TodoRetryEvent['eventType'],
            errorMessage: `[agent] ${error instanceof Error ? error.message : String(error)}`,
          })
        })
      }).catch((error) => {
        console.error('[ProjectAutoSync] 加载 agent 派发模块失败:', error)
      })
    }
  })

  return unsubscribe
}

/** 任务创建/确认：按指派类型分流（AI 员工 → agent；真人 → 飞书/钉钉） */
async function syncCreatedTask(task: Task): Promise<void> {
  // 指派给 AI 员工：走 AgentTodoProvider（headless 执行），不推到外部待办
  const { isAgentAssignee, dispatchTaskToAgent } = await import('./agent-employee-service')
  if (isAgentAssignee(task)) {
    try {
      await dispatchTaskToAgent(task)
    } catch (error) {
      enqueueOutboxEvent({
        projectId: task.projectId,
        entityType: 'task',
        entityId: task.id,
        eventType: 'agent.dispatch' as TodoRetryEvent['eventType'],
        errorMessage: `[agent] ${error instanceof Error ? error.message : String(error)}`,
      })
    }
    return
  }

  for (const platform of PLATFORMS) {
    const provider = getTodoProvider(platform)
    if (!provider) continue
    try {
      const result = await syncTaskToExternal(task, platform, provider)
      if (!result.success) {
        enqueueOutboxEvent({
          projectId: task.projectId,
          entityType: 'task',
          entityId: task.id,
          eventType: `${platform}.create_todo` as TodoRetryEvent['eventType'],
          errorMessage: `[${platform}] ${result.error ?? '外部待办创建失败'}`,
        })
      }
    } catch (error) {
      enqueueOutboxEvent({
        projectId: task.projectId,
        entityType: 'task',
        entityId: task.id,
        eventType: `${platform}.create_todo` as TodoRetryEvent['eventType'],
        errorMessage: `[${platform}] ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
}

/** 任务更新：回写已同步平台的待办状态 */
async function syncUpdatedTaskStatus(task: Task): Promise<void> {
  for (const platform of PLATFORMS) {
    const provider = getTodoProvider(platform)
    const external = task.externalSync?.[platform]
    if (!provider || !external?.taskId) continue
    try {
      const ok = await updateExternalTaskStatus(external.taskId, task.status, provider, {
        unionId: (external as { unionId?: string }).unionId,
      })
      if (!ok) {
        enqueueOutboxEvent({
          projectId: task.projectId,
          entityType: 'task',
          entityId: task.id,
          eventType: `${platform}.update_todo_status` as TodoRetryEvent['eventType'],
          errorMessage: `[${platform}] 状态回写失败（待重试）`,
        })
      }
    } catch (error) {
      enqueueOutboxEvent({
        projectId: task.projectId,
        entityType: 'task',
        entityId: task.id,
        eventType: `${platform}.update_todo_status` as TodoRetryEvent['eventType'],
        errorMessage: `[${platform}] ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
}

/** 重试一条 outbox 事件：重新执行对应的同步动作 */
export async function retryOutboxEvent(eventId: string): Promise<boolean> {
  const { getOutboxEvent, markOutboxEvent } = await import('./project-sqlite-store')
  const event = getOutboxEvent(eventId)
  if (!event) return false

  markOutboxEvent(eventId, 'processing')
  try {
    if (event.eventType.endsWith('create_todo')) {
      const { getTask } = await import('./project-service')
      const task = await getTask(event.entityId)
      if (!task) throw new Error('任务不存在，无法重试')
      await syncCreatedTask(task)
    } else {
      const { getTask } = await import('./project-service')
      const task = await getTask(event.entityId)
      if (!task) throw new Error('任务不存在，无法重试')
      await syncUpdatedTaskStatus(task)
    }
    markOutboxEvent(eventId, 'completed')
    return true
  } catch (error) {
    markOutboxEvent(eventId, 'failed', error instanceof Error ? error.message : String(error))
    return false
  }
}

async function maybeCreateBrief(task: Task): Promise<void> {
  const { isCoreTask, createBriefForTask } = await import('./brief-service')
  if (!isCoreTask(task)) return
  const { getBriefCallbackBaseUrl } = await import('./brief-callback-server')
  const baseUrl = getBriefCallbackBaseUrl()
  await createBriefForTask(task, undefined, baseUrl)
}
