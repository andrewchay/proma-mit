import { readOwnerGrantUsage } from './project-owner-execution-settlement'
/** 将准确成果及逐项检查送入Owner分析；不授予验收或业务动作权限。 */
import type { OwnerExecutionObservation, OwnerExecutionRevalidationRecord, OwnerExecutionRevalidationTask, OwnerManagementDeliveryItem, OwnerManagementDeliveryReview } from '@gravitas/shared'
import { readOwnerTextDelivery, assertOwnerReviewerTextDelivery } from './project-owner-text-delivery'
import { listOwnerTechnicalReviewEvidence } from './project-owner-technical-review'
import { readOwnerCommandFrozenSource } from './project-owner-employee-runtime'
import { getOwnerQualityRecovery, readOwnerQualityAction } from './project-owner-quality-actions'
import { ownerExecutionHash } from './project-owner-execution-hash'
import { getOwnerExecutionRevalidation, listOwnerExecutionRevalidationHistory } from './project-owner-execution-revalidation'
import { getOwnerTaskMaterializationRecord } from './project-owner-task-materialization'
import { isCompletedStatus } from './task-status-logic'
import * as store from './project-sqlite-store'
import { appendOwnerManagementMessage, getOwnerManager } from './project-owner-management-store'

export function readOwnerManagementDelivery(projectId: string, observation: OwnerExecutionObservation): OwnerManagementDeliveryReview {
  const base = { version: 1 as const }
  if (observation.trigger !== 'terminal' || observation.executionStatus !== 'completed') return { ...base, state: 'unavailable', detail: '本次工作没有完整完成成果，不能作质量结论。' }
  try {
    const frozen = readOwnerCommandFrozenSource(observation.commandId).source
    const technicalReview = observation.role === 'reviewer' ? listOwnerTechnicalReviewEvidence(projectId, observation.businessTaskId).find(item => item.reviewerCommandId === observation.commandId && item.reviewerExecutionId === observation.executionId && item.artifactVerified === true) : undefined
    const developmentArtifact = frozen.executionKind === 'development' && observation.role === 'reviewer' ? technicalReview?.developmentArtifact : undefined
    const artifact = developmentArtifact ? undefined : observation.role === 'reviewer' ? assertOwnerReviewerTextDelivery(observation.commandId) : readOwnerTextDelivery(observation.commandId, true)
    if (!artifact && !developmentArtifact) {
      if (frozen.textDeliveryVersion === 1 || frozen.executionKind === 'development') throw new Error('已冻结成果正文缺失')
      return { ...base, state: 'legacy', detail: '本次来源未提供可核验的完整文本成果；旧摘要不能作为已读全文的证明。' }
    }
    if (artifact && (artifact.projectId !== projectId || artifact.grantId !== observation.grantId || artifact.taskId !== observation.businessTaskId || artifact.planRevision !== observation.sourcePlanRevision)) throw new Error('成果与Owner观察归属不一致')
    if (developmentArtifact && (!technicalReview || developmentArtifact.executorCommandId !== technicalReview.executorCommandId || developmentArtifact.executorExecutionId !== technicalReview.executorExecutionId
      || developmentArtifact.projectId !== projectId || developmentArtifact.grantId !== observation.grantId || developmentArtifact.taskId !== observation.businessTaskId
      || developmentArtifact.stepLinkId !== technicalReview.stepLinkId || developmentArtifact.sourceHash !== technicalReview.sourceHash
      || developmentArtifact.planRevision !== observation.sourcePlanRevision)) throw new Error('代码快照与独立评审执行来源不一致')
    const artifactHash = developmentArtifact?.contentHash ?? artifact?.contentSha256
    const review = technicalReview?.artifactHash === artifactHash ? technicalReview : undefined
    if (observation.role === 'reviewer' && !review) throw new Error('缺少准确版本的逐项独立检查')
    const result: OwnerManagementDeliveryReview = { ...base, state: 'available', detail: developmentArtifact ? '已核对准确代码快照及独立检查；本地验证和代码内容不证明外部事实。' : '完整正文已核对账本摘要；语义质量和外部事实仍需按标准判断。', ...(artifact ? { artifact } : {}), ...(developmentArtifact ? { developmentArtifact } : {}),
      ...(review ? { review: { reviewerCommandId: review.reviewerCommandId, artifactHash: artifactHash!, verdict: review.verdict, criteria: review.criteria.map(item => ({ ...item, quote: item.quote ?? null })), findings: review.findings, ...(review.validationEvidence ? { validationEvidence: review.validationEvidence } : {}) } } : {}) }
    if (review && frozen.qualityManagementVersion === 1) {
      const usage = readOwnerGrantUsage(observation.grantId)
      const reworkOrdinal = developmentArtifact?.reworkOrdinal ?? artifact?.reworkOrdinal
      if (!Number.isSafeInteger(reworkOrdinal)) throw new Error('Owner质量额度缺少成果返工轮次')
      result.qualityDecisionVersion = 1
      result.qualityLimits = { maxRework: frozen.budget.maxRework, remainingRework: Math.max(0, frozen.budget.maxRework - reworkOrdinal!), remainingRuns: Math.max(0, frozen.budget.maxRuns - usage.runReservations), remainingCostMicros: Math.max(0, frozen.budget.maxCostMicros - usage.committedCostMicros) }
      result.qualityRecovery = getOwnerQualityRecovery(projectId, observation.commandId) ?? undefined
    }
    if (JSON.stringify(result).length > 140000) return { ...base, state: 'unavailable', detail: '完整成果与检查的JSON超出140000字符管理输入上限；正文保留，不截断为通过依据，需要调整交付后再审。' }
    return result
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException)?.code
    return { ...base, state: 'unavailable', detail: code ? `本机成果读取失败（${code}）；保留原记录，不从摘要补造。` : '完整成果或逐项检查未能核验；保留原记录，不从摘要补造。' }
  }
}

