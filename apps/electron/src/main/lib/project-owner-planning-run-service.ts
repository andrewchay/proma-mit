/** 仅可信Runtime回调调用。Run证据不可覆盖；晚到证据不覆盖已有处理结论。无Caller/派工/费用许可。 */
import { recordOwnerManagementRun, recordOwnerManagementRecoveredAssignment } from './project-owner-management-store'
import { createHash } from 'node:crypto'
import { assertOwnerPlanningAdmission, type OwnerPlanningAdmission } from './project-owner-planning-provider'
import type { SDKResultMessage, OwnerExecutionAssignmentProposal, ProjectOwnerPlanProposal } from '@gravitas/shared'
import { getOwnerRuntimeBinding } from './project-owner-runtime-binding'
import { readOwnerPlanningSnapshot, resolveOwnerPlanningTask } from './project-owner-planning-source'
import { parseProjectOwnerPlanningResponse } from './project-owner-planning-protocol'
import { appendGeneratedOwnerPlan } from './project-owner-plan-service'
import { parseOwnerExecutionAssignmentProposal, type OwnerExecutionAssignmentProtocolContext } from './project-owner-execution-assignment-protocol'
import * as store from './project-sqlite-store'
import { isOwnerPlanningConfigurationError } from './owner-planning-configuration'
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
  purpose: 'owner_planning' | 'owner_execution_assignment'
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
  state: 'proposed' | 'needs_clarification' | 'replied' | 'stale' | 'failed' | 'unknown' | 'stopped'
  detail: string
  reply?: string
  changeProposal?: import('@gravitas/shared').OwnerConversationChange
  employeeDecision?: import('./project-owner-planning-protocol').OwnerEmployeeDecision
  qualityDecision?: import('@gravitas/shared').OwnerQualityDecision
  planRevision?: number
  clarification?: Extract<ReturnType<typeof parseProjectOwnerPlanningResponse>, { kind: 'needs_clarification' }>
  assignmentProposal?: OwnerExecutionAssignmentProposal
}
interface ReceiptRow { id: string; execution_id: string; capture_hash: string; payload: string }
interface OutcomeRow { receipt_id: string; payload: string }
interface RecoveredOwnerResponse {
  schemaVersion: 1
  executionId: string
  receiptId: string
  responseHash: string
  originalOutcomeHash: string
  recoveredOutcome: OwnerPlanningRunOutcome
  recoveredAt: number
}
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

