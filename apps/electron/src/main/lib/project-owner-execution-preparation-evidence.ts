/** 附属来源用途只会收窄能力，绝不授予执行。与policy模块无循环依赖。 */
import { getProjectDb } from './project-sqlite-store'
export function hasOwnerExecutionPreparationEvidence(projectId: string): boolean {
  const database = getProjectDb()
  return Boolean(
    database.prepare('SELECT id FROM project_owner_execution_preparations WHERE project_id=? LIMIT 1').get(projectId)
    || database.prepare('SELECT id FROM project_owner_task_materializations WHERE project_id=? LIMIT 1').get(projectId)
    || database.prepare('SELECT id FROM project_owner_task_step_links WHERE project_id=? LIMIT 1').get(projectId)
    || database.prepare('SELECT id FROM tasks WHERE project_id=? AND owner_step_link_id IS NOT NULL LIMIT 1').get(projectId)
    || database.prepare(`SELECT r.session_id FROM project_owner_business_session_restrictions r LEFT JOIN tasks t ON t.id=r.task_id LEFT JOIN agent_executions e ON e.id=r.execution_id WHERE r.project_id=? OR t.project_id=? OR e.project_id=? LIMIT 1`).get(projectId,projectId,projectId)
  )
}
export function assertNoOwnerExecutionPreparation(projectId: string, reference?: unknown): void {
  if (reference !== undefined || hasOwnerExecutionPreparationEvidence(projectId))
    throw new Error('Owner执行准备尚未关联权威任务与发送门禁，不能发行或消费执行许可')
}
export function assertOwnerExecutionBoundaryIdle(projectId: string): void {
  const db = getProjectDb()
  if (
    db
      .prepare(
        "SELECT id FROM pilot_runtime_grants WHERE project_id = ? AND state = 'active' LIMIT 1",
      )
      .get(projectId) ||
    db
      .prepare(
        "SELECT id FROM pilot_commands WHERE project_id = ? AND state IN ('reserved','queued','running','needs_reconcile') LIMIT 1",
      )
      .get(projectId) ||
    db
      .prepare(
        "SELECT r.request_id FROM pilot_request_reservations r LEFT JOIN pilot_commands c ON c.id=r.command_id WHERE (c.project_id=? OR c.id IS NULL) AND r.state != 'settled' LIMIT 1",
      )
      .get(projectId) ||
    db
      .prepare(
        'SELECT 1 FROM pilot_stop_escalations WHERE project_id=? AND resolved_at IS NULL LIMIT 1',
      )
      .get(projectId)
  )
    throw new Error('项目存在活动授权、未决占额或停止对账，请先经原入口暂停和核查')
}
