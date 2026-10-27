import { readOwnerCommandRuntime, assertOwnerCommandPrice } from './project-owner-employee-runtime'
/** Owner逐请求出口：derive→reserve→verify→fetch→settle五步镜像；Owner出口一律redirect:'error'；默认fake transport。 */
import { createHash, randomUUID } from 'node:crypto'
import * as store from './project-sqlite-store'
import { derivePilotRequestEnvelope, getPilotReviewedPriceEvidence, getPilotReviewedPriceEvidenceForModel } from './project-pilot-request-evidence'
import { getAgentProviderProtocol, type ProviderType } from '@gravitas/shared'
import { PILOT_DEFAULT_PRICE_EVIDENCE_ID } from './project-pilot-request-exit'
import { ownerEmployeePriceProviderKind } from './project-owner-employee-runtime'

const REQUEST_EVIDENCE_PATTERN = /^[a-f0-9]{64}$/
function injectStreamUsage(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    if (parsed && typeof parsed === 'object' && !('stream' in parsed) && !parsed.stream_options) return body
    if (parsed.stream === true || (parsed.stream_options as Record<string, unknown>)?.include_usage === true) {
      return JSON.stringify({ ...parsed, stream_options: { ...(parsed.stream_options as Record<string, unknown> | undefined), include_usage: true } })
    }
    return body
  } catch { return body }
}
function capPiOwnerOutput(body: string, runtime: ReturnType<typeof readOwnerCommandRuntime>): string {
  if (runtime.runtime !== 'pi') return body
  const price = runtime.priceEvidenceId ? getPilotReviewedPriceEvidence(runtime.priceEvidenceId) : null
  if (!price || price.model !== runtime.modelId || price.providerKind !== 'openai') throw new Error('Owner Pi 输出上限缺少匹配的审核价格证据')
  const parsed = JSON.parse(body) as Record<string, unknown>
  let capped = false
  for (const key of ['max_tokens', 'max_completion_tokens']) {
    const value = parsed[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) continue
    const ownerLimit = runtime.modelId === 'deepseek-flash' ? 131_072 : price.maxModelOutputTokens
    parsed[key] = Math.min(value, price.maxModelOutputTokens, ownerLimit)
    capped = true
  }
  if (!capped) throw new Error('Owner Pi 请求缺少可核验的输出上限')
  return JSON.stringify(parsed)
}
export interface OwnerRequestFetchInput {
  commandId: string
  executionId: string
  sessionId: string
  priceEvidenceId?: string
  baseFetch: typeof globalThis.fetch
}

const OWNER_PREFLIGHT_PRICE_REJECTION = 'Owner 命令输出上限与运行授权/审核价格证据不匹配'

interface OwnerPreflightCommandRow {
  command_role: string
  command_state: string
  command_id: string
  execution_id: string | null
  grant_id: string
  grant_state: string
  project_id: string
  channel_id: string
  model_id: string
  runtime: string
  reserved_cost_micros: number
}

