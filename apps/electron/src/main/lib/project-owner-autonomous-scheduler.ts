import type { OwnerExecutionCommandRole, OwnerExecutionNextAction, OwnerTechnicalReviewVerdict, ProjectOwnerGoalSubject } from '@gravitas/shared'
import { dispatchAutonomousOwnerCommandExecution } from './project-owner-execution-dispatcher'
import { getOwnerExecutionRevalidation } from './project-owner-execution-revalidation'
import { getOwnerTaskMaterializationRecord } from './project-owner-task-materialization'
import { reserveAndQueueAutonomousOwnerCommand } from './project-owner-execution-command'
import { readOwnerGrantUsage } from './project-owner-execution-settlement'
import { getPilotPolicy } from './project-pilot-policy'
import { onProjectChainChange } from './project-chain-service'
import { onOwnerAutonomousScheduleWake, requestOwnerAutonomousScheduleWake } from './project-owner-autonomous-scheduler-events'
import { isCompletedStatus } from './task-status-logic'
import * as store from './project-sqlite-store'
import { listOwnerTechnicalReviewEvidence } from './project-owner-technical-review'

export type OwnerAutonomousScheduleState =
  | 'no_grant'
  | 'manual'
  | 'paused'
  | 'needs_reconcile'
  | 'expired'
  | 'archived'
  | 'stale'
  | 'ready'
  | 'running'
  | 'waiting'

export interface OwnerAutonomousScheduleStatus {
  projectId: string
  state: OwnerAutonomousScheduleState
  grantId?: string
  taskId?: string
  role?: OwnerExecutionCommandRole
  reservedCostMicros: number
  committedCostMicros: number
  runReservations: number
  reason: string
  reworkOrdinal?: number
  reviewVerdict?: OwnerTechnicalReviewVerdict
  reviewSummary?: string
  reviewFindings?: string[]
  nextAction?: OwnerExecutionNextAction
}
interface GrantRow {
  id: string
  project_id: string
  task_id: string | null
  dispatch_mode: string
  state: string
  revalidation_id: string
  revalidation_revision: number
  revalidation_integrity_hash: string
  materialization_id: string
  materialization_integrity_hash: string
  policy_revision: number
  expires_at: number
}
interface CommandRow {
  id: string
  state: string
  execution_id: string | null
  execution_status: string | null
  ack_fingerprint: string
  actual_cost_micros: number | null
  usage_evidence: string | null
}
type Action =
  | { kind: 'dispatch'; commandId: string; ackFingerprint: string; taskId: string; role: OwnerExecutionCommandRole }
  | { kind: 'queue'; subject: ProjectOwnerGoalSubject; input: { grantId: string; taskId: string; role: OwnerExecutionCommandRole; reworkOrdinal: number; expectedRevalidationRevision: number }; taskId: string; role: OwnerExecutionCommandRole }
interface Evaluation { status: OwnerAutonomousScheduleStatus; action?: Action }
function readTechnicalReview(projectId: string, grantId: string, taskId: string, stepLinkId: string, reworkOrdinal: number) {
  const reviews = listOwnerTechnicalReviewEvidence(projectId, taskId).filter(review =>
    review.grantId === grantId && review.stepLinkId === stepLinkId && review.reworkOrdinal === reworkOrdinal)
  if (reviews.length > 1) throw new Error(`同一Owner Task/返工轮次存在多条技术评审证据（${taskId}/${reworkOrdinal}）`)
  return reviews[0] ?? null
}
interface OwnerAutonomousSchedulerDriver {
  queue: typeof reserveAndQueueAutonomousOwnerCommand
  dispatch: typeof dispatchAutonomousOwnerCommandExecution
}
const defaultDriver: OwnerAutonomousSchedulerDriver = { queue: reserveAndQueueAutonomousOwnerCommand, dispatch: dispatchAutonomousOwnerCommandExecution }
const inFlight = new Map<string, Promise<OwnerAutonomousScheduleStatus>>()
let lifecycleStarted = false

