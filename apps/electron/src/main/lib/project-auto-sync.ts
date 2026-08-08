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
import { getTodoProvider, syncTaskToExternal } from './project-sync-service'
import { enqueueOutboxEvent } from './project-sqlite-store'
import { recordTodoEvent } from './todo-event-service'
import type { TodoRetryEvent } from './project-types'

/** 已支持的外部平台 */
const PLATFORMS = ['dingtalk', 'feishu'] as const
type Platform = (typeof PLATFORMS)[number]

/** 注册自动同步（返回取消函数）。应用启动时调用一次。 */
export function registerProjectAutoSync(): () => void {
  const unsubscribe = onTaskChange((task, action) => {
    // PH2-A：Todo 事件流（团队可订阅语义流）
    recordTaskTodoEvent(task, action)

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

  // PH1-A：定时增量同步通讯录成员（启动 + 每 6 小时，带冷却与并发保护，幂等）
  const memberSyncTimer = setInterval(() => {
    void runPeriodicMemberSync()
  }, MEMBER_SYNC_INTERVAL_MS)
  void runPeriodicMemberSync()

  function cleanup(): void {
    clearInterval(memberSyncTimer)
    unsubscribe()
  }
  return cleanup
}

const MEMBER_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 小时

/** 定时成员同步：只同步已配置平台（有 Bot 凭证才拉），冷却期内自动跳过。 */
async function runPeriodicMemberSync(): Promise<void> {
  for (const platform of ['feishu', 'dingtalk'] as const) {
    try {
      // 调用带冷却/并发保护的入口；凭证缺失时 syncPlatform 内部抛错并忽略
      const { syncMembersIfCooldownElapsed } = await import('./member-sync-service')
      const result = await syncMembersIfCooldownElapsed(platform)
      if (result) {
        console.log(`[ProjectAutoSync] 通讯录成员增量同步 ${platform}: 拉取 ${result.pulled} 新增 ${result.inserted} 合并 ${result.merged} 失败 ${result.failed}`)
      }
    } catch (error) {
      // 未配置 Bot / 网络失败：静默，避免启动噪音
      console.debug(`[ProjectAutoSync] ${platform} 成员同步跳过:`, error instanceof Error ? error.message : error)
    }
  }
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
      // 直接调用 provider，让具体错误（含授权链接）能透传到 outbox 供用户查看
      const ok = await provider.updateTodoStatus(external.taskId, task.status, {
        unionId: (external as { unionId?: string }).unionId,
      })
      // PH2 修复：编辑任务改截止日期后，同步更新飞书 Todo 的 due（provider 支持时，保持 this 绑定）
      const providerWithDue = provider as unknown as { updateTodoDue?: (...args: [string, number]) => Promise<boolean> }
      if (task.dueDate && typeof providerWithDue.updateTodoDue === 'function') {
        await providerWithDue.updateTodoDue(external.taskId, task.dueDate)
      }
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
    // 若任务/子任务已不存在 → 该 outbox 事件已孤儿，直接丢弃（不再反复重试"任务不存在"）
    const { getTask } = await import('./project-service')
    const task = await getTask(event.entityId)
    if (!task) {
      markOutboxEvent(eventId, 'completed')
      console.log(`[Diag][outbox] 实体已不存在，清除孤儿重试 ${entryDesc(event)}`)
      return true
    }
    if (event.eventType.endsWith('create_todo')) {
      await syncCreatedTask(task)
    } else {
      await syncUpdatedTaskStatus(task)
    }
    markOutboxEvent(eventId, 'completed')
    return true
  } catch (error) {
    markOutboxEvent(eventId, 'failed', error instanceof Error ? error.message : String(error))
    return false
  }
}

function entryDesc(event: { entityType?: string; entityId: string; eventType: string }): string {
  return `[${event.entityType ?? 'entity'}#${event.entityId.slice(0, 8)} ${event.eventType}]`
}

async function maybeCreateBrief(task: Task): Promise<void> {
  const { isCoreTask, createBriefForTask } = await import('./brief-service')
  if (!isCoreTask(task)) return
  const { getBriefCallbackBaseUrl } = await import('./brief-callback-server')
  const baseUrl = getBriefCallbackBaseUrl()
  await createBriefForTask(task, undefined, baseUrl)
}

/** 把项目管理任务(Todo)生命周期映射为语义事件，写入 todo-events 流（PH2-A）。 */
function recordTaskTodoEvent(task: Task | null, action: Parameters<Parameters<typeof onTaskChange>[0]>[1]): void {
  if (!task) return
  const memberId = task.assignee?.userId
  // 由 assignee 推断动作语义：updated 且已完成 → completed；改派 → assigned；删除 → deleted
  let action_: import('./todo-event-service').TodoEventAction
  if (action === 'created' || action === 'draft_confirmed') action_ = 'created'
  else if (action === 'deleted') action_ = 'deleted'
  else if (task.status === 'completed') action_ = 'completed'
  else if (task.assignee?.userId) action_ = 'assigned'
  else action_ = 'updated'

  recordTodoEvent({
    source: 'project',
    action: action_,
    todoId: task.id,
    title: task.title,
    status: task.status,
    memberId,
    assigneeName: task.assignee?.displayName,
    projectId: task.projectId,
    dueAt: task.dueDate,
  })
}
