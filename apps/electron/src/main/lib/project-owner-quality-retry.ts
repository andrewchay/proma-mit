import type { OwnerManagementDeliveryReview, OwnerPlanningLink } from '@gravitas/shared'
import * as store from './project-sqlite-store'
import { readOwnerPlanningSnapshot } from './project-owner-planning-source'
import { getOwnerPlanningRunOutcome, getOwnerPlanningRunReceipt } from './project-owner-planning-run-service'
import { assertOwnerQualityRetryBudget, getOwnerManagementClaim, getOwnerManagementDelegation } from './project-owner-management-delegation'
import { appendOwnerManagementMessage, getOwnerManager, getOwnerManagementMessage } from './project-owner-management-store'
import { getProjectOwnerPlanningContext, getProjectOwnerPlanDraft, assertLocalActorEnabled } from './project-owner-plan-service'
import { getOwnerRuntimeBinding, OWNER_QUALITY_RETRY_PREFIX, prepareOwnerPlanning } from './project-owner-runtime-binding'
import { readOwnerExecutionObservation } from './project-owner-management-execution'
import { readOwnerQualityAction } from './project-owner-quality-actions'
import { readOwnerManagementDelivery } from './project-owner-management-delivery'
import { getOwnerExecutionRevalidation } from './project-owner-execution-revalidation'
import { evaluateDevelopmentValidationEvidence, isOwnerValidationEvidenceExpired } from './development-validation-acceptance'
import { ownerQualityBrowserCheckFailed, ownerQualityBrowserRefreshIds, refreshOwnerQualityBrowserEvidence, readDevelopmentValidationEvidence } from './development-validation-service'
import { assertOwnerDispatchNotPaused } from './project-owner-dispatch-control'
import { requestOwnerManagementWake } from './project-owner-management-events'

function readOriginalDecision(projectId: string, taskId: string | undefined, executionId: string, delegationId: string) {
  if (getOwnerManager(projectId)?.status !== 'active') throw new Error('项目 Owner 已暂停')
  const db = store.getProjectDb()
  const execution = store.getAgentExecution(executionId)
  const outcome = getOwnerPlanningRunOutcome(executionId)
  const receipt = outcome && getOwnerPlanningRunReceipt(outcome.receiptId)
  if (execution?.projectId !== projectId || execution.status !== 'failed' || outcome?.state !== 'failed'
    || !receipt?.requestHash || receipt.executionId !== executionId || receipt.sessionId !== execution.sessionId
    || receipt.runtimeResult?.subtype !== 'error_during_execution' || receipt.runtimeResult.finish_reason !== 'length'
    || receipt.stopped || db.prepare('SELECT 1 FROM project_owner_planning_stop_requests WHERE execution_id=?').get(executionId)) {
    throw new Error('原验收请求没有可核对的截断终态')
  }
  const snapshot = readOwnerPlanningSnapshot(receipt.planningTaskId, { allowUnknownPromptForHistory: true })
  const claim = getOwnerManagementClaim(receipt.planningTaskId)
  const frozen = snapshot?.context.conversation?.deliveryReview
  const observation = snapshot?.context.conversation?.executionObservation
  const plan = getProjectOwnerPlanDraft(projectId, taskId)
  if (!snapshot || snapshot.link.id !== receipt.linkId || snapshot.link.targetTaskId !== taskId
    || snapshot.link.projectId !== projectId || claim?.executionId !== executionId || claim.delegationId !== delegationId
    || frozen?.qualityDecisionVersion !== 1 || !frozen.review || observation?.role !== 'reviewer'
    || plan?.state !== 'confirmed' || plan.revision !== snapshot.link.planRevision || plan.goalRevision !== snapshot.link.goalRevision) {
    throw new Error('原验收、当前方案或授权已变化')
  }
  const current = readOwnerExecutionObservation(projectId, observation.executionId, 'terminal')
  const reviewer = db.prepare(`SELECT c.state,c.usage_evidence,g.state AS grant_state,g.expires_at,g.revalidation_id
    FROM project_owner_execution_commands c JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
    WHERE c.id=? AND c.project_id=? AND c.role='reviewer' AND c.execution_id=?
      AND NOT EXISTS (SELECT 1 FROM project_owner_execution_commands n WHERE n.grant_id=c.grant_id AND n.source_task_id=c.source_task_id AND n.rowid>c.rowid)`)
    .get(observation.commandId, projectId, observation.executionId) as { state: string; usage_evidence: string | null; grant_state: string; expires_at: number; revalidation_id: string } | undefined
  if (current.taskId !== taskId || current.observation.commandId !== observation.commandId || reviewer?.state !== 'settled'
    || !reviewer.usage_evidence || reviewer.grant_state !== 'active' || reviewer.expires_at <= Date.now()
    || store.getTask(observation.businessTaskId)?.status !== 'paused' || readOwnerQualityAction(observation.commandId)
    || store.listTaskBlockers(projectId).some(item => item.taskId === observation.businessTaskId)) throw new Error('当前独立评审或执行许可不再适用于恢复')
  assertOwnerDispatchNotPaused(projectId, observation.grantId)
  const revalidation = getOwnerExecutionRevalidation({ projectId, ...(taskId ? { taskId } : {}) })
  if (revalidation.status !== 'current' || revalidation.revalidation?.id !== reviewer.revalidation_id) throw new Error('当前成果或执行范围已改变，需重新核对')
  const delivery = readOwnerManagementDelivery(projectId, current.observation)
  if (delivery.state !== 'available' || delivery.review?.artifactHash !== frozen.review.artifactHash
    || delivery.review.verdict !== 'approved') throw new Error('原成果及独立评审无法核验')
  return { current, plan, snapshot, delivery }
}