/** 在价格协议拒绝时固化发送前证据；只有零逐请求账本行且身份仍为running才记录。 */
function recordOwnerPreflightPriceRejection(input: {
  command: OwnerPreflightCommandRow
  executionId: string
  provider: ProviderType
  protocol: string
  modelId: string
  priceEvidenceId: string
  errorMessage: string
}): void {
  const database = store.getProjectDb()
  if (database.isTransactionActive()) throw new Error('Owner预发送拒绝不得嵌套未提交事务')
  database.transaction(() => {
    const stored = database.prepare(`SELECT c.id AS command_id, c.execution_id, c.project_id, c.grant_id, c.state AS command_state,
        g.state AS grant_state, g.channel_id, g.model_id, g.runtime
      FROM project_owner_execution_commands c JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
      WHERE c.id=?`).get(input.command.command_id) as OwnerPreflightCommandRow | undefined
    const runtime = stored ? readOwnerCommandRuntime(stored.command_id) : null
    const command = stored && runtime ? { ...stored, channel_id: runtime.channelId, model_id: runtime.modelId, runtime: runtime.runtime } : null
    const execution = store.getAgentExecution(input.executionId)
    if (!command || !execution || command.project_id !== input.command.project_id || command.grant_id !== input.command.grant_id
      || command.execution_id !== input.executionId || command.command_state !== 'running' || command.grant_state !== 'active'
      || command.channel_id !== input.command.channel_id || command.model_id !== input.modelId || !['ai-sdk', 'pi'].includes(command.runtime)
      || execution.projectId !== command.project_id || execution.ownerCommandId !== command.command_id
      || execution.sessionId === '' || execution.status !== 'running') {
      throw new Error('Owner预发送拒绝归属或状态已变化')
    }
    const requestRows = database.prepare('SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations WHERE command_id=? OR execution_id=?').get(command.command_id, input.executionId) as { count: number }
    if (requestRows.count !== 0) throw new Error('Owner执行已有请求账本记录，拒绝记为发送前失败')
    if (database.prepare('SELECT 1 FROM project_owner_execution_preflight_rejections WHERE execution_id=? OR command_id=?').get(input.executionId, command.command_id)) {
      throw new Error('Owner预发送拒绝证据已存在，拒绝重复写入')
    }
    const errorSha256 = createHash('sha256').update(input.errorMessage, 'utf8').digest('hex')
    database.prepare(`INSERT INTO project_owner_execution_preflight_rejections
      (execution_id, command_id, project_id, grant_id, channel_id, model_id, provider_type, provider_protocol, price_evidence_id, reason_code, error_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reviewed_price_evidence_mismatch', ?, ?)`)
      .run(input.executionId, command.command_id, command.project_id, command.grant_id, command.channel_id, input.modelId,
        input.provider, input.protocol, input.priceEvidenceId, errorSha256, Date.now())
  })()
}

