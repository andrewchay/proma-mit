/** 只消费真实Owner回执的质量决定。实际动作与审计同事务；不伪装人工签收。 */
import type { OwnerQualityDecision } from '@gravitas/shared'
import * as store from './project-sqlite-store'
import { ownerExecutionHash } from './project-owner-execution-hash'
import { getOwnerManager } from './project-owner-management-store'
import { assertOwnerManagementTask, getOwnerManagementDelegation } from './project-owner-management-delegation'
import { assertOwnerReviewerTextDelivery } from './project-owner-text-delivery'
import { listOwnerTechnicalReviewEvidence } from './project-owner-technical-review'
import { getOwnerExecutionRevalidation } from './project-owner-execution-revalidation'
import { ownerTaskDeliveryKind, readOwnerCommandFrozenSource } from './project-owner-employee-runtime'
import { resolveOwnerPlanningTask, readOwnerPlanningSnapshot } from './project-owner-planning-source'
import { getPilotPolicy } from './project-pilot-policy'
import { readOwnerGrantUsage } from './project-owner-execution-settlement'
import { requestOwnerAutonomousScheduleWake } from './project-owner-autonomous-scheduler-events'
import { matchesOwnerExactTextInsertion } from './project-owner-delivery-content'
import { isOwnerCounterSupplementCurrent, readOwnerCounterSupplement } from './project-owner-counter-supplement'
import { OWNER_COUNTER_SUPPLEMENT_COMMAND } from './development-validation-service'
import { isCompletedStatus } from './task-status-logic'
import { isOwnerEvidenceGapRework, OWNER_ACCEPT_WITH_FINDINGS, parseOwnerQualityDecision } from './project-owner-quality-protocol'

