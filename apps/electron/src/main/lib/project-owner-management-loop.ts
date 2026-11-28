import { prepareOwnerLocalResourceSample, readOwnerLocalResourceWait, recheckOwnerLocalResources } from './project-owner-local-resources'
import { findOwnerFollowupFuse, hasUnstartedOwnerConversation, preparePendingOwnerConversation } from './project-owner-management-conversation'
import { decideAttentionCarryover } from './project-owner-attention-carryover-policy'
import { prepareOwnerManagementAssignment, projectOwnerManagementAssignmentResult, queueOwnerAssignmentProtocolRetry, isRecoverableOwnerAssignmentRejection } from './project-owner-management-assignment'
import { getOwnerInitialPlanningRecoveryCutoff, getPendingOwnerInitialPlanningRecovery, getOwnerManagementClaim, getOwnerManagementDelegation, hasAccountedOwnerManagementRun, hasActiveOwnerManagementRequest, renewExpiredOwnerManagementDelegation } from './project-owner-management-delegation'
import type { OwnerManagementEvent } from '@gravitas/shared'
import { prepareOwnerUnchangedAnswer, projectOwnerManagementRunResult } from './project-owner-management-questions'
import { getProjectOwnerGoalDraft } from './project-owner-goal-service'
import { confirmProjectOwnerPlanDraftForOwner, getCurrentBoundRevisionRetrySource, getProjectOwnerPlanDraft, getProjectOwnerPlanningContext, isOwnerRevisionCurrentForAutomation, matchesCurrentBoundRevisionRetry } from './project-owner-plan-service'
import { getOwnerRuntimeBinding, prepareOwnerPlanning, resolveOwnerRuntimeBindingFromDefaults, OWNER_BOUND_REVISION_RETRY_PREFIX, OWNER_INITIAL_PLAN_RETRY_PREFIX, OWNER_QUALITY_RETRY_PREFIX, ownerInitialPlanRetryRequestId } from './project-owner-runtime-binding'
import { onOwnerManagementChanged, onOwnerManagementWake, type OwnerManagementChanged } from './project-owner-management-events'
import { appendOwnerManagementMessage, appendOwnerManagementTrace, consumeOwnerManagementEvent, getOwnerManagementMessage, getOwnerManager, listPendingOwnerManagementEvents, recordOwnerManagementAssignmentRecheck, recordOwnerManagementRenewalRecheck, recordStaleOwnerManagementTrace } from './project-owner-management-store'
import * as store from './project-sqlite-store'
import { nextOwnerExecutionObservationDeadline, scanOwnerExecutionObservations } from './project-owner-management-execution'
import { OwnerPlanningSourceChangedError, readOwnerPlanningSnapshot, resolveOwnerPlanningTask } from './project-owner-planning-source'
import { hasCompleteOwnerManagementDelivery, publishOwnerManagementCompletion } from './project-owner-management-delivery'
import { onOwnerAutonomousScheduleWake } from './project-owner-autonomous-scheduler-events'
import { listOwnerExecutionAssignmentRuns } from './project-owner-execution-assignment-service'
import { getOwnerPlanningRunOutcome, getOwnerPlanningRunReceipt, hasCompleteRejectedOwnerPlanReceipt, isRetryableOwnerBoundRevisionReceipt, recoverInitialOwnerPlanningResponse, recoverLegacyOwnerConversationReply } from './project-owner-planning-run-service'
import { ensureOwnerDefaultTeam } from './project-owner-default-team'

let requestActiveOwnerManagementRescan: (() => void) | null = null

/** 系统唤醒后立即重新扫描项目，补偿休眠期间未触发的定时器与状态事件。 */
export function rescanOwnerManagementProjects(): void {
  requestActiveOwnerManagementRescan?.()
}

/**
 * 管理循环是否已启动。
 * 外部事件触发器（event-router 的 owner-goal 目标）用它判断能否唤醒：
 * 未启动时唤醒是无操作，必须让调用方看到失败而不是伪装成功。
 */
export function isOwnerManagementLoopRunning(): boolean {
  return requestActiveOwnerManagementRescan !== null
}

/** 即使当前没有可继续处理的Run，也要把失效授权反馈写回Owner对话。 */
function reportStaleManagementDelegations(projectId: string): void {
  const subjects = store.getProjectDb().prepare('SELECT DISTINCT subject_key FROM project_owner_revisions WHERE project_id = ?').all(projectId) as { subject_key: string }[]
  for (const { subject_key: key } of subjects) {
    const taskId = key === 'project' ? undefined : key.startsWith('task:') ? key.slice(5) : null
    if (taskId === null) continue
    const view = getOwnerManagementDelegation(projectId, taskId)
    if (view.state !== 'stale' || !view.delegation) continue
    recordStaleOwnerManagementTrace(projectId, view.delegation.id, taskId)
    appendOwnerManagementMessage({
      projectId,
      eventId: `management-delegation-stale:${view.delegation.id}`,
      role: 'assistant',
      kind: 'attention',
      ...(taskId ? { taskId } : {}),
      content: '我已暂停后续推进：管理配置、资料来源或费用上界已变化，旧授权不会用于新请求。目标和已保存成果仍保留；请核对当前范围、项目总预算和期限并重新确认，确认后我会继续处理。',
    })
  }
}

/** 每次只处理当前持久事件；准备为无费动作，付费模型仍走独立受控准入。 */
function handleTeamChange(event: OwnerManagementEvent): void {
  const subjects = store.getProjectDb().prepare('SELECT DISTINCT subject_key FROM project_owner_revisions WHERE project_id = ?').all(event.projectId) as { subject_key: string }[]
  for (const { subject_key: subjectKey } of subjects) {
    const taskId = subjectKey === 'project' ? undefined : subjectKey.startsWith('task:') ? subjectKey.slice(5) : null
    if (taskId === null) continue
    if (event.taskId !== undefined && event.taskId !== taskId) continue
    const plan = getProjectOwnerPlanDraft(event.projectId, taskId)
    if (!plan || !['proposed', 'confirmed'].includes(plan.state)) continue
    if (plan.state === 'proposed') {
      const delegation = getOwnerManagementDelegation(event.projectId, taskId)
      if (!event.sourceId?.startsWith('team-access:') || delegation.state !== 'active' || !delegation.delegation) continue
    }
    const existing = store.getProjectDb().prepare("SELECT 1 FROM project_owner_planning_links WHERE project_id = ? AND json_extract(payload, '$.purpose') = 'owner_execution_assignment' AND json_extract(payload, '$.targetTaskId') IS ? AND json_extract(payload, '$.planRevision') = ? LIMIT 1")
      .get(event.projectId, taskId ?? null, plan.revision)
    if (existing) continue
    prepareOwnerManagementAssignment({ ...event, id: `${event.id}:${subjectKey}`, ...(taskId ? { taskId } : {}), sourceRevision: plan.revision })
  }
}

function isVerifiedDevelopmentNarrowing(proposed: NonNullable<ReturnType<typeof getProjectOwnerPlanDraft>>, delegation: NonNullable<ReturnType<typeof getOwnerManagementDelegation>['delegation']>): boolean {
  const feedback = proposed.proposal.deliveryFeedbackAssessment
  if (feedback?.authorizationImpact !== 'additional_confirmation' || delegation.autonomousWorkspaceEditVersion !== 1) return false
  const binding = getOwnerRuntimeBinding(proposed.projectId)
  if (!binding) return false
  const { readOwnerDevelopmentRevisionLimit } = require('./project-owner-development-artifact') as typeof import('./project-owner-development-artifact')
  try {
    const limit = readOwnerDevelopmentRevisionLimit(proposed, binding.workspaceId, true)
    return limit?.onlyNarrowing === true && limit.delegationId === delegation.id
  }
  catch { return false }
}

