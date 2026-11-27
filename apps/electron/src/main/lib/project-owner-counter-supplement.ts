/** 计数器补测证据独立入账，原始评审与研发快照可按各自的版本重放。 */
import { createHash } from 'node:crypto'
import type { DevelopmentValidationResult, OwnerManagementDeliveryReview } from '@gravitas/shared'
import { containsOwnerValidationEvidenceQuote, evaluateDevelopmentValidationEvidence } from './development-validation-acceptance'
import { OWNER_COUNTER_KEYBOARD_COMMAND, OWNER_COUNTER_SUPPLEMENT_COMMAND, readDevelopmentValidationEvidence, runOwnerCounterKeyboardSupplement, runOwnerCounterSupplement } from './development-validation-service'
import { ownerExecutionHash } from './project-owner-execution-hash'
import { appendOwnerManagementMessage } from './project-owner-management-store'
import { requestOwnerManagementWake } from './project-owner-management-events'
import { assertOwnerDispatchManagementCurrent, assertOwnerDispatchNotPaused } from './project-owner-dispatch-control'
import { ownerDevelopmentValidationId } from './development-validation-attempt'
import { getOwnerExecutionRevalidation } from './project-owner-execution-revalidation'
import { getPilotPolicy } from './project-pilot-policy'
import type { OwnerTechnicalReviewEvidence } from './project-owner-technical-review'
import * as store from './project-sqlite-store'

interface CounterSupplement {
  reviewerCommandId: string
  reviewHash: string
  artifactHash: string
  validation: DevelopmentValidationResult
}

function counterSupplementCommand(review: OwnerTechnicalReviewEvidence): string | undefined {
  if (review.verdict !== 'blocked' || review.artifactVerified !== true || !review.developmentArtifact
    || review.findings.length !== 0 || review.validationEvidence?.length !== 1) return undefined
  const [initial, interaction] = review.criteria
  const text = (value: string) => value.replace(/[\s，。！？]/g, '')
  const [validation] = review.validationEvidence
  if (validation?.command === 'browser:html.loads' && review.criteria.length === 2
    && initial?.status === 'met' && /^打开(?:文件|页面)后初值(?:显示|为)0$/.test(text(initial.criterion))
    && interaction?.status === 'not_verified' && /^点击加一后(?:显示|为)1再点(?:击)?重置后(?:回到|为)0$/.test(text(interaction.criterion))
  ) return OWNER_COUNTER_SUPPLEMENT_COMMAND
  // 旧回执已通过鼠标与 Enter，缺口只能是同一序列的 Tab 焦点证明。
  if (validation?.command === OWNER_COUNTER_KEYBOARD_COMMAND
    && containsOwnerValidationEvidenceQuote([validation], '鼠标：0 → 1 → 2 → 0；Enter：0 → 1 → 2 → 0')
    && !validation.outputTail?.includes('Tab 焦点：')
    && review.criteria.some(item => item.status === 'met' && /鼠标.*(?:0→1→2→0)/.test(text(item.criterion)))
    && review.criteria.some(item => item.status === 'not_verified')
    && review.criteria.every(item => item.status === 'met' || (item.status === 'not_verified'
      && /^(?:再用|用)?Tab(?:与|和|及|\+|\/)Enter走(?:一遍)?同样序列(?:并保留浏览器回执)?$/i.test(text(item.criterion))))) {
    return OWNER_COUNTER_KEYBOARD_COMMAND
  }
}

export function canSupplementOwnerCounterReview(review: OwnerTechnicalReviewEvidence): boolean {
  return counterSupplementCommand(review) === OWNER_COUNTER_SUPPLEMENT_COMMAND
}

/** 同一浏览器命令可有原始回执；只有按Reviewer派生的ID才代表补测。 */
export function findOwnerCounterSupplementValidation(review: OwnerManagementDeliveryReview['review']) {
  return review?.validationEvidence?.find(item => item.command === OWNER_COUNTER_SUPPLEMENT_COMMAND
    || item.command === OWNER_COUNTER_KEYBOARD_COMMAND
    && item.validationId === ownerDevelopmentValidationId(review.reviewerCommandId, item.command, review.artifactHash))
}