function hasOnlyNullUsage(usage: OwnerPlanningRunReceipt['usage']): boolean {
  return usage === null || usage.inputTokens === null && usage.outputTokens === null && usage.cacheReadTokens === null && usage.cacheWriteTokens === null
}
/** AI SDK可能把已确认的本地入口错误包装成零用量错误终态；其他终态仍按未知请求处理。 */
function isUnsentRuntimeEnvelope(result: SDKResultMessage | null, sessionId: string): boolean {
  if (result === null) return true
  if (result.type !== 'result' || result.session_id !== sessionId || result.subtype !== 'error_during_execution' || result.finish_reason !== 'error' || result.result !== '' || result.total_cost_usd !== undefined) return false
  const usage = result.usage as { input_tokens?: unknown; output_tokens?:unknown } | undefined
  const planningUsage = result.owner_planning_usage
  return result.errors?.length === 1 && isOwnerPlanningConfigurationError(result.errors[0])
    && usage !== undefined && Object.keys(usage).length === 2 && usage.input_tokens === 0 && usage.output_tokens === 0
    && planningUsage !== undefined && hasOnlyNullUsage(planningUsage)
}
/** 发送前配置失败的只读核查；缺少准入本身不足以解除未知请求门禁。 */
export function isUnsentOwnerPlanningConfigurationFailure(executionId: string, receiptId: string): boolean {
  const execution = store.getAgentExecution(executionId), receipt = getOwnerPlanningRunReceipt(receiptId)
  if (!execution || execution.status !== 'failed' || !isOwnerPlanningConfigurationError(execution.error)
    || !receipt || receipt.executionId !== executionId || receipt.sessionId !== execution.sessionId) return false
  const frozen = readOwnerPlanningSnapshot(execution.entityId)
  if (!frozen || frozen.link.id !== receipt.linkId || frozen.link.projectId !== execution.projectId || receipt.projectId !== execution.projectId
    || frozen.link.planningTaskId !== execution.entityId || frozen.link.protocolVersion === '1') return false
  const db = store.getProjectDb()
  const prepared = db.prepare('SELECT execution_id,owner_planning_link_id,provider_admitted_at FROM controlled_task_preparations WHERE task_id=?').get(execution.entityId) as { execution_id: string | null; owner_planning_link_id: string | null; provider_admitted_at: number | null } | undefined
  if (prepared?.execution_id !== executionId || prepared.owner_planning_link_id !== receipt.linkId || prepared.provider_admitted_at !== null) return false
  if (db.prepare('SELECT 1 FROM project_owner_planning_admissions WHERE execution_id=? OR session_id=? OR link_id=?').get(executionId, receipt.sessionId, receipt.linkId)) return false
  const receipts = (db.prepare('SELECT * FROM project_owner_planning_run_receipts WHERE execution_id=?').all(executionId) as ReceiptRow[]).map(storedReceipt)
  if (!receipts.length || receipts.some(item => item.requestHash !== null || !isUnsentRuntimeEnvelope(item.runtimeResult, item.sessionId) || item.responseText !== '' || !hasOnlyNullUsage(item.usage)
    || item.stopped || item.validTerminal || item.cost.source !== 'unknown' || item.cost.usd !== null
    || !['ai-sdk', 'unknown'].includes(item.runtimeSource) || item.error !== null && !isOwnerPlanningConfigurationError(item.error))) return false
  const callbacks = db.prepare('SELECT id,payload FROM project_owner_planning_callback_evidence WHERE execution_id=?').all(executionId) as { id: string; payload: string }[]
  return callbacks.length > 0 && callbacks.every(row => {
    try {
      const value = JSON.parse(row.payload) as { executionId: string; sessionId: string; projectId: string; runtimeSource: string; runtimeResult: SDKResultMessage | null; stopped: boolean; error: string | null }
      return hash(value) === row.id && value.executionId === executionId && value.sessionId === receipt.sessionId && value.projectId === execution.projectId
        && ['ai-sdk', 'unknown'].includes(value.runtimeSource) && isUnsentRuntimeEnvelope(value.runtimeResult, value.sessionId) && value.stopped === false
        && (value.error === null || isOwnerPlanningConfigurationError(value.error))
    } catch { return false }
  })
}
function readStoredOwnerPlanningRunOutcome(executionId: string): OwnerPlanningRunOutcome | null {
  const row = store.getProjectDb().prepare('SELECT receipt_id, payload FROM project_owner_planning_run_outcomes WHERE execution_id = ?').get(executionId) as { receipt_id: string; payload: string } | undefined
  if (!row) return null
  try {
    const parsed = JSON.parse(row.payload) as OwnerPlanningRunOutcome & { integrityHash: string }
    const { integrityHash, ...value } = parsed
    const allowed = ['executionId', 'receiptId', 'state', 'detail', 'planRevision', 'clarification', 'assignmentProposal', 'reply', 'changeProposal', 'qualityDecision', 'employeeDecision']
    const receipt = getOwnerPlanningRunReceipt(value.receiptId)
    if (Object.keys(value).some(key => !allowed.includes(key)) || hash(value) !== integrityHash || value.executionId !== executionId || value.receiptId !== row.receipt_id || !receipt || receipt.executionId !== executionId || !['proposed', 'needs_clarification', 'replied', 'stale', 'failed', 'unknown', 'stopped'].includes(value.state) || typeof value.detail !== 'string') throw new Error('结论完整性无效')
    if (value.state === 'proposed' || value.state === 'needs_clarification' || value.state === 'replied') {
      if (!receipt.validTerminal || receipt.stopped || receipt.error) throw new Error('结论没有可信终态')
      const frozen = readOwnerPlanningSnapshot(receipt.planningTaskId)
      if (!frozen || frozen.link.purpose !== receipt.purpose) throw new Error('结论来源缺失或用途不匹配')
      if (frozen.link.purpose === 'owner_execution_assignment') {
        if (value.state !== 'proposed' || !frozen.assignmentContext || value.planRevision !== undefined || value.clarification !== undefined || value.reply !== undefined || value.changeProposal !== undefined || value.qualityDecision !== undefined) throw new Error('Owner人员安排Run结论字段无效')
        const source = frozen.assignmentContext
        const protocolContext: OwnerExecutionAssignmentProtocolContext = { ...(source.teamContractVersion ? { teamContractVersion: source.teamContractVersion } : {}), contextFingerprint: source.contextFingerprint, workspaces: source.workspaces.map(({ id, name }) => ({ id, name })), executionKinds: source.executionKinds, ownerCarrierId: source.ownerCarrierId, steps: source.steps.map(({ key, dependencies, roleKey, sourceReferences }) => ({ key, dependencies, roleKey, ...(sourceReferences ? { sourceReferences } : {}) })), ...(source.codeFiles ? { codeFiles: source.codeFiles } : {}), candidates: source.candidates }
        const proposal = parseOwnerExecutionAssignmentProposal(receipt.responseText, protocolContext)
        if (!value.assignmentProposal || JSON.stringify(proposal) !== JSON.stringify(value.assignmentProposal)) throw new Error('人员安排结论与原始响应不一致')
      } else {
        if (value.assignmentProposal !== undefined) throw new Error('Owner规划Run不能夹带人员安排结论')
        // 历史结论按原回执时间重验；新鲜度属于当时证据，不能在恢复读取时反向使已接受成果失效。
        const response = parseProjectOwnerPlanningResponse(receipt.responseText, frozen.context, receipt.capturedAt)
        if (value.state === 'replied') {
          if (!['conversation_reply', 'conversation_change', 'quality_decision', 'employee_decision'].includes(response.kind) || !('message' in response) || value.reply !== response.message || value.planRevision !== undefined || value.clarification !== undefined || JSON.stringify(value.changeProposal) !== JSON.stringify(response.kind === 'conversation_change' ? response.change : undefined) || JSON.stringify(value.qualityDecision) !== JSON.stringify(response.kind === 'quality_decision' ? response.decision : undefined) || JSON.stringify(value.employeeDecision) !== JSON.stringify(response.kind === 'employee_decision' ? response.decision : undefined)) throw new Error('对话回应与原始响应不一致')
        } else if (value.employeeDecision !== undefined || value.qualityDecision !== undefined || value.reply !== undefined || value.changeProposal !== undefined || (value.state === 'proposed' ? response.kind !== 'plan_proposal' || !Number.isSafeInteger(value.planRevision) || value.planRevision !== frozen.link.planRevision + 1 || value.clarification !== undefined : response.kind !== 'needs_clarification' || JSON.stringify(response) !== JSON.stringify(value.clarification) || value.planRevision !== undefined)) throw new Error('结论与原始响应不一致')
      }
    } else if (value.employeeDecision !== undefined || value.qualityDecision !== undefined || value.planRevision !== undefined || value.clarification !== undefined || value.assignmentProposal !== undefined || value.reply !== undefined || value.changeProposal !== undefined) throw new Error('失败结论夹带提案')
    return value
  } catch { throw new Error('Owner Run处理结论无效，请保留数据核查') }
}

