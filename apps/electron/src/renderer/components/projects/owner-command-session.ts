import type { AgentExecutionResult, AgentSessionMeta, OwnerExecutionCommandView } from '@gravitas/shared'

/** 只从精确命令执行定位会话；不按同Task的“最近会话”猜测，也不启动或重试执行。 */
export function resolveOwnerCommandSession(
  projectId: string,
  command: Pick<OwnerExecutionCommandView, 'executionId' | 'taskId' | 'employeeId'>,
  executions: Pick<AgentExecutionResult, 'id' | 'projectId' | 'entityType' | 'entityId' | 'agentId' | 'sessionId'>[],
  sessions: Pick<AgentSessionMeta, 'id' | 'projectId' | 'workspaceId' | 'title'>[],
): Pick<AgentSessionMeta, 'id' | 'projectId' | 'workspaceId' | 'title'> {
  const execution = executions.find(item => item.id === command.executionId)
  if (!execution || execution.projectId !== projectId || execution.entityType !== 'task' || execution.entityId !== command.taskId
    || execution.agentId !== command.employeeId || !execution.sessionId.trim() || execution.sessionId.startsWith('workflow:'))
    throw new Error('命令对应的执行会话尚不可用，请刷新后核对')
  const session = sessions.find(item => item.id === execution.sessionId && item.projectId === projectId)
  if (!session) throw new Error('命令会话与项目来源不匹配，不打开其他会话')
  return session
}
