/** 业务事实唤醒Owner；只准备受控管理分析，不发行员工许可、不自动重试业务请求。 */
import type { OwnerExecutionObservation } from '@gravitas/shared'
import { ownerExecutionHash } from './project-owner-execution-hash'
import { readOwnerCommandRuntime, readOwnerCommandFrozenSource } from './project-owner-employee-runtime'
import { getProjectOwnerGoalDraft } from './project-owner-goal-service'
import { getProjectOwnerPlanDraft } from './project-owner-plan-service'
import { getOwnerManager, recordOwnerManagementObservation } from './project-owner-management-store'
import { listOwnerTechnicalReviewEvidence } from './project-owner-technical-review'
import * as store from './project-sqlite-store'
import { getOwnerQualityRecovery, readOwnerQualityAction } from './project-owner-quality-actions'

export const OWNER_EXECUTION_STALL_MS = 15 * 60_000
interface ObservationCommand {
  id: string; project_id: string; grant_id: string; source_task_id: string; role: 'executor' | 'reviewer'
  state: string; actual_cost_micros: number | null; reserved_cost_micros: number; grant_state: string
  grant_task_id: string | null; expires_at: number; dispatch_mode: string
  source_plan_revision: number
}
export function readOwnerExecutionObservation(projectId: string, executionId: string, trigger: OwnerExecutionObservation['trigger'], now = Date.now()): { taskId?: string; observation: OwnerExecutionObservation } {
  const execution = store.getAgentExecution(executionId)
  const command = execution?.ownerCommandId ? store.getProjectDb().prepare(`SELECT c.*, g.state AS grant_state, g.task_id AS grant_task_id, g.expires_at, g.dispatch_mode, json_extract(r.payload, '$.source.planRevision') AS source_plan_revision
    FROM project_owner_execution_commands c JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
    JOIN project_owner_execution_revalidations r ON r.id=g.revalidation_id AND r.project_id=g.project_id
    WHERE c.id=? AND c.project_id=? AND c.execution_id=?`).get(execution.ownerCommandId, projectId, executionId) as ObservationCommand | undefined : undefined
  if (!execution || execution.projectId !== projectId || !command || command.dispatch_mode !== 'autonomous' || execution.entityType !== 'task' || execution.entityId !== command.source_task_id || !['executor', 'reviewer'].includes(command.role)) throw new Error('Owner执行观察缺少准确业务归属')
  readOwnerCommandRuntime(command.id)
  const terminal = ['completed', 'failed', 'cancelled', 'stale'].includes(execution.status)
  if (trigger === 'terminal' ? !terminal : trigger === 'stalled' ? execution.status !== 'running' || now - (execution.lastHeartbeatAt ?? execution.startedAt) < OWNER_EXECUTION_STALL_MS : trigger !== 'expired' || command.expires_at > now || terminal) throw new Error('Owner执行观察条件已经变化')
  const task = store.getTask(command.source_task_id)
  if (!task || task.projectId !== projectId) throw new Error('Owner执行观察任务缺失')
  const review = command.role === 'reviewer' ? listOwnerTechnicalReviewEvidence(projectId, task.id).find(item => item.reviewerCommandId === command.id && item.reviewerExecutionId === execution.id) : undefined
  return { ...(command.grant_task_id ? { taskId: command.grant_task_id } : {}), observation: {
    executionId, commandId: command.id, grantId: command.grant_id, sourcePlanRevision: command.source_plan_revision, businessTaskId: task.id, taskTitle: task.title.slice(0, 1000), role: command.role, trigger,
    ...(trigger === 'terminal' ? {} : { conditionTimestamp: trigger === 'stalled' ? execution.lastHeartbeatAt ?? execution.startedAt : command.expires_at }),
    executionStatus: execution.status, commandState: command.state, grantState: command.grant_state,
    ...(execution.completedAt === undefined ? {} : { completedAt: execution.completedAt }), resultSummary: (execution.resultSummary ?? '').slice(0, 16000), error: (execution.error ?? '').slice(0, 2000),
    actualCostMicros: command.actual_cost_micros, reservedCostMicros: command.reserved_cost_micros,
    requestsSent: (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations WHERE command_id=?').get(command.id) as { count: number }).count,
    ...(review ? { review: { verdict: review.verdict, summary: review.summary.slice(0, 2000), findings: review.findings.slice(0, 8).map(item => `${item.severity}: ${item.description} → ${item.requestedChange}`.slice(0, 1000)) } } : {}),
  } }
}
/** 启动补偿与定时检查复用同一事实身份；无变化不会增加事件或模型请求。 */
export function scanOwnerExecutionObservations(projectId: string, now = Date.now()): void {
  if (getOwnerManager(projectId)?.status !== 'active' || store.getProjectDb().isTransactionActive()) return
  const rows = store.getProjectDb().prepare(`SELECT e.id FROM agent_executions e JOIN project_owner_execution_commands c ON c.execution_id=e.id AND c.id=e.owner_command_id
    JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
    WHERE e.project_id=? AND g.dispatch_mode='autonomous'
    AND e.status IN ('completed','failed','cancelled','stale','running','queued') ORDER BY e.started_at DESC`).all(projectId) as { id: string }[]
  for (const row of rows) {
    for (const trigger of ['terminal', 'expired', 'stalled'] as const) {
      try {
        const source = readOwnerExecutionObservation(projectId, row.id, trigger, now), goal = getProjectOwnerGoalDraft(projectId, source.taskId)
        if (!goal) break
        const frozen = readOwnerCommandFrozenSource(source.observation.commandId).source
        const preparation = store.getProjectDb().prepare('SELECT json_extract(payload,\'$.source.goalRevision\') AS goal_revision FROM project_owner_execution_preparations WHERE id=?').get(frozen.originalPreparation.id) as { goal_revision: number } | undefined
        const plan = getProjectOwnerPlanDraft(projectId, source.taskId)
        if (preparation?.goal_revision !== goal.revision || !plan || plan.revision !== frozen.planRevision) break
        // 正常完成的员工交给独立Reviewer；此时Owner没有待决策事项，不额外调用模型总结进度。
        if (frozen.qualityManagementVersion === 1 && source.observation.role === 'executor' && source.observation.executionStatus === 'completed') break
        recordOwnerManagementObservation(projectId, goal.revision, source.observation, source.taskId, ownerExecutionHash(source.observation))
        break
      } catch { /* 该触发不适用或来源不可核验；不生成模型请求。 */ }
    }
  }
  scanBlockedQualityRecoveries(projectId, now)
}

/** 阻断后只有权威质量门槛变化才追加新观察；旧请求、决定和未知费用均不重放。 */
function scanBlockedQualityRecoveries(projectId: string, now: number): void {
  if (getOwnerManager(projectId)?.status !== 'active' || store.getProjectDb().isTransactionActive()) return
  const rows = store.getProjectDb().prepare("SELECT DISTINCT reviewer_command_id FROM project_owner_quality_actions WHERE project_id=? ORDER BY created_at").all(projectId) as { reviewer_command_id: string }[]
  for (const row of rows) {
    try {
      const action = readOwnerQualityAction(row.reviewer_command_id)
      const recovery = action?.state === 'blocked' ? getOwnerQualityRecovery(projectId, row.reviewer_command_id) : null
      if (!action || !recovery) continue
      const reviewerCommand = store.getProjectDb().prepare('SELECT execution_id FROM project_owner_execution_commands WHERE id=? AND project_id=?').get(action.reviewerCommandId, projectId) as { execution_id: string } | undefined
      const businessExecutionId = reviewerCommand?.execution_id
      if (!businessExecutionId) continue
      const current = readOwnerExecutionObservation(projectId, businessExecutionId, 'terminal', now)
      const goal = getProjectOwnerGoalDraft(projectId, current.taskId)
      if (!goal || current.observation.role !== 'reviewer') continue
      const observationHash = ownerExecutionHash({ observation: current.observation, recovery })
      const eventId = `execution-observation:${projectId}:${goal.revision}:${observationHash}`
      if (store.getProjectDb().prepare('SELECT 1 FROM project_owner_management_messages WHERE project_id=? AND event_id=? LIMIT 1').get(projectId, eventId)) continue
      recordOwnerManagementObservation(projectId, goal.revision, current.observation, current.taskId, observationHash)
    } catch {
      // 来源缺失、费用未知或恢复上下文不可核验时，保留原阻断，不制造新请求。
    }
  }
}