function status(projectId: string, state: OwnerAutonomousScheduleState, reason: string, details: Partial<OwnerAutonomousScheduleStatus> = {}): OwnerAutonomousScheduleStatus {
  return { projectId, state, reservedCostMicros: 0, committedCostMicros: 0, runReservations: 0, reason, ...details }
}
function usageDetails(grantId: string): Pick<OwnerAutonomousScheduleStatus, 'reservedCostMicros' | 'committedCostMicros' | 'runReservations'> {
  const database = store.getProjectDb()
  const usage = readOwnerGrantUsage(grantId)
  const row = database.prepare(`SELECT COALESCE(SUM(CASE WHEN state IN ('queued','running','needs_reconcile') THEN reserved_cost_micros ELSE 0 END),0) AS reserved
    FROM project_owner_execution_commands WHERE grant_id=?`).get(grantId) as { reserved: number }
  return { reservedCostMicros: row.reserved, committedCostMicros: usage.committedCostMicros, runReservations: usage.runReservations }
}
function getRoleCommand(projectId: string, grantId: string, taskId: string, role: OwnerExecutionCommandRole, reworkOrdinal: number): CommandRow | null {
  const rows = store.getProjectDb().prepare(`SELECT c.id, c.state, c.execution_id, c.ack_fingerprint, c.actual_cost_micros, c.usage_evidence,
      e.status AS execution_status
    FROM project_owner_execution_commands c LEFT JOIN agent_executions e ON e.id=c.execution_id
    WHERE c.project_id=? AND c.grant_id=? AND c.source_task_id=? AND c.role=? AND c.rework_ordinal=? ORDER BY c.created_at`)
    .all(projectId, grantId, taskId, role, reworkOrdinal) as CommandRow[]
  if (rows.length > 1) throw new Error(`同一Owner Task/角色/返工轮次存在多条命令（${taskId}/${role}/${reworkOrdinal}），拒绝自动续派`)
  return rows[0] ?? null
}
function hasSuccessfulKnownSettlement(command: CommandRow | null): boolean {
  return Boolean(command && command.state === 'settled' && command.actual_cost_micros !== null && command.usage_evidence !== null && command.execution_status === 'completed')
}
function roleContinuation(command: CommandRow | null, projectId: string, grantId: string, taskId: string, role: OwnerExecutionCommandRole, reworkOrdinal: number, expectedRevision: number): Evaluation | 'complete' {
  const nextAction: OwnerExecutionNextAction = role === 'executor' ? (reworkOrdinal > 0 ? 'rework' : 'execute') : 'review'
  const details = { grantId, taskId, role, reworkOrdinal, nextAction, ...usageDetails(grantId) }
  if (!command) {
    return {
      status: status(projectId, 'ready', `等待自动安排${role === 'executor' ? 'Executor' : 'Reviewer'}（返工轮次 ${reworkOrdinal}）`, details),
      action: { kind: 'queue', subject: { projectId }, input: { grantId, taskId, role, reworkOrdinal, expectedRevalidationRevision: expectedRevision }, taskId, role },
    }
  }
  if (command.state === 'queued' && command.execution_id) {
    return {
      status: status(projectId, 'ready', `Owner ${role} 第 ${reworkOrdinal} 轮命令已排队，等待主进程启动`, details),
      action: { kind: 'dispatch', commandId: command.id, ackFingerprint: command.ack_fingerprint, taskId, role },
    }
  }
  if (command.state === 'running') return { status: status(projectId, 'running', `Owner ${role} 第 ${reworkOrdinal} 轮正在运行；不会并行启动下一角色`, details) }
  if (hasSuccessfulKnownSettlement(command)) return 'complete'
  if (command.state === 'needs_reconcile') return { status: status(projectId, 'needs_reconcile', `Owner ${role} 命令费用/停止状态需对账；预算保留，不自动重试`, details) }
  if (command.state === 'released' || command.state === 'cancelled') return { status: status(projectId, 'waiting', `Owner ${role} 命令已取消/释放；不自动重试`, details) }
  return { status: status(projectId, 'waiting', `Owner ${role} 未以已知费用和成功终态收敛（command=${command.state}, execution=${command.execution_status ?? 'none'}）；停止自动续派`, details) }
}
function evaluate(projectId: string, now = Date.now()): Evaluation {
  const grant = store.getProjectDb().prepare("SELECT * FROM project_owner_execution_grants WHERE project_id=? ORDER BY issued_at DESC LIMIT 1").get(projectId) as GrantRow | undefined
  if (!grant) return { status: status(projectId, 'no_grant', '当前无Owner执行授权') }
  const usage = usageDetails(grant.id), details = { grantId: grant.id, ...usage }
  if (grant.state === 'archived') return { status: status(projectId, 'archived', '授权已过期并归档；unknown占额保留，不派发或释放', details) }
  if (grant.dispatch_mode !== 'autonomous') return { status: status(projectId, 'manual', '此授权为人工逐条确认模式；自主调度未启用', details) }
  if (grant.state === 'needs_reconcile') return { status: status(projectId, 'needs_reconcile', '授权处于needs_reconcile；不创建命令或重试', details) }
  if (grant.state !== 'active') return { status: status(projectId, 'paused', '自主授权已暂停；不派发新命令', details) }
  if (grant.expires_at <= now) return { status: status(projectId, 'expired', '授权期限已过；不派发新命令', details) }
  const subject: ProjectOwnerGoalSubject = { projectId, ...(grant.task_id ? { taskId: grant.task_id } : {}) }
  const view = getOwnerExecutionRevalidation(subject)
  const record = view.revalidation
  const policy = getPilotPolicy(projectId)
  if (view.status !== 'current' || !record || record.id !== grant.revalidation_id || record.revision !== grant.revalidation_revision
    || record.integrityHash !== grant.revalidation_integrity_hash || record.source.materialization.id !== grant.materialization_id
    || record.source.materialization.integrityHash !== grant.materialization_integrity_hash || policy?.revision !== grant.policy_revision) {
    return { status: status(projectId, 'stale', `冻结来源或策略不再current（${view.status}）；撤权/重新验证前不续派`, details) }
  }
  const pendingCommand = store.getProjectDb().prepare("SELECT 1 FROM project_owner_execution_commands WHERE grant_id=? AND state IN ('reserved','queued','running') LIMIT 1").get(grant.id)
  const budgetExhausted = !pendingCommand && (usage.runReservations >= record.source.budget.maxRuns || usage.committedCostMicros >= record.source.budget.maxCostMicros)
  const batch = getOwnerTaskMaterializationRecord(projectId, record.source.materialization.id)
  if (batch.links.length !== record.source.tasks.length || record.source.tasks.some(task => !batch.links.some(link => link.taskId === task.taskId && link.id === task.linkId))) {
    return { status: status(projectId, 'stale', '冻结Task/步骤集合与材料化记录不一致；拒绝续派', details) }
  }
  const blockers = new Map(store.listTaskBlockers(projectId).map(item => [item.taskId, item.reason]))
  const taskStatuses = store.listTaskStatuses(projectId)
  let latestApproved: { taskId: string; reworkOrdinal: number; summary: string } | undefined
  let waitingReason = '冻结任务的技术评审尚未完成'
  for (const frozenTask of record.source.tasks) {
    const task = store.getTask(frozenTask.taskId)
    if (!task || task.projectId !== projectId || task.ownerStepLinkId !== frozenTask.linkId) return { status: status(projectId, 'stale', `冻结Task ${frozenTask.taskId} 缺失或步骤关联变化`, details) }
    if (isCompletedStatus(task.status, taskStatuses)) {
      const executor = getRoleCommand(projectId, grant.id, task.id, 'executor', 0)
      const reviewer = getRoleCommand(projectId, grant.id, task.id, 'reviewer', 0)
      if (!hasSuccessfulKnownSettlement(executor) || !hasSuccessfulKnownSettlement(reviewer)) {
        return { status: status(projectId, 'waiting', `Task ${task.id} 已完成，但缺少Executor/Reviewer成功与费用结算证据；不会自动补跑`, { ...details, taskId: task.id, nextAction: 'human_decision' }) }
      }
      continue
    }
    if (task.status !== 'paused') return { status: status(projectId, 'stale', `冻结Task ${task.id} 状态不再是暂停/完成终态`, details) }
    const blocker = blockers.get(task.id)
    if (blocker) {
      waitingReason = `等待权威依赖解除：${blocker}`
      return { status: status(projectId, 'waiting', waitingReason, { ...details, taskId: task.id, nextAction: 'human_decision', ...(latestApproved ? { reviewVerdict: 'approved', reworkOrdinal: latestApproved.reworkOrdinal, reviewSummary: latestApproved.summary } : {}) }) }
    }
    let approved = false
    for (let reworkOrdinal = 0; reworkOrdinal <= record.source.budget.maxRework; reworkOrdinal++) {
      const executor = getRoleCommand(projectId, grant.id, task.id, 'executor', reworkOrdinal)
      const executorProgress = roleContinuation(executor, projectId, grant.id, task.id, 'executor', reworkOrdinal, record.revision)
      if (executorProgress !== 'complete') {
        let progress = executorProgress
        if (reworkOrdinal > 0) {
          try {
            const previousReview = readTechnicalReview(projectId, grant.id, task.id, frozenTask.linkId, reworkOrdinal - 1)
            if (previousReview) progress = { ...executorProgress, status: { ...executorProgress.status, reviewVerdict: previousReview.verdict, reviewSummary: previousReview.summary, reviewFindings: previousReview.findings.slice(0, 8).map(finding => `${finding.severity}: ${finding.description} → ${finding.requestedChange}`) } }
          } catch (error) {
            return { status: status(projectId, 'stale', error instanceof Error ? error.message : '上一轮技术评审完整性错误；停止返工', { ...details, taskId: task.id, reworkOrdinal, nextAction: 'human_decision' }) }
          }
        }
        if (budgetExhausted && progress.action?.kind === 'queue') return { status: status(projectId, 'waiting', '授权费用或运行次数已耗尽；返工不派发，未自动增加额度', { ...progress.status, state: 'waiting', reason: '授权费用或运行次数已耗尽；返工不派发，未自动增加额度', nextAction: 'human_decision' }) }
        return progress
      }
      const reviewer = getRoleCommand(projectId, grant.id, task.id, 'reviewer', reworkOrdinal)
      const reviewerProgress = roleContinuation(reviewer, projectId, grant.id, task.id, 'reviewer', reworkOrdinal, record.revision)
      if (reviewerProgress !== 'complete') {
        if (budgetExhausted && reviewerProgress.action?.kind === 'queue') return { status: status(projectId, 'waiting', '授权费用或运行次数已耗尽；Reviewer 不派发，未自动增加额度', { ...reviewerProgress.status, state: 'waiting', reason: '授权费用或运行次数已耗尽；Reviewer 不派发，未自动增加额度', nextAction: 'human_decision' }) }
        return reviewerProgress
      }
      let review
      try { review = readTechnicalReview(projectId, grant.id, task.id, frozenTask.linkId, reworkOrdinal) }
      catch (error) { return { status: status(projectId, 'stale', error instanceof Error ? error.message : '技术评审证据完整性错误；停止续派', { ...details, taskId: task.id, reworkOrdinal, nextAction: 'human_decision' }) } }
      if (!review) return { status: status(projectId, 'waiting', `Reviewer 第 ${reworkOrdinal} 轮已结束，但缺少可核验的结构化技术评审；停止自动续派`, { ...details, taskId: task.id, role: 'reviewer', reworkOrdinal, nextAction: 'human_decision' }) }
      if (review.verdict === 'blocked') return { status: status(projectId, 'waiting', `Reviewer 报告卡点：${review.blockerReason ?? review.summary}；等待人工决策，未自动继续`, { ...details, taskId: task.id, role: 'reviewer', reworkOrdinal, reviewVerdict: 'blocked', reviewSummary: review.summary, nextAction: 'human_decision' }) }
      if (review.verdict === 'changes_requested') {
        if (reworkOrdinal >= record.source.budget.maxRework) return { status: status(projectId, 'waiting', `已达授权最大返工次数 ${record.source.budget.maxRework}；保留评审意见并等待人工决策`, { ...details, taskId: task.id, role: 'reviewer', reworkOrdinal, reviewVerdict: 'changes_requested', reviewSummary: review.summary, reviewFindings: review.findings.slice(0, 8).map(finding => `${finding.severity}: ${finding.description} → ${finding.requestedChange}`), nextAction: 'human_decision' }) }
        latestApproved = undefined
        continue
      }
      latestApproved = { taskId: task.id, reworkOrdinal, summary: review.summary }
      approved = true
      break
    }
    if (!approved) return { status: status(projectId, 'waiting', waitingReason, { ...details, taskId: task.id, nextAction: 'human_decision' }) }
  }
  return { status: status(projectId, 'waiting', '技术评审通过；业务Task仍未验收或完成，等待人类业务验收', { ...details, ...(latestApproved ? { taskId: latestApproved.taskId, reworkOrdinal: latestApproved.reworkOrdinal, reviewVerdict: 'approved', reviewSummary: latestApproved.summary } : {}), nextAction: 'await_business_acceptance' }) }
}
function markDispatchUncertain(commandId: string, projectId: string): void {
  const database = store.getProjectDb()
  const command = database.prepare('SELECT grant_id FROM project_owner_execution_commands WHERE id=? AND project_id=?').get(commandId, projectId) as { grant_id: string } | undefined
  if (!command) return
  database.transaction(() => {
    const now = Date.now()
    database.prepare("UPDATE project_owner_execution_commands SET state='needs_reconcile', updated_at=? WHERE id=? AND state IN ('queued','running')").run(now, commandId)
    database.prepare("UPDATE project_owner_execution_grants SET state='needs_reconcile' WHERE id=? AND project_id=? AND state='active'").run(command.grant_id, projectId)
  })()
}
export function getOwnerAutonomousScheduleStatus(projectId: string): OwnerAutonomousScheduleStatus {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('项目ID无效')
  return evaluate(projectId).status
}
export async function runOwnerAutonomousSchedule(projectId: string, driver: OwnerAutonomousSchedulerDriver = defaultDriver): Promise<OwnerAutonomousScheduleStatus> {
  const pending = inFlight.get(projectId)
  if (pending) return pending
  const task = (async () => {
    const evaluation = evaluate(projectId)
    if (!evaluation.action) return evaluation.status
    if (evaluation.action.kind === 'dispatch') {
      try {
        const result = await driver.dispatch({ commandId: evaluation.action.commandId, ackFingerprint: evaluation.action.ackFingerprint, acknowledgeExecution: true })
        if (!result.started) {
          const execution = store.getAgentExecution(result.executionId)
          if (execution?.status === 'queued') markDispatchUncertain(result.commandId, projectId)
        }
      } catch {
        markDispatchUncertain(evaluation.action.commandId, projectId)
      }
      return evaluate(projectId).status
    }
    let queued: ReturnType<typeof reserveAndQueueAutonomousOwnerCommand>
    try {
      queued = driver.queue(evaluation.action.subject, evaluation.action.input)
    } catch (error) {
      return status(projectId, 'waiting', error instanceof Error ? error.message : 'Owner自主命令预留失败', { grantId: evaluation.status.grantId, ...usageDetails(evaluation.status.grantId ?? '') })
    }
    try {
      const result = await driver.dispatch({ commandId: queued.commandId, ackFingerprint: queued.ackFingerprint, acknowledgeExecution: true })
      if (!result.started && store.getAgentExecution(result.executionId)?.status === 'queued') markDispatchUncertain(result.commandId, projectId)
    } catch {
      markDispatchUncertain(queued.commandId, projectId)
    }
    return evaluate(projectId).status
  })()
  inFlight.set(projectId, task)
  try { return await task }
  finally { if (inFlight.get(projectId) === task) inFlight.delete(projectId) }
}
export function startOwnerAutonomousScheduler(): void {
  if (lifecycleStarted) return
  const projects = store.listProjects()
  lifecycleStarted = true
  onOwnerAutonomousScheduleWake(projectId => { void runOwnerAutonomousSchedule(projectId).catch(error => console.error('[Owner Scheduler] 事件调度失败:', error)) })
  onProjectChainChange(requestOwnerAutonomousScheduleWake)
  for (const project of projects) requestOwnerAutonomousScheduleWake(project.id)
}