function browserRefreshIds(requestId: string, delivery: OwnerManagementDeliveryReview): [string, string] | undefined {
  const artifact = delivery.developmentArtifact
  if (!requestId.startsWith(OWNER_QUALITY_RETRY_PREFIX) || !artifact || artifact.validationEvidence.length !== 1
    || artifact.validationEvidence[0]?.command !== 'browser:html.loads') return undefined
  return ownerQualityBrowserRefreshIds(requestId, artifact.contentHash)
}

/** 只为明确续验的冻结快照投影新证据，原评审正文和依据原样保留。 */
export function applyOwnerQualityBrowserRefresh(delivery: OwnerManagementDeliveryReview, requestId: string, frozenValidationId?: string | false): OwnerManagementDeliveryReview {
  const artifact = delivery.developmentArtifact, review = delivery.review
  const ids = browserRefreshIds(requestId, delivery)
  if (!ids || !artifact || !review || frozenValidationId === false || (frozenValidationId && !ids.includes(frozenValidationId))) return delivery
  let id = frozenValidationId ?? ids[0]
  let proof: ReturnType<typeof readDevelopmentValidationEvidence>
  try { proof = readDevelopmentValidationEvidence(artifact.taskId, artifact.executorExecutionId, id) }
  catch (error) { if (frozenValidationId) throw error; return delivery }
  if (!frozenValidationId && ownerQualityBrowserCheckFailed(proof, artifact.contentHash)) {
    id = ids[1]
    try { proof = readDevelopmentValidationEvidence(artifact.taskId, artifact.executorExecutionId, id) }
    catch { throw new Error('浏览器补跑尚无可采信的成功回执') }
  }
  const v = proof.result
  if (v.id !== id || v.command !== 'browser:html.loads' || v.method !== 'browser_assertions'
    || v.binding?.projectId !== artifact.projectId
    || !evaluateDevelopmentValidationEvidence(proof, { expectedSnapshotHash: artifact.contentHash, ...(frozenValidationId ? { now: v.finishedAt } : {}) }).accepted
    || !v.rawOutputSha256 || !Number.isSafeInteger(v.rawOutputByteLength)) {
    throw new Error('补跑浏览器回执无法核验')
  }
  const validationEvidence = [{ command: v.command, validationId: v.id, attemptState: 'completed' as const,
    freshness: 'fresh' as const, status: v.status, exitCode: v.exitCode, timedOut: v.timedOut,
    outputTail: v.outputTail, outputTruncated: v.outputTruncated, rawOutputSha256: v.rawOutputSha256,
    rawOutputByteLength: v.rawOutputByteLength!, finishedAt: v.finishedAt }]
  return { ...delivery, validationRefresh: validationEvidence }
}

function assertFreshRetryEvidence(delivery: OwnerManagementDeliveryReview, requestId: string): void {
  const checked = applyOwnerQualityBrowserRefresh(delivery, requestId)
  if ((checked.validationRefresh ?? checked.developmentArtifact?.validationEvidence)?.some(item => isOwnerValidationEvidenceExpired(item))) {
    throw new Error('原成果验证已过期，补跑回执尚未就绪')
  }
}

/** 只允许用户确认产生的链接重走同一成果的验收。 */
export function canStartOwnerQualityRetry(link: OwnerPlanningLink, delegationId: string): boolean {
  if (!link.requestId.startsWith(OWNER_QUALITY_RETRY_PREFIX) || !link.conversationMessageId) return false
  const [executionId, originalDelegationId, extra] = link.requestId.slice(OWNER_QUALITY_RETRY_PREFIX.length).split(':')
  if (!executionId || extra !== undefined || originalDelegationId !== delegationId) return false
  const message = getOwnerManagementMessage(link.projectId, link.conversationMessageId)
  if (message?.eventId !== link.requestId || message.kind !== 'execution_observation' || message.role !== 'assistant') return false
  try {
    const { current, snapshot, delivery } = readOriginalDecision(link.projectId, link.targetTaskId, executionId, delegationId)
    assertFreshRetryEvidence(delivery, link.requestId)
    return link.goalRevision === snapshot.link.goalRevision && link.planRevision === snapshot.link.planRevision
      && JSON.stringify(message.executionObservation) === JSON.stringify(current.observation)
  } catch { return false }
}

