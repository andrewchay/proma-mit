/** Owner业务用途的负向限制；无证据仅继续原门禁，永不等于执行许可。 */
import {
  getProjectDb,
  hasOwnerBusinessExecutionEvidence,
  hasOwnerBusinessTaskEvidence,
  preserveOwnerBusinessSessionEvidence,
} from './project-sqlite-store'

export { hasOwnerBusinessExecutionEvidence, hasOwnerBusinessTaskEvidence }

export function assertNoOwnerBusinessTask(taskId: string): void {
  if (hasOwnerBusinessTaskEvidence(taskId)) {
    throw new Error('Owner业务任务仅暂停落地，执行许可与资料门禁尚未开放')
  }
}

export function assertNoOwnerBusinessExecution(executionId: string): void {
  if (hasOwnerBusinessExecutionEvidence(executionId)) {
    throw new Error('Owner业务执行用途受限，不能借旧排队或费用确认启动')
  }
}

export function hasOwnerBusinessSessionEvidence(sessionId: string): boolean {
  const database = getProjectDb()
  if (database.prepare('SELECT session_id FROM project_owner_business_session_restrictions WHERE session_id = ? LIMIT 1').get(sessionId)) return true
  const executions = database.prepare('SELECT id FROM agent_executions WHERE session_id = ?').all(sessionId) as Array<{ id: string }>
  return executions.some(execution => hasOwnerBusinessExecutionEvidence(execution.id))
}

export function assertNoOwnerBusinessSession(sessionId: string): void {
  if (hasOwnerBusinessSessionEvidence(sessionId)) {
    preserveOwnerBusinessSessionEvidence(sessionId)
    throw new Error('Owner业务会话用途受限，不能调用模型或继续工具执行')
  }
}
