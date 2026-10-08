import { PROJECT_IPC_CHANNELS, type ProjectOwnerGoalResult } from '@gravitas/shared'
import { getProjectOwnerGoalDraft, ProjectOwnerGoalConflictError, saveProjectOwnerGoalDraft } from './project-owner-goal-service'

interface GoalIpcRegistrar {
  handle: (channel: string, handler: (event: unknown, request: unknown) => unknown) => void
}

function requestFields(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new Error('目标草案请求必须是 JSON 对象')
  }
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error('目标草案请求含有未知字段')
  const value = input as Record<string, unknown>
  if (typeof value.projectId !== 'string' || !value.projectId.trim()
    || (value.taskId !== undefined && (typeof value.taskId !== 'string' || !value.taskId.trim()))) {
    throw new Error('目标草案项目或任务身份无效')
  }
  return value
}

function result<T>(operation: () => T): ProjectOwnerGoalResult<T> {
  try { return { ok: true, value: operation() } }
  catch (cause) {
    return { ok: false, error: {
      code: cause instanceof ProjectOwnerGoalConflictError ? 'conflict' : 'failed',
      message: cause instanceof Error ? cause.message : '目标草案操作失败',
    } }
  }
}

/** 仅供应用 IPC；无运行工具注册，不调用模型、任务/派发或授权服务。 */
export function registerProjectOwnerGoalIpcHandlers(ipc: GoalIpcRegistrar): void {
  ipc.handle(PROJECT_IPC_CHANNELS.GET_OWNER_GOAL_DRAFT, (_, request) => result(() => {
    const value = requestFields(request, ['projectId', 'taskId'])
    return getProjectOwnerGoalDraft(value.projectId as string, value.taskId as string | undefined)
  }))
  ipc.handle(PROJECT_IPC_CHANNELS.SAVE_OWNER_GOAL_DRAFT, (_, request) => result(() => {
    const value = requestFields(request, ['projectId', 'taskId', 'expectedRevision', 'input'])
    if (typeof value.expectedRevision !== 'number') throw new Error('目标草案修订版本无效')
    return saveProjectOwnerGoalDraft(value.projectId as string, value.expectedRevision, value.input, value.taskId as string | undefined)
  }))
}