/** Owner 命令必须在 AI SDK 组装请求前设置审核模型可接受的输出上限。 */
export function resolveOwnerExecutionMaxOutputTokens(sessionId: string, modelId: string, provider: ProviderType): number | undefined {
  const execution = store.getAgentExecutionBySessionId(sessionId)
  if (!execution?.ownerCommandId) return undefined
  const stored = store.getProjectDb().prepare(`SELECT c.id AS command_id, c.state AS command_state, c.role AS command_role, c.execution_id,
      c.project_id, c.grant_id, c.reserved_cost_micros, g.state AS grant_state, g.channel_id, g.model_id, g.runtime
    FROM project_owner_execution_commands c
    JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
    WHERE c.id=? AND c.project_id=?`).get(execution.ownerCommandId, execution.projectId) as OwnerPreflightCommandRow | undefined
  const runtime = stored ? readOwnerCommandRuntime(stored.command_id) : null
  const row = stored && runtime ? { ...stored, channel_id: runtime.channelId, model_id: runtime.modelId, runtime: runtime.runtime } : null
  if (runtime) assertOwnerCommandPrice(runtime)
  const providerKind = ownerEmployeePriceProviderKind(row?.runtime ?? 'ai-sdk', provider, modelId)
  const protocol = row?.runtime === 'pi' ? 'openai-completions' : getAgentProviderProtocol(provider, 'ai-sdk')
  if (!row || row.execution_id !== execution.id || row.project_id !== execution.projectId || row.command_id !== execution.ownerCommandId
    || row.command_state !== 'running' || execution.status !== 'running' || row.grant_state !== 'active'
    || !['ai-sdk', 'pi'].includes(row.runtime) || row.model_id !== modelId) {
    throw new Error('Owner命令执行归属或运行授权不匹配')
  }
  const price = getPilotReviewedPriceEvidenceForModel(modelId, providerKind)
  if (!price || price.model !== modelId || price.providerKind !== providerKind) {
    const attemptedPriceEvidenceId = price?.evidenceId ?? PILOT_DEFAULT_PRICE_EVIDENCE_ID
    recordOwnerPreflightPriceRejection({ command: row, executionId: execution.id, provider, protocol, modelId,
      priceEvidenceId: attemptedPriceEvidenceId, errorMessage: OWNER_PREFLIGHT_PRICE_REJECTION })
    throw new Error(OWNER_PREFLIGHT_PRICE_REJECTION)
  }
  // 价格证据不是每轮输出目标。Owner采用更保守的调用策略上限；不据此断言Provider的真实协议上限或旧失败原因。
  const protocolSafeMax = row.model_id === 'deepseek-flash' && providerKind === 'openai' ? 131_072 : price.maxModelOutputTokens
  // 输出上限还要受命令额度约束：单请求按最大输出预留若接近命令额度，实际请求必然被拒。
  // 只用一半额度估算输出，其余留给输入与后续请求；这是保守调用策略，不代表Provider上限。
  const outputMicrosPerToken = price.outputMicrosPerMillion / 1_000_000
  const budgetBoundedMax = outputMicrosPerToken > 0 && row.reserved_cost_micros > 0
    ? Math.floor(row.reserved_cost_micros * 0.5 / outputMicrosPerToken)
    : protocolSafeMax
  return Math.max(1024, Math.min(price.maxModelOutputTokens, protocolSafeMax, budgetBoundedMax))
}
function reserveOwnerRequest(input: { requestId: string; commandId: string; executionId: string; sessionId: string; envelope: ReturnType<typeof derivePilotRequestEnvelope> }) {
  if ([input.requestId, input.commandId, input.executionId, input.sessionId].some(id => typeof id !== 'string' || !id.trim())
    || !REQUEST_EVIDENCE_PATTERN.test(input.envelope?.requestEvidenceId ?? '')
    || !Number.isSafeInteger(input.envelope?.inputTokenCeiling) || input.envelope.inputTokenCeiling <= 0
    || !Number.isSafeInteger(input.envelope?.outputTokenCeiling) || input.envelope.outputTokenCeiling <= 0) {
    throw new Error('Owner请求身份或包络无效')
  }
  const evidence = getPilotReviewedPriceEvidence(input.envelope.priceEvidenceId)
  if (!evidence) throw new Error('Owner价格证据未审核，拒绝预留')
  if (input.envelope.inputRateMicrosPerMillion !== evidence.inputMicrosPerMillion
    || input.envelope.outputRateMicrosPerMillion !== evidence.outputMicrosPerMillion
    || input.envelope.extraCostCeilingMicros !== evidence.extraCostCeilingMicros
    || input.envelope.inputTokenCeiling > evidence.maxModelInputTokens
    || input.envelope.outputTokenCeiling > evidence.maxModelOutputTokens) {
    throw new Error('Owner请求包络与价格证据不一致')
  }
  const database = store.getProjectDb()
  let reserved = 0
  database.transaction(() => {
    const { assertOwnerSmokeRequestLimit } = require('./owner-real-chain-smoke-budget') as typeof import('./owner-real-chain-smoke-budget')
    assertOwnerSmokeRequestLimit()
    const command = database.prepare("SELECT project_id, grant_id, state, reserved_cost_micros FROM project_owner_execution_commands WHERE id=? AND execution_id=?").get(input.commandId, input.executionId) as { project_id: string; grant_id: string; state: string; reserved_cost_micros: number } | undefined
    const execution = store.getAgentExecution(input.executionId)
    const grant = command && database.prepare("SELECT state, expires_at FROM project_owner_execution_grants WHERE id=? AND project_id=?").get(command.grant_id, command.project_id) as { state: string; expires_at: number } | undefined
    if (!command || !execution || !grant || command.state !== 'running' || grant.state !== 'active'
      || grant.expires_at <= Date.now() || execution.status !== 'running'
      || execution.ownerCommandId !== input.commandId || execution.sessionId !== input.sessionId) {
      throw new Error('Owner请求归属或活动授权无法核验')
    }
    if (database.prepare('SELECT 1 FROM project_owner_execution_request_reservations WHERE request_id=?').get(input.requestId)) throw new Error('Owner请求ID已预留，不得重复发送')
    if (database.prepare('SELECT 1 FROM project_owner_execution_request_reservations WHERE execution_id=? AND request_evidence_id=?').get(input.executionId, input.envelope.requestEvidenceId)) throw new Error('Owner请求体指纹已预留，不得重复发送')
    if (database.prepare("SELECT 1 FROM project_owner_execution_request_reservations WHERE command_id=? AND state='needs_reconcile' LIMIT 1").get(input.commandId)) throw new Error('Owner已有请求用量未知并需对账，拒绝继续调用模型')
    reserved = Math.ceil(input.envelope.inputTokenCeiling * evidence.inputMicrosPerMillion / 1_000_000)
      + Math.ceil(input.envelope.outputTokenCeiling * evidence.outputMicrosPerMillion / 1_000_000)
      + input.envelope.extraCostCeilingMicros
    const alreadyReserved = database.prepare(`SELECT COALESCE(SUM(CASE WHEN state='settled' THEN settled_cost_micros ELSE reserved_cost_micros END), 0) AS total
      FROM project_owner_execution_request_reservations WHERE command_id=?`).get(input.commandId) as { total: number }
    if (!Number.isSafeInteger(command.reserved_cost_micros) || command.reserved_cost_micros <= 0
      || !Number.isSafeInteger(alreadyReserved.total) || alreadyReserved.total + reserved > command.reserved_cost_micros) {
      throw new Error('Owner请求预留超过命令授权额度，拒绝发送')
    }
    database.prepare(`INSERT INTO project_owner_execution_request_reservations
      (request_id, command_id, execution_id, session_id, request_evidence_id, price_evidence_id, reserved_cost_micros, settled_cost_micros, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'reserved', ?)`).run(input.requestId, input.commandId, input.executionId, input.sessionId, input.envelope.requestEvidenceId, input.envelope.priceEvidenceId, reserved, Date.now())
  })()
  return reserved
}
function verifyOwnerRequestBody(requestId: string, body: string, priceEvidenceId: string): void {
  const evidenceId = derivePilotRequestEnvelope({ body, priceEvidenceId }).requestEvidenceId
  const row = store.getProjectDb().prepare('SELECT request_evidence_id FROM project_owner_execution_request_reservations WHERE request_id=?').get(requestId) as { request_evidence_id: string } | undefined
  if (!row || row.request_evidence_id !== evidenceId) throw new Error('Owner请求体与预留指纹不一致，拒绝发送')
}
function parseOpenAIUsage(responseBody: string): { promptTokens: number; completionTokens: number } | null {
  const parseUsage = (value: unknown): { promptTokens: number; completionTokens: number } | null => {
    if (!value || typeof value !== 'object') return null
    const usage = (value as { usage?: unknown }).usage
    if (!usage || typeof usage !== 'object') return null
    const row = usage as { prompt_tokens?: unknown; completion_tokens?: unknown }
    return Number.isSafeInteger(row.prompt_tokens) && Number.isSafeInteger(row.completion_tokens)
      && Number(row.prompt_tokens) >= 0 && Number(row.completion_tokens) >= 0
      ? { promptTokens: Number(row.prompt_tokens), completionTokens: Number(row.completion_tokens) } : null
  }
  try {
    const json = JSON.parse(responseBody) as unknown
    const usage = parseUsage(json)
    if (usage) return usage
  } catch { /* SSE response; below */ }
  for (const line of responseBody.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try { const usage = parseUsage(JSON.parse(data) as unknown); if (usage) return usage } catch { /* 忽略非JSON SSE帧，最终无usage即unknown */ }
  }
  return null
}
function settleOwnerRequestUsage(requestId: string, usage: { promptTokens: number; completionTokens: number }): void {
  const database = store.getProjectDb()
  database.transaction(() => {
    const row = database.prepare('SELECT reserved_cost_micros, price_evidence_id, state FROM project_owner_execution_request_reservations WHERE request_id=?').get(requestId) as { reserved_cost_micros: number; price_evidence_id: string; state: string } | undefined
    if (!row) throw new Error('Owner请求预留不存在，不能结算')
    if (row.state === 'settled') return
    if (row.state !== 'reserved') throw new Error('Owner请求已进入对账，不能自动改判')
    const price = getPilotReviewedPriceEvidence(row.price_evidence_id)
    if (!price) throw new Error('Owner价格证据不可用')
    const cost = (BigInt(usage.promptTokens) * BigInt(price.inputMicrosPerMillion) + BigInt(usage.completionTokens) * BigInt(price.outputMicrosPerMillion) + 999_999n) / 1_000_000n + BigInt(price.extraCostCeilingMicros)
    if (cost > BigInt(row.reserved_cost_micros)) throw new Error('Owner实际响应费用超过请求预留上界')
    database.prepare("UPDATE project_owner_execution_request_reservations SET state='settled', settled_cost_micros=? WHERE request_id=? AND state='reserved'").run(Number(cost), requestId)
  })()
}
/**
 * 已发出但尚未结算的请求：流式透传不能等整段响应结束再交给 Runtime，
 * 否则模型输出要等上游关闭后才可见。这里记录后台结算，供工具门禁和测试等待真实终态。
 */
