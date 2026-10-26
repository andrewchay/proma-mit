import { decideOwnerConversationChange } from './project-owner-management-changes'
import { sendOwnerManagementMessage } from './project-owner-management-conversation'
function managementDelegation(): typeof import('./project-owner-management-delegation') { return require('./project-owner-management-delegation') as typeof import('./project-owner-management-delegation') }
import { setOwnerManagerStatus } from './project-owner-management-store'
import { requestOwnerManagementWake } from './project-owner-management-events'
import { getOwnerManagementConversation, answerOwnerManagementQuestion } from './project-owner-management-questions'
import { assertLocalActorEnabled } from './project-owner-plan-service'
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
  ipc.handle(PROJECT_IPC_CHANNELS.PREVIEW_OWNER_MANAGEMENT_DELEGATION, (_, request) => result(() => managementDelegation().previewOwnerManagementDelegation(request)))
  ipc.handle(PROJECT_IPC_CHANNELS.CONFIRM_OWNER_MANAGEMENT_DELEGATION, (_, request) => result(() => managementDelegation().confirmOwnerManagementDelegation(request)))
  ipc.handle(PROJECT_IPC_CHANNELS.GET_OWNER_MANAGEMENT_DELEGATION, (_, request) => result(() => {
    const value = requestFields(request, ['projectId', 'taskId'])
    const delegation = managementDelegation().getOwnerManagementDelegation(value.projectId as string, value.taskId as string | undefined)
    // 用户打开Owner对话时立即对账；例如资料指纹刚变更，不能等到后台轮询才说明已暂停。
    if (delegation.state === 'stale') requestOwnerManagementWake(value.projectId as string)
    return delegation
  }))
  ipc.handle(PROJECT_IPC_CHANNELS.REVOKE_OWNER_MANAGEMENT_DELEGATION, (_, request) => result(() => {
    const value = requestFields(request, ['projectId', 'delegationId'])
    if (typeof value.delegationId !== 'string' || !value.delegationId.trim()) throw new Error('管理委托身份无效')
    return managementDelegation().revokeOwnerManagementDelegation(value.projectId as string, value.delegationId)
  }))
  ipc.handle(PROJECT_IPC_CHANNELS.GET_OWNER_MANAGEMENT, (_, request) => result(() => {
    const value = requestFields(request, ['projectId'])
    return getOwnerManagementConversation(value.projectId as string)
  }))
  ipc.handle(PROJECT_IPC_CHANNELS.CONFIRM_OWNER_TEAM_WORKSPACE_ACCESS, (_, request) => result(() => {
    const access = require('./project-owner-team-workspace-access') as typeof import('./project-owner-team-workspace-access')
    return access.confirmOwnerTeamWorkspaceAccess(request)
  }))
  ipc.handle(PROJECT_IPC_CHANNELS.DECIDE_OWNER_CONVERSATION_CHANGE, (_, request) => result(() => decideOwnerConversationChange(request)))
  ipc.handle(PROJECT_IPC_CHANNELS.SEND_OWNER_MANAGEMENT_MESSAGE, (_, request) => result(() => sendOwnerManagementMessage(request)))
  ipc.handle(PROJECT_IPC_CHANNELS.ANSWER_OWNER_MANAGEMENT_QUESTION, (_, request) => result(() => answerOwnerManagementQuestion(request)))
  ipc.handle(PROJECT_IPC_CHANNELS.SET_OWNER_MANAGEMENT_STATUS, (_, request) => result(() => {
    const value = requestFields(request, ['projectId', 'expectedRevision', 'status'])
    assertLocalActorEnabled()
    if (typeof value.expectedRevision !== 'number' || (value.status !== 'active' && value.status !== 'paused')) throw new Error('Owner管理状态请求无效')
    return setOwnerManagerStatus(value.projectId as string, value.expectedRevision, value.status)
  }))

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