function acceptPlanAndArrange(event: OwnerManagementEvent, proposed: NonNullable<ReturnType<typeof getProjectOwnerPlanDraft>>): void {
  if (!isOwnerRevisionCurrentForAutomation(proposed)) return
  const delegation = getOwnerManagementDelegation(event.projectId, event.taskId)
  if (delegation.state !== 'active' || !delegation.delegation) return
  if (!delegation.delegation.autonomousExecution) {
    prepareOwnerManagementAssignment(event)
    return
  }
  const feedback = proposed.proposal.deliveryFeedbackAssessment
  const scopeNarrowed = isVerifiedDevelopmentNarrowing(proposed, delegation.delegation)
  if (feedback && feedback.authorizationImpact !== 'within_confirmed_boundary' && !scopeNarrowed) {
    appendOwnerManagementMessage({ projectId: event.projectId, eventId: `owner-feedback-scope:${event.id}:${proposed.revision}`,
      ...(event.taskId ? { taskId: event.taskId } : {}), goalRevision: proposed.goalRevision,
      role: 'assistant', kind: 'attention', content: `这次修订涉及需要你决定的范围：${feedback.authorizationRationale}` })
    return
  }
  const accepted = confirmProjectOwnerPlanDraftForOwner(event.projectId, proposed.goalRevision, proposed.revision, event.taskId)
  prepareOwnerManagementAssignment({ ...event, id: `owner-plan-accepted:${event.id}:${accepted.revision}`, kind: 'plan_confirmed', sourceRevision: accepted.revision })
}

function handle(event: OwnerManagementEvent): void {
  if (event.kind === 'team_changed') { handleTeamChange(event); return }
  const goal = getProjectOwnerGoalDraft(event.projectId, event.taskId)
  if (!goal || (event.kind === 'goal_saved' && goal.revision !== event.sourceRevision)) return
  if (event.kind === 'goal_saved' && !event.taskId) {
    void import('./project-file-change-observations').then(service => service.reconcileProjectFileChangeObservationsForProject(event.projectId)).catch(error => console.warn('[Owner管理] 文件变化观察恢复失败:', error))
  }
  if (event.kind === 'execution_observed') {
    if (goal.revision === event.sourceRevision) preparePendingOwnerConversation(event.projectId, event.taskId)
    return
  }
  if (event.kind === 'assignment_recheck') {
    const plan = getProjectOwnerPlanDraft(event.projectId, event.taskId)
    const delegation = getOwnerManagementDelegation(event.projectId, event.taskId)
    const protocolRetry = event.sourceId?.startsWith('protocol-retry:') === true
    const manualRetry = event.sourceId?.startsWith('manual-retry:') === true
    // 续期补排：来源带授权ID，同样只接受已确认方案与活跃授权。
    const renewalRetry = event.sourceId?.startsWith('delegation-renewal:') === true
    const renewalMatchesDelegation = renewalRetry && event.sourceId === `delegation-renewal:${delegation.delegation?.id}`
    if (!plan || (protocolRetry || manualRetry || renewalRetry ? plan.state !== 'confirmed' : plan.state !== 'proposed') || plan.revision !== event.sourceRevision
      || delegation.state !== 'active' || (renewalRetry ? !renewalMatchesDelegation : protocolRetry ? !delegation.delegation?.autonomousExecution : !manualRetry && delegation.delegation?.id !== event.sourceId)) {
      appendOwnerManagementMessage({ projectId: event.projectId, eventId: event.id, ...(event.taskId ? { taskId: event.taskId } : {}), role: 'assistant', kind: 'attention', content: '当前方案或持续管理授权已变化，我已停止使用旧安排条件；请在项目对话中核对最新方案与管理范围。' })
      return
    }
    prepareOwnerManagementAssignment(event)
    return
  }
  if (event.kind === 'answer_saved') { prepareOwnerUnchangedAnswer(event); return }
  if (event.kind === 'message_received') {
    const starts = require('./project-owner-execution-start-intent') as typeof import('./project-owner-execution-start-intent')
    if (event.sourceId && starts.requeueConflictedOwnerStartFromConversation(event.projectId, event.sourceId, event.taskId)) return
    preparePendingOwnerConversation(event.projectId, event.taskId)
    return
  }
  if (event.kind === 'delegation_confirmed') {
    const delegation = getOwnerManagementDelegation(event.projectId, event.taskId)
    const grant = delegation.delegation
    if (delegation.state !== 'active' || !grant || grant.id !== event.sourceId) return
    const recovery = grant.initialPlanningRecovery
    if (recovery && (goal.revision !== grant.goalRevision || getProjectOwnerPlanDraft(event.projectId, event.taskId))) return
    if (!recovery && hasUnstartedOwnerConversation(event.projectId, event.taskId)) {
      preparePendingOwnerConversation(event.projectId, event.taskId)
      return
    }
    const plan = getProjectOwnerPlanDraft(event.projectId, event.taskId)
    if (plan?.state === 'proposed') { acceptPlanAndArrange(event, plan); return }
    if (plan?.state === 'confirmed') { prepareOwnerManagementAssignment(event); return }
    const binding = getOwnerRuntimeBinding(event.projectId) ?? resolveOwnerRuntimeBindingFromDefaults(event.projectId)
    if (!binding) {
      appendOwnerManagementMessage({ projectId: event.projectId, eventId: event.id, ...(event.taskId ? { taskId: event.taskId } : {}), role: 'assistant', kind: 'configuration_required', content: '管理范围已确认，但本项目还没有可用的模型和工作位置。我会在这里说明需要补齐的项目配置；尚未发送模型请求。' })
      return
    }
    const context = getProjectOwnerPlanningContext(event.projectId, event.taskId)
    const planningTaskId = prepareOwnerPlanning(event.projectId, { requestId: `delegation:${event.sourceId}`, ...(event.taskId ? { taskId: event.taskId } : {}), expectedBindingRevision: binding.revision, expectedGoalRevision: goal.revision, expectedPlanRevision: plan?.revision ?? 0, expectedContextFingerprint: context.fingerprint }).planningTaskId
    appendOwnerManagementMessage({ projectId: event.projectId, eventId: event.id, ...(event.taskId ? { taskId: event.taskId } : {}), role: 'assistant', kind: 'management_progress', planningTaskId, content: '管理范围已确认。我正在按当前目标和资料重新整理方案；需要你决定的业务问题会在这里说明。' })
    return
  }
  if (event.kind === 'assignment_result') { projectOwnerManagementAssignmentResult(event); preparePendingOwnerConversation(event.projectId, event.taskId); return }
  if (event.kind === 'plan_confirmed') { prepareOwnerManagementAssignment(event); return }
  if (event.kind === 'planning_result') {
    if (!event.sourceId) throw new Error('Owner运行事件缺少来源')
    const proposed = getProjectOwnerPlanDraft(event.projectId, event.taskId)
    if (proposed?.sourceRun?.executionId === event.sourceId && !isOwnerRevisionCurrentForAutomation(proposed)) {
      appendOwnerManagementMessage({ projectId: event.projectId, eventId: event.id, ...(event.taskId ? { taskId: event.taskId } : {}),
        role: 'assistant', kind: 'attention', content: '原方案已保留。当前意见、交付版本或授权与原请求不符，尚未安排团队。' })
      preparePendingOwnerConversation(event.projectId, event.taskId)
      return
    }
    projectOwnerManagementRunResult(event.projectId, event.sourceId, event.id)
    if (proposed?.state === 'proposed' && proposed.sourceRun?.executionId === event.sourceId) acceptPlanAndArrange(event, proposed)
    preparePendingOwnerConversation(event.projectId, event.taskId)
    return
  }
  const binding = getOwnerRuntimeBinding(event.projectId) ?? resolveOwnerRuntimeBindingFromDefaults(event.projectId)
  if (event.kind === 'binding_changed' && binding?.revision !== event.sourceRevision) return
  if (!binding) {
    appendOwnerManagementMessage({ projectId: event.projectId, eventId: event.id, ...(event.taskId ? { taskId: event.taskId } : {}), role: 'assistant', kind: 'configuration_required', content: '目标已收到。我正在准备方案。为保护项目资料，需要确认本项目的专用资料空间；模型和团队选择由我负责。如果内部条件不足，我会在这里说明具体影响，不要求你配置技术选项或安排步骤。' })
    return
  }
  if (event.kind === 'binding_changed' && preparePendingOwnerConversation(event.projectId, event.taskId)) return
  const context = getProjectOwnerPlanningContext(event.projectId, event.taskId)
  const plan = getProjectOwnerPlanDraft(event.projectId, event.taskId)
  if (plan && plan.state !== 'stale') {
    if (plan.state === 'confirmed') prepareOwnerManagementAssignment(event)
    return
  }
  // 同来源已存在规划时复用准确记录，避免前台旧入口与后台同时准备两份。
  const links = store.getProjectDb().prepare("SELECT planning_task_id FROM project_owner_planning_links WHERE project_id = ? AND json_extract(payload, '$.purpose') = 'owner_planning' AND json_extract(payload, '$.targetTaskId') IS ? AND json_extract(payload, '$.bindingRevision') = ? AND json_extract(payload, '$.goalRevision') = ? AND json_extract(payload, '$.planRevision') = ? AND json_extract(payload, '$.contextFingerprint') = ? AND json_extract(payload, '$.conversationMessageId') IS NULL ORDER BY rowid DESC LIMIT 1")
    .get(event.projectId, event.taskId ?? null, binding.revision, goal.revision, plan?.revision ?? 0, context.fingerprint) as { planning_task_id: string } | undefined
  const planningTaskId = links?.planning_task_id ?? prepareOwnerPlanning(event.projectId, { requestId: `management:${event.id}`, ...(event.taskId ? { taskId: event.taskId } : {}), expectedBindingRevision: binding.revision, expectedGoalRevision: goal.revision, expectedPlanRevision: plan?.revision ?? 0, expectedContextFingerprint: context.fingerprint }).planningTaskId
  const previousRun = store.listAgentExecutionsByEntity('task', planningTaskId).length > 0
  const delegation = getOwnerManagementDelegation(event.projectId, event.taskId)
  const awaitingAuthorization = delegation.state !== 'active' || !delegation.delegation?.autonomousExecution
  appendOwnerManagementMessage({ projectId: event.projectId, eventId: event.id, ...(event.taskId ? { taskId: event.taskId } : {}), role: 'assistant', kind: previousRun ? 'attention' : 'planning_confirmation', planningTaskId,
    content: previousRun ? '这份目标已有规划运行记录，我会保留结果和费用记录。需要新的调用时应先核对上次结果和授权。' : awaitingAuthorization ? '目标已保存。持续管理范围尚未确认，我没有发送模型请求。请在下方确认项目总预算和有效期限；确认后我会自动继续。' : '目标已收到。我会先核对项目已有的资料与费用范围，再整理方案；缺少边界时会在这里请你决定。方案确认后，我会组织团队并开始推进。' })
}

