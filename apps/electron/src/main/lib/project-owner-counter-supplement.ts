/** 计数器补测证据独立入账，原始评审与研发快照可按各自的版本重放。 */
import { createHash } from 'node:crypto'
import type { DevelopmentValidationResult } from '@gravitas/shared'
import { evaluateDevelopmentValidationEvidence } from './development-validation-acceptance'
import { OWNER_COUNTER_SUPPLEMENT_COMMAND, readDevelopmentValidationEvidence, runOwnerCounterSupplement } from './development-validation-service'
import { ownerExecutionHash } from './project-owner-execution-hash'
import { appendOwnerManagementMessage } from './project-owner-management-store'
import { requestOwnerManagementWake } from './project-owner-management-events'
import type { OwnerTechnicalReviewEvidence } from './project-owner-technical-review'
import * as store from './project-sqlite-store'

interface CounterSupplement {
  reviewerCommandId: string
  reviewHash: string
  artifactHash: string
  validation: DevelopmentValidationResult
}

export function canSupplementOwnerCounterReview(review: OwnerTechnicalReviewEvidence): boolean {
  const [initial, interaction] = review.criteria
  const text = (value: string) => value.replace(/[\s，。！？]/g, '')
  return review.verdict === 'blocked' && review.artifactVerified === true && !!review.developmentArtifact
    && review.findings.length === 0 && review.criteria.length === 2
    && initial?.status === 'met' && /^打开(?:文件|页面)后初值(?:显示|为)0$/.test(text(initial.criterion))
    && interaction?.status === 'not_verified' && /^点击加一后(?:显示|为)1再点(?:击)?重置后(?:回到|为)0$/.test(text(interaction.criterion))
    && review.validationEvidence?.length === 1 && review.validationEvidence[0]?.command === 'browser:html.loads'
}

export function readOwnerCounterSupplement(reviewerCommandId: string, validationId?: string): CounterSupplement | null {
  const row = store.getProjectDb().prepare(`SELECT validation_id,created_at,payload,integrity_hash FROM project_owner_counter_supplements
    WHERE reviewer_command_id=? AND (? IS NULL OR validation_id=?) ORDER BY created_at DESC,rowid DESC LIMIT 1`)
    .get(reviewerCommandId, validationId ?? null, validationId ?? null) as { validation_id: string; created_at: number; payload: string; integrity_hash: string } | undefined
  if (!row) return null
  const value = JSON.parse(row.payload) as CounterSupplement
  const v = value.validation
  if (ownerExecutionHash(value) !== row.integrity_hash || value.reviewerCommandId !== reviewerCommandId || v.id !== row.validation_id
    || !/^val-[a-f0-9]{64}$/.test(v.id) || v.finishedAt !== row.created_at || v.snapshotContentHash !== value.artifactHash || v.command !== OWNER_COUNTER_SUPPLEMENT_COMMAND
    || v.method !== 'browser_assertions' || v.checks?.length !== 2
    || !['html.loads', 'counter.increment-reset'].every(id => v.checks?.some(check => check.id === id && check.status === 'passed'))
    || !evaluateDevelopmentValidationEvidence({ result: v, freshness: 'fresh' }, { expectedSnapshotHash: value.artifactHash, now: v.finishedAt }).accepted
    || v.outputTail !== JSON.stringify(v.checks) || v.rawOutputByteLength !== Buffer.byteLength(v.outputTail)
    || v.rawOutputSha256 !== createHash('sha256').update(v.outputTail).digest('hex')) throw new Error('Owner计数器补测记录不一致')
  return value
}

export function isOwnerCounterSupplementCurrent(supplement: CounterSupplement): boolean {
  const v = supplement.validation
  try {
    const current = readDevelopmentValidationEvidence(v.taskId, v.executionId, v.id)
    return ownerExecutionHash(current.result) === ownerExecutionHash(v)
      && evaluateDevelopmentValidationEvidence(current, { expectedSnapshotHash: supplement.artifactHash }).accepted
  } catch { return false }
}