export interface OwnerQualityAction {
  ownerExecutionId: string; ownerReceiptId: string; actor: string; projectId: string; grantId: string; taskId: string
  reviewerCommandId: string; artifactHash: string; reworkOrdinal: number; decision: OwnerQualityDecision
  state: 'accepted' | 'rework_authorized' | 'escalated' | 'blocked'; detail: string; conditionFingerprint?: string; createdAt: number
  recoveredFromOwnerExecutionId?: string
  enforcedConstraint?: 'exact_text_insertion'
}
function runs() { return require('./project-owner-planning-run-service') as typeof import('./project-owner-planning-run-service') }
function managementTaskId(ownerExecutionId: string): string | undefined {
  const outcome = runs().getOwnerPlanningRunOutcome(ownerExecutionId)
  const receipt = outcome ? runs().getOwnerPlanningRunReceipt(outcome.receiptId) : null
  return receipt ? readOwnerPlanningSnapshot(receipt.planningTaskId)?.link.targetTaskId : undefined
}
interface OwnerQualityActionRow { reviewer_command_id: string; owner_execution_id: string; project_id: string; grant_id: string; task_id: string; payload: string; integrity_hash: string; created_at: number }
export interface OwnerQualityArtifact { contentHash: string; content: string; projectId: string; grantId: string; taskId: string; stepLinkId: string; sourceHash: string; planRevision: number; reworkOrdinal: number }
export function readOwnerQualityArtifact(reviewerCommandId: string): OwnerQualityArtifact | null {
  const { source, taskId } = readOwnerCommandFrozenSource(reviewerCommandId)
  if (ownerTaskDeliveryKind(source, taskId) === 'development') {
    const review = listOwnerTechnicalReviewEvidence(source.projectId).find(item => item.reviewerCommandId === reviewerCommandId && item.artifactVerified === true)
    const artifact = review?.developmentArtifact
    if (!review || !artifact || artifact.executorCommandId !== review.executorCommandId || artifact.executorExecutionId !== review.executorExecutionId
      || artifact.contentHash !== review.artifactHash || !review.validationEvidenceVerified) return null
    return { contentHash: artifact.contentHash, content: artifact.content, projectId: artifact.projectId, grantId: artifact.grantId,
      taskId: artifact.taskId, stepLinkId: artifact.stepLinkId, sourceHash: artifact.sourceHash, planRevision: artifact.planRevision, reworkOrdinal: artifact.reworkOrdinal }
  }
  const artifact = assertOwnerReviewerTextDelivery(reviewerCommandId)
  return artifact ? { contentHash: artifact.contentSha256, content: artifact.content, projectId: artifact.projectId, grantId: artifact.grantId,
    taskId: artifact.taskId, stepLinkId: artifact.stepLinkId, sourceHash: artifact.sourceHash, planRevision: artifact.planRevision, reworkOrdinal: artifact.reworkOrdinal } : null
}
function parseActionRow(row: OwnerQualityActionRow): OwnerQualityAction {
  const value = JSON.parse(row.payload) as OwnerQualityAction
  const outcome = runs().getOwnerPlanningRunOutcome(value.ownerExecutionId), receipt = outcome ? runs().getOwnerPlanningRunReceipt(outcome.receiptId) : null
  const original = receipt ? readOwnerPlanningSnapshot(receipt.planningTaskId)?.context.conversation : undefined
  const observation = original?.executionObservation, artifact = original?.deliveryReview?.artifact, developmentArtifact = original?.deliveryReview?.developmentArtifact
  if (!outcome?.qualityDecision || ownerExecutionHash(value) !== row.integrity_hash || value.reviewerCommandId !== row.reviewer_command_id || value.ownerExecutionId !== row.owner_execution_id || value.projectId !== row.project_id || value.grantId !== row.grant_id || value.taskId !== row.task_id || value.createdAt !== row.created_at || value.conditionFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(value.conditionFingerprint) || !['accepted', 'rework_authorized', 'escalated', 'blocked'].includes(value.state) || value.ownerReceiptId !== receipt?.id || receipt?.projectId !== value.projectId || ownerExecutionHash(outcome?.qualityDecision) !== ownerExecutionHash(value.decision)) throw new Error('Owner质量动作与原始决定证据不一致')
  const artifactHash = developmentArtifact?.contentHash ?? artifact?.contentSha256
  const artifactReworkOrdinal = developmentArtifact?.reworkOrdinal ?? artifact?.reworkOrdinal
  if (observation?.commandId !== value.reviewerCommandId || observation.grantId !== value.grantId || observation.businessTaskId !== value.taskId || artifactHash !== value.artifactHash || artifactReworkOrdinal !== value.reworkOrdinal || getOwnerManager(value.projectId)?.ownerId !== value.actor || (value.state === 'accepted' && value.decision.verdict !== 'accept') || (value.enforcedConstraint !== undefined && (value.enforcedConstraint !== 'exact_text_insertion' || value.state !== 'rework_authorized' || value.decision.verdict === 'escalate')) || (value.state === 'rework_authorized' && value.decision.verdict !== 'rework' && value.enforcedConstraint !== 'exact_text_insertion') || (value.state === 'escalated' && value.decision.verdict !== 'escalate')) throw new Error('Owner质量动作的身份、成果或决定类型不一致')
  const recovery = original?.deliveryReview?.qualityRecovery
  if (value.recoveredFromOwnerExecutionId && (!recovery || recovery.previousExecutionId !== value.recoveredFromOwnerExecutionId || recovery.conditionFingerprint !== value.conditionFingerprint)) throw new Error('Owner质量恢复动作未绑定前次阻断与新事实指纹')
  return value
}
export function readOwnerQualityAction(reviewerCommandId: string): OwnerQualityAction | null {
  const row = store.getProjectDb().prepare('SELECT * FROM project_owner_quality_actions WHERE reviewer_command_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(reviewerCommandId) as OwnerQualityActionRow | undefined
  return row ? parseActionRow(row) : null
}
export function readOwnerQualityActionByExecution(ownerExecutionId: string): OwnerQualityAction | null {
  const row = store.getProjectDb().prepare('SELECT * FROM project_owner_quality_actions WHERE owner_execution_id=?').get(ownerExecutionId) as OwnerQualityActionRow | undefined
  return row ? parseActionRow(row) : null
}
/** 当前阻断门槛的事实指纹；只用于判断是否值得新分析，不授予任何许可。 */
export function getOwnerQualityConditionFingerprint(projectId: string, reviewerCommandId: string, targetTaskId?: string): string {
  const command = store.getProjectDb().prepare("SELECT c.id,c.grant_id,c.source_task_id,c.state,c.actual_cost_micros,c.reserved_cost_micros,c.usage_evidence,e.status AS execution_status,g.state AS grant_state,g.task_id AS grant_task_id,g.expires_at,g.revalidation_id,g.revalidation_integrity_hash,g.source_hash,g.policy_revision FROM project_owner_execution_commands c JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id LEFT JOIN agent_executions e ON e.id=c.execution_id WHERE c.id=? AND c.project_id=? AND c.role='reviewer'").get(reviewerCommandId, projectId) as Record<string, unknown> | undefined
  if (!command) throw new Error('Owner质量恢复缺少准确Reviewer命令')
  const task = store.getTask(String(command.source_task_id))
  const manager = getOwnerManager(projectId)
  const policy = getPilotPolicy(projectId)
  const management = getOwnerManagementDelegation(projectId, targetTaskId)
  const usage = readOwnerGrantUsage(String(command.grant_id))
  const blockers = store.listTaskBlockers(projectId).filter(item => item.taskId === command.source_task_id)
  const artifact = (() => { try { return readOwnerQualityArtifact(reviewerCommandId)?.contentHash ?? null } catch { return null } })()
  const revalidation = getOwnerExecutionRevalidation({ projectId, ...(typeof command.grant_task_id === 'string' ? { taskId: command.grant_task_id } : {}) })
  const supplement = readOwnerCounterSupplement(reviewerCommandId)
  return ownerExecutionHash({ command, ...(supplement ? { counterValidationId: supplement.validation.id } : {}), task: task ? { id: task.id, status: task.status, ownerStepLinkId: task.ownerStepLinkId, completionNotes: task.completionNotes ?? null } : null,
    manager: manager ? { ownerId: manager.ownerId, revision: manager.revision, status: manager.status } : null,
    management: { id: management.delegation?.id ?? null, state: management.state, qualityDecisionEnabled: management.delegation?.qualityDecisionEnabled === true },
    policyRevision: policy?.revision ?? null, usage, blockers, artifact,
    revalidation: { status: revalidation.status, id: revalidation.revalidation?.id ?? null, integrityHash: revalidation.revalidation?.integrityHash ?? null, sourceHash: revalidation.revalidation ? ownerExecutionHash(revalidation.revalidation.source) : null } })
}
function canReconsiderQualityAction(action: OwnerQualityAction): boolean {
  if (action.state === 'blocked') return true
  if (action.state !== 'escalated') return false
  const supplement = readOwnerCounterSupplement(action.reviewerCommandId)
  return Boolean(supplement && supplement.validation.finishedAt >= action.createdAt && isOwnerCounterSupplementCurrent(supplement))
}
function isRecoverableOwnerQualityProtocolError(detail: string): boolean {
  return detail === 'Owner规划响应与目标或资料版本不匹配' || detail === OWNER_ACCEPT_WITH_FINDINGS
}
interface FailedOwnerQualityRecovery { previousExecutionId: string; previousDetail: string; targetTaskId?: string }
/** 只读取协议拒绝的原始失败，不改写原回执；是否允许复验由调用方另行显式授权。 */
function readFailedOwnerQualityRecovery(projectId: string, reviewerCommandId: string, ownerExecutionId: string): FailedOwnerQualityRecovery | null {
  const outcome = runs().getOwnerPlanningRunOutcome(ownerExecutionId), receipt = outcome ? runs().getOwnerPlanningRunReceipt(outcome.receiptId) : null
  const snapshot = receipt ? readOwnerPlanningSnapshot(receipt.planningTaskId, { allowUnknownPromptForHistory: true }) : null, conversation = snapshot?.context.conversation
  if (outcome?.state !== 'failed' || !isRecoverableOwnerQualityProtocolError(outcome.detail) && outcome.detail !== 'Owner质量决定未按准确标准逐项判断或引用不符' || receipt?.projectId !== projectId
    || conversation?.executionObservation?.role !== 'reviewer' || conversation.executionObservation.commandId !== reviewerCommandId
    || conversation.deliveryReview?.qualityDecisionVersion !== 1) return null
  if (isRecoverableOwnerQualityProtocolError(outcome.detail)) {
    if (!receipt.validTerminal || receipt.stopped || receipt.error || receipt.runtimeResult?.subtype !== 'success'
      || receipt.runtimeResult.finish_reason !== 'stop' || !Number.isSafeInteger(receipt.usage?.inputTokens)
      || !Number.isSafeInteger(receipt.usage?.outputTokens) || conversation.deliveryReview.qualityRecovery) return null
    // 原模型决定仍被拒绝，新请求必须重新判断，并保留原回执和占额。
    let response: unknown
    try { response = JSON.parse(receipt.responseText) } catch { return null }
    if (!response || typeof response !== 'object' || !('kind' in response) || response.kind !== 'quality_decision') return null
  }
  return { previousExecutionId: ownerExecutionId, previousDetail: outcome.detail, targetTaskId: snapshot?.link.targetTaskId }
}
/** 权威阻断事实变化或首次完整终态的质量信封抄写错误，可在授权额度内提供新判断入口。 */
export function getOwnerQualityRecovery(projectId: string, reviewerCommandId: string): { previousExecutionId: string; conditionFingerprint: string; previousDetail: string } | null {
  const latest = readOwnerQualityAction(reviewerCommandId)
  // 质量信封抄写错误可在自主授权内新判断一次；烟测另可显式选择历史引用错误。
  const smokeFailureId = process.env.GRAVITAS_PACKAGE_SMOKE === '1' ? process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID : undefined
  const lastRun = !latest && !smokeFailureId ? store.getProjectDb().prepare(`SELECT e.id FROM agent_executions e
    JOIN project_owner_planning_links l ON l.planning_task_id=e.entity_id AND l.project_id=e.project_id
    WHERE e.project_id=? AND json_extract(l.source_snapshot, '$.conversation.executionObservation.commandId')=?
    ORDER BY e.rowid DESC LIMIT 1`).get(projectId, reviewerCommandId) as { id: string } | undefined : undefined
  const candidateId = smokeFailureId ?? lastRun?.id
  const candidate = !latest && candidateId ? readFailedOwnerQualityRecovery(projectId, reviewerCommandId, candidateId) : null
  const failed = candidate && (smokeFailureId || isRecoverableOwnerQualityProtocolError(candidate.previousDetail)) ? candidate : null
  if (!failed && (!latest || latest.projectId !== projectId || !canReconsiderQualityAction(latest) || !latest.conditionFingerprint)) return null
  const targetTaskId = latest ? managementTaskId(latest.ownerExecutionId) : failed!.targetTaskId
  const management = getOwnerManagementDelegation(projectId, targetTaskId)
  if (management.state !== 'active' || management.delegation?.qualityDecisionEnabled !== true
    || failed && !smokeFailureId && !management.delegation.autonomousExecution) return null
  const conditionFingerprint = getOwnerQualityConditionFingerprint(projectId, reviewerCommandId, targetTaskId)
  if (latest && conditionFingerprint === latest.conditionFingerprint) return null
  const row = store.getProjectDb().prepare("SELECT c.state,c.actual_cost_micros,c.usage_evidence,c.grant_id,c.source_task_id,c.rework_ordinal,e.status AS execution_status,g.state AS grant_state,g.expires_at,g.revalidation_id,g.revalidation_integrity_hash,g.source_hash,g.policy_revision,g.task_id AS grant_task_id FROM project_owner_execution_commands c JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id JOIN agent_executions e ON e.id=c.execution_id WHERE c.id=? AND c.project_id=? AND c.role='reviewer'").get(reviewerCommandId, projectId) as Record<string, unknown> | undefined
  const task = row ? store.getTask(String(row.source_task_id)) : null
  const usage = row ? readOwnerGrantUsage(String(row.grant_id)) : null
  if (!row || !task || task.status !== 'paused' || row.grant_state !== 'active' || Number(row.expires_at) <= Date.now() || row.state !== 'settled' || row.actual_cost_micros === null || !row.usage_evidence || row.execution_status !== 'completed' || store.listTaskBlockers(projectId).some(item => item.taskId === row.source_task_id)
    || store.getProjectDb().prepare("SELECT 1 FROM project_owner_execution_commands WHERE grant_id=? AND source_task_id=? AND (rework_ordinal>? OR state IN ('reserved','queued','running','needs_reconcile')) LIMIT 1").get(String(row.grant_id), String(row.source_task_id), Number(row.rework_ordinal))
    || !usage) return null
  const view = getOwnerExecutionRevalidation({ projectId, ...(typeof row.grant_task_id === 'string' ? { taskId: row.grant_task_id } : {}) })
  const currentRevalidation = view.revalidation
  if (view.status !== 'current' || !currentRevalidation || currentRevalidation.id !== row.revalidation_id || currentRevalidation.integrityHash !== row.revalidation_integrity_hash || ownerExecutionHash(currentRevalidation.source) !== row.source_hash || getPilotPolicy(projectId)?.revision !== row.policy_revision) return null
  try { if (!readOwnerQualityArtifact(reviewerCommandId)) return null } catch { return null }
  return { previousExecutionId: latest?.ownerExecutionId ?? failed!.previousExecutionId, conditionFingerprint, previousDetail: latest?.detail ?? failed!.previousDetail }
}
interface GrantRow { id: string; state: string; dispatch_mode: string; expires_at: number; revalidation_id: string; revalidation_integrity_hash: string; source_hash: string; policy_revision: number }
function execute(value: OwnerQualityAction, planningTaskId: string): Pick<OwnerQualityAction, 'state' | 'detail' | 'enforcedConstraint'> {
  const manager = getOwnerManager(value.projectId)
  if (!manager || manager.status !== 'active' || manager.ownerId !== value.actor || !assertOwnerManagementTask(value.ownerExecutionId)) throw new Error('当前Owner管理责任或质量决定许可不可用')
  resolveOwnerPlanningTask(planningTaskId, true)
  const frozen = readOwnerCommandFrozenSource(value.reviewerCommandId).source
  if (frozen.qualityManagementVersion !== 1) throw new Error('旧业务许可未委托Owner验收子任务')
  const grant = store.getProjectDb().prepare('SELECT * FROM project_owner_execution_grants WHERE id=? AND project_id=?').get(value.grantId, value.projectId) as GrantRow | undefined
  if (!grant || grant.state !== 'active' || grant.dispatch_mode !== 'autonomous' || grant.expires_at <= Date.now()) throw new Error('业务许可已暂停、过期或不属于自主执行')
  const view = getOwnerExecutionRevalidation({ projectId: value.projectId, ...(frozen.taskId ? { taskId: frozen.taskId } : {}) })
  if (view.status !== 'current' || view.revalidation?.id !== grant.revalidation_id || view.revalidation.integrityHash !== grant.revalidation_integrity_hash || ownerExecutionHash(view.revalidation.source) !== grant.source_hash || getPilotPolicy(value.projectId)?.revision !== grant.policy_revision) throw new Error('业务目标、计划、资料或配置已变化，不能执行旧质量决定')
  const artifact = readOwnerQualityArtifact(value.reviewerCommandId)
  if (!artifact || artifact.contentHash !== value.artifactHash || artifact.taskId !== value.taskId || artifact.grantId !== value.grantId || artifact.reworkOrdinal !== value.reworkOrdinal) throw new Error('质量决定对应的完整成果无法核验')
  const command = store.getProjectDb().prepare("SELECT c.state,c.actual_cost_micros,c.usage_evidence,e.status FROM project_owner_execution_commands c JOIN agent_executions e ON e.id=c.execution_id AND e.owner_command_id=c.id WHERE c.id=? AND c.role='reviewer'").get(value.reviewerCommandId) as { state: string; actual_cost_micros: number | null; usage_evidence: string | null; status: string } | undefined
  if (!command || command.state !== 'settled' || command.actual_cost_micros === null || !command.usage_evidence || command.status !== 'completed') throw new Error('独立评审费用或执行终态未核验')
  if (store.getProjectDb().prepare("SELECT 1 FROM project_owner_execution_commands WHERE grant_id=? AND source_task_id=? AND (rework_ordinal>? OR state IN ('reserved','queued','running','needs_reconcile')) LIMIT 1").get(value.grantId, value.taskId, value.reworkOrdinal)) throw new Error('任务已有更新轮次、在途命令或未知费用')
  const task = store.getTask(value.taskId)
  if (!task || task.projectId !== value.projectId || task.ownerStepLinkId !== artifact.stepLinkId || task.status !== 'paused') throw new Error('任务已变更或不再等待Owner质量决定')
  if (store.listTaskBlockers(value.projectId).some(item => item.taskId === value.taskId)) throw new Error('任务仍有未解除的权威依赖')
  if (value.decision.verdict === 'escalate') return { state: 'escalated', detail: 'Owner保留成果并提出需协商事项，未验收或启动返工。' }
  const { readOwnerExactTextInsertion } = require('./project-owner-execution-command') as typeof import('./project-owner-execution-command')
  const insertion = ownerTaskDeliveryKind(frozen, value.taskId) === 'text' ? readOwnerExactTextInsertion(frozen) : null
  const outOfScope = insertion !== null && !matchesOwnerExactTextInsertion(insertion.original, artifact.content, insertion.line, insertion.placement)
  if (outOfScope || value.decision.verdict === 'rework') {
    if (!outOfScope && isOwnerEvidenceGapRework(value.decision)) {
      return { state: 'blocked', detail: '独立评审缺少运行验证证据；已保存Owner提出的验证要求。现有授权未包含对应验证，暂不重复执行员工或宣称验收。' }
    }
    const usage = readOwnerGrantUsage(value.grantId)
    if (value.reworkOrdinal >= frozen.budget.maxRework || frozen.budget.maxRuns - usage.runReservations < 2 || usage.committedCostMicros >= frozen.budget.maxCostMicros) throw new Error(outOfScope ? '候选稿超出用户限定的单行新增范围，原文已保留；授权内返工额度已用尽。' : '授权返工次数、执行/复验请求或费用额度不足，需协商边界')
    return { state: 'rework_authorized', ...(outOfScope ? { enforcedConstraint: 'exact_text_insertion' as const } : {}), detail: outOfScope ? '候选稿超出用户限定的单行新增范围，已按原文安排授权内返工。' : 'Owner已按具体缺陷安排授权内返工；调度器将复核许可后启动执行与复验。' }
  }
  // 历史决定可读不代表现在可执行；首次验收必须重新核对当前时效与完整协议。
  const planning = readOwnerPlanningSnapshot(planningTaskId)
  if (!planning) throw new Error('Owner质量决定的冻结来源缺失')
  const counterValidation = planning.context.conversation?.deliveryReview?.review?.validationEvidence?.find(item => item.command === OWNER_COUNTER_SUPPLEMENT_COMMAND)
  if (counterValidation) {
    const supplement = readOwnerCounterSupplement(value.reviewerCommandId, counterValidation.validationId)
    if (!supplement || !isOwnerCounterSupplementCurrent(supplement)) throw new Error('计数器交互补测已过期或成果已变化')
  }
  parseOwnerQualityDecision(value.decision, planning.context)
  const completed = store.listTaskStatuses(value.projectId).find(item => item.stateGroup === 'completed')?.id
  if (!completed) throw new Error('项目没有明确完成状态，需核对配置')
  const updated = store.updateTask(value.taskId, { status: completed, completionNotes: `Owner依据准确成果与独立检查验收：${value.decision.reason}` })
  if (!updated || !isCompletedStatus(updated.status, store.listTaskStatuses(value.projectId))) throw new Error('任务权威完成状态未提交')
  return { state: 'accepted', detail: 'Owner已按标准验收此子任务，权威任务状态已完成；后继任务将自动核对依赖并续派。' }
}
/** 管理循环可重放已提交动作；只读历史不复活已撤销的执行许可。 */
export function applyOwnerQualityDecision(projectId: string, ownerExecutionId: string): OwnerQualityAction {
  const database = store.getProjectDb()
  let result: OwnerQualityAction | undefined
  database.transaction(() => {
    const outcome = runs().getOwnerPlanningRunOutcome(ownerExecutionId), receipt = outcome ? runs().getOwnerPlanningRunReceipt(outcome.receiptId) : null
    const frozen = receipt ? readOwnerPlanningSnapshot(receipt.planningTaskId) : null
    const conversation = frozen?.context.conversation, observation = conversation?.executionObservation, manager = getOwnerManager(projectId)
    if (!outcome?.qualityDecision || outcome.state !== 'replied' || !receipt || receipt.projectId !== projectId || !manager || !observation || observation.role !== 'reviewer' || outcome.qualityDecision.reviewerCommandId !== observation.commandId || !Number.isSafeInteger(receipt.usage?.inputTokens) || !Number.isSafeInteger(receipt.usage?.outputTokens)) throw new Error('缺少准确Owner质量决定或可信用量回执')
    const runAction = readOwnerQualityActionByExecution(ownerExecutionId)
    if (runAction) { result = runAction; return }
    const existing = readOwnerQualityAction(observation.commandId), recovery = conversation?.deliveryReview?.qualityRecovery
    let recoveryFingerprint: string | undefined
    if (existing) {
      const currentFingerprint = getOwnerQualityConditionFingerprint(projectId, observation.commandId, frozen?.link.targetTaskId)
      if (!canReconsiderQualityAction(existing) || !existing.conditionFingerprint || !recovery || recovery.previousExecutionId !== existing.ownerExecutionId || recovery.conditionFingerprint !== currentFingerprint || currentFingerprint === existing.conditionFingerprint) throw new Error('同一评审已有决定；只有阻断条件发生变化并重新核对后才能形成新决定')
      recoveryFingerprint = recovery.conditionFingerprint
    } else if (recovery) {
      const failed = readFailedOwnerQualityRecovery(projectId, observation.commandId, recovery.previousExecutionId)
      const currentFingerprint = getOwnerQualityConditionFingerprint(projectId, observation.commandId, frozen?.link.targetTaskId)
      if (!failed || recovery.previousDetail !== failed.previousDetail || recovery.conditionFingerprint !== currentFingerprint) throw new Error('Owner质量恢复未绑定原协议失败与当前事实')
      recoveryFingerprint = recovery.conditionFingerprint
    }
    const artifact = readOwnerQualityArtifact(observation.commandId)
    if (!artifact || artifact.contentHash !== outcome.qualityDecision.artifactHash) throw new Error('Owner质量决定未绑定可核验的成果版本')
    let action: OwnerQualityAction = { ownerExecutionId, ownerReceiptId: receipt.id, actor: manager.ownerId, projectId, grantId: observation.grantId, taskId: observation.businessTaskId, reviewerCommandId: observation.commandId, artifactHash: outcome.qualityDecision.artifactHash, reworkOrdinal: artifact.reworkOrdinal, decision: outcome.qualityDecision, state: 'blocked', detail: '', conditionFingerprint: getOwnerQualityConditionFingerprint(projectId, observation.commandId, frozen!.link.targetTaskId), ...(recoveryFingerprint && recovery ? { recoveredFromOwnerExecutionId: recovery.previousExecutionId } : {}), createdAt: Date.now() }
    // 保存动作失败不能留下半个Task状态；外层事务仍保存阻断原因与原决定。
    database.exec('SAVEPOINT owner_quality_apply')
    try {
      if (recoveryFingerprint && getOwnerQualityConditionFingerprint(projectId, observation.commandId, frozen!.link.targetTaskId) !== recoveryFingerprint) throw new Error('恢复期间质量门槛再次变化，请重新核对')
      action = { ...action, ...execute(action, receipt.planningTaskId) }
      database.exec('RELEASE owner_quality_apply')
    } catch (cause) {
      database.exec('ROLLBACK TO owner_quality_apply'); database.exec('RELEASE owner_quality_apply')
      action.detail = cause instanceof Error ? cause.message : '质量动作未能核验，原决定和成果已保留'
    }
    database.prepare('INSERT INTO project_owner_quality_actions (reviewer_command_id,owner_execution_id,project_id,grant_id,task_id,payload,integrity_hash,created_at) VALUES (?,?,?,?,?,?,?,?)').run(action.reviewerCommandId,ownerExecutionId,projectId,action.grantId,action.taskId,JSON.stringify(action),ownerExecutionHash(action),action.createdAt)
    store.recordProjectActivity({ projectId, entityType: 'task', entityId: action.taskId, action: 'owner_quality_decision', actor: action.actor, summary: action.detail, payload: { ownerExecutionId, ownerReceiptId: receipt.id, reviewerCommandId: action.reviewerCommandId, artifactHash: action.artifactHash, verdict: action.decision.verdict, state: action.state } })
    requestOwnerAutonomousScheduleWake(projectId)
    result = action
  })()
  if (!result) throw new Error('Owner质量动作未能提交')
  return result
}
