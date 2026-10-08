/** 无费用Owner计划IPC。不是模型运行/派发工具，操作人固定由主进程确定。 */
import { PROJECT_IPC_CHANNELS, type ProjectOwnerGoalResult } from '@gravitas/shared'
import {
  confirmProjectOwnerPlanDraft, getProjectOwnerPlanDraft, getProjectOwnerPlanningContext,
  listProjectOwnerPlanHistory, ProjectOwnerPlanConflictError, saveProjectOwnerPlanDraft,
} from './project-owner-plan-service'

interface PlanIpcRegistrar {
  handle: (channel: string, handler: (event: unknown, request: unknown) => unknown) => void
}
function requestFields(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) throw new Error('Owner 计划请求必须是 JSON 对象')
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error('Owner 计划请求含有未知字段')
  const value = input as Record<string, unknown>
  if (typeof value.projectId !== 'string' || !value.projectId.trim()
    || (value.taskId !== undefined && (typeof value.taskId !== 'string' || !value.taskId.trim()))) throw new Error('Owner 计划项目或任务身份无效')
  return value
}
function result<T>(operation: () => T): ProjectOwnerGoalResult<T> {
  try { return { ok: true, value: operation() } }
  catch (cause) { return { ok: false, error: {
    code: cause instanceof ProjectOwnerPlanConflictError ? 'conflict' : 'failed',
    message: cause instanceof Error ? cause.message : 'Owner 计划操作失败',
  } } }
}
export function registerProjectOwnerPlanIpcHandlers(ipc: PlanIpcRegistrar): void {
  const readOperations = [
    [PROJECT_IPC_CHANNELS.GET_OWNER_PLANNING_CONTEXT, getProjectOwnerPlanningContext],
    [PROJECT_IPC_CHANNELS.GET_OWNER_PLAN_DRAFT, getProjectOwnerPlanDraft],
    [PROJECT_IPC_CHANNELS.LIST_OWNER_PLAN_HISTORY, listProjectOwnerPlanHistory],
  ] as const
  for (const [channel, operation] of readOperations) {
    ipc.handle(channel, (_, request) => result(() => {
      const value = requestFields(request, ['projectId', 'taskId'])
      return operation(value.projectId as string, value.taskId as string | undefined)
    }))
  }
  ipc.handle(PROJECT_IPC_CHANNELS.SAVE_OWNER_PLAN_DRAFT, (_, request) => result(() => {
    const value = requestFields(request, ['projectId', 'taskId', 'expectedGoalRevision', 'expectedRevision', 'input'])
    if (typeof value.expectedGoalRevision !== 'number' || typeof value.expectedRevision !== 'number') throw new Error('Owner 计划修订参数无效')
    return saveProjectOwnerPlanDraft(value.projectId as string, value.expectedGoalRevision, value.expectedRevision, value.input, value.taskId as string | undefined)
  }))
  ipc.handle(PROJECT_IPC_CHANNELS.CONFIRM_OWNER_PLAN_DRAFT, (_, request) => result(() => {
    const value = requestFields(request, ['projectId', 'taskId', 'expectedGoalRevision', 'expectedRevision'])
    if (typeof value.expectedGoalRevision !== 'number' || typeof value.expectedRevision !== 'number') throw new Error('Owner 计划修订参数无效')
    return confirmProjectOwnerPlanDraft(value.projectId as string, value.expectedGoalRevision, value.expectedRevision, value.taskId as string | undefined)
  }))
}