const pendingSettlements = new Map<string, { commandId: string; promise: Promise<void> }>()

function markOwnerRequestUnknown(requestId: string): void {
  store.getProjectDb().prepare("UPDATE project_owner_execution_request_reservations SET state='needs_reconcile' WHERE request_id=? AND state='reserved'").run(requestId)
}

/** 计费分支独立读完响应体，成功取得 usage 才结算；任何异常或用量缺失都保持对账状态。 */
async function settleOwnerFromAccountingBranch(requestId: string, accountingBody: ReadableStream<Uint8Array>): Promise<void> {
  try {
    const body = await new Response(accountingBody).text()
    if (body.length > 4_000_000) { markOwnerRequestUnknown(requestId); return }
    const usage = parseOpenAIUsage(body)
    if (!usage) { markOwnerRequestUnknown(requestId); return }
    settleOwnerRequestUsage(requestId, usage)
  } catch { markOwnerRequestUnknown(requestId) }
}

/**
 * 只有流式（SSE）响应需要即时透传：非流式响应本就整段返回，仍是读完即结算，
 * 保持“终态回调时用量已确认”的同步语义，避免无谓地推迟命令结算。
 */
async function passthroughWithSettlement(commandId: string, requestId: string, response: Response): Promise<Response> {
  if (!response.ok || !response.body) { markOwnerRequestUnknown(requestId); return response }
  const isStream = (response.headers.get('content-type') ?? '').includes('text/event-stream')
  if (!isStream) {
    try {
      const body = await response.text()
      if (body.length > 4_000_000) markOwnerRequestUnknown(requestId)
      else {
        const usage = parseOpenAIUsage(body)
        if (usage) settleOwnerRequestUsage(requestId, usage)
        else markOwnerRequestUnknown(requestId)
      }
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    } catch {
      markOwnerRequestUnknown(requestId)
      return response
    }
  }
  const [clientBody, accountingBody] = response.body.tee()
  const entry = { commandId, promise: settleOwnerFromAccountingBranch(requestId, accountingBody) }
  pendingSettlements.set(requestId, entry)
  void entry.promise.finally(() => { if (pendingSettlements.get(requestId) === entry) pendingSettlements.delete(requestId) })
  return new Response(clientBody, { status: response.status, statusText: response.statusText, headers: response.headers })
}