class OwnerEventReconciliationError extends Error {
  constructor(readonly eventId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}

export function reconcileOwnerManagement(projectId: string): void {
  const db = store.getProjectDb()
  // 提交前收到唤醒不能消费未提交事件；启动扫描会补偿进程关闭时未发出的唤醒。
  if (db.isTransactionActive() || !store.getProject(projectId) || getOwnerManager(projectId)?.status !== 'active') return
  renewExpiredProfiles(projectId)
  reportStaleManagementDelegations(projectId)
  try {
    const interactions = require('./project-owner-employee-interactions') as typeof import('./project-owner-employee-interactions')
    interactions.expireOwnerEmployeeInteractions(projectId)
  } catch (cause) { console.warn('[Owner管理] 员工等待到期核对失败', projectId, cause) }
  // 同轮先投影可信回调，再准备用户积压消息，避免后续请求漏掉刚到达的Owner回应。
  const isResult = (event: OwnerManagementEvent) => event.kind === 'planning_result' || event.kind === 'assignment_result'
  const events = listPendingOwnerManagementEvents(projectId).sort((a, b) => Number(isResult(b)) - Number(isResult(a)))
  for (const event of events) {
    try {
      // Promise投递不可回滚：先在事务外完成权威决定回流，事务内仅幂等补写和消费事件。
      if (event.kind === 'planning_result' && event.sourceId) {
        const runs = require('./project-owner-planning-run-service') as typeof import('./project-owner-planning-run-service')
        if (runs.getOwnerPlanningRunOutcome(event.sourceId)?.employeeDecision) {
          projectOwnerManagementRunResult(projectId, event.sourceId, event.id)
        }
      }
      db.transaction(() => {
        if (getOwnerManager(projectId)?.status !== 'active') return
        // 同库其他消费者已完成时，不重复发消息或准备。
        if (!listPendingOwnerManagementEvents(projectId).some(item => item.id === event.id)) return
        handle(event)
        consumeOwnerManagementEvent(event)
      })()
    } catch (cause) {
      // 事务已回滚；保留事件交给外层持久退避，恢复后重新核对，不能将失败当作已处理。
      throw new OwnerEventReconciliationError(event.id, cause)
    }
  }
  recoverLegacyOwnerResponses(projectId)
  // 兼容旧版本已保存但没有启动执行的对话；恢复授权或进程重启后继续处理原消息。
  const subjects = store.getProjectDb().prepare('SELECT DISTINCT subject_key FROM project_owner_revisions WHERE project_id = ?').all(projectId) as { subject_key: string }[]
  for (const { subject_key: key } of subjects) {
    const taskId = key === 'project' ? undefined : key.startsWith('task:') ? key.slice(5) : null
    if (taskId === null) continue
    if (hasUnstartedOwnerConversation(projectId, taskId)) {
      preparePendingOwnerConversation(projectId, taskId)
      continue
    }
    // 兼容旧版已判需确认的路径缩减，只复核当前精确反馈。
    const pending = getProjectOwnerPlanDraft(projectId, taskId)
    if (pending?.state !== 'proposed' || pending.proposal.deliveryFeedbackAssessment?.authorizationImpact !== 'additional_confirmation' || !isOwnerRevisionCurrentForAutomation(pending)) continue
    const view = getOwnerManagementDelegation(projectId, taskId)
    if (view.state !== 'active' || !view.delegation?.autonomousExecution || !isVerifiedDevelopmentNarrowing(pending, view.delegation)) continue
    confirmProjectOwnerPlanDraftForOwner(projectId, pending.goalRevision, pending.revision, taskId)
  }
  recoverMissingOwnerDefaultTeams(projectId)
  recoverMissingProposedPlanAssignment(projectId)
  recoverProtocolRejectedOwnerAssignments(projectId)
  recoverConfirmedPlanRenewalAssignment(projectId)
  if (getOwnerManager(projectId)?.status === 'active') {
    try { publishOwnerManagementCompletion(projectId) }
    catch (cause) { console.warn('[Owner管理] 最终成果尚未完成核验，保留原成果并等待下次对账', projectId, cause) }
  }
}

/** 旧Owner记录挡住组队时，启动后在原有效授权内补齐；只有本次新建团队才续接安排。 */
function recoverMissingOwnerDefaultTeams(projectId: string): void {
  const subjects = store.getProjectDb().prepare('SELECT DISTINCT subject_key FROM project_owner_revisions WHERE project_id=?').all(projectId) as { subject_key: string }[]
  for (const { subject_key: key } of subjects) {
    const taskId = key === 'project' ? undefined : key.startsWith('task:') ? key.slice(5) : null
    if (taskId === null) continue
    const plan = getProjectOwnerPlanDraft(projectId, taskId), view = getOwnerManagementDelegation(projectId, taskId)
    if (plan?.state !== 'confirmed' || view.state !== 'active' || !view.delegation
      || hasActiveOwnerManagementRequest(view.delegation.id)) continue
    const binding = getOwnerRuntimeBinding(projectId)
    if (!binding) continue
    store.getProjectDb().transaction(() => {
      if (!ensureOwnerDefaultTeam(projectId, binding, plan.proposal.steps.map(step => step.roleKey), plan.proposal.steps.some(step => step.deliveryKind === 'development'))) return
      prepareOwnerManagementAssignment({ id: `default-team-recovery:${projectId}:${taskId ?? 'project'}:${plan.revision}:${binding.revision}`, projectId, ...(taskId ? { taskId } : {}), kind: 'plan_confirmed', sourceRevision: plan.revision, createdAt: Date.now(), consumedAt: null })
    })()
  }
}

const initialPlanRetryErrors = new Set(['Owner规划响应包含未知字段', '计划步骤 存在未知字段：criteriaTrace', 'Owner规划响应包含重复计划字段', '步骤内的目标追溯与所属步骤不符'])

/** 只为已完整结束且有费用回执或可按已知费率计入预算的首份规划准备一次新请求。 */
function queueOwnerInitialPlanProtocolRetry(projectId: string, executionId: string): void {
  const outcome = getOwnerPlanningRunOutcome(executionId)
  const receipt = outcome && getOwnerPlanningRunReceipt(outcome.receiptId)
  if (!outcome || !receipt || receipt.projectId !== projectId || !outcome.protocolRejected || !hasCompleteRejectedOwnerPlanReceipt(outcome, receipt)
    || !initialPlanRetryErrors.has(outcome.detail) && !outcome.detail.startsWith('目标追溯来源原文与目标不符：')) return
  const source = readOwnerPlanningSnapshot(receipt.planningTaskId, { allowUnknownPromptForHistory: true })
  if (!source || source.link.planRevision !== 0 || source.link.conversationMessageId || source.link.id !== receipt.linkId
    || source.link.requestId.startsWith(OWNER_INITIAL_PLAN_RETRY_PREFIX)) return
  const taskId = source.link.targetTaskId
  if (getProjectOwnerPlanDraft(projectId, taskId) || hasUnstartedOwnerConversation(projectId, taskId)) return
  const grant = getOwnerManagementDelegation(projectId, taskId)
  const claim = getOwnerManagementClaim(receipt.planningTaskId)
  if (grant.state !== 'active' || !grant.delegation?.autonomousExecution || claim?.executionId !== executionId || claim.delegationId !== grant.delegation.id
    || hasActiveOwnerManagementRequest(grant.delegation.id) || !hasAccountedOwnerManagementRun(receipt.planningTaskId, executionId)) return
  const requestId = ownerInitialPlanRetryRequestId(grant.delegation.id, source.link.goalRevision)
  const db = store.getProjectDb()
  db.transaction(() => {
    if (db.prepare(`SELECT 1 FROM project_owner_planning_links WHERE project_id=? AND json_extract(payload,'$.requestId')=? LIMIT 1`).get(projectId, requestId)
      || db.prepare('SELECT 1 FROM project_owner_planning_stop_requests WHERE execution_id=?').get(executionId)
      || !resolveOwnerPlanningTask(receipt.planningTaskId, true)) return
    const planned = prepareOwnerPlanning(projectId, { requestId, ...(taskId ? { taskId } : {}), expectedBindingRevision: source.link.bindingRevision,
      expectedGoalRevision: source.link.goalRevision, expectedPlanRevision: 0, expectedContextFingerprint: source.context.fingerprint }, 'initial_protocol_retry')
    appendOwnerManagementMessage({ projectId, eventId: requestId, ...(taskId ? { taskId } : {}), role: 'assistant', kind: 'management_progress',
      planningTaskId: planned.planningTaskId, content: '首份规划已返回，但格式无法校验。我保留了原回执，将在现有项目预算内重新整理一次。' })
  })()
}

function queueOwnerBoundRevisionProtocolRetry(projectId: string, executionId: string): void {
  const outcome = getOwnerPlanningRunOutcome(executionId)
  const receipt = outcome && getOwnerPlanningRunReceipt(outcome.receiptId)
  if (!outcome || !receipt || !isRetryableOwnerBoundRevisionReceipt(outcome, receipt)) return
  const snapshot = readOwnerPlanningSnapshot(receipt.planningTaskId)
  if (!snapshot?.context.conversation?.deliveryFeedback || snapshot.link.projectId !== projectId) return
  const taskId = snapshot.link.targetTaskId
  const grant = getOwnerManagementDelegation(projectId, taskId)
  if (grant.state !== 'active' || !grant.delegation?.autonomousExecution || hasActiveOwnerManagementRequest(grant.delegation.id)) return
  const delegationId = grant.delegation.id
  const requestId = `${OWNER_BOUND_REVISION_RETRY_PREFIX}${executionId}`
  const db = store.getProjectDb()
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM project_owner_planning_links WHERE project_id=? AND request_id=?').get(projectId, requestId)) return
    const source = getCurrentBoundRevisionRetrySource(projectId, executionId, delegationId)
    if (!source?.link.conversationMessageId || !resolveOwnerPlanningTask(receipt.planningTaskId, true)) return
    const planned = prepareOwnerPlanning(projectId, { requestId, ...(taskId ? { taskId } : {}), conversationMessageId: source.link.conversationMessageId,
      expectedBindingRevision: source.link.bindingRevision, expectedGoalRevision: source.link.goalRevision, expectedPlanRevision: source.link.planRevision,
      expectedContextFingerprint: source.context.fingerprint }, 'bound_revision_retry')
    appendOwnerManagementMessage({ projectId, eventId: requestId, ...(taskId ? { taskId } : {}), role: 'assistant', kind: 'management_progress',
      planningTaskId: planned.planningTaskId, content: '修订方案未通过原成果标准的核验。我已保留原记录，会在同一份交付和现有授权内重新核对一次。' })
  })()
}

