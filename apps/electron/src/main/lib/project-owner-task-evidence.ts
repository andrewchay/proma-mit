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

/** 删除前先核对权威引用，不能先取消待决请求或移除会话索引。 */
export function assertOwnerSessionDeletionAllowed(sessionId: string): void {
  if (hasOwnerBusinessSessionEvidence(sessionId)) {
    throw new Error('该会话承载项目 Owner 的成果与执行证据，不能作为普通聊天删除；请保留记录并在项目中处理。')
  }
}