function keyboardTrace(validation: DevelopmentValidationResult): string | undefined {
  const detail = validation.checks?.find(check => check.id === 'counter.mouse-keyboard' && check.status === 'passed')?.detail
  if (detail && /^鼠标：0 → 1 → 2 → 0；Enter：0 → 1 → 2 → 0；Tab 焦点：#increment（[1-9]\d* 次 Tab） → #increment（0 次 Tab） → #reset（[1-9]\d* 次 Tab）$/.test(detail)) return detail
}

export function readOwnerCounterSupplement(reviewerCommandId: string, validationId?: string): CounterSupplement | null {
  const row = store.getProjectDb().prepare(`SELECT validation_id,created_at,payload,integrity_hash FROM project_owner_counter_supplements
    WHERE reviewer_command_id=? AND (? IS NULL OR validation_id=?) ORDER BY created_at DESC,rowid DESC LIMIT 1`)
    .get(reviewerCommandId, validationId ?? null, validationId ?? null) as { validation_id: string; created_at: number; payload: string; integrity_hash: string } | undefined
  if (!row) return null
  const value = JSON.parse(row.payload) as CounterSupplement
  const v = value.validation
  const interaction = v.command === OWNER_COUNTER_KEYBOARD_COMMAND ? 'counter.mouse-keyboard' : 'counter.increment-reset'
  if (ownerExecutionHash(value) !== row.integrity_hash || value.reviewerCommandId !== reviewerCommandId || v.id !== row.validation_id
    || !/^val-[a-f0-9]{64}$/.test(v.id) || v.finishedAt !== row.created_at || v.snapshotContentHash !== value.artifactHash
    || v.command !== OWNER_COUNTER_SUPPLEMENT_COMMAND && (v.command !== OWNER_COUNTER_KEYBOARD_COMMAND || !keyboardTrace(v))
    || v.method !== 'browser_assertions' || v.checks?.length !== 2
    || !['html.loads', interaction].every(id => v.checks?.some(check => check.id === id && check.status === 'passed'))
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
  const command = counterSupplementCommand(review)
  if (!command) return review
  const supplement = readOwnerCounterSupplement(review.reviewerCommandId, validationId)
  if (!supplement) return review
  const v = supplement.validation
  if (v.command !== command || supplement.reviewHash !== review.responseSha256 || supplement.artifactHash !== review.artifactHash
    || v.executionId !== review.executorExecutionId || v.taskId !== review.taskId || v.binding?.projectId !== review.projectId)
    throw new Error('Owner计数器补测跨成果或执行来源')
  const validationEvidence = [{
    command: v.command, validationId: v.id, attemptState: 'completed' as const, freshness: 'fresh' as const,
    status: v.status, exitCode: v.exitCode, timedOut: v.timedOut, outputTail: v.outputTail,
    outputTruncated: v.outputTruncated, rawOutputSha256: v.rawOutputSha256!, rawOutputByteLength: v.rawOutputByteLength!, finishedAt: v.finishedAt,
  }]
  const trace = keyboardTrace(v)
  if (trace && review.criteria.some(item => item.status === 'met' && item.quote
    && containsOwnerValidationEvidenceQuote(review.validationEvidence, item.quote)
    && !containsOwnerValidationEvidenceQuote(validationEvidence, item.quote))) return review
  return {
    ...review, verdict: 'approved', blockerReason: null,
    summary: '原独立评审及内置浏览器补测已覆盖冻结标准。',
    criteria: review.criteria.map(item => item.status === 'met' ? item : {
      ...item, status: 'met', evidence: trace ?? '受管浏览器实际点击后观察到 0 → 1 → 0。', quote: trace ?? v.command,
    }),
    validationEvidence, developmentArtifact: { ...review.developmentArtifact!, validationEvidence },
  }
}

const inFlight = new Map<string, Promise<DevelopmentValidationResult | undefined>>()

export async function supplementOwnerCounterReview(projectId: string, reviewerCommandId: string): Promise<DevelopmentValidationResult> {
  const validation = await recordCounterSupplement(projectId, reviewerCommandId, OWNER_COUNTER_SUPPLEMENT_COMMAND)
  if (!validation) throw new Error('当前评审缺口不符合计数器内置补测范围')
  return validation
}

export async function recoverOwnerCounterKeyboardEvidence(projectId: string, reviewerCommandId: string): Promise<boolean> {
  const existing = readOwnerCounterSupplement(reviewerCommandId)
  if (existing) return false
  await recordCounterSupplement(projectId, reviewerCommandId, OWNER_COUNTER_KEYBOARD_COMMAND)
  return Boolean(readOwnerCounterSupplement(reviewerCommandId))
}

async function recordCounterSupplement(projectId: string, reviewerCommandId: string, command: string): Promise<DevelopmentValidationResult | undefined> {
  const { listOwnerTechnicalReviewEvidence } = require('./project-owner-technical-review') as typeof import('./project-owner-technical-review')
  const read = () => {
    const review = listOwnerTechnicalReviewEvidence(projectId, undefined, [reviewerCommandId], false)[0]
    if (!review || counterSupplementCommand(review) !== command) return undefined
    const db = store.getProjectDb()
    const settled = db.prepare(`SELECT g.task_id AS scope_task_id,g.state AS grant_state,g.expires_at,g.dispatch_mode,
      g.revalidation_id,g.revalidation_integrity_hash,g.source_hash,g.policy_revision,
      (SELECT id FROM project_owner_execution_grants WHERE project_id=g.project_id ORDER BY issued_at DESC,rowid DESC LIMIT 1) AS latest_grant_id
      FROM project_owner_execution_commands c
      JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
      JOIN agent_executions e ON e.id=c.execution_id AND e.owner_command_id=c.id AND e.project_id=c.project_id
      WHERE c.id=? AND c.project_id=? AND c.role='reviewer' AND c.state='settled' AND c.actual_cost_micros IS NOT NULL
        AND e.status='completed' AND e.id=? AND NOT EXISTS (
          SELECT 1 FROM project_owner_execution_commands replacement WHERE replacement.project_id=c.project_id
            AND replacement.source_task_id=c.source_task_id AND (replacement.rowid>c.rowid OR replacement.state IN ('reserved','queued','running','needs_reconcile'))
        )`).get(reviewerCommandId, projectId, review.reviewerExecutionId) as {
      scope_task_id: string | null; grant_state: string; expires_at: number; dispatch_mode: string; latest_grant_id: string
      revalidation_id: string; revalidation_integrity_hash: string; source_hash: string; policy_revision: number
    } | undefined
    if (!settled) throw new Error('原评审尚未完成结算，或已有后续运行')
    if (command === OWNER_COUNTER_KEYBOARD_COMMAND) {
      if (settled.grant_state !== 'active' || settled.dispatch_mode !== 'autonomous' || settled.expires_at <= Date.now()
        || settled.latest_grant_id !== review.grantId) return undefined
      const view = getOwnerExecutionRevalidation({ projectId, ...(settled.scope_task_id ? { taskId: settled.scope_task_id } : {}) })
      if (view.status !== 'current' || view.revalidation?.id !== settled.revalidation_id
        || view.revalidation.integrityHash !== settled.revalidation_integrity_hash
        || ownerExecutionHash(view.revalidation.source) !== settled.source_hash
        || getPilotPolicy(projectId)?.revision !== settled.policy_revision) return undefined
      assertOwnerDispatchNotPaused(projectId, review.grantId)
      assertOwnerDispatchManagementCurrent(projectId, review.grantId)
    }
    const task = store.getTask(review.taskId)
    if (!task || task.status !== 'paused' || task.projectId !== projectId || task.ownerStepLinkId !== review.stepLinkId)
      throw new Error('任务已完成或状态已变化')
    return { review, scopeTaskId: settled.scope_task_id }
  }
  const original = read()
  if (!original) return undefined
  const { review, scopeTaskId } = original
  const pending = inFlight.get(reviewerCommandId)
  if (pending) return pending
  const prior = readOwnerCounterSupplement(reviewerCommandId)
  if (prior && isOwnerCounterSupplementCurrent(prior)) return prior.validation
  const operation = (async () => {
    const validation = command === OWNER_COUNTER_KEYBOARD_COMMAND
      ? await runOwnerCounterKeyboardSupplement({ ...review, artifactHash: review.artifactHash! })
      : await runOwnerCounterSupplement(review.taskId, review.executorExecutionId, review.artifactHash!)
    if (validation.status !== 'passed') return validation
    const receipt: CounterSupplement = { reviewerCommandId, reviewHash: review.responseSha256, artifactHash: review.artifactHash!, validation }
    if (command === OWNER_COUNTER_KEYBOARD_COMMAND && (!keyboardTrace(validation) || !isOwnerCounterSupplementCurrent(receipt))) return undefined
    store.getProjectDb().transaction(() => {
      const latest = read()?.review
      if (latest?.responseSha256 !== review.responseSha256 || latest.artifactHash !== review.artifactHash) throw new Error('补测期间成果或评审已变化')
      store.getProjectDb().prepare('INSERT INTO project_owner_counter_supplements(validation_id,reviewer_command_id,created_at,payload,integrity_hash) VALUES (?,?,?,?,?)')
        .run(validation.id, reviewerCommandId, validation.finishedAt, JSON.stringify(receipt), ownerExecutionHash(receipt))
      // 同一事务核对入账证据，再通知 Owner 沿现有授权重新判断。
      readOwnerCounterSupplement(reviewerCommandId, validation.id)
      appendOwnerManagementMessage({ projectId, ...(scopeTaskId ? { taskId: scopeTaskId } : {}), eventId: `counter-supplement:${validation.id}`, role: 'assistant', kind: 'management_progress',
        content: command === OWNER_COUNTER_KEYBOARD_COMMAND
          ? '已对原计数器成果补跑授权内的浏览器验证，保存了实际 Tab 焦点和鼠标、Enter 的计数结果。Owner 将核对这些证据后重新判断。'
          : '已对原计数器成果补跑浏览器验证，实际观察到 0 → 1 → 0。结果已绑定此成果，等待 Owner 核对执行范围并重新验收。' })
    })()
    requestOwnerManagementWake(projectId)
    return validation
  })()
  inFlight.set(reviewerCommandId, operation)
  try { return await operation }
  finally { inFlight.delete(reviewerCommandId) }
}
