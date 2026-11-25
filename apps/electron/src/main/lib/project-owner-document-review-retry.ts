/** 明确确认后，以原 Markdown 快照补齐本地验证，再安排一次独立评审。 */
import type { DevelopmentValidationResult } from '@gravitas/shared'
import { readDevelopmentValidationEvidence, runOwnerMarkdownSupplement } from './development-validation-service'
import { evaluateDevelopmentValidationEvidence } from './development-validation-acceptance'
import { MARKDOWN_VERIFICATION_COMMAND } from './owner-runtime-verification-command'
import { ownerExecutionHash } from './project-owner-execution-hash'
import { assertLocalActorEnabled } from './project-owner-plan-service'
import { listOwnerTechnicalReviewEvidence, type OwnerTechnicalReviewEvidence } from './project-owner-technical-review'
import { requestOwnerAutonomousScheduleWake } from './project-owner-autonomous-scheduler-events'
import * as store from './project-sqlite-store'

interface DocumentReviewRetry {
  projectId: string
  grantId: string
  taskId: string
  ordinal: number
  previousReviewerId: string
  reviewerId: string
  executorId: string
  validation: DevelopmentValidationResult
}
interface RetryRow {
  previous_reviewer_id: string
  reviewer_id: string
  grant_id: string
  task_id: string
  ordinal: number
  validation_id: string
  payload: string
  integrity_hash: string
}

export function ownerDocumentReviewRetryKey(reviewerId: string): string {
  return `owner-document-review-${ownerExecutionHash({ reviewerId })}`
}

export function readOwnerDocumentReviewRetry(key: { reviewerId: string } | { validationId: string } | { grantId: string; taskId: string; ordinal: number }): DocumentReviewRetry | null {
  const db = store.getProjectDb()
  let row: RetryRow | undefined
  if ('reviewerId' in key) row = db.prepare('SELECT * FROM project_owner_document_review_retries WHERE reviewer_id=?').get(key.reviewerId) as RetryRow | undefined
  else if ('validationId' in key) row = db.prepare('SELECT * FROM project_owner_document_review_retries WHERE validation_id=?').get(key.validationId) as RetryRow | undefined
  else row = db.prepare('SELECT * FROM project_owner_document_review_retries WHERE grant_id=? AND task_id=? AND ordinal=?').get(key.grantId, key.taskId, key.ordinal) as RetryRow | undefined
  if (!row) return null
  const value = JSON.parse(row.payload) as DocumentReviewRetry
  if (ownerExecutionHash(value) !== row.integrity_hash || value.previousReviewerId !== row.previous_reviewer_id
    || value.reviewerId !== row.reviewer_id || value.grantId !== row.grant_id || value.taskId !== row.task_id || value.ordinal !== row.ordinal
    || value.validation.id !== row.validation_id || value.validation.taskId !== value.taskId || value.validation.binding?.projectId !== value.projectId
    || value.validation.command !== MARKDOWN_VERIFICATION_COMMAND || value.validation.status !== 'passed'
    || value.reviewerId !== `owner-auto-command-${ownerExecutionHash({ idempotencyKey: ownerDocumentReviewRetryKey(value.previousReviewerId) }).slice(0, 48)}`) {
    throw new Error('Owner Markdown 复核记录完整性无效')
  }
  return value
}

export function canRetryOwnerMarkdownReview(review: OwnerTechnicalReviewEvidence): boolean {
  return review.verdict === 'blocked' && review.artifactVerified === true && Boolean(review.developmentArtifact)
    && review.findings.length === 0 && review.validationEvidence?.length === 1
    && review.validationEvidence[0]?.command === 'browser:html.loads'
    && review.validationEvidence[0]?.status !== 'passed'
    && store.getTask(review.taskId)?.developmentScope?.targetPaths.every(path => /\.md$/i.test(path)) === true
}

export function readOwnerDocumentReviewValidation(reviewerId: string, executorId: string, artifactHash: string) {
  const retry = readOwnerDocumentReviewRetry({ reviewerId })
  if (!retry) return null
  if (retry.executorId !== executorId || retry.validation.snapshotContentHash !== artifactHash) throw new Error('Markdown 复核与原执行产物不匹配')
  const result = retry.validation
  const evidence = readDevelopmentValidationEvidence(retry.taskId, result.executionId, result.id)
  if (ownerExecutionHash(evidence.result) !== ownerExecutionHash(result)
    || !evaluateDevelopmentValidationEvidence(evidence, { expectedSnapshotHash: artifactHash }).accepted) throw new Error('Markdown 验证已过期或原快照有变化')
  return {
    command: result.command, validationId: result.id, attemptState: 'completed' as const,
    freshness: 'fresh' as const, status: result.status, exitCode: result.exitCode,
    timedOut: result.timedOut, outputTail: result.outputTail, outputTruncated: result.outputTruncated,
    rawOutputSha256: result.rawOutputSha256, rawOutputByteLength: result.rawOutputByteLength,
    finishedAt: result.finishedAt,
  }
}

const inFlight = new Map<string, Promise<{ reviewerCommandId: string }>>()

export function retryOwnerMarkdownReview(projectId: string, previousReviewerId: string): Promise<{ reviewerCommandId: string }> {
  assertLocalActorEnabled()
  const pending = inFlight.get(previousReviewerId)
  if (pending) return pending.then(result => {
    if (readOwnerDocumentReviewRetry({ reviewerId: result.reviewerCommandId })?.projectId !== projectId) throw new Error('评审不属于本项目')
    return result
  })
  const operation = retry(projectId, previousReviewerId)
  inFlight.set(previousReviewerId, operation)
  return operation.finally(() => { inFlight.delete(previousReviewerId) })
}