/**
 * 对历史兼容拒绝只重新验证本地原文，不重放模型请求；原始失败结论与回执保持不变。
 * 仅接受严格可解析的普通回应或准确质量决定；质量动作仍重新核验当前授权与成果。
 */
export function recoverLegacyOwnerConversationReply(executionId: string): OwnerPlanningRunOutcome | null {
  const original = readStoredOwnerPlanningRunOutcome(executionId)
  if (!original || original.state !== 'failed' || !['Owner规划响应包含未知字段', 'Owner执行跟进只允许分析回应或必要协商', 'Owner质量决定与准确评审/成果不匹配', 'Owner质量决定未按准确标准逐项判断或引用不符'].includes(original.detail)) return null
  const receipt = getOwnerPlanningRunReceipt(original.receiptId)
  if (!receipt || receipt.executionId !== executionId || receipt.purpose !== 'owner_planning' || !receipt.validTerminal || receipt.stopped || receipt.error !== null
    || receipt.runtimeResult?.subtype !== 'success' || receipt.runtimeResult.finish_reason !== 'stop'
    || !receipt.usage || !Number.isSafeInteger(receipt.usage.inputTokens) || receipt.usage.inputTokens === null
    || !Number.isSafeInteger(receipt.usage.outputTokens) || receipt.usage.outputTokens === null) return null
  const frozen = readOwnerPlanningSnapshot(receipt.planningTaskId)
  if (!frozen || frozen.link.id !== receipt.linkId || frozen.link.projectId !== receipt.projectId || frozen.link.purpose !== 'owner_planning' || !frozen.link.conversationMessageId) return null
  let response: ReturnType<typeof parseProjectOwnerPlanningResponse>
  try { response = parseProjectOwnerPlanningResponse(receipt.responseText, frozen.context) }
  catch { return null }
  if (response.kind !== 'conversation_reply' && response.kind !== 'quality_decision') return null
  const recoveredOutcome: OwnerPlanningRunOutcome = {
    executionId, receiptId: receipt.id, state: 'replied',
    detail: 'Owner旧格式回应已从本地原始回执重新校验；未重发请求，费用仍按原预留记录。',
    reply: response.message,
    ...(response.kind === 'quality_decision' ? { qualityDecision: response.decision } : {}),
  }
  const recovered: RecoveredOwnerResponse = {
    schemaVersion: 1, executionId, receiptId: receipt.id, responseHash: receipt.responseHash,
    originalOutcomeHash: hash(original), recoveredOutcome, recoveredAt: Date.now(),
  }
  const integrityHash = hash(recovered)
  store.getProjectDb().prepare(`INSERT OR IGNORE INTO project_owner_planning_run_recoveries
    (execution_id, receipt_id, original_outcome_hash, payload, integrity_hash) VALUES (?, ?, ?, ?, ?)`)
    .run(executionId, receipt.id, recovered.originalOutcomeHash, JSON.stringify({ ...recovered, integrityHash }), integrityHash)
  return getOwnerPlanningRunOutcome(executionId)
}

