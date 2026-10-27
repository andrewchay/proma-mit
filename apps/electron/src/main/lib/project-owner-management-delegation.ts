/** v6 规划协议允许的输出上限；与运行时校验、费用上界和授权记录保持同一口径。 */
export const OWNER_PLANNING_MAX_OUTPUT_TOKENS_V6 = 32768
export const OWNER_PLANNING_MAX_OUTPUT_TOKENS_LEGACY = 8192

/** 只有 GLM-5.3 系（长推理、v6 协议）使用 32768；其余模型维持既有 8192 上界。 */
export function ownerPlanningOutputCeiling(modelId: string, provider: string): 8192 | 32768 {
  return provider === 'zhipu' && /^glm-5\.3(?:-flash|-flashx)?$/i.test(modelId) ? OWNER_PLANNING_MAX_OUTPUT_TOKENS_V6 : OWNER_PLANNING_MAX_OUTPUT_TOKENS_LEGACY
}

/** 有界管理委托：复用Owner零工具出口，永久占用每次保守上界；无退款或未知状态自动重试。 */
import { createHash, randomUUID } from 'node:crypto'
import type { OwnerManagementAttentionCheck, OwnerManagementDelegation, OwnerManagementDelegationInput, OwnerManagementDelegationPreview, OwnerManagementDelegationView } from '@gravitas/shared'
import { getAgentProviderProtocol } from '@gravitas/shared'
import * as store from './project-sqlite-store'
import { getChannelById } from './channel-manager'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getOwnerCarrierFacts, getOwnerRuntimeBinding, ownerCarrierBindingMatches } from './project-owner-runtime-binding'
import { assertLocalActorEnabled, confirmProjectOwnerPlanDraft, getProjectOwnerPlanDraft, getProjectOwnerPlanningContext } from './project-owner-plan-service'
import { getProjectOwnerGoalDraft } from './project-owner-goal-service'
import { getOwnerManager, recordOwnerManagementDelegationConfirmed } from './project-owner-management-store'
import { getPilotReviewedPriceEvidenceForModel } from './project-pilot-request-evidence'
import { resolveOwnerPlanningTask } from './project-owner-planning-source'
import { requestOwnerManagementWake } from './project-owner-management-events'
import { readOwnerPlanningApiKey } from './owner-planning-configuration'
import { OWNER_PLANNING_V6_INPUT_TOKEN_CEILING, usesBoundedOwnerPlanningEnvelope } from './project-owner-planning-envelope'