/** 从原回执重新验证旧版误拒的首份方案、对话回应或质量决定。 */
function recoverLegacyOwnerResponses(projectId: string): void {
  const executions = store.getProjectDb().prepare(`SELECT o.execution_id FROM project_owner_planning_run_outcomes o
    JOIN project_owner_planning_run_receipts r ON r.id = o.receipt_id
    WHERE json_extract(r.payload, '$.projectId') = ? AND json_extract(r.payload, '$.purpose') = 'owner_planning'
      AND json_extract(o.payload, '$.state') = 'failed' AND (
        json_extract(o.payload, '$.protocolRejected') = 1
        OR json_extract(o.payload, '$.detail') IN ('Owner规划响应包含未知字段', 'Owner执行跟进只允许分析回应或必要协商', 'Owner质量决定与准确评审/成果不匹配', 'Owner质量决定未按准确标准逐项判断或引用不符', 'Owner返工必须指出具体不满足标准及可执行修改'))
      AND NOT EXISTS (SELECT 1 FROM project_owner_planning_run_recoveries p WHERE p.execution_id = o.execution_id AND json_extract(p.payload, '$.recoveredOutcome.state') IN ('proposed', 'needs_clarification'))
      AND NOT (EXISTS (SELECT 1 FROM project_owner_management_messages m WHERE m.project_id = ? AND m.event_id = 'legacy-response-recovered:' || o.execution_id)
        AND EXISTS (SELECT 1 FROM project_owner_planning_run_recoveries p WHERE p.execution_id = o.execution_id AND json_type(p.payload, '$.recoveredOutcome.qualityDecision') = 'object'))
    ORDER BY r.rowid`).all(projectId, projectId) as { execution_id: string }[]
  for (const { execution_id: executionId } of executions) {
    try {
      if (recoverInitialOwnerPlanningResponse(executionId)) continue
      queueOwnerBoundRevisionProtocolRetry(projectId, executionId)
      queueOwnerInitialPlanProtocolRetry(projectId, executionId)
      const recovered = recoverLegacyOwnerConversationReply(executionId)
      if (!recovered || recovered.state !== 'replied') continue
      const receipt = getOwnerPlanningRunReceipt(recovered.receiptId)
      if (!receipt) continue
      const snapshot = readOwnerPlanningSnapshot(receipt.planningTaskId, { allowUnknownPromptForHistory: true })
      if (!snapshot || snapshot.link.projectId !== projectId || !snapshot.link.conversationMessageId) continue
      projectOwnerManagementRunResult(projectId, executionId, `legacy-response-recovered:${executionId}`)
      if (recovered.qualityDecision) continue

      // 只在仍有效的自主项目授权、已确认的同一方案和准确来源下续接安排；绝不重放旧请求。
      const plan = getProjectOwnerPlanDraft(projectId, snapshot.link.targetTaskId)
      const delegation = getOwnerManagementDelegation(projectId, snapshot.link.targetTaskId)
      if (!plan || plan.state !== 'confirmed' || plan.revision !== snapshot.link.planRevision
        || plan.goalRevision !== snapshot.link.goalRevision || delegation.state !== 'active'
        || delegation.delegation?.autonomousExecution !== true) continue
      prepareOwnerManagementAssignment({
        id: `legacy-response-plan-continuation:${executionId}:${plan.revision}`,
        projectId, kind: 'plan_confirmed', sourceRevision: plan.revision, createdAt: Date.now(), consumedAt: null,
        ...(snapshot.link.targetTaskId ? { taskId: snapshot.link.targetTaskId } : {}),
      })
    } catch (cause) {
      console.warn('[Owner管理] 旧回应本地恢复未通过核验，保留原失败记录', executionId, cause)
    }
  }
}