export function applyOwnerCounterSupplement(review: OwnerTechnicalReviewEvidence, validationId?: string): OwnerTechnicalReviewEvidence {
  if (!canSupplementOwnerCounterReview(review)) return review
  const supplement = readOwnerCounterSupplement(review.reviewerCommandId, validationId)
  if (!supplement) return review
  const v = supplement.validation
  if (supplement.reviewHash !== review.responseSha256 || supplement.artifactHash !== review.artifactHash
    || v.executionId !== review.executorExecutionId || v.taskId !== review.taskId || v.binding?.projectId !== review.projectId)
    throw new Error('Owner计数器补测跨成果或执行来源')
  const validationEvidence = [{
    command: v.command, validationId: v.id, attemptState: 'completed' as const, freshness: 'fresh' as const,
    status: v.status, exitCode: v.exitCode, timedOut: v.timedOut, outputTail: v.outputTail,
    outputTruncated: v.outputTruncated, rawOutputSha256: v.rawOutputSha256!, rawOutputByteLength: v.rawOutputByteLength!, finishedAt: v.finishedAt,
  }]
  return {
    ...review, verdict: 'approved', blockerReason: null,
    summary: '原独立评审及内置浏览器补测已覆盖两项冻结标准。',
    criteria: [review.criteria[0]!, { ...review.criteria[1]!, status: 'met', evidence: '受管浏览器实际点击后观察到 0 → 1 → 0。', quote: v.command }],
    validationEvidence, developmentArtifact: { ...review.developmentArtifact!, validationEvidence },
  }
}

const inFlight = new Map<string, Promise<DevelopmentValidationResult>>()

export async function supplementOwnerCounterReview(projectId: string, reviewerCommandId: string): Promise<DevelopmentValidationResult> {
  const { listOwnerTechnicalReviewEvidence } = require('./project-owner-technical-review') as typeof import('./project-owner-technical-review')
  const read = () => {
    const review = listOwnerTechnicalReviewEvidence(projectId, undefined, [reviewerCommandId], false)[0]
    if (!review || !canSupplementOwnerCounterReview(review)) throw new Error('当前评审缺口不符合计数器内置补测范围')
    const db = store.getProjectDb()
    const settled = db.prepare(`SELECT g.task_id AS scope_task_id FROM project_owner_execution_commands c
      JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
      JOIN agent_executions e ON e.id=c.execution_id AND e.owner_command_id=c.id AND e.project_id=c.project_id
      WHERE c.id=? AND c.project_id=? AND c.role='reviewer' AND c.state='settled' AND c.actual_cost_micros IS NOT NULL
        AND e.status='completed' AND e.id=? AND NOT EXISTS (
          SELECT 1 FROM project_owner_execution_commands replacement WHERE replacement.project_id=c.project_id
            AND replacement.source_task_id=c.source_task_id AND (replacement.rowid>c.rowid OR replacement.state IN ('reserved','queued','running','needs_reconcile'))
        )`).get(reviewerCommandId, projectId, review.reviewerExecutionId) as { scope_task_id: string | null } | undefined
    if (!settled) throw new Error('原评审尚未完成结算，或已有后续运行')
    const task = store.getTask(review.taskId)
    if (!task || task.status !== 'paused' || task.projectId !== projectId || task.ownerStepLinkId !== review.stepLinkId)
      throw new Error('任务已完成或状态已变化')
    return { review, scopeTaskId: settled.scope_task_id }
  }
  const { review, scopeTaskId } = read()
  const pending = inFlight.get(reviewerCommandId)
  if (pending) return pending
  const prior = readOwnerCounterSupplement(reviewerCommandId)
  if (prior && isOwnerCounterSupplementCurrent(prior)) return prior.validation
  const operation = (async () => {
    const validation = await runOwnerCounterSupplement(review.taskId, review.executorExecutionId, review.artifactHash!)
    if (validation.status !== 'passed') return validation
    store.getProjectDb().transaction(() => {
      const { review: latest } = read()
      if (latest.responseSha256 !== review.responseSha256 || latest.artifactHash !== review.artifactHash) throw new Error('补测期间成果或评审已变化')
      const receipt: CounterSupplement = { reviewerCommandId, reviewHash: review.responseSha256, artifactHash: review.artifactHash!, validation }
      store.getProjectDb().prepare('INSERT INTO project_owner_counter_supplements(validation_id,reviewer_command_id,created_at,payload,integrity_hash) VALUES (?,?,?,?,?)')
        .run(validation.id, reviewerCommandId, validation.finishedAt, JSON.stringify(receipt), ownerExecutionHash(receipt))
      // 同一事务核对入账证据，再通知 Owner 沿现有授权重新判断。
      readOwnerCounterSupplement(reviewerCommandId, validation.id)
      appendOwnerManagementMessage({ projectId, ...(scopeTaskId ? { taskId: scopeTaskId } : {}), eventId: `counter-supplement:${validation.id}`, role: 'assistant', kind: 'management_progress',
        content: '已对原计数器成果补跑浏览器验证，实际观察到 0 → 1 → 0。结果已绑定此成果，等待 Owner 核对执行范围并重新验收。' })
    })()
    requestOwnerManagementWake(projectId)
    return validation
  })()
  inFlight.set(reviewerCommandId, operation)
  try { return await operation }
  finally { inFlight.delete(reviewerCommandId) }
}