interface Row { payload: string; integrity_hash: string }
interface GrantRow extends Row { revoked_at: number | null }
interface Claim { taskId: string; executionId: string; delegationId: string; reservedCostMicros: number }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function safeOutcomeDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined
  const safe = detail.replace(/\bBearer\s+\S+/gi, 'Bearer [已隐藏凭证]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[已隐藏凭证]')
    .replace(/\b(api[_-]?key|authorization|token)\s*[:=]\s*\S+/gi, '$1=[已隐藏凭证]')
    .replace(/\s+/g, ' ').trim().slice(0, 600)
  return safe || undefined
}
function read<T>(row: Row): T {
  const value: unknown = JSON.parse(row.payload)
  if (!value || typeof value !== 'object' || hash(value) !== row.integrity_hash) throw new Error('Owner管理委托记录损坏，请保留原件核查')
  return value as T
}
function object(raw: unknown, fields: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !fields.includes(key))) throw new Error('Owner管理委托字段无效')
  return raw as Record<string, unknown>
}
const fields = ['projectId', 'taskId', 'requestId', 'maxRequests', 'maxCostMicros', 'expiresAt', 'startApproval', 'autonomousExecution']
const MAX_MANAGEMENT_REQUESTS = 12
function parse(raw: unknown): OwnerManagementDelegationInput {
  const value = object(raw, fields)
  for (const key of ['projectId', 'requestId', ...(value.taskId === undefined ? [] : ['taskId'])]) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key] !== value[key].trim() || value[key].length > 128) throw new Error('Owner管理委托身份无效')
  }
  if (!Number.isSafeInteger(value.maxRequests) || Number(value.maxRequests) < 1 || (!value.autonomousExecution && Number(value.maxRequests) > MAX_MANAGEMENT_REQUESTS)
    || (value.autonomousExecution !== undefined && value.autonomousExecution !== true)
    || !Number.isSafeInteger(value.maxCostMicros) || Number(value.maxCostMicros) < 1 || Number(value.maxCostMicros) > 100_000_000
    || !Number.isSafeInteger(value.expiresAt)) throw new Error('Owner管理委托额度或期限无效')
  let startApproval: OwnerManagementDelegationInput['startApproval']
  if (value.startApproval !== undefined) {
    const approval = object(value.startApproval, ['expectedGoalRevision', 'expectedPlanRevision', 'planFingerprint', 'contextFingerprint'])
    if (!Number.isSafeInteger(approval.expectedGoalRevision) || Number(approval.expectedGoalRevision) < 1
      || !Number.isSafeInteger(approval.expectedPlanRevision) || Number(approval.expectedPlanRevision) < 1
      || typeof approval.planFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(approval.planFingerprint)
      || typeof approval.contextFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(approval.contextFingerprint)) throw new Error('Owner方案启动确认绑定无效')
    startApproval = { expectedGoalRevision: Number(approval.expectedGoalRevision), expectedPlanRevision: Number(approval.expectedPlanRevision), planFingerprint: approval.planFingerprint, contextFingerprint: approval.contextFingerprint }
  }
  return { projectId: value.projectId as string, ...(typeof value.taskId === 'string' ? { taskId: value.taskId } : {}), requestId: value.requestId as string,
    maxRequests: Number(value.maxRequests), maxCostMicros: Number(value.maxCostMicros), expiresAt: Number(value.expiresAt), ...(value.autonomousExecution ? { autonomousExecution: true as const } : {}), ...(startApproval ? { startApproval } : {}) }
}
function scope(projectId: string, taskId?: string, conversationEnabled = false, executionFollowupEnabled = false, fullDeliveryReviewEnabled = false, qualityDecisionEnabled = false) {
  assertLocalActorEnabled()
  const manager = getOwnerManager(projectId), binding = getOwnerRuntimeBinding(projectId)
  if (!manager || manager.status !== 'active' || !binding) throw new Error('Owner管理者未启用或尚无有效模型配置')
  const facts = getOwnerCarrierFacts(projectId, binding.carrierId, binding.workspaceId)
  if (!ownerCarrierBindingMatches(binding, facts)) throw new Error('Owner管理配置已变化，请重新确认')
  const channel = getChannelById(binding.channelId)
  if (!channel?.enabled) throw new Error('Owner管理渠道不可用')
  const protocol = getAgentProviderProtocol(channel.provider, binding.runtime)
  const kind = protocol === 'openai-chat' ? 'openai' : protocol === 'anthropic-messages' ? 'anthropic' : 'google'
  const price = getPilotReviewedPriceEvidenceForModel(binding.modelId, kind)
  if (!price || price.maxModelOutputTokens < 8192) throw new Error(`当前 Owner 模型「${binding.modelId}」暂不支持项目预算内的持续管理。请点击“更换 Owner 模型”选择支持的模型，再核对项目预算；添加渠道模型不会自动切换项目 Owner。`)
  const context = getProjectOwnerPlanningContext(projectId, taskId)
  // 不保存渠道凭据；配置/资料摘要用于每次发送前复核。
  const scopeHash = hash({ ownerId: manager.ownerId, binding, configurationFingerprint: facts.carrierConfigurationFingerprint, sources: context.sources, price, ...(conversationEnabled ? { conversationEnabled: true } : {}), ...(executionFollowupEnabled ? { executionFollowupEnabled: true } : {}), ...(fullDeliveryReviewEnabled ? { fullDeliveryReviewEnabled: true } : {}), ...(qualityDecisionEnabled ? { qualityDecisionEnabled: true } : {}) })
  const outputCeiling = ownerPlanningOutputCeiling(binding.modelId, getChannelById(binding.channelId)!.provider)
  const inputCeiling = usesBoundedOwnerPlanningEnvelope(binding.modelId, channel.provider)
    ? Math.min(price.maxModelInputTokens, OWNER_PLANNING_V6_INPUT_TOKEN_CEILING) : price.maxModelInputTokens
  const perRequestCeilingMicros = Number((BigInt(inputCeiling) * BigInt(price.inputMicrosPerMillion) + BigInt(outputCeiling) * BigInt(price.outputMicrosPerMillion) + 999999n) / 1000000n) + price.extraCostCeilingMicros
  if (!Number.isSafeInteger(perRequestCeilingMicros) || perRequestCeilingMicros < 1) throw new Error('Owner管理请求费用上界无效')
  return { binding, context, scopeHash, perRequestCeilingMicros, priceEvidenceId: price.evidenceId, outputCeiling }
}
export function previewOwnerManagementDelegation(raw: unknown): OwnerManagementDelegationPreview {
  const input = parse(raw), current = scope(input.projectId, input.taskId, true, true, true, true)
  readOwnerPlanningApiKey(current.binding.channelId)
  if (input.startApproval) {
    const plan = getProjectOwnerPlanDraft(input.projectId, input.taskId), context = getProjectOwnerPlanningContext(input.projectId, input.taskId)
    if (!plan || plan.state !== 'proposed' || plan.goalRevision !== input.startApproval.expectedGoalRevision || plan.revision !== input.startApproval.expectedPlanRevision
      || plan.planFingerprint !== input.startApproval.planFingerprint || plan.contextFingerprint !== input.startApproval.contextFingerprint
      || context.goal.revision !== input.startApproval.expectedGoalRevision || context.fingerprint !== input.startApproval.contextFingerprint)
      throw new Error('待确认方案或目标来源已变化；请重新审阅当前方案')
  }
  if (input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 7 * 86400000) throw new Error('Owner管理委托期限须在未来七天内')
  const prior = historicalUsage(input.projectId)
  if (input.maxRequests <= prior.usedRequests) throw new Error('累计管理请求次数不足以继续一次请求，请提高请求上限')
  if (input.maxCostMicros < prior.reservedCostMicros + current.perRequestCeilingMicros) throw new Error('预算不足以覆盖历史预留和一次保守请求上界，请调整累计预算或使用单次确认')
  assertOwnerModelBudgetAvailable({ projectBudgetMicros: input.maxCostMicros,
    ownerModelMicros: getOwnerModelBudgetUsage(input.projectId, input.maxCostMicros).ownerModelMicros,
    nextReservedMicros: current.perRequestCeilingMicros })
  const body = { ...input, conversationEnabled: true as const, executionFollowupEnabled: true as const, fullDeliveryReviewEnabled: true as const, qualityDecisionEnabled: true as const, scopeHash: current.scopeHash, goalContentHash: hash(current.context.goal), bindingRevision: current.binding.revision, goalRevision: current.context.goal.revision, modelId: current.binding.modelId, workspaceName: getAgentWorkspace(current.binding.workspaceId)!.name, priceEvidenceId: current.priceEvidenceId, perRequestCeilingMicros: current.perRequestCeilingMicros, maxOutputTokens: current.outputCeiling }
  return { ...body, previewHash: hash(body) }
}
function latest(projectId: string, taskId?: string): { delegation: OwnerManagementDelegation; row: GrantRow } | null {
  const row = store.getProjectDb().prepare('SELECT payload, integrity_hash, revoked_at FROM project_owner_management_delegations WHERE project_id = ? AND task_id IS ? ORDER BY rowid DESC LIMIT 1').get(projectId, taskId ?? null) as GrantRow | undefined
  if (!row) return null
  const delegation = read<OwnerManagementDelegation>(row)
  if (delegation.projectId !== projectId || delegation.taskId !== taskId) throw new Error('Owner管理委托主体不一致')
  return { delegation, row }
}
function claims(id: string): Claim[] {
  return (store.getProjectDb().prepare('SELECT payload, integrity_hash FROM project_owner_management_claims WHERE delegation_id = ? ORDER BY rowid').all(id) as Row[]).map(row => {
    const claim = read<Claim>(row)
    if (claim.delegationId !== id) throw new Error('Owner管理占额身份不一致')
    return claim
  })
}
/** Owner模型开销占项目总预算的比例上限；超出必须由用户新增明确授权。 */
export const OWNER_MODEL_BUDGET_RATIO = 0.2