interface OwnerDeliveryGrant {
  id: string
  state: string
  task_id: string | null
  revalidation_id: string
  revalidation_revision: number
  revalidation_integrity_hash: string
  materialization_id: string
  materialization_integrity_hash: string
}

/** 单独核验一份执行授权；其他批次的状态不影响本批交付。 */
function publishGrantCompletion(projectId: string, grant: OwnerDeliveryGrant): boolean {
  const subject = { projectId, ...(grant.task_id ? { taskId: grant.task_id } : {}) }
  const current = getOwnerExecutionRevalidation(subject)
  const matchesGrant = (record: OwnerExecutionRevalidationRecord) => record.id === grant.revalidation_id && record.revision === grant.revalidation_revision
    && record.integrityHash === grant.revalidation_integrity_hash && record.source.materialization.id === grant.materialization_id
    && record.source.materialization.integrityHash === grant.materialization_integrity_hash
  const currentRecord = current.status === 'current' && current.revalidation && matchesGrant(current.revalidation) ? current.revalidation : null
  const historicalRecord = grant.state === 'paused'
    ? listOwnerExecutionRevalidationHistory(subject).find(matchesGrant) ?? null
    : null
  const record = currentRecord ?? historicalRecord
  if (!record || record.source.materialization.id !== grant.materialization_id
    || record.source.materialization.integrityHash !== grant.materialization_integrity_hash || record.source.qualityManagementVersion !== 1
    || record.source.tasks.length === 0 || record.source.tasks.length > 32) return false

  const batch = getOwnerTaskMaterializationRecord(projectId, record.source.materialization.id)
  if (batch.integrityHash !== record.source.materialization.integrityHash || batch.links.length !== record.source.tasks.length) return false
  const taskStatuses = store.listTaskStatuses(projectId)
  const items: OwnerManagementDeliveryItem[] = []
  for (const taskSource of record.source.tasks as OwnerExecutionRevalidationTask[]) {
    const link = batch.links.find(item => item.id === taskSource.linkId && item.taskId === taskSource.taskId)
    const task = store.getTask(taskSource.taskId)
    if (!link || !task || task.projectId !== projectId || task.ownerStepLinkId !== link.id || !isCompletedStatus(task.status, taskStatuses)) return false
    const actionRow = store.getProjectDb().prepare(`SELECT reviewer_command_id FROM project_owner_quality_actions
      WHERE grant_id=? AND task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(grant.id, task.id) as { reviewer_command_id: string } | undefined
    if (!actionRow) return false
    const action = readOwnerQualityAction(actionRow.reviewer_command_id)
    if (!action || action.grantId !== grant.id || action.taskId !== task.id || action.state !== 'accepted') return false
    const frozen = readOwnerCommandFrozenSource(action.reviewerCommandId).source
    const technicalEvidence = listOwnerTechnicalReviewEvidence(projectId, task.id).find(item => item.reviewerCommandId === action.reviewerCommandId && item.artifactVerified === true)
    const developmentArtifact = frozen.executionKind === 'development' ? technicalEvidence?.developmentArtifact : undefined
    if (frozen.executionKind === 'development' && (!technicalEvidence?.validationEvidenceVerified || !technicalEvidence.validationEvidence
      || technicalEvidence.validationEvidence.some(item => item.attemptState !== 'completed' || item.freshness !== 'fresh' || item.status !== 'passed'
        || item.exitCode !== 0 || item.timedOut !== false || item.outputTruncated !== false || !item.rawOutputSha256 || !Number.isSafeInteger(item.rawOutputByteLength)))) return false
    const artifact = developmentArtifact ? undefined : assertOwnerReviewerTextDelivery(action.reviewerCommandId)
    const artifactHash = developmentArtifact?.contentHash ?? artifact?.contentSha256
    const artifactContent = developmentArtifact?.content ?? artifact?.content
    if (!artifactHash || !artifactContent || artifactHash !== action.artifactHash) return false
    const review = listOwnerTechnicalReviewEvidence(projectId, task.id).find(item => item.reviewerCommandId === action.reviewerCommandId
      && item.grantId === grant.id && item.stepLinkId === link.id && item.artifactVerified === true
      && item.artifactHash === artifactHash && item.verdict === 'approved')
    if (!review) return false
    items.push({ stepKey: link.stepKey, title: link.projection.title, acceptanceCriteria: link.projection.acceptanceCriteria,
      artifactHash, content: artifactContent, ownerDecision: action.detail, reviewerSummary: review.summary })
  }
  const delivery = { schemaVersion: 1 as const, planVersion: record.source.planVersion, items }
  if (JSON.stringify(delivery).length > 2_000_000) return false
  const bundleHash = ownerExecutionHash(delivery)
  appendOwnerManagementMessage({ projectId, eventId: `owner-delivery:${grant.id}:${bundleHash}`, ...(grant.task_id ? { taskId: grant.task_id } : {}),
    role: 'assistant', kind: 'delivery', delivery,
    content: `本轮工作已完成，Owner已按约定标准验收并核对独立评审。以下保留员工提交的成果原文；验收与评审不代表外部事实已另行证实。` })
  return true
}

/** 每份授权批次独立检查；较新的未完成批次不能挡住已完成批次回到Owner对话。 */
export function publishOwnerManagementCompletion(projectId: string): boolean {
  const manager = getOwnerManager(projectId)
  if (!manager || manager.status !== 'active') return false
  const grants = store.getProjectDb().prepare(`SELECT id, state, task_id, revalidation_id, revalidation_revision,
      revalidation_integrity_hash, materialization_id, materialization_integrity_hash
    FROM project_owner_execution_grants g WHERE project_id=? AND NOT EXISTS (
      SELECT 1 FROM project_owner_management_messages m WHERE m.project_id=g.project_id AND m.event_id LIKE 'owner-delivery:' || g.id || ':%'
    ) ORDER BY issued_at, id`).all(projectId) as OwnerDeliveryGrant[]
  let published = false
  for (const grant of grants) {
    try {
      if (publishGrantCompletion(projectId, grant)) published = true
    } catch (cause) {
      console.warn('[Owner交付] 单个授权批次尚未能投影，继续检查其他批次', grant.id, cause)
    }
  }
  return published
}