/** 只恢复受控安排的空代码范围占位；重验原文，不发送新请求、不改变旧失败或费用。 */
export function recoverLegacyOwnerAssignmentProposal(executionId: string): OwnerPlanningRunOutcome | null {
  const original = readStoredOwnerPlanningRunOutcome(executionId)
  if (!original || original.state !== 'failed' || original.detail !== '受控非研发安排不得包含代码范围') return null
  const receipt = getOwnerPlanningRunReceipt(original.receiptId)
  if (!receipt || receipt.purpose !== 'owner_execution_assignment' || !receipt.validTerminal || receipt.stopped || receipt.error !== null
    || receipt.runtimeResult?.subtype !== 'success' || receipt.runtimeResult.finish_reason !== 'stop'
    || !receipt.usage || !finite(receipt.usage.inputTokens) || !Number.isSafeInteger(receipt.usage.inputTokens)
    || !finite(receipt.usage.outputTokens) || !Number.isSafeInteger(receipt.usage.outputTokens)) return null
  const frozen = readOwnerPlanningSnapshot(receipt.planningTaskId)
  if (!frozen?.assignmentContext || frozen.link.id !== receipt.linkId || frozen.link.projectId !== receipt.projectId) return null
  let proposal: OwnerExecutionAssignmentProposal
  try { proposal = parseOwnerExecutionAssignmentProposal(receipt.responseText, frozen.assignmentContext) }
  catch { return null }
  if (proposal.executionKind !== 'controlled') return null
  const recovered: RecoveredOwnerResponse = {
    schemaVersion: 1, executionId, receiptId: receipt.id, responseHash: receipt.responseHash, originalOutcomeHash: hash(original), recoveredAt: Date.now(),
    recoveredOutcome: { executionId, receiptId: receipt.id, state: 'proposed', detail: 'Owner旧格式受控安排已从本地原回执重新校验；未重发请求或修改原失败和费用。', assignmentProposal: proposal },
  }
  const integrityHash = hash(recovered)
  store.getProjectDb().transaction(() => {
    store.getProjectDb().prepare(`INSERT OR IGNORE INTO project_owner_planning_run_recoveries
    (execution_id, receipt_id, original_outcome_hash, payload, integrity_hash) VALUES (?, ?, ?, ?, ?)`)
    .run(executionId, receipt.id, recovered.originalOutcomeHash, JSON.stringify({ ...recovered, integrityHash }), integrityHash)
    recordOwnerManagementRecoveredAssignment(receipt.projectId, executionId, frozen.link.goalRevision, receipt.id, frozen.link.targetTaskId)
  })()
  return getOwnerPlanningRunOutcome(executionId)
}