export interface OwnerModelBudgetUsage {
  projectBudgetMicros: number
  ownerModelLimitMicros: number
  ownerModelMicros: number
  /** 仅可信 Runtime 报告的实际费用；估价不解除未知预留。 */
  ownerModelSettledMicros: number
  ownerModelInFlightMicros: number
  executionMicros: number
  remainingOwnerModelMicros: number
}

/** 按上限取整，保证占比永不因四舍五入越过上限。 */
export function ownerModelBudgetLimit(projectBudgetMicros: number): number {
  if (!Number.isSafeInteger(projectBudgetMicros) || projectBudgetMicros < 1) throw new Error('项目总预算无效')
  return Math.floor(projectBudgetMicros * OWNER_MODEL_BUDGET_RATIO)
}

/** 下一请求也必须装入 20% 上限；包络过大时拒绝发送，不能先消费再申请。 */
export function assertOwnerModelBudgetAvailable(input: { projectBudgetMicros: number; ownerModelMicros: number; nextReservedMicros: number }): void {
  if (!Number.isSafeInteger(input.ownerModelMicros) || input.ownerModelMicros < 0) throw new Error('Owner模型占额记录无效')
  const next = input.nextReservedMicros
  if (!Number.isSafeInteger(next) || next < 0) throw new Error('Owner下一请求预留无效')
  const limit = ownerModelBudgetLimit(input.projectBudgetMicros)
  if (input.ownerModelMicros >= limit || next > limit - input.ownerModelMicros) throw new Error(`Owner模型额度已用尽，或下一请求预留将超过项目预算的${OWNER_MODEL_BUDGET_RATIO * 100}%上限，须先确认增量授权或缩小请求包络`)
}

/**
 * 单个请求的Owner模型开销：
 * 仅完整性校验通过的 Runtime 实际费用可结算；token 和本地估价不能释放未知占额。
 */