function queueReview(retry: DocumentReviewRetry, expectedRevalidationRevision: number) {
  const { getOwnerAutonomousScheduleStatus } = require('./project-owner-autonomous-scheduler') as typeof import('./project-owner-autonomous-scheduler')
  const schedule = getOwnerAutonomousScheduleStatus(retry.projectId)
  if (schedule.state !== 'ready' || schedule.grantId !== retry.grantId || schedule.taskId !== retry.taskId
    || schedule.role !== 'reviewer' || schedule.reworkOrdinal !== retry.ordinal) throw new Error(schedule.reason)
  const { reserveAndQueueAutonomousOwnerCommand } = require('./project-owner-execution-command') as typeof import('./project-owner-execution-command')
  reserveAndQueueAutonomousOwnerCommand({ projectId: retry.projectId }, {
    grantId: retry.grantId, taskId: retry.taskId, role: 'reviewer', reworkOrdinal: retry.ordinal, expectedRevalidationRevision,
  })
}

async function retry(projectId: string, previousReviewerId: string): Promise<{ reviewerCommandId: string }> {
  const db = store.getProjectDb()
  const reviewerId = `owner-auto-command-${ownerExecutionHash({ idempotencyKey: ownerDocumentReviewRetryKey(previousReviewerId) }).slice(0, 48)}`
  const prior = readOwnerDocumentReviewRetry({ reviewerId })
  if (prior && prior.projectId !== projectId) throw new Error('评审不属于本项目')
  const queued = () => Boolean(db.prepare('SELECT 1 FROM project_owner_execution_commands WHERE id=? AND project_id=?').get(reviewerId, projectId))
  if (prior && queued()) {
    requestOwnerAutonomousScheduleWake(projectId)
    return { reviewerCommandId: reviewerId }
  }
  const check = () => {
    const review = listOwnerTechnicalReviewEvidence(projectId, undefined, [previousReviewerId], false)[0]
    if (!review?.artifactHash || !canRetryOwnerMarkdownReview(review)) throw new Error('仅能复核因错误网页验证而阻塞的 Markdown 原成果')
    const task = store.getTask(review.taskId)
    if (task?.status !== 'paused' || task.projectId !== projectId || task.ownerStepLinkId !== review.stepLinkId) throw new Error('任务状态或工作范围已变化')
    const eligible = db.prepare(`SELECT g.revalidation_revision FROM project_owner_execution_commands c
      JOIN agent_executions e ON e.id=c.execution_id AND e.project_id=c.project_id AND e.owner_command_id=c.id
      JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
      WHERE c.id=? AND c.project_id=? AND c.state='settled' AND c.actual_cost_micros IS NOT NULL
        AND c.usage_record_key IS NOT NULL AND e.status='completed' AND g.state='active'
        AND g.dispatch_mode='autonomous' AND g.expires_at>?
        AND NOT EXISTS (SELECT 1 FROM project_owner_execution_commands later
          WHERE later.grant_id=c.grant_id AND later.source_task_id=c.source_task_id AND later.rowid>c.rowid)
    `).get(previousReviewerId, projectId, Date.now()) as { revalidation_revision: number } | undefined
    if (!eligible) throw new Error('原评审或费用未结算、已有后续运行，或执行授权已失效')
    const { assertOwnerDispatchNotPaused } = require('./project-owner-dispatch-control') as typeof import('./project-owner-dispatch-control')
    assertOwnerDispatchNotPaused(projectId, review.grantId)
    return { review, revalidationRevision: eligible.revalidation_revision }
  }
  const { review } = check()
  const validation = await runOwnerMarkdownSupplement(review.taskId, review.executorExecutionId, review.artifactHash!, review.executorCommandId)
  if (validation.status !== 'passed') throw new Error('原 Markdown 文件验证未通过，未安排独立评审')
  const { review: latest, revalidationRevision } = check()
  if (latest.artifactHash !== review.artifactHash || latest.responseSha256 !== review.responseSha256) throw new Error('原评审或文件已发生变化')
  const value: DocumentReviewRetry = { projectId, grantId: review.grantId, taskId: review.taskId, ordinal: review.reworkOrdinal,
    previousReviewerId, reviewerId, executorId: review.executorCommandId, validation }
  db.prepare(`INSERT INTO project_owner_document_review_retries VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(previous_reviewer_id) DO UPDATE SET payload=excluded.payload, integrity_hash=excluded.integrity_hash
    WHERE NOT EXISTS (SELECT 1 FROM project_owner_execution_commands c WHERE c.id=excluded.reviewer_id)`)
    .run(previousReviewerId, reviewerId, value.grantId, value.taskId, value.ordinal, validation.id, JSON.stringify(value), ownerExecutionHash(value))
  try { queueReview(value, revalidationRevision) }
  catch (error) {
    db.prepare(`DELETE FROM project_owner_document_review_retries WHERE reviewer_id=?
      AND NOT EXISTS (SELECT 1 FROM project_owner_execution_commands c WHERE c.id=?)`).run(reviewerId, reviewerId)
    if (!queued()) throw error
  }
  store.recordProjectActivity({ projectId, entityType: 'task', entityId: value.taskId, action: 'owner_document_review_retry', actor: 'local-user',
    summary: '用户确认保留 Markdown 文件，补验证后另行运行一次独立评审', payload: { previousReviewerId, reviewerId, validationId: validation.id } })
  requestOwnerAutonomousScheduleWake(projectId)
  return { reviewerCommandId: reviewerId }
}