/** 进程在失败回执落库后退出时，从可信Run记录恢复唯一一次协议续跑。 */
function recoverProtocolRejectedOwnerAssignments(projectId: string): void {
  if (getOwnerManager(projectId)?.status !== 'active') return
  const subjects = store.getProjectDb().prepare('SELECT DISTINCT subject_key FROM project_owner_revisions WHERE project_id = ?').all(projectId) as { subject_key: string }[]
  for (const { subject_key: key } of subjects) {
    const taskId = key === 'project' ? undefined : key.startsWith('task:') ? key.slice(5) : null
    if (taskId === null) continue
    for (const run of listOwnerExecutionAssignmentRuns({ projectId, ...(taskId ? { taskId } : {}) })) {
      for (const outcome of run.outcomes) {
        if (outcome.state === 'failed' && isRecoverableOwnerAssignmentRejection(outcome.detail)) {
          queueOwnerAssignmentProtocolRetry(projectId, taskId, outcome.executionId)
        }
      }
    }
  }
}

/** 恢复没有产生安排或阻塞反馈的授权事件；每个方案版本只尝试一次。 */
function recoverMissingProposedPlanAssignment(projectId: string): void {
  if (getOwnerManager(projectId)?.status !== 'active') return
  const subjects = store.getProjectDb().prepare('SELECT DISTINCT subject_key FROM project_owner_revisions WHERE project_id = ?').all(projectId) as { subject_key: string }[]
  for (const { subject_key: subjectKey } of subjects) {
    const taskId = subjectKey.startsWith('task:') ? subjectKey.slice(5) : undefined
    const plan = getProjectOwnerPlanDraft(projectId, taskId)
    if (!plan || plan.state !== 'proposed' || !isOwnerRevisionCurrentForAutomation(plan)) continue
    const delegation = getOwnerManagementDelegation(projectId, taskId)
    if (delegation.state !== 'active' || !delegation.delegation) continue
    const assignments = listOwnerExecutionAssignmentRuns({ projectId, ...(taskId ? { taskId } : {}) })
    if (assignments.some(run => run.link.planRevision === plan.revision && run.sourceStatus === 'current')) continue
    const blocked = store.getProjectDb().prepare("SELECT 1 FROM project_owner_management_events e JOIN project_owner_management_messages m ON m.event_id = e.id WHERE e.project_id = ? AND json_extract(e.payload, '$.kind') = 'delegation_confirmed' AND json_extract(e.payload, '$.sourceId') = ? AND json_extract(e.payload, '$.taskId') IS ? AND json_extract(m.payload, '$.kind') IN ('attention', 'configuration_required', 'clarification') LIMIT 1")
      .get(projectId, delegation.delegation.id, taskId ?? null)
    if (blocked) continue
    const recovery = store.getProjectDb().prepare("SELECT id, consumed_at FROM project_owner_management_events WHERE project_id = ? AND json_extract(payload, '$.kind') = 'assignment_recheck' AND json_extract(payload, '$.taskId') IS ? AND json_extract(payload, '$.sourceRevision') = ? AND json_extract(payload, '$.sourceId') = ? ORDER BY rowid DESC LIMIT 1")
      .get(projectId, taskId ?? null, plan.revision, delegation.delegation.id) as { id: string; consumed_at: number | null } | undefined
    if (!recovery) {
      recordOwnerManagementAssignmentRecheck(projectId, plan.revision, delegation.delegation.id, taskId)
      continue
    }
    if (recovery.consumed_at === null) continue
    const response = store.getProjectDb().prepare('SELECT 1 FROM project_owner_management_messages WHERE project_id = ? AND event_id = ? LIMIT 1').get(projectId, recovery.id)
    if (!response) appendOwnerManagementMessage({ projectId, eventId: `assignment-recheck-incomplete:${recovery.id}`, ...(taskId ? { taskId } : {}), role: 'assistant', kind: 'attention', content: '我已暂停：这份待审方案没有生成可核对的团队安排结果。原方案和授权记录仍保留；为避免重复请求，我没有自动重试。请在这里告诉我是否调整结果范围或项目可用团队。' })
  }
}

/**
 * 按长期 Owner profile 自动续签已到期的管理委托。
 *
 * 只在核对入口调用一次：续签失败（无 profile / 配置漂移 / 已撤销）时静默返回，
 * 由既有 stale/expired 路径继续提示用户。任何失败都不能让核对中断。
 */
function renewExpiredProfiles(projectId: string): void {
  try {
    const subjects = store.getProjectDb().prepare('SELECT DISTINCT subject_key FROM project_owner_revisions WHERE project_id = ?').all(projectId) as { subject_key: string }[]
    for (const { subject_key: key } of subjects) {
      // 委托可以挂在项目级（subject_key='project'）或任务级（'task:<id>'）。
      const taskId = key === 'project' ? undefined : key.startsWith('task:') ? key.slice(5) : null
      if (taskId === null) continue
      const view = getOwnerManagementDelegation(projectId, taskId)
      // 只处理自然到期；其余状态（active/revoked/stale/exhausted/attention）保持既有语义。
      if (view.state !== 'expired' || !view.delegation) continue
      const renewed = renewExpiredOwnerManagementDelegation(projectId, taskId)
      // 续签内部走 confirmOwnerManagementDelegation，已记录 delegation_confirmed 事件；
      // 这里不再补 trace，避免同一事实产生两条审计。
      if (renewed) console.log(`[Owner管理] 已按长期 profile 续签委托 ${renewed.id}（项目 ${projectId}）`)
    }
  } catch (cause) {
    // 续签是增强路径：失败必须让原核对继续，不能把项目卡在异常里。
    console.warn('[Owner管理] 长期 profile 续签失败', projectId, cause)
  }
}

/**
 * 授权续期后补回安排步骤。
 *
 * `delegation_confirmed` 在有未启动用户对话时只接续对话，安排步骤不会重新进入；
 * 随后的 conversation 回复走 owner_planning，也不会回到安排链。于是续期额度被对话消耗完，
 * 团队仍未组建（真实用例：绿地原生项目续期后只产生两条 planning，零安排运行）。
 *
 * 判定基准是**当前授权的签发时间**，不是「当前方案版本有没有结论」：
 * 真实事故里同一方案版本下已存在两条失败结论，但它们属于上一个已过期的授权，
 * 按版本判断会把续期后的补排一起挡掉。只有当前授权签发后的失败才由
 * 协议续跑或用户手动重排处理，自动路径不重复调用。
 */
function recoverConfirmedPlanRenewalAssignment(projectId: string): void {
  if (getOwnerManager(projectId)?.status !== 'active') return
  const subjects = store.getProjectDb().prepare('SELECT DISTINCT subject_key FROM project_owner_revisions WHERE project_id = ?').all(projectId) as { subject_key: string }[]
  for (const { subject_key: key } of subjects) {
    const taskId = key === 'project' ? undefined : key.startsWith('task:') ? key.slice(5) : null
    if (taskId === null) continue
    const plan = getProjectOwnerPlanDraft(projectId, taskId)
    const view = getOwnerManagementDelegation(projectId, taskId)
    if (plan?.state !== 'confirmed' || view.state !== 'active' || !view.delegation) continue
    if (hasActiveOwnerManagementRequest(view.delegation.id)) continue
    if (hasCompleteOwnerManagementDelivery(projectId, taskId, plan)) continue
    const assignments = listOwnerExecutionAssignmentRuns({ projectId, ...(taskId ? { taskId } : {}) })
    // 当前授权签发后只要准备过安排就交给既有链路：成功、失败、待启动都有各自处理，
    // 自动补排只负责「这次授权完全没走到安排步骤」这一种情况。
    const attempted = assignments.some(run => run.link.createdAt >= view.delegation!.issuedAt)
    if (attempted) continue
    // 已有排队/运行中的安排 Run 时等待结果，不重复准备。
    if (assignments.some(run => run.executions.some(execution => execution.status === 'queued' || execution.status === 'running'))) continue
    // 已经提示过阻塞（能力不足/工作区建议/配置缺失）时不重复推进。
    const blocked = store.getProjectDb().prepare("SELECT 1 FROM project_owner_management_events e JOIN project_owner_management_messages m ON m.event_id = e.id WHERE e.project_id = ? AND json_extract(e.payload, '$.kind') = 'delegation_confirmed' AND json_extract(e.payload, '$.sourceId') = ? AND json_extract(e.payload, '$.taskId') IS ? AND json_extract(m.payload, '$.kind') IN ('attention', 'configuration_required', 'clarification') LIMIT 1")
      .get(projectId, view.delegation.id, taskId ?? null)
    if (blocked) continue
    // 只排队一次；事件 ID 由授权与方案版本派生，重复核对不会重复调用。
    const queued = store.getProjectDb().prepare("SELECT id, consumed_at FROM project_owner_management_events WHERE project_id = ? AND json_extract(payload, '$.kind') = 'assignment_recheck' AND json_extract(payload, '$.taskId') IS ? AND json_extract(payload, '$.sourceRevision') = ? AND json_extract(payload, '$.sourceId') = ? ORDER BY rowid DESC LIMIT 1")
      .get(projectId, taskId ?? null, plan.revision, `delegation-renewal:${view.delegation.id}`) as { id: string; consumed_at: number | null } | undefined
    if (!queued) {
      recordOwnerManagementRenewalRecheck(projectId, plan.revision, view.delegation.id, taskId)
      break
    }
    if (queued.consumed_at === null) continue
    // 已消费却没有产生任何安排运行，说明补排没有落地；明确告知而不是静默重试。
    const responded = store.getProjectDb().prepare('SELECT 1 FROM project_owner_management_messages WHERE project_id = ? AND event_id = ? LIMIT 1').get(projectId, queued.id)
    if (!responded) appendOwnerManagementMessage({ projectId, eventId: `renewal-recheck-incomplete:${queued.id}`, ...(taskId ? { taskId } : {}), role: 'assistant', kind: 'attention', content: '续期后我尝试恢复团队安排，但这份已确认方案没有生成可核对的安排结果。原方案和授权仍保留；为避免重复请求，我没有自动重试。请在这里告诉我是否调整结果范围或项目可用团队。' })
    break
  }
}