function claimCostMicros(claim: Claim, database = store.getProjectDb()): { micros: number; settled: boolean } {
  const row = database.prepare('SELECT id FROM project_owner_planning_run_receipts WHERE execution_id = ? ORDER BY rowid DESC LIMIT 1').get(claim.executionId) as { id: string } | undefined
  if (row) {
    try {
      const { getOwnerPlanningRunReceipt } = require('./project-owner-planning-run-service') as typeof import('./project-owner-planning-run-service')
      const receipt = getOwnerPlanningRunReceipt(row.id)
      if (receipt?.executionId === claim.executionId && receipt.cost.source === 'runtime_reported' && typeof receipt.cost.usd === 'number' && Number.isFinite(receipt.cost.usd) && receipt.cost.usd >= 0) {
        return { micros: Math.ceil(receipt.cost.usd * 1_000_000), settled: true }
      }
    } catch { /* 回执损坏时按预留保守占用。 */ }
  }
  return { micros: claim.reservedCostMicros, settled: false }
}

/** Owner 模型开销按可信实际费用与未知预留统计，不用估价冒充结算。 */
export function getOwnerModelBudgetUsage(projectId: string, projectBudgetMicros: number, excludeExecutionId?: string): OwnerModelBudgetUsage {
  const rows = store.getProjectDb().prepare('SELECT id, payload, integrity_hash FROM project_owner_management_delegations WHERE project_id = ? ORDER BY rowid').all(projectId) as Array<{ id: string } & Row>
  const entries = rows.flatMap(row => claims(row.id)).filter(claim => claim.executionId !== excludeExecutionId)
  let ownerModelMicros = 0, ownerModelSettledMicros = 0
  for (const claim of entries) {
    const cost = claimCostMicros(claim)
    ownerModelMicros += cost.micros
    if (cost.settled) ownerModelSettledMicros += cost.micros
  }
  const execution = historicalUsage(projectId).executionReservedCostMicros
  const limit = ownerModelBudgetLimit(projectBudgetMicros)
  if (!Number.isSafeInteger(ownerModelMicros) || ownerModelMicros < 0) throw new Error('Owner模型占额记录无效，请保留账本核对')
  return { projectBudgetMicros, ownerModelLimitMicros: limit, ownerModelMicros, ownerModelSettledMicros, ownerModelInFlightMicros: ownerModelMicros - ownerModelSettledMicros, executionMicros: execution, remainingOwnerModelMicros: Math.max(0, limit - ownerModelMicros) }
}