/** 等待已发出请求的结算落库；工具执行前用它把“用量已确认”恢复到同步门禁之前。 */
export async function awaitOwnerRequestSettlements(filter?: { requestId?: string; commandId?: string }): Promise<void> {
  if (filter?.requestId) { await pendingSettlements.get(filter.requestId)?.promise; return }
  while (pendingSettlements.size > 0) {
    const waiting = [...pendingSettlements].filter(([, entry]) => !filter?.commandId || entry.commandId === filter.commandId)
    if (waiting.length === 0) return
    await Promise.all(waiting.map(([, entry]) => entry.promise))
  }
}
/** Owner受控出口：字符串body fail-closed、include_usage注入、预留→核验→发送→结算。 */
export function createOwnerRequestFetch(input: OwnerRequestFetchInput): typeof globalThis.fetch {
  const ownerFetch = async (rawInput: Parameters<typeof globalThis.fetch>[0], rawInit?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> => {
    const init = rawInit ?? {}
    const body = init.body ?? (rawInput instanceof Request ? await rawInput.clone().text() : undefined)
    if (typeof body !== 'string' || body.length === 0) throw new Error('Owner受控出口无法核验请求体，拒绝发送')
    const runtime = readOwnerCommandRuntime(input.commandId)
    assertOwnerCommandPrice(runtime)
    if (runtime.priceEvidenceId && input.priceEvidenceId && runtime.priceEvidenceId !== input.priceEvidenceId) throw new Error('Owner请求价格与当前员工冻结来源不一致')
    const priceEvidenceId = runtime.priceEvidenceId ?? input.priceEvidenceId ?? PILOT_DEFAULT_PRICE_EVIDENCE_ID
    const finalBody = injectStreamUsage(capPiOwnerOutput(body, runtime))
    const envelope = derivePilotRequestEnvelope({ body: finalBody, priceEvidenceId })
    const requestId = `owner-${randomUUID()}`
    reserveOwnerRequest({ requestId, commandId: input.commandId, executionId: input.executionId, sessionId: input.sessionId, envelope })
    verifyOwnerRequestBody(requestId, finalBody, priceEvidenceId)
    // Owner出口一律redirect:'error'：发送前核验出口origin属冻结渠道（调用方在参数比对集内完成）。
    let response: Response
    try { response = await input.baseFetch(rawInput, { ...init, body: finalBody, redirect: 'error' }) }
    catch (error) {
      markOwnerRequestUnknown(requestId)
      throw error
    }
    return passthroughWithSettlement(input.commandId, requestId, response)
  }
  return Object.assign(ownerFetch, { preconnect: () => {} })
}
export function getOwnerRequestReservation(requestId: string): { state: string; settledCostMicros: number | null } | null {
  const row = store.getProjectDb().prepare('SELECT state, settled_cost_micros FROM project_owner_execution_request_reservations WHERE request_id=?').get(requestId) as { state: string; settled_cost_micros: number | null } | undefined
  return row ? { state: row.state, settledCostMicros: row.settled_cost_micros } : null
}
/** 工具执行前先等流式请求的结算落地，再执行既有同步门禁；非Owner会话直接放行。 */
const OWNER_SETTLEMENT_WAIT_MS = 10_000
export async function awaitOwnerExecutionRequestsSettled(sessionId: string): Promise<void> {
  let execution: ReturnType<typeof store.getAgentExecutionBySessionId>
  // 窄单测可能不初始化项目库；这种情况没有 Owner 证据，按非Owner会话放行。
  try { execution = store.getAgentExecutionBySessionId(sessionId) }
  catch (cause) {
    if (cause instanceof Error && cause.message.includes('未初始化')) return
    throw cause
  }
  if (!execution?.ownerCommandId) return
  // 有界等待：上游异常长时间不结束不能让工具无限挂起；超时仍由同步门禁 fail-closed 拒绝。
  await Promise.race([
    awaitOwnerRequestSettlements({ commandId: execution.ownerCommandId }),
    new Promise<void>(resolve => { setTimeout(resolve, OWNER_SETTLEMENT_WAIT_MS).unref?.() }),
  ])
  assertOwnerExecutionRequestsSettled(sessionId)
}

/** Pi工具执行前要求本次会话已有Provider请求全部取得确定用量回执。 */
export function assertOwnerExecutionRequestsSettled(sessionId: string): void {
  const execution = store.getAgentExecutionBySessionId(sessionId)
  if (!execution?.ownerCommandId) return
  const pending = store.getProjectDb().prepare("SELECT 1 FROM project_owner_execution_request_reservations WHERE command_id=? AND state<>'settled' LIMIT 1").get(execution.ownerCommandId)
  if (pending) throw new Error('Owner请求费用/用量尚未确认，暂停执行工具并等待对账')
}