// 只找原管理委托已占额、还没建会话和发送证据的排队记录。
function queuedOwnerManagementExecutions(projectId?: string): { id: string; projectId: string; taskId: string }[] {
  return store.getProjectDb().prepare(`
    SELECT e.id, e.project_id AS projectId, e.entity_id AS taskId FROM agent_executions e
    JOIN project_owner_management_claims c ON c.execution_id=e.id AND c.task_id=e.entity_id
    JOIN controlled_task_preparations p ON p.execution_id=e.id AND p.task_id=e.entity_id
      AND p.project_id=e.project_id AND p.owner_management_delegation_id=c.delegation_id
    WHERE e.status='queued' AND e.entity_type='task' AND e.session_id=''
      AND e.owner_command_id IS NULL AND e.pilot_command_id IS NULL AND p.provider_admitted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM project_owner_planning_admissions a WHERE a.execution_id=e.id)
      AND NOT EXISTS (SELECT 1 FROM project_owner_planning_stop_requests s WHERE s.execution_id=e.id)
      AND NOT EXISTS (SELECT 1 FROM project_owner_planning_run_receipts r WHERE r.execution_id=e.id)
      AND NOT EXISTS (SELECT 1 FROM project_owner_planning_callback_evidence b WHERE b.execution_id=e.id)
      ${projectId === undefined ? '' : 'AND e.project_id = ?'}
    ORDER BY e.started_at, e.rowid
  `).all(...(projectId === undefined ? [] : [projectId])) as { id: string; projectId: string; taskId: string }[]
}

