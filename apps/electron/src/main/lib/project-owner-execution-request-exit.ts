/** Owner逐请求出口：derive→reserve→verify→fetch→settle五步镜像；Owner出口一律redirect:'error'；默认fake transport。 */
import { createHash, randomUUID } from 'node:crypto'
import * as store from './project-sqlite-store'
import { derivePilotRequestEnvelope, getPilotReviewedPriceEvidence, getPilotReviewedPriceEvidenceForModel } from './project-pilot-request-evidence'
import { getAgentProviderProtocol, type ProviderType } from '@gravitas/shared'
import { PILOT_DEFAULT_PRICE_EVIDENCE_ID } from './project-pilot-request-exit'

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
    const command = database.prepare(`SELECT c.id AS command_id, c.execution_id, c.project_id, c.grant_id, c.state AS command_state,
        g.state AS grant_state, g.channel_id, g.model_id, g.runtime
      FROM project_owner_execution_commands c JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
      WHERE c.id=?`).get(input.command.command_id) as OwnerPreflightCommandRow | undefined
    const execution = store.getAgentExecution(input.executionId)
    if (!command || !execution || command.project_id !== input.command.project_id || command.grant_id !== input.command.grant_id
      || command.execution_id !== input.executionId || command.command_state !== 'running' || command.grant_state !== 'active'
      || command.channel_id !== input.command.channel_id || command.model_id !== input.modelId || command.runtime !== 'ai-sdk'
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
  const row = store.getProjectDb().prepare(`SELECT c.id AS command_id, c.state AS command_state, c.role AS command_role, c.execution_id,
      c.project_id, c.grant_id, g.state AS grant_state, g.channel_id, g.model_id, g.runtime
    FROM project_owner_execution_commands c
    JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
    WHERE c.id=? AND c.project_id=?`).get(execution.ownerCommandId, execution.projectId) as OwnerPreflightCommandRow | undefined
  const protocol = getAgentProviderProtocol(provider, 'ai-sdk')
  const providerKind = protocol === 'openai-chat' ? 'openai' : protocol === 'anthropic-messages' ? 'anthropic' : 'google'
  if (!row || row.execution_id !== execution.id || row.project_id !== execution.projectId || row.command_id !== execution.ownerCommandId
    || row.command_state !== 'running' || execution.status !== 'running' || row.grant_state !== 'active'
    || row.runtime !== 'ai-sdk' || row.model_id !== modelId) {
    throw new Error('Owner命令执行归属或运行授权不匹配')
  }
  const price = getPilotReviewedPriceEvidenceForModel(modelId, providerKind)
  if (!price || price.model !== modelId || price.providerKind !== providerKind) {
    const attemptedPriceEvidenceId = price?.evidenceId ?? PILOT_DEFAULT_PRICE_EVIDENCE_ID
    recordOwnerPreflightPriceRejection({ command: row, executionId: execution.id, provider, protocol, modelId,
      priceEvidenceId: attemptedPriceEvidenceId, errorMessage: OWNER_PREFLIGHT_PRICE_REJECTION })
    throw new Error(OWNER_PREFLIGHT_PRICE_REJECTION)
  }
  // DeepSeek 思考内容也占输出额度；为结构化评审保留正文空间，仍逐请求预留完整上界。
  const outputLimit = modelId === 'deepseek-flash' && row.command_role === 'reviewer' ? 8192 : 4096
  return Math.min(outputLimit, price.maxModelOutputTokens)
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
async function settleOwnerAfterResponse(requestId: string, response: Response): Promise<Response> {
  const markUnknown = (): void => { store.getProjectDb().prepare("UPDATE project_owner_execution_request_reservations SET state='needs_reconcile' WHERE request_id=? AND state='reserved'").run(requestId) }
  if (!response.ok || !response.body) { markUnknown(); return response }
  let clientResponse = response
  try {
    const [clientBody, accountingBody] = response.body.tee()
    clientResponse = new Response(clientBody, { status: response.status, statusText: response.statusText, headers: response.headers })
    const body = await new Response(accountingBody).text()
    if (body.length > 4_000_000) { markUnknown(); return clientResponse }
    const usage = parseOpenAIUsage(body)
    if (!usage) { markUnknown(); return clientResponse }
    settleOwnerRequestUsage(requestId, usage)
  } catch { markUnknown() }
  return clientResponse
}
/** Owner受控出口：字符串body fail-closed、include_usage注入、预留→核验→发送→结算。 */
export function createOwnerRequestFetch(input: OwnerRequestFetchInput): typeof globalThis.fetch {
  const ownerFetch = async (rawInput: Parameters<typeof globalThis.fetch>[0], rawInit?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> => {
    const init = rawInit ?? {}
    if (typeof init.body !== 'string' || init.body.length === 0) throw new Error('Owner受控出口无法核验请求体，拒绝发送')
    const finalBody = injectStreamUsage(init.body)
    const envelope = derivePilotRequestEnvelope({ body: finalBody, priceEvidenceId: input.priceEvidenceId ?? PILOT_DEFAULT_PRICE_EVIDENCE_ID })
    const requestId = `owner-${randomUUID()}`
    reserveOwnerRequest({ requestId, commandId: input.commandId, executionId: input.executionId, sessionId: input.sessionId, envelope })
    verifyOwnerRequestBody(requestId, finalBody, input.priceEvidenceId ?? PILOT_DEFAULT_PRICE_EVIDENCE_ID)
    // Owner出口一律redirect:'error'：发送前核验出口origin属冻结渠道（调用方在参数比对集内完成）。
    let response: Response
    try { response = await input.baseFetch(rawInput, { ...init, body: finalBody, redirect: 'error' }) }
    catch (error) {
      store.getProjectDb().prepare("UPDATE project_owner_execution_request_reservations SET state='needs_reconcile' WHERE request_id=? AND state='reserved'").run(requestId)
      throw error
    }
    return settleOwnerAfterResponse(requestId, response)
  }
  return Object.assign(ownerFetch, { preconnect: () => {} })
}
export function getOwnerRequestReservation(requestId: string): { state: string; settledCostMicros: number | null } | null {
  const row = store.getProjectDb().prepare('SELECT state, settled_cost_micros FROM project_owner_execution_request_reservations WHERE request_id=?').get(requestId) as { state: string; settled_cost_micros: number | null } | undefined
  return row ? { state: row.state, settledCostMicros: row.settled_cost_micros } : null
}