type OwnerQualityRetryResult = { planningTaskId: string } | { failedValidationId: string }
async function prepareRetry(projectId: string, taskId: string | undefined, executionId: string, failedValidationId?: string): Promise<OwnerQualityRetryResult> {
  assertLocalActorEnabled()
  const db = store.getProjectDb()
  const initialView = getOwnerManagementDelegation(projectId, taskId)
  const initialGrant = initialView.delegation
  if (!initialGrant) throw new Error('当前项目没有有效的管理授权')
  const retryId = `${OWNER_QUALITY_RETRY_PREFIX}${executionId}:${initialGrant.id}`
  if (initialView.attentionCheck?.retryExecutionId === executionId) {
    assertOwnerQualityRetryBudget(initialView)
    const { delivery } = readOriginalDecision(projectId, taskId, executionId, initialGrant.id)
    const artifact = delivery.developmentArtifact
    if (artifact?.validationEvidence.some(item => isOwnerValidationEvidenceExpired(item))) {
      const attemptIds = browserRefreshIds(retryId, delivery)
      if (!attemptIds) throw new Error('此成果的过期验证需要单独核对')
      const result = await refreshOwnerQualityBrowserEvidence({ ...artifact, requestId: retryId, qualityRetryExecutionId: executionId, failedValidationId, artifactHash: artifact.contentHash })
      if (result.status === 'failed' && result.exitCode === 1) {
        if (result.id === attemptIds[0]) return { failedValidationId: result.id }
        throw new Error('浏览器检查重试后仍失败，已保留两次检查记录，请核对成果。')
      }
      assertFreshRetryEvidence(delivery, retryId)
    }
  }
  let result: { planningTaskId: string } | undefined
  db.transaction(() => {
    const view = getOwnerManagementDelegation(projectId, taskId)
    const grant = view.delegation
    if (!grant || grant.id !== initialGrant.id || getOwnerManager(projectId)?.status !== 'active') throw new Error('当前项目没有有效的管理授权')
    const requestId = `${OWNER_QUALITY_RETRY_PREFIX}${executionId}:${grant.id}`
    const existing = db.prepare('SELECT planning_task_id FROM project_owner_planning_links WHERE project_id=? AND request_id=?')
      .get(projectId, requestId) as { planning_task_id: string } | undefined
    if (existing) { result = { planningTaskId: existing.planning_task_id }; return }
    if (view.state !== 'attention' || view.attentionCheck?.phase !== 'quality_decision'
      || view.attentionCheck.retryExecutionId !== executionId || grant.expiresAt <= Date.now()) throw new Error('当前没有可续验的截断请求')
    assertOwnerQualityRetryBudget(view)
    const { current, plan, snapshot, delivery } = readOriginalDecision(projectId, taskId, executionId, grant.id)
    assertFreshRetryEvidence(delivery, requestId)
    const context = getProjectOwnerPlanningContext(projectId, taskId)
    const binding = getOwnerRuntimeBinding(projectId)
    if (!binding || snapshot.link.bindingRevision !== binding.revision || snapshot.context.fingerprint !== context.fingerprint) throw new Error('模型或项目资料已变化')
    const message = appendOwnerManagementMessage({ projectId, ...(taskId ? { taskId } : {}), eventId: requestId,
      role: 'assistant', kind: 'execution_observation', goalRevision: plan.goalRevision, executionObservation: current.observation,
      content: '已确认沿用原成果和原独立评审，仅重新运行一次成果验收。原请求的费用记录保留。' })
    const link = prepareOwnerPlanning(projectId, { requestId, ...(taskId ? { taskId } : {}), conversationMessageId: message.id,
      expectedBindingRevision: binding.revision, expectedGoalRevision: plan.goalRevision, expectedPlanRevision: plan.revision, expectedContextFingerprint: context.fingerprint }, 'quality_retry')
    result = { planningTaskId: link.planningTaskId }
  })()
  if (!result) throw new Error('未保存成果续验请求')
  requestOwnerManagementWake(projectId)
  return result
}


const activeRetries = new Map<string, Promise<OwnerQualityRetryResult>>()
export function prepareOwnerQualityRetry(projectId: string, taskId: string | undefined, executionId: string, failedValidationId?: string): Promise<OwnerQualityRetryResult> {
  const key = JSON.stringify([projectId, taskId, executionId, failedValidationId])
  const existing = activeRetries.get(key)
  if (existing) return existing
  const operation = prepareRetry(projectId, taskId, executionId, failedValidationId).finally(() => activeRetries.delete(key))
  activeRetries.set(key, operation)
  return operation
}