/** 主进程生命周期，不依赖页面挂载。旧项目无管理身份不会被启动扫描启用。 */
export function startOwnerManagementLoop(onChanged?: (change: OwnerManagementChanged) => void): () => Promise<void> {
  let stopped = false
  const inFlight = new Set<string>(), pending = new Set<string>()
  const inFlightTasks = new Map<string, Promise<void>>()
  const wakeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * 失败退避：对账失败多为"来源/回执不匹配"这类确定性错误，立即重试只会空转。
   * 次数与截止持久化到 SQLite，重启后继续退避；同一错误第 3 次起只提示一次。
   */
  const failures = require('./project-owner-management-failures') as typeof import('./project-owner-management-failures')
  const noteBlocked = (projectId: string, key: string) => {
    try {
      appendOwnerManagementMessage({
        projectId,
        eventId: `owner-loop-blocked:${projectId}:${key.slice(0, 24)}`,
        role: 'assistant',
        kind: 'attention',
        content: '项目推进遇到持续的内部核对问题，待处理记录已保留。我会间隔一段时间再次检查；在问题解决前不会把这次工作当作已完成，也不会因此绕过原有授权和费用核对。',
      })
    } catch (cause) { console.warn('[Owner管理] 无法保存退避提示', projectId, cause); throw cause }
  }
  const clearWake = (projectId: string): void => {
    const timer = wakeTimers.get(projectId)
    if (timer) clearTimeout(timer)
    wakeTimers.delete(projectId)
  }
  const scheduleWake = (projectId: string, deadline: number): void => {
    clearWake(projectId)
    if (stopped || !Number.isFinite(deadline)) return
    const timer = setTimeout(() => { wakeTimers.delete(projectId); run(projectId) }, Math.min(2_147_483_647, Math.max(1, deadline - Date.now())))
    timer.unref?.()
    wakeTimers.set(projectId, timer)
  }
  const recordFailure = (projectId: string, cause: unknown): void => {
    const key = cause instanceof OwnerEventReconciliationError ? `event:${cause.eventId}` : cause instanceof Error ? cause.message : String(cause)
    const failure = failures.recordOwnerManagementFailure(projectId, key)
    if (failure.attemptCount >= 3 && !failure.notified) {
      try {
        store.getProjectDb().transaction(() => {
          if (failures.markOwnerManagementFailureNotified(projectId, key)) noteBlocked(projectId, key)
        })()
      } catch (notificationError) { console.warn('[Owner管理] 退避提示将在下次对账时重试', projectId, notificationError) }
    }
    scheduleWake(projectId, failure.retryUntil)
    console.warn('[Owner管理] 对账失败，保留待处理事件', projectId, `第${failure.attemptCount}次`, cause)
  }
  const run = (projectId: string): void => {
    if (stopped) return
    if (inFlight.has(projectId)) { pending.add(projectId); return }
    const blocked = failures.readOwnerManagementFailure(projectId)
    if (blocked && blocked.retryUntil > Date.now()) { scheduleWake(projectId, blocked.retryUntil); return }
    clearWake(projectId)
    const checkedAt = Date.now()
    try {
      // 先记录状态投影：只用于观测“哪些域发生了变化”，阶段C才据此决定是否调用模型。
      // 没有Owner管理者的项目不建立投影，避免为未启用管理的项目留下痕迹。
      if (getOwnerManager(projectId)?.status === 'active') {
        ;(require('./project-owner-state-projection') as typeof import('./project-owner-state-projection')).reconcileOwnerStateProjection(projectId)
      }
      ;(require('./project-owner-employee-interactions') as typeof import('./project-owner-employee-interactions')).reconcileLostOwnerEmployeeInteractions(projectId)
      scanOwnerExecutionObservations(projectId)
      reconcileOwnerManagement(projectId)
      if (getOwnerManager(projectId)?.status === 'active') {
        const { nextOwnerEmployeeInteractionDeadline } = require('./project-owner-employee-interactions') as typeof import('./project-owner-employee-interactions')
        scheduleWake(projectId, Math.min(nextOwnerEmployeeInteractionDeadline(projectId, checkedAt), nextOwnerExecutionObservationDeadline(projectId, checkedAt)))
      }
    } catch (cause) {
      recordFailure(projectId, cause)
      return
    }
    if (getOwnerManager(projectId)?.status !== 'active') return
    inFlight.add(projectId)
    const task = (async () => {
      pending.delete(projectId)
      if (stopped || getOwnerManager(projectId)?.status !== 'active') return
      const { recoverPendingOwnerExecutionStartIntents } = await import('./project-owner-execution-start-intent')
      await recoverPendingOwnerExecutionStartIntents(projectId)
      const { prepareHistoricalConflictedReplan } = await import('./project-owner-execution-start-intent')
      prepareHistoricalConflictedReplan(projectId)
      if (stopped || getOwnerManager(projectId)?.status !== 'active') return
      const queued = queuedOwnerManagementExecutions(projectId)
      if (queued.length) {
        const { tryStartExecution, cancelAgentExecution } = await import('./agent-employee-service')
        for (const { id, taskId } of queued) {
          if (stopped || getOwnerManager(projectId)?.status !== 'active') return
          const pendingExecution = store.getAgentExecution(id)
          if (pendingExecution?.status !== 'queued' || pendingExecution.sessionId) continue
          // 已占额请求属于该主体正在处理的这一轮；排队后的普通补充按既有对话顺序接续。
          // 若原安排的成果已交付，停止这个尚未发送的安排，避免重复组织团队。
          const link = readOwnerPlanningSnapshot(taskId, { allowUnknownPromptForHistory: true })?.link
          const currentPlan = link?.purpose === 'owner_execution_assignment' ? getProjectOwnerPlanDraft(projectId, link.targetTaskId) : null
          if (link && currentPlan && hasCompleteOwnerManagementDelivery(projectId, link.targetTaskId, currentPlan)) {
            cancelAgentExecution(id)
            continue
          }
          // 沿用原执行的受控启动门禁，重新核对委托、来源、预算和并发上限。
          await tryStartExecution(id)
          const execution = store.getAgentExecution(id)
          if (execution?.status === 'running' && execution.sessionId && link) {
            appendOwnerManagementTrace({
              eventId: `owner-run:${link.planningTaskId}:running`, projectId,
              ...(link.targetTaskId ? { taskId: link.targetTaskId } : {}),
              phase: link.conversationMessageId ? 'owner_response' : 'assignment_run', state: 'started',
              createdAt: Date.now(), detailCode: 'provider_pending',
            })
          }
        }
      }
      // 当前对话消息与业务观察是Owner已承担的管理责任；不能被更晚写入的内部安排Run抢先消费。
      const links = store.getProjectDb().prepare("SELECT planning_task_id, payload FROM project_owner_planning_links WHERE project_id = ? ORDER BY CASE WHEN json_extract(payload, '$.conversationMessageId') IS NOT NULL THEN 0 ELSE 1 END, rowid DESC").all(projectId) as { planning_task_id: string; payload: string }[]
      const conversationSubjects = new Set(links.flatMap(link => {
        const subject = JSON.parse(link.payload) as { targetTaskId?: string; goalRevision?: number; conversationMessageId?: string }
        const subjectKey = subject.targetTaskId ?? 'project'
        return subject.conversationMessageId && getProjectOwnerGoalDraft(projectId, subject.targetTaskId)?.revision === subject.goalRevision ? [subjectKey] : []
      }))
      const recoveryBySubject = new Map<string, { cutoff: number; requestId?: string }>()
      const subjects = new Set<string>()
      const conversations = new Set<string>()
      for (const link of links) {
        if (stopped) break
        const subject = JSON.parse(link.payload) as { targetTaskId?: string; conversationMessageId?: string; purpose?: string; requestId?: string; goalRevision?: number; planRevision?: number }
        const subjectKey = subject.targetTaskId ?? 'project'
        if (subjects.has(subjectKey)) continue
        let recovery = recoveryBySubject.get(subjectKey)
        if (!recovery) {
          const cutoff = getOwnerInitialPlanningRecoveryCutoff(projectId, subject.targetTaskId)
          recovery = { cutoff: cutoff ?? 0, requestId: cutoff === undefined ? undefined : getPendingOwnerInitialPlanningRecovery(projectId, subject.targetTaskId) }
          recoveryBySubject.set(subjectKey, recovery)
        }
        if (recovery.requestId && recovery.requestId !== subject.requestId) continue
        // 过时的对话/观察准备不能占用当前主体的调度位置；新的用户消息由对话恢复逻辑重建。
        if (subject.conversationMessageId && subject.planRevision !== (getProjectOwnerPlanDraft(projectId, subject.targetTaskId)?.revision ?? 0)) continue
        if (subject.conversationMessageId) {
          const message = getOwnerManagementMessage(projectId, subject.conversationMessageId)
          if (message && message.createdAt <= recovery.cutoff) continue
          const conversationKey = `${subjectKey}:${message?.role === 'user' ? 'user' : 'observation'}`
          if (conversations.has(conversationKey)) continue
          // 用户消息和员工观察各保留最新链接，避免后到的观察掩盖尚未启动的用户消息。
          conversations.add(conversationKey)
        }
        // 初始规划Run对应的Link在提案写入后已经过期；待审/已确认方案
        // 必须走内部安排链，不能从旧Link再派发规划Run。
        if (subject.purpose === 'owner_planning' && !subject.conversationMessageId) {
          // 一旦主体已有对话消息链接，旧版初始规划不能在当前消息之后再单独运行，
          // 否则会与用户刚恢复的对话请求重复消耗预算并产生竞争结果。
          // 同版本答复不会产生goal_saved；其已核验的answer_saved准备必须能接续旧对话。
          // 这里只解除重复规划过滤，来源、额度和请求准入仍由启动路径完整重验。
          const answerContinuation = subject.requestId?.startsWith('management:') && store.getProjectDb().prepare(
            "SELECT 1 FROM project_owner_management_events WHERE project_id = ? AND id = ? AND json_extract(payload, '$.kind') = 'answer_saved' AND json_extract(payload, '$.taskId') IS ? AND json_extract(payload, '$.sourceRevision') = ? AND consumed_at IS NOT NULL",
          ).get(projectId, subject.requestId.slice('management:'.length), subject.targetTaskId ?? null, subject.goalRevision ?? null)
          if (conversationSubjects.has(subjectKey) && !answerContinuation && !recovery.requestId) continue
          const plan = getProjectOwnerPlanDraft(projectId, subject.targetTaskId)
          if (plan && ['proposed', 'confirmed'].includes(plan.state)) continue
        }
        const view = getOwnerManagementDelegation(projectId, subject.targetTaskId)
        if (subject.requestId?.startsWith(OWNER_BOUND_REVISION_RETRY_PREFIX)) {
          const retry = readOwnerPlanningSnapshot(link.planning_task_id)
          if (!retry || view.state !== 'active' || !view.delegation?.autonomousExecution || !matchesCurrentBoundRevisionRetry(retry.link, view.delegation.id)) continue
        }
        if (subject.requestId?.startsWith(OWNER_INITIAL_PLAN_RETRY_PREFIX)
          && (view.state !== 'active' || !view.delegation?.autonomousExecution || subject.goalRevision === undefined
            || subject.requestId !== ownerInitialPlanRetryRequestId(view.delegation.id, subject.goalRevision))) continue
        if (view.state === 'stale') continue
        // 最新对话已有Run时不重复调用；后续内部安排仍可继续处理。
        if (store.listAgentExecutionsByEntity('task', link.planning_task_id).length) continue
        subjects.add(subjectKey)
        // 已有调用时等待完成回调；先入队再失败回滚会产生新唤醒，造成忙重试。
        // attention 且可接续（上条仅结论不可继续、仍在预算内）时放行，与对话层和认领闸门判定一致。
        const isQualityRetry = subject.requestId?.startsWith(OWNER_QUALITY_RETRY_PREFIX) === true
        if ((view.state !== 'active' && decideAttentionCarryover(view) !== 'proceed' && !isQualityRetry) || !view.delegation || hasActiveOwnerManagementRequest(view.delegation.id)) continue
        if (isQualityRetry) {
          const { canStartOwnerQualityRetry } = await import('./project-owner-quality-retry')
          const source = readOwnerPlanningSnapshot(link.planning_task_id)
          if (!source || !canStartOwnerQualityRetry(source.link, view.delegation.id)) continue
        }
        if (readOwnerPlanningSnapshot(link.planning_task_id, { allowUnknownPromptForHistory: true })?.context.conversation?.executionObservation && view.delegation?.executionFollowupEnabled !== true) {
          appendOwnerManagementMessage({ projectId, eventId: `followup-scope:${link.planning_task_id}`, role: 'assistant', kind: 'attention', ...(subject.targetTaskId ? { taskId: subject.targetTaskId } : {}), content: '执行结果已保留。此前管理委托未包含主动跟进分析；重新确认管理范围后，我才能在额度内分析，不会自动消耗旧许可。' })
          continue
        }
        if (readOwnerPlanningSnapshot(link.planning_task_id, { allowUnknownPromptForHistory: true })?.context.conversation?.deliveryReview && view.delegation?.fullDeliveryReviewEnabled !== true) {
          appendOwnerManagementMessage({ projectId, eventId: `delivery-scope:${link.planning_task_id}`, role: 'assistant', kind: 'attention', ...(subject.targetTaskId ? { taskId: subject.targetTaskId } : {}), content: '成果已保留。此前管理委托未包含完整成果读取；请在原对话确认新增范围，不会自动消耗旧许可。' })
          continue
        }
        if (readOwnerPlanningSnapshot(link.planning_task_id, { allowUnknownPromptForHistory: true })?.context.conversation?.deliveryReview?.qualityDecisionVersion === 1 && view.delegation?.qualityDecisionEnabled !== true) {
          appendOwnerManagementMessage({ projectId, eventId: `quality-scope:${link.planning_task_id}`, role: 'assistant', kind: 'attention', ...(subject.targetTaskId ? { taskId: subject.targetTaskId } : {}), content: '完整成果和独立检查已保留，旧管理委托不含质量决定；确认管理范围后再继续，不消耗旧额度。' })
          continue
        }
        if (subject.conversationMessageId && view.delegation?.conversationEnabled !== true) {
          appendOwnerManagementMessage({ projectId, eventId: `conversation-scope:${link.planning_task_id}`, role: 'assistant', kind: 'attention', ...(subject.targetTaskId ? { taskId: subject.targetTaskId } : {}), content: '消息已保存。此前管理委托不包含持续对话调用，请先在这里重新确认管理范围；不会自动使用旧额度发送。' })
          continue
        }
        const fuse = subject.conversationMessageId ? findOwnerFollowupFuse(projectId, subject.conversationMessageId) : null
        if (fuse) {
          appendOwnerManagementMessage({ projectId, eventId: `owner-followup-fuse:${fuse}`, role: 'assistant', kind: 'attention',
            ...(subject.targetTaskId ? { taskId: subject.targetTaskId } : {}),
            content: '同一任务的自动跟进已达到上限，后续观察仍会保留。请在项目对话中确认下一步；我不会自动开启更多分析。' })
          continue
        }
        try {
          const { startDelegatedOwnerPlanningTask } = await import('./controlled-project-task-service')
          const sample = prepareOwnerLocalResourceSample()
          if (sample) await sample
          if (readOwnerLocalResourceWait()) {
            recheckOwnerLocalResources(projectId)
            break
          }
          if (stopped || getOwnerManager(projectId)?.status !== 'active') return
          // 质量对话优先于内部安排；交付可能在安排等待期间形成，启动前必须按当前事实再核验。
          const currentPlan = subject.purpose === 'owner_execution_assignment' ? getProjectOwnerPlanDraft(projectId, subject.targetTaskId) : null
          if (currentPlan && (!isOwnerRevisionCurrentForAutomation(currentPlan) || hasCompleteOwnerManagementDelivery(projectId, subject.targetTaskId, currentPlan))) {
            appendOwnerManagementTrace({ eventId: `owner-delivery-arrangement-suppressed:${link.planning_task_id}`, projectId, ...(subject.targetTaskId ? { taskId: subject.targetTaskId } : {}), phase: 'assignment_run', state: 'blocked', createdAt: Date.now(), detailCode: 'no_update' })
            continue
          }
          const started = await startDelegatedOwnerPlanningTask(link.planning_task_id)
          if (!['queued', 'running', 'completed'].includes(started.status)) throw new Error('管理运行尚未成功启动，请核对已有记录')
          const responseRun = Boolean(subject.conversationMessageId)
          appendOwnerManagementTrace({ eventId: `owner-run:${link.planning_task_id}:${started.status}`, projectId, ...(subject.targetTaskId ? { taskId: subject.targetTaskId } : {}), phase: responseRun ? 'owner_response' : 'assignment_run', state: started.status === 'queued' ? 'queued' : started.status === 'completed' ? 'completed' : 'started', createdAt: Date.now(), detailCode: started.status === 'completed' ? 'result_ready' : 'provider_pending' })
          // 对话回应的启动不再回写占位消息，排队与进行状态由 owner_response trace 和界面指示呈现。
          if (!responseRun) {
            appendOwnerManagementMessage({ projectId, eventId: `delegation-start:${view.delegation!.id}:${link.planning_task_id}`, role: 'assistant', kind: 'management_progress', ...(subject.targetTaskId ? { taskId: subject.targetTaskId } : {}), planningTaskId: link.planning_task_id, content: started.status === 'queued' ? '已在你确认的管理额度内排队，等待可用运行位置。' : started.status === 'completed' ? '本次管理请求已完成，正在整理方案或需要与你商量的问题。' : '已在你确认的管理额度内启动规划。我会继续整理方案，有需要决定的问题会在这里与你商量。' })
          }
        } catch (cause) {
          // 旧Link来源被替代不是项目级故障，不能阻断新的授权和对话链接。
          if (cause instanceof OwnerPlanningSourceChangedError) {
            appendOwnerManagementTrace({ eventId: `owner-source-stale:${link.planning_task_id}`, projectId, ...(subject.targetTaskId ? { taskId: subject.targetTaskId } : {}), phase: subject.purpose === 'owner_execution_assignment' ? 'assignment_run' : 'owner_response', state: 'blocked', createdAt: Date.now(), detailCode: 'authorization_changed' })
            continue
          }
          console.warn('[Owner管理] 委托调用需要核对', cause)
          // 提示写入是幂等的，重试不会重复刷屏；但异常必须继续上抛，否则外层退避永远不生效：
          // 这里吞掉异常会让本轮按成功结束并清空失败记录，下一次 30 秒扫描又重来一次。
          // 来源快照校验失败这类确定性错误重试不会自愈，只能靠退避拉开间隔。
          appendOwnerManagementMessage({ projectId, eventId: `delegation:${view.delegation!.id}:${link.planning_task_id}`, role: 'assistant', kind: 'attention', content: '管理调用尚未继续，当前来源、额度或运行需要核对。原目标与记录已保留，不会自动重试已发送请求。' })
          throw cause
        }
        break
      }
    })().then(() => { if (!stopped) failures.clearOwnerManagementFailure(projectId) })
      .catch(cause => { if (!stopped) recordFailure(projectId, cause) }).finally(() => {
      inFlight.delete(projectId)
      inFlightTasks.delete(projectId)
      if (!stopped && pending.has(projectId)) run(projectId)
    })
    inFlightTasks.set(projectId, task)
  }
  const unsubscribeChanges = onChanged ? onOwnerManagementChanged(onChanged) : () => {}
  // 分批让出主进程：多个项目的完整来源校验不能在同一个定时器回调中连续阻塞界面。
  const scheduledProjects = new Set<string>()
  let batchTimer: ReturnType<typeof setTimeout> | undefined
  const runNextProject = (): void => {
    batchTimer = undefined
    if (stopped) return
    const projectId = scheduledProjects.values().next().value
    if (projectId === undefined) return
    scheduledProjects.delete(projectId)
    run(projectId)
    if (scheduledProjects.size && !batchTimer) batchTimer = setTimeout(runNextProject, 0)
  }
  const runAllProjects = (): void => {
    for (const project of store.listProjects()) scheduledProjects.add(project.id)
    if (!batchTimer && scheduledProjects.size) batchTimer = setTimeout(runNextProject, 0)
  }
  // 一个项目释放并发位置，也应唤醒其他项目已经占额的队列。周期扫作为兜底。
  let queueWake: ReturnType<typeof setTimeout> | undefined
  const wake = (projectId: string): void => {
    run(projectId)
    if (stopped || queueWake) return
    queueWake = setTimeout(() => {
      queueWake = undefined
      try {
        for (const queued of queuedOwnerManagementExecutions()) {
          if (!inFlight.has(queued.projectId)) scheduledProjects.add(queued.projectId)
        }
        if (!batchTimer && scheduledProjects.size) batchTimer = setTimeout(runNextProject, 0)
      } catch (cause) { console.warn('[Owner管理] 排队唤醒失败，保留记录等待周期核对', cause) }
    }, 0)
  }
  const unsubscribe = onOwnerManagementWake(wake)
  const unsubscribeSchedule = onOwnerAutonomousScheduleWake(wake)
  requestActiveOwnerManagementRescan = runAllProjects
  const timer = setInterval(runAllProjects, 30_000)
  timer.unref?.()
  // 首次启动沿用既有的同步对账契约；后续周期和唤醒补扫分批执行。
  for (const project of store.listProjects()) run(project.id)
  return async () => {
    stopped = true
    if (batchTimer) clearTimeout(batchTimer)
    if (queueWake) clearTimeout(queueWake)
    scheduledProjects.clear()
    if (requestActiveOwnerManagementRescan === runAllProjects) requestActiveOwnerManagementRescan = null
    clearInterval(timer)
    for (const projectId of wakeTimers.keys()) clearWake(projectId)
    unsubscribe()
    unsubscribeSchedule()
    unsubscribeChanges()
    // 停止只禁止新动作；已经启动的外部请求保持原账本，等待管理轮次退出后再导出证据。
    await Promise.allSettled([...inFlightTasks.values()])
  }
}