export function getOwnerPlanningRunOutcome(executionId: string): OwnerPlanningRunOutcome | null {
  const original = readStoredOwnerPlanningRunOutcome(executionId)
  if (!original) return null
  const row = store.getProjectDb().prepare('SELECT receipt_id, original_outcome_hash, payload, integrity_hash FROM project_owner_planning_run_recoveries WHERE execution_id = ?').get(executionId) as (OutcomeRow & { original_outcome_hash: string; integrity_hash: string }) | undefined
  if (!row) return original
  try {
    const recovered = JSON.parse(row.payload) as RecoveredOwnerResponse
    const { integrityHash, ...body } = recovered as RecoveredOwnerResponse & { integrityHash: string }
    const receipt = getOwnerPlanningRunReceipt(row.receipt_id)
    const frozen = receipt ? readOwnerPlanningSnapshot(receipt.planningTaskId) : null
    if (!receipt || !frozen || recovered.schemaVersion !== 1 || recovered.executionId !== executionId || recovered.receiptId !== row.receipt_id
      || recovered.responseHash !== receipt.responseHash || recovered.originalOutcomeHash !== row.original_outcome_hash || hash(original) !== row.original_outcome_hash
      || hash(body) !== row.integrity_hash || row.integrity_hash !== integrityHash || !['replied', 'proposed'].includes(recovered.recoveredOutcome.state)
      || recovered.recoveredOutcome.executionId !== executionId || recovered.recoveredOutcome.receiptId !== receipt.id) throw new Error('旧回应恢复记录完整性无效')
    if (recovered.recoveredOutcome.state === 'proposed') {
      if (original.state !== 'failed' || original.detail !== '受控非研发安排不得包含代码范围'
        || receipt.purpose !== 'owner_execution_assignment' || !frozen.assignmentContext || !receipt.validTerminal || receipt.stopped || receipt.error !== null
        || receipt.runtimeResult?.subtype !== 'success' || receipt.runtimeResult.finish_reason !== 'stop'
        || !receipt.usage || !finite(receipt.usage.inputTokens) || !Number.isSafeInteger(receipt.usage.inputTokens)
        || !finite(receipt.usage.outputTokens) || !Number.isSafeInteger(receipt.usage.outputTokens)
        || recovered.recoveredOutcome.detail !== 'Owner旧格式受控安排已从本地原回执重新校验；未重发请求或修改原失败和费用。'
        || recovered.recoveredOutcome.reply !== undefined || recovered.recoveredOutcome.qualityDecision !== undefined
        || recovered.recoveredOutcome.planRevision !== undefined || recovered.recoveredOutcome.clarification !== undefined || recovered.recoveredOutcome.changeProposal !== undefined) throw new Error('受控安排恢复来源不符')
      const proposal = parseOwnerExecutionAssignmentProposal(receipt.responseText, frozen.assignmentContext)
      if (proposal.executionKind !== 'controlled' || JSON.stringify(proposal) !== JSON.stringify(recovered.recoveredOutcome.assignmentProposal)) throw new Error('受控安排恢复与原文不一致')
      return recovered.recoveredOutcome
    }
    if (recovered.recoveredOutcome.detail !== 'Owner旧格式回应已从本地原始回执重新校验；未重发请求，费用仍按原预留记录。') throw new Error('旧回应恢复说明不符')
    // 已追加的历史恢复按可信回执时间重验；当前质量动作仍独立检查实时证据有效期。
    const response = parseProjectOwnerPlanningResponse(receipt.responseText, frozen.context, receipt.capturedAt)
    if ((response.kind !== 'conversation_reply' && response.kind !== 'quality_decision') || recovered.recoveredOutcome.reply !== response.message || JSON.stringify(recovered.recoveredOutcome.qualityDecision) !== JSON.stringify(response.kind === 'quality_decision' ? response.decision : undefined)) throw new Error('旧回应恢复记录与原文不一致')
    return recovered.recoveredOutcome
  } catch { throw new Error('Owner旧回应恢复记录无效，请保留原始回执核查') }
}
/** 计划历史反查同Run原文与严格协议，不以origin标签或Model自述作为证明。 */
export function verifyGeneratedOwnerPlan(sourceRun: { receiptId: string; executionId: string; responseHash: string }, proposal: ProjectOwnerPlanProposal, goalRevision: number, contextFingerprint: string): void {
  const receipt = getOwnerPlanningRunReceipt(sourceRun.receiptId)
  if (!receipt || receipt.purpose !== 'owner_planning' || receipt.executionId !== sourceRun.executionId || receipt.responseHash !== sourceRun.responseHash || !receipt.validTerminal || receipt.stopped || receipt.error) throw new Error('Owner生成计划缺少可信Run证据')
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
    const body: Omit<OwnerPlanningRunReceipt, 'id'> = { schemaVersion: 1, executionId, sessionId: execution.sessionId, projectId: link.projectId, planningTaskId: link.planningTaskId, linkId: link.id, carrierId: binding.carrierId, channelId: binding.channelId, modelId: binding.modelId, bindingRevision: binding.revision, purpose: link.purpose, runtimeSource, captureHash, capturedAt: Date.now(), requestHash: admission?.request_hash ?? null, responseText, responseHash: hash(responseText), runtimeResult: runtimeResult ?? null, stopped, error: callbackError ?? null, validTerminal, usage: trustedRuntime ? nullableUsage(runtimeResult) : null, cost: trustedRuntime && admission && finite(runtimeResult.total_cost_usd) ? { source: 'runtime_reported', usd: runtimeResult.total_cost_usd } : { source: 'unknown', usd: null } }
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
        try { resolveOwnerPlanningTask(execution.entityId) } catch (cause) { outcome = { executionId, receiptId: receipt!.id, state: 'stale', detail: cause instanceof Error ? cause.message : '来源版本更新，保留原文' }; throw new Error('owner-source-stale') }
        if (link.purpose === 'owner_execution_assignment') {
          const source = frozen.assignmentContext
          if (!source) throw new Error('Owner安排冻结资料缺失')
          const protocolContext: OwnerExecutionAssignmentProtocolContext = { ...(source.teamContractVersion ? { teamContractVersion: source.teamContractVersion } : {}), contextFingerprint: source.contextFingerprint, workspaces: source.workspaces.map(({ id, name }) => ({ id, name })), executionKinds: source.executionKinds, ownerCarrierId: source.ownerCarrierId, steps: source.steps.map(({ key, dependencies, roleKey, sourceReferences }) => ({ key, dependencies, roleKey, ...(sourceReferences ? { sourceReferences } : {}) })), ...(source.codeFiles ? { codeFiles: source.codeFiles } : {}), candidates: source.candidates }
          const assignmentProposal = parseOwnerExecutionAssignmentProposal(responseText, protocolContext)
          outcome = { executionId, receiptId: receipt!.id, state: 'proposed', detail: 'Owner已提出执行安排，等待用户审核；不代表准备已保存或获得执行授权', assignmentProposal }
        } else {
          const response = parseProjectOwnerPlanningResponse(responseText, frozen.context)
          if (response.kind === 'employee_decision') outcome = { executionId, receiptId: receipt!.id, state: 'replied', detail: 'Owner已形成员工问题决定，待权威回流核验', reply: response.message, employeeDecision: response.decision }
          else if (response.kind === 'quality_decision') outcome = { executionId, receiptId: receipt!.id, state: 'replied', detail: 'Owner已提出质量决定，等待权威服务核验执行', reply: response.message, qualityDecision: response.decision }
          else if (response.kind === 'conversation_reply' || response.kind === 'conversation_change') outcome = { executionId, receiptId: receipt!.id, state: 'replied', detail: response.kind === 'conversation_change' ? 'Owner已整理理解，等待用户确认后更新内容' : 'Owner已回应当前消息，未修改计划或执行许可', reply: response.message, ...(response.kind === 'conversation_change' ? { changeProposal: response.change } : {}) }
          else if (response.kind === 'needs_clarification') outcome = { executionId, receiptId: receipt!.id, state: 'needs_clarification', detail: response.reason, clarification: response }
          else {
            const plan = appendGeneratedOwnerPlan(receipt!.id)
            outcome = { executionId, receiptId: receipt!.id, state: 'proposed', detail: 'AI提案待人工内容确认，不是执行许可', planRevision: plan.revision }
          }
        }
      } catch (cause) { if (outcome.state !== 'stale') outcome = { executionId, receiptId: receipt!.id, state: 'failed', detail: cause instanceof Error ? cause.message : '响应无效，保留原始证据，不覆盖计划' } }
    }
    store.getProjectDb().prepare('INSERT INTO project_owner_planning_run_outcomes (execution_id, receipt_id, payload) VALUES (?, ?, ?)').run(executionId, outcome.receiptId, JSON.stringify({ ...outcome, integrityHash: hash(outcome) }))
    // 规划承载Run终结；业务目标/DoD、员工绩效/学习/Review和通知不在这里写回。
    if (execution.status === 'running' || execution.status === 'queued') store.updateAgentExecution(executionId, { status: outcome.state === 'proposed' || outcome.state === 'needs_clarification' || outcome.state === 'replied' ? 'completed' : outcome.state === 'stopped' ? 'cancelled' : outcome.state === 'unknown' || outcome.state === 'stale' ? 'stale' : 'failed', completedAt: Date.now(), resultSummary: outcome.detail, ...(outcome.state === 'proposed' || outcome.state === 'needs_clarification' || outcome.state === 'replied' ? {} : { error: outcome.detail }) })
    const task = store.getTask(execution.entityId)
    if (task?.controlledPreparationId && task.assignee?.userId === `agent-${binding.carrierId}`) store.updateTask(task.id, { status: 'paused' })
    recordOwnerManagementRun(link.projectId, executionId, link.goalRevision, link.targetTaskId, link.purpose)
  })()
  return outcome
}