function historicalUsage(projectId: string): { usedRequests: number; reservedCostMicros: number; managementReservedCostMicros: number; executionReservedCostMicros: number } {
  const rows = store.getProjectDb().prepare('SELECT id, payload, integrity_hash FROM project_owner_management_delegations WHERE project_id = ? ORDER BY rowid').all(projectId) as Array<{ id: string } & Row>
  const delegations = rows.map(row => {
    const delegation = read<OwnerManagementDelegation>(row)
    if (delegation.id !== row.id || delegation.projectId !== projectId) throw new Error('Owner管理委托历史主体不一致')
    return delegation
  })
  const ids = delegations.map(item => item.id)
  if (!ids.length) return { usedRequests: 0, reservedCostMicros: 0, managementReservedCostMicros: 0, executionReservedCostMicros: 0 }
  const entryList = ids.flatMap(claims)
  const managementReserved = entryList.reduce((sum, claim) => sum + claim.reservedCostMicros, 0)
  const placeholders = ids.map(() => '?').join(',')
  const execution = store.getProjectDb().prepare(`SELECT COALESCE(SUM(CASE
    WHEN c.state='released' THEN 0
    WHEN c.state='settled' AND c.actual_cost_micros IS NOT NULL THEN c.actual_cost_micros
    WHEN c.actual_cost_micros > c.reserved_cost_micros THEN c.actual_cost_micros
    ELSE c.reserved_cost_micros END), 0) AS reserved
    FROM project_owner_execution_commands c
    JOIN project_owner_execution_grants g ON g.id=c.grant_id
    WHERE g.owner_management_delegation_id IN (${placeholders}) AND c.project_id=?`).get(...ids, projectId) as { reserved: number }
  const total = managementReserved + execution.reserved
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Owner项目预算占额无效，请保留账本核对')
  return { usedRequests: entryList.length, reservedCostMicros: total, managementReservedCostMicros: managementReserved, executionReservedCostMicros: execution.reserved }
}
/** 用于执行命令排队时，与管理调用共享同一项目总预算；未知/未结算命令按完整预留额占用。 */
export function assertOwnerManagementBudgetReservationAvailable(delegationId: string, additionalCostMicros: number): void {
  if (!Number.isSafeInteger(additionalCostMicros) || additionalCostMicros <= 0) throw new Error('Owner项目预算新增占额无效')
  const row = store.getProjectDb().prepare('SELECT payload, integrity_hash, revoked_at FROM project_owner_management_delegations WHERE id=?').get(delegationId) as GrantRow | undefined
  if (!row || row.revoked_at !== null) throw new Error('项目总预算授权已撤销或缺失')
  const delegation = read<OwnerManagementDelegation>(row)
  const current = getOwnerManagementDelegation(delegation.projectId, delegation.taskId)
  if (!['active', 'exhausted'].includes(current.state) || current.delegation?.id !== delegationId) throw new Error(current.detail || '项目总预算授权已失效')
  if (current.reservedCostMicros + additionalCostMicros > delegation.maxCostMicros) throw new Error('项目总预算余额不足，须先确认增量预算')
}
/** 新目标修订必须有原问题→答复→目标的精确证据；人工改目标不能继承旧委托。 */
function assertGoalLineage(delegation: OwnerManagementDelegation, currentRevision: number): void {
  const root = store.getProjectDb().prepare('SELECT payload FROM project_owner_revisions WHERE project_id = ? AND subject_key = ? AND revision = ?').get(delegation.projectId, delegation.taskId ? `task:${delegation.taskId}` : 'project', delegation.goalRevision) as { payload: string } | undefined
  if (!root || hash(JSON.parse(root.payload)) !== delegation.goalContentHash) throw new Error('Owner管理委托的原目标内容已变化')
  if (currentRevision < delegation.goalRevision) throw new Error('Owner目标已回退')
  for (let revision = delegation.goalRevision + 1; revision <= currentRevision; revision++) {
    const rows = store.getProjectDb().prepare('SELECT payload, integrity_hash FROM project_owner_management_answers WHERE project_id = ? AND json_extract(payload, \'$.goal.revision\') = ?').all(delegation.projectId, revision) as Row[]
    const answer = rows.map(row => read<{ questionId: string; goal: { revision: number; goal: { taskId?: string } } }>(row)).find(item => item.goal.goal.taskId === delegation.taskId)
    const questionRow = answer ? store.getProjectDb().prepare('SELECT payload, integrity_hash FROM project_owner_management_questions WHERE id = ? AND project_id = ?').get(answer.questionId, delegation.projectId) as Row | undefined : undefined
    const question = questionRow ? read<{ goalRevision: number; taskId?: string }>(questionRow) : null
    const goal = store.getProjectDb().prepare('SELECT payload FROM project_owner_revisions WHERE project_id = ? AND subject_key = ? AND revision = ?').get(delegation.projectId, delegation.taskId ? `task:${delegation.taskId}` : 'project', revision) as { payload: string } | undefined
    if (!answer || !question || question.goalRevision !== revision - 1 || question.taskId !== delegation.taskId || goal?.payload !== JSON.stringify(answer.goal)) throw new Error('Owner目标已人工修订，需要重新确认管理范围')
  }
}
function assertCurrent(delegation: OwnerManagementDelegation): void {
  if (!delegation.autonomousExecution && delegation.maxRequests > MAX_MANAGEMENT_REQUESTS) throw new Error('管理委托超过当前调用安全上限，请重新确认预算与期限')
  const current = scope(delegation.projectId, delegation.taskId, delegation.conversationEnabled === true, delegation.executionFollowupEnabled === true, delegation.fullDeliveryReviewEnabled === true, delegation.qualityDecisionEnabled === true)
  if (current.scopeHash !== delegation.scopeHash || current.binding.revision !== delegation.bindingRevision || current.perRequestCeilingMicros !== delegation.perRequestCeilingMicros) throw new Error('Owner管理委托的配置、资料或价格已变化')
  assertGoalLineage(delegation, current.context.goal.revision)
}
export function getOwnerManagementDelegation(projectId: string, taskId?: string): OwnerManagementDelegationView {
  const found = latest(projectId, taskId)
  if (!found) return { delegation: null, state: 'none', usedRequests: 0, reservedCostMicros: 0, detail: '' }
  const { delegation, row } = found, entries = claims(delegation.id)
  const usage = historicalUsage(projectId)
  const base = { delegation, ...usage, ownerModelBudget: (() => {
    const budget = getOwnerModelBudgetUsage(projectId, delegation.maxCostMicros)
    return { limitMicros: budget.ownerModelLimitMicros, usedMicros: budget.ownerModelMicros, settledMicros: budget.ownerModelSettledMicros, inFlightMicros: budget.ownerModelInFlightMicros, remainingMicros: budget.remainingOwnerModelMicros, ratio: OWNER_MODEL_BUDGET_RATIO }
  })() }
  let rejectedProtocolReply = false
  let localConfigurationFailure = false
  for (const entry of entries) {
    const execution = store.getAgentExecution(entry.executionId)
    if (execution && ['queued', 'running'].includes(execution.status)) continue
    const runs = require('./project-owner-planning-run-service') as typeof import('./project-owner-planning-run-service')
    const value = runs.getOwnerPlanningRunOutcome(entry.executionId)
    const receipt = value ? runs.getOwnerPlanningRunReceipt(value.receiptId) : null
    if (receipt && runs.isUnsentOwnerPlanningConfigurationFailure(entry.executionId, receipt.id)) {
      localConfigurationFailure = true
      continue
    }
    const protocolRejected = Boolean(receipt && value && (receipt.purpose === 'owner_planning' && (value.detail.startsWith('Owner规划') || ['Owner质量决定未按准确标准逐项判断或引用不符', 'Owner质量决定与准确评审/成果不匹配'].includes(value.detail))
      || receipt.purpose === 'owner_execution_assignment' && (value.detail.startsWith('Owner安排') || value.detail.startsWith('Owner人员安排'))))
    const rejectedReply = value?.state === 'failed'
      && protocolRejected
      && receipt?.validTerminal === true
      && receipt.error === null
      && receipt.runtimeResult?.subtype === 'success'
    rejectedProtocolReply ||= rejectedReply
    let reason: OwnerManagementAttentionCheck['reason'] | null = null
    if (!execution) reason = 'missing_execution'
    else if (!value) reason = 'missing_outcome'
    else if (!receipt) reason = 'missing_receipt'
    else if (!receipt.usage) reason = 'missing_usage'
    else if (!Number.isSafeInteger(receipt.usage.inputTokens) || !Number.isSafeInteger(receipt.usage.outputTokens)) reason = 'invalid_usage'
    else if (receipt.runtimeResult?.finish_reason === 'length' || Number(receipt.usage.outputTokens) > delegation.maxOutputTokens) reason = 'output_limit'
    else if (!['proposed', 'needs_clarification', 'replied'].includes(value?.state ?? '') && !rejectedReply) reason = 'non_continueable_outcome'
    if (reason) {
      const requestId = receipt?.runtimeResult?.provider_request_id, responseId = receipt?.runtimeResult?.provider_response_id, outcomeDetail = safeOutcomeDetail(value?.detail)
      const attentionCheck: OwnerManagementAttentionCheck = {
        executionStatus: execution?.status ?? 'missing', outcomeState: value?.state ?? 'missing', reason,
        requestStartedAt: execution?.startedAt ?? null, receiptCapturedAt: receipt?.capturedAt ?? null,
        inputTokens: receipt?.usage?.inputTokens ?? null, outputTokens: receipt?.usage?.outputTokens ?? null,
        costSource: receipt?.cost.source ?? 'missing', costUsd: receipt?.cost.usd ?? null,
        ...(receipt?.modelId ? { modelId: receipt.modelId } : {}),
        ...(outcomeDetail ? { outcomeDetail } : {}),
        ...(typeof requestId === 'string' && requestId.trim() ? { providerRequestId: requestId } : {}),
        ...(typeof responseId === 'string' && responseId.trim() ? { providerResponseId: responseId } : {}),
      }
      return { ...base, state: 'attention', detail: '上次管理请求没有满足继续处理所需的运行或用量证据；请查看原请求核对信息，不会自动重试。', attentionCheck }
    }
  }
  // 未知或失败请求的费用核对优先于委托漂移提示，避免把实际中断原因藏在重新授权状态后面。
  if (row.revoked_at !== null) return { ...base, state: 'revoked', detail: '管理委托已撤销；已发出的请求费用和远端停止状态须另核对。' }
  if (localConfigurationFailure) return { ...base, state: 'stale', detail: '上次在本地配置检查阶段失败，未进入模型请求发送。请保存服务凭据后重新核对项目预算；原失败和保守预留仍保留，不自动重发，也不补造模型用量或账单。' }
  if (delegation.expiresAt <= Date.now()) return { ...base, state: 'expired', detail: '管理委托已到期。' }
  try { assertCurrent(delegation) } catch (cause) { return { ...base, state: 'stale', detail: cause instanceof Error ? cause.message : '管理范围需重新确认' } }
  if ((!delegation.autonomousExecution && base.usedRequests >= delegation.maxRequests) || base.reservedCostMicros + delegation.perRequestCeilingMicros > delegation.maxCostMicros) return { ...base, state: 'exhausted', detail: delegation.autonomousExecution ? '项目总预算预留已用尽。实际费用另按运行证据核对。' : '管理请求额度或费用预留已用尽。实际费用另按运行证据核对。' }
  try { assertOwnerModelBudgetAvailable({ projectBudgetMicros: delegation.maxCostMicros,
    ownerModelMicros: base.ownerModelBudget.usedMicros, nextReservedMicros: delegation.perRequestCeilingMicros }) }
  catch (cause) { return { ...base, state: 'exhausted', detail: cause instanceof Error ? cause.message : 'Owner占比额度不足' } }
  const detail = delegation.qualityDecisionEnabled ? '管理委托有效；Owner可按完整成果与独立检查提出质量决定，只有当前业务许可覆盖时才执行验收或有限返工。' : delegation.fullDeliveryReviewEnabled ? '管理委托有效；可读取准确完整文本成果和逐项检查并分析，不包含自动验收或员工执行许可。' : delegation.executionFollowupEnabled ? '管理委托有效；可在约定额度内主动分析员工结果、停滞和到期情况；不包含员工执行或成果自动验收许可。' : delegation.conversationEnabled ? '管理委托有效；只允许已确认范围内的受限规划、对话及安排，不包含员工执行许可。' : '旧管理委托有效；仅含受限规划和安排，不包含持续对话或员工执行许可。'
  return { ...base, state: 'active', detail: rejectedProtocolReply ? `上一条Owner响应未通过协议校验；原请求不会重试，费用未知仍按保守预留占用项目额度。${detail}` : detail }
}
export function confirmOwnerManagementDelegation(raw: unknown): OwnerManagementDelegation {
  const value = object(raw, ['input', 'previewHash']), input = parse(value.input)
  if (typeof value.previewHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.previewHash)) throw new Error('管理委托确认指纹无效')
  const db = store.getProjectDb()
  if (db.isTransactionActive()) throw new Error('管理委托不能在未提交外层事务中发行')
  let result: OwnerManagementDelegation | undefined
  db.transaction(() => {
    assertLocalActorEnabled()
    const old = db.prepare('SELECT payload, integrity_hash FROM project_owner_management_delegations WHERE project_id = ? AND request_id = ?').get(input.projectId, input.requestId) as Row | undefined
    if (old) {
      const saved = read<OwnerManagementDelegation>(old)
      if (saved.previewHash !== value.previewHash || fields.some(field => {
        const previous = saved[field as keyof OwnerManagementDelegation], next = input[field as keyof OwnerManagementDelegationInput]
        return previous !== next && !(previous !== undefined && next !== undefined && typeof previous === 'object' && typeof next === 'object' && hash(previous) === hash(next))
      })) throw new Error('管理委托请求ID已用于不同确认')
      result = saved; return
    }
    const preview = previewOwnerManagementDelegation(input)
    if (preview.previewHash !== value.previewHash) throw new Error('管理委托预览已变化，请重新确认')
    const current = getOwnerManagementDelegation(input.projectId, input.taskId)
    if (current.delegation && hasActiveOwnerManagementRequest(current.delegation.id)) throw new Error('上次管理请求仍在运行，请先核对请求状态')
    if (current.delegation && current.state === 'stale') {
      // 旧委托已因当前范围变化而失效；仅在用户确认新预览的同一事务中关闭旧记录。
      db.prepare('UPDATE project_owner_management_delegations SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND project_id = ?').run(Date.now(), current.delegation.id, input.projectId)
    } else if (current.delegation && !['revoked', 'expired'].includes(current.state)) {
      throw new Error('请先撤销已有管理委托，再确认新范围')
    }
    if (input.startApproval) confirmProjectOwnerPlanDraft(input.projectId, input.startApproval.expectedGoalRevision, input.startApproval.expectedPlanRevision, input.taskId)
    result = { ...preview, id: randomUUID(), issuedAt: Date.now() }
    db.prepare('INSERT INTO project_owner_management_delegations (id, project_id, task_id, request_id, payload, integrity_hash, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)').run(result.id, input.projectId, input.taskId ?? null, input.requestId, JSON.stringify(result), hash(result))
    const goal = getProjectOwnerGoalDraft(input.projectId, input.taskId)
    if (!goal) throw new Error('Owner目标已不存在，不能启动管理委托')
    // 首次授权也必须形成持久事件。仅发进程内唤醒会依赖旧规划链接补偿，
    // 而已有方案/旧事件已消费时可能没有后续动作，用户只会看到额度卡片。
    recordOwnerManagementDelegationConfirmed(input.projectId, goal.revision, result.id, input.taskId)
  })()
  if (!result) throw new Error('管理委托发行失败')
  requestOwnerManagementWake(input.projectId)
  return result
}
export function revokeOwnerManagementDelegation(projectId: string, id: string): OwnerManagementDelegationView {
  assertLocalActorEnabled()
  const row = store.getProjectDb().prepare('SELECT payload, integrity_hash FROM project_owner_management_delegations WHERE id = ? AND project_id = ?').get(id, projectId) as Row | undefined
  if (!row) throw new Error('管理委托不存在或不属于当前项目')
  const delegation = read<OwnerManagementDelegation>(row)
  store.getProjectDb().prepare('UPDATE project_owner_management_delegations SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(Date.now(), id)
  return getOwnerManagementDelegation(projectId, delegation.taskId)
}
export function getOwnerManagementClaim(taskId: string): Claim | null {
  const row = store.getProjectDb().prepare('SELECT payload, integrity_hash FROM project_owner_management_claims WHERE task_id = ?').get(taskId) as Row | undefined
  const value = row ? read<Claim>(row) : null
  if (value && value.taskId !== taskId) throw new Error('Owner管理占额任务不一致')
  return value
}
/** 只读调度提示；真正占额仍须在排队事务中重新检查。 */
export function hasActiveOwnerManagementRequest(delegationId: string): boolean {
  return claims(delegationId).some(item => ['queued', 'running'].includes(store.getAgentExecution(item.executionId)?.status ?? ''))
}
/** 在受控排队同事务占额，确保失败回滚且双击不创建第二次调用。 */
export function claimOwnerManagementTask(taskId: string, executionId: string): void {
  const db = store.getProjectDb()
  if (!db.isTransactionActive()) throw new Error('Owner管理占额必须与执行排队同事务')
  const source = resolveOwnerPlanningTask(taskId)
  if (!source) throw new Error('管理委托只适用于Owner受限推理')
  const view = getOwnerManagementDelegation(source.link.projectId, source.link.targetTaskId)
  if (view.state !== 'active' || !view.delegation) throw new Error(view.detail || '没有有效管理委托')
  if (source.context.conversation?.executionObservation && view.delegation.executionFollowupEnabled !== true) throw new Error('旧管理委托不包含业务结果主动跟进，请重新确认管理范围')
  if (source.context.conversation?.deliveryReview && view.delegation.fullDeliveryReviewEnabled !== true) throw new Error('旧管理委托未包含完整成果读取，请重新确认管理范围')
  if (source.context.conversation?.deliveryReview?.qualityDecisionVersion === 1 && view.delegation.qualityDecisionEnabled !== true) throw new Error('旧管理委托未包含质量决定')
  if (source.link.conversationMessageId && view.delegation.conversationEnabled !== true) throw new Error('旧管理委托不包含持续对话，请重新确认管理范围')
  if (hasActiveOwnerManagementRequest(view.delegation.id)) throw new Error('Owner已有管理请求运行，等待当前结果')
  assertOwnerModelBudgetAvailable({ projectBudgetMicros: view.delegation.maxCostMicros, ownerModelMicros: getOwnerModelBudgetUsage(view.delegation.projectId, view.delegation.maxCostMicros).ownerModelMicros, nextReservedMicros: view.delegation.perRequestCeilingMicros })
  const claim: Claim = { taskId, executionId, delegationId: view.delegation.id, reservedCostMicros: view.delegation.perRequestCeilingMicros }
  db.prepare('UPDATE controlled_task_preparations SET owner_management_delegation_id = ? WHERE task_id = ?').run(claim.delegationId, taskId)
  db.prepare('INSERT INTO project_owner_management_claims (task_id, delegation_id, execution_id, payload, integrity_hash) VALUES (?, ?, ?, ?, ?)').run(taskId, claim.delegationId, executionId, JSON.stringify(claim), hash(claim))
}
/** 有占额证据就不能退回普通确认路径；撤销、到期或来源漂移均拒绝新发送。 */
export function assertOwnerManagementTask(executionId: string): boolean {
  const execution = store.getAgentExecution(executionId)
  if (!execution || execution.entityType !== 'task') return false
  const claim = getOwnerManagementClaim(execution.entityId)
  const marker = store.getProjectDb().prepare('SELECT owner_management_delegation_id FROM controlled_task_preparations WHERE task_id = ?').get(execution.entityId) as { owner_management_delegation_id: string | null } | undefined
  if (!claim && !marker?.owner_management_delegation_id) return false
  if (!claim || marker?.owner_management_delegation_id !== claim.delegationId) throw new Error('Owner管理占额证据缺失或不一致，不能降级普通确认')
  const source = resolveOwnerPlanningTask(execution.entityId)
  const found = source ? latest(source.link.projectId, source.link.targetTaskId) : null
  if (!source || !found || claim.executionId !== executionId || claim.delegationId !== found.delegation.id || found.row.revoked_at !== null || found.delegation.expiresAt <= Date.now()) throw new Error('Owner管理请求的委托已撤销、过期或身份不一致')
  if (source.binding.carrierId !== execution.agentId || execution.projectId !== source.link.projectId) throw new Error('Owner管理执行主体不一致')
  if (source.context.conversation?.executionObservation && found.delegation.executionFollowupEnabled !== true) throw new Error('管理许可未包含业务结果主动跟进')
  if (source.context.conversation?.deliveryReview && found.delegation.fullDeliveryReviewEnabled !== true) throw new Error('管理许可未包含完整成果读取')
  if (source.context.conversation?.deliveryReview?.qualityDecisionVersion === 1 && found.delegation.qualityDecisionEnabled !== true) throw new Error('管理许可未包含质量决定')
  if (source.link.conversationMessageId && found.delegation.conversationEnabled !== true) throw new Error('管理许可未包含持续对话')
  assertCurrent(found.delegation)
  const usage = historicalUsage(found.delegation.projectId)
  if ((!found.delegation.autonomousExecution && usage.usedRequests > found.delegation.maxRequests) || usage.reservedCostMicros > found.delegation.maxCostMicros || claim.reservedCostMicros !== found.delegation.perRequestCeilingMicros || source.link.maxOutputTokens > ownerPlanningOutputCeiling(source.binding.modelId, getChannelById(source.binding.channelId)!.provider)) throw new Error('Owner管理占额超限或与请求不一致')
  // 排除自身后再计入整笔冻结预留，既不重复占额，也不绕过本次上限。
  assertOwnerModelBudgetAvailable({ projectBudgetMicros: found.delegation.maxCostMicros, ownerModelMicros: getOwnerModelBudgetUsage(found.delegation.projectId, found.delegation.maxCostMicros, executionId).ownerModelMicros, nextReservedMicros: claim.reservedCostMicros })
  return true
}
