/** 仅可信Runtime回调调用。Run证据不可覆盖；晚到证据不覆盖已有处理结论。无Caller/派工/费用许可。 */
import { createHash } from 'node:crypto'
import { assertOwnerPlanningAdmission, type OwnerPlanningAdmission } from './project-owner-planning-provider'
import type { SDKResultMessage, ProjectOwnerPlanProposal } from '@gravitas/shared'
import { getOwnerRuntimeBinding } from './project-owner-runtime-binding'
import { readOwnerPlanningSnapshot, resolveOwnerPlanningTask } from './project-owner-planning-source'
import { parseProjectOwnerPlanningResponse } from './project-owner-planning-protocol'
import { appendGeneratedOwnerPlan } from './project-owner-plan-service'
import * as store from './project-sqlite-store'
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export interface OwnerPlanningRunReceipt {
  schemaVersion: 1
  id: string
  executionId: string
  sessionId: string
  projectId: string
  planningTaskId: string
  linkId: string
  carrierId: string
  channelId: string
  modelId: string
  bindingRevision: number
  purpose: 'owner_planning'
  runtimeSource: string
  captureHash: string
  capturedAt: number
  requestHash: string | null
  responseText: string
  responseHash: string
  runtimeResult: SDKResultMessage | null
  stopped: boolean
  error: string | null
  validTerminal: boolean
  usage: NonNullable<SDKResultMessage['owner_planning_usage']> | null
  cost: { source: 'runtime_reported' | 'unknown'; usd: number | null }
}
export interface OwnerPlanningRunOutcome {
  executionId: string
  receiptId: string
  state: 'proposed' | 'needs_clarification' | 'stale' | 'failed' | 'unknown' | 'stopped'
  detail: string
  planRevision?: number
  clarification?: Extract<ReturnType<typeof parseProjectOwnerPlanningResponse>, { kind: 'needs_clarification' }>
}
interface ReceiptRow { id: string; execution_id: string; capture_hash: string; payload: string }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function nullableUsage(result?: SDKResultMessage): OwnerPlanningRunReceipt['usage'] {
  const value = result?.owner_planning_usage
  if (!value) return null
  const token = (input: unknown) => finite(input) ? input : null
  return { inputTokens: token(value.inputTokens), outputTokens: token(value.outputTokens), cacheReadTokens: token(value.cacheReadTokens), cacheWriteTokens: token(value.cacheWriteTokens) }
}
function storedReceipt(row: ReceiptRow): OwnerPlanningRunReceipt {
  try {
    const receipt = JSON.parse(row.payload) as OwnerPlanningRunReceipt
    const { id, ...body } = receipt
    if (receipt.schemaVersion !== 1 || id !== row.id || receipt.executionId !== row.execution_id || receipt.captureHash !== row.capture_hash || hash(body) !== id || hash(receipt.responseText) !== receipt.responseHash || receipt.validTerminal && (typeof receipt.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.requestHash))) throw new Error('证据摘要不一致')
    return receipt
  } catch { throw new Error('Owner Run回执无效，请保留数据核查') }
}
export function getOwnerPlanningRunReceipt(receiptId: string): OwnerPlanningRunReceipt | null {
  const row = store.getProjectDb().prepare('SELECT * FROM project_owner_planning_run_receipts WHERE id = ?').get(receiptId) as ReceiptRow | undefined
  return row ? storedReceipt(row) : null
}
export function getOwnerPlanningRunOutcome(executionId: string): OwnerPlanningRunOutcome | null {
  const row = store.getProjectDb().prepare('SELECT receipt_id, payload FROM project_owner_planning_run_outcomes WHERE execution_id = ?').get(executionId) as { receipt_id: string; payload: string } | undefined
  if (!row) return null
  try {
    const parsed = JSON.parse(row.payload) as OwnerPlanningRunOutcome & { integrityHash: string }
    const { integrityHash, ...value } = parsed
    const allowed = ['executionId', 'receiptId', 'state', 'detail', 'planRevision', 'clarification']
    const receipt = getOwnerPlanningRunReceipt(value.receiptId)
    if (Object.keys(value).some(key => !allowed.includes(key)) || hash(value) !== integrityHash || value.executionId !== executionId || value.receiptId !== row.receipt_id || !receipt || receipt.executionId !== executionId || !['proposed', 'needs_clarification', 'stale', 'failed', 'unknown', 'stopped'].includes(value.state) || typeof value.detail !== 'string') throw new Error('结论完整性无效')
    if (value.state === 'proposed' || value.state === 'needs_clarification') {
      if (!receipt.validTerminal || receipt.stopped || receipt.error) throw new Error('结论没有可信终态')
      const frozen = readOwnerPlanningSnapshot(receipt.planningTaskId)
      if (!frozen) throw new Error('结论来源缺失')
      const response = parseProjectOwnerPlanningResponse(receipt.responseText, frozen.context)
      if (value.state === 'proposed' ? response.kind !== 'plan_proposal' || !Number.isSafeInteger(value.planRevision) || value.planRevision !== frozen.link.planRevision + 1 || value.clarification !== undefined : response.kind !== 'needs_clarification' || JSON.stringify(response) !== JSON.stringify(value.clarification) || value.planRevision !== undefined) throw new Error('结论与原始响应不一致')
    } else if (value.planRevision !== undefined || value.clarification !== undefined) throw new Error('失败结论夹带提案')
    return value
  } catch { throw new Error('Owner Run处理结论无效，请保留数据核查') }
}
/** 计划历史反查同Run原文与严格协议，不以origin标签或Model自述作为证明。 */
export function verifyGeneratedOwnerPlan(sourceRun: { receiptId: string; executionId: string; responseHash: string }, proposal: ProjectOwnerPlanProposal, goalRevision: number, contextFingerprint: string): void {
  const receipt = getOwnerPlanningRunReceipt(sourceRun.receiptId)
  if (!receipt || receipt.executionId !== sourceRun.executionId || receipt.responseHash !== sourceRun.responseHash || !receipt.validTerminal || receipt.stopped || receipt.error) throw new Error('Owner生成计划缺少可信Run证据')
  const frozen = readOwnerPlanningSnapshot(receipt.planningTaskId)
  if (!frozen || frozen.link.id !== receipt.linkId || frozen.link.goalRevision !== goalRevision || frozen.link.contextFingerprint !== contextFingerprint) throw new Error('Owner生成计划与Run资料不匹配')
  const response = parseProjectOwnerPlanningResponse(receipt.responseText, frozen.context)
  if (response.kind !== 'plan_proposal' || JSON.stringify(response.proposal) !== JSON.stringify(proposal)) throw new Error('Owner计划不是该Run原始提案')
}
/** 仅用途检测，不接受此结果作为发送或生成许可；任一持久证据存在即不能降级。 */
export function ownerPlanningPurposeExists(taskId: string, executionId: string): boolean {
  return store.hasOwnerPlanningTaskEvidence(taskId) || store.hasOwnerPlanningExecutionEvidence(executionId)
}
/** 在外部abort前落持久停止意图；不宣称已停止/已结清，不授予重试。 */
export function requestOwnerPlanningStop(executionId: string): boolean {
  const execution = store.getAgentExecution(executionId)
  if (!execution || execution.entityType !== 'task') return false
  const purpose = ownerPlanningPurposeExists(execution.entityId, executionId)
  if (!purpose) return false
  // 停止只收紧能力，不能因冻结资料损坏拒绝已知execution的目标abort。
  if (execution.status !== 'running' && execution.status !== 'queued') throw new Error('Owner Run已终结，不再记录新停止意图')
  store.getProjectDb().prepare('INSERT OR IGNORE INTO project_owner_planning_stop_requests (execution_id, session_id, requested_at) VALUES (?, ?, ?)').run(executionId, execution.sessionId, Date.now())
  return true
}
/** 返回null仅普通任务；Owner坏关联不得降级。重复/晚到callback留新证据，不重复CAS或回写业务目标。 */
export function recordOwnerPlanningRun(executionId: string, runtimeSource: string, runtimeResult?: SDKResultMessage, stopped = false, error?: string): OwnerPlanningRunOutcome | null {
  const execution = store.getAgentExecution(executionId)
  if (!execution || execution.entityType !== 'task') return null
  const purpose = ownerPlanningPurposeExists(execution.entityId, executionId)
  if (purpose) {
    // 严格来源解析之前仅保全server callback，不把隔离记录当完整Run回执/生成证明。
    // 损坏配置/来源也不能丢原文或SDK报告；不带认证Header或API key。
    const payload = { schemaVersion: 1, executionId, projectId: execution.projectId, entityId: execution.entityId, agentId: execution.agentId, sessionId: execution.sessionId, runtimeSource, runtimeResult: runtimeResult ?? null, stopped, error: error ?? null }
    store.getProjectDb().prepare('INSERT OR IGNORE INTO project_owner_planning_callback_evidence (id, execution_id, payload) VALUES (?, ?, ?)').run(hash(payload), executionId, JSON.stringify(payload))
  }
  const frozen = readOwnerPlanningSnapshot(execution.entityId)
  if (!frozen) { if (purpose) throw new Error('Owner用途证据损坏，回调已隔离保存，不降级普通任务或生成提案'); return null }
  const stopIntent = store.getProjectDb().prepare('SELECT session_id, requested_at FROM project_owner_planning_stop_requests WHERE execution_id = ?').get(executionId) as { session_id: string; requested_at: number } | undefined
  if (stopIntent && (stopIntent.session_id !== execution.sessionId || !Number.isSafeInteger(stopIntent.requested_at) || stopIntent.requested_at <= 0)) throw new Error('Owner停止意图归属无效')
  stopped ||= Boolean(stopIntent)
  const { link } = frozen
  const binding = getOwnerRuntimeBinding(link.projectId, link.bindingRevision)
  const preparation = store.getProjectDb().prepare('SELECT execution_id FROM controlled_task_preparations WHERE task_id = ?').get(execution.entityId) as { execution_id: string | null } | undefined
  if (!binding || binding.carrierFingerprint !== link.carrierFingerprint || execution.projectId !== link.projectId || execution.agentId !== binding.carrierId || preparation?.execution_id !== execution.id || execution.pilotCommandId) throw new Error('Owner回执与冻结执行身份不匹配')
  const admission = store.getProjectDb().prepare('SELECT * FROM project_owner_planning_admissions WHERE execution_id = ?').get(executionId) as OwnerPlanningAdmission | undefined
  if (admission) assertOwnerPlanningAdmission(admission)
  if ((!execution.sessionId && (admission || runtimeResult)) || (admission && (admission.link_id !== link.id || admission.session_id !== execution.sessionId || admission.source_snapshot !== JSON.stringify(frozen.context)))) throw new Error('Owner回执与实际请求占位不匹配')
  const trustedRuntime = runtimeSource === 'ai-sdk' && runtimeResult?.type === 'result' && runtimeResult.session_id === execution.sessionId
  const validTerminal = !!(trustedRuntime && admission && runtimeResult.subtype === 'success' && runtimeResult.finish_reason === 'stop' && typeof runtimeResult.result === 'string')
  const responseText = typeof runtimeResult?.result === 'string' ? runtimeResult.result : ''
  const callbackError = error ?? (trustedRuntime && runtimeResult.subtype !== 'success' ? runtimeResult.errors?.join('；') || runtimeResult.subtype : undefined)
  const captureHash = hash({ runtimeSource, runtimeResult: runtimeResult ?? null, stopped, error: error ?? null })
  const oldRow = store.getProjectDb().prepare('SELECT * FROM project_owner_planning_run_receipts WHERE execution_id = ? AND capture_hash = ?').get(executionId, captureHash) as ReceiptRow | undefined
  let receipt = oldRow ? storedReceipt(oldRow) : undefined
  if (!receipt) {
    const body: Omit<OwnerPlanningRunReceipt, 'id'> = { schemaVersion: 1, executionId, sessionId: execution.sessionId, projectId: link.projectId, planningTaskId: link.planningTaskId, linkId: link.id, carrierId: binding.carrierId, channelId: binding.channelId, modelId: binding.modelId, bindingRevision: binding.revision, purpose: 'owner_planning', runtimeSource, captureHash, capturedAt: Date.now(), requestHash: admission?.request_hash ?? null, responseText, responseHash: hash(responseText), runtimeResult: runtimeResult ?? null, stopped, error: callbackError ?? null, validTerminal, usage: trustedRuntime ? nullableUsage(runtimeResult) : null, cost: trustedRuntime && admission && finite(runtimeResult.total_cost_usd) ? { source: 'runtime_reported', usd: runtimeResult.total_cost_usd } : { source: 'unknown', usd: null } }
    receipt = { id: hash(body), ...body }
    store.getProjectDb().prepare('INSERT INTO project_owner_planning_run_receipts (id, execution_id, capture_hash, payload) VALUES (?, ?, ?, ?)').run(receipt.id, executionId, captureHash, JSON.stringify(receipt))
  }
  // 证据事务先提交，生成失败不能把原文与费用回滚丢掉。
  const existing = getOwnerPlanningRunOutcome(executionId)
  if (existing) return existing
  let outcome: OwnerPlanningRunOutcome = { executionId, receiptId: receipt.id, state: stopped ? 'stopped' : callbackError || (trustedRuntime && runtimeResult.subtype !== 'success') ? 'failed' : 'unknown', detail: callbackError ?? '没有可信完整终态，费用可能未知；不会补发' }
  store.getProjectDb().transaction(() => {
    const concurrent = getOwnerPlanningRunOutcome(executionId)
    if (concurrent) { outcome = concurrent; return }
    if (validTerminal && !stopped && !error && execution.status === 'running') {
      try {
        const response = parseProjectOwnerPlanningResponse(responseText, frozen.context)
        try { resolveOwnerPlanningTask(execution.entityId) } catch (cause) { outcome = { executionId, receiptId: receipt!.id, state: 'stale', detail: cause instanceof Error ? cause.message : '来源版本更新，保留原文' }; throw new Error('owner-source-stale') } // // 版本/载体/来源重读与append双CAS在同同步事务。
        if (response.kind === 'needs_clarification') outcome = { executionId, receiptId: receipt!.id, state: 'needs_clarification', detail: response.reason, clarification: response }
        else {
          const plan = appendGeneratedOwnerPlan(receipt!.id)
          outcome = { executionId, receiptId: receipt!.id, state: 'proposed', detail: 'AI提案待人工内容确认，不是执行许可', planRevision: plan.revision }
        }
      } catch (cause) { if (outcome.state !== 'stale') outcome = { executionId, receiptId: receipt!.id, state: 'failed', detail: cause instanceof Error ? cause.message : '响应无效，保留原始证据，不覆盖计划' } }
    }
    store.getProjectDb().prepare('INSERT INTO project_owner_planning_run_outcomes (execution_id, receipt_id, payload) VALUES (?, ?, ?)').run(executionId, outcome.receiptId, JSON.stringify({ ...outcome, integrityHash: hash(outcome) }))
    // 规划承载Run终结；业务目标/DoD、员工绩效/学习/Review和通知不在这里写回。
    if (execution.status === 'running' || execution.status === 'queued') store.updateAgentExecution(executionId, { status: outcome.state === 'proposed' || outcome.state === 'needs_clarification' ? 'completed' : outcome.state === 'stopped' ? 'cancelled' : outcome.state === 'unknown' || outcome.state === 'stale' ? 'stale' : 'failed', completedAt: Date.now(), resultSummary: outcome.detail, ...(outcome.state === 'proposed' || outcome.state === 'needs_clarification' ? {} : { error: outcome.detail }) })
    const task = store.getTask(execution.entityId)
    if (task?.controlledPreparationId && task.assignee?.userId === `agent-${binding.carrierId}`) store.updateTask(task.id, { status: 'paused' })
  })()
  return outcome
}
