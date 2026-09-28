import { getAgentExecution, getProjectDb } from './project-sqlite-store'
import { calculatePilotRequestCeiling, type PilotRequestEnvelope } from './project-pilot-request-envelope'
import { getPilotReviewedPriceEvidence, pilotRequestFingerprint } from './project-pilot-request-evidence'

export interface PilotRequestReservationInput {
  requestId: string
  commandId: string
  executionId: string
  sessionId: string
  envelope: PilotRequestEnvelope
}

const REQUEST_EVIDENCE_PATTERN = /^[0-9a-f]{64}$/

/** 命令预留内的原子子预留。价格证据必须已审核入库，包络数值必须与证据一致；不放行任何 Runtime。 */
export function reservePilotRequest(input: PilotRequestReservationInput, now = Date.now()): number {
  if ([input.requestId, input.commandId, input.executionId, input.sessionId].some((id) => typeof id !== 'string' || !id.trim())
    || !Number.isSafeInteger(now) || now < 0) throw new Error('Pilot 请求身份或时间无效')
  // requestEvidenceId 只接受请求体的 SHA-256 指纹，拒绝自述字符串；上界必须是正整数防 NaN 绕过。
  if (!REQUEST_EVIDENCE_PATTERN.test(input.envelope?.requestEvidenceId ?? '')) {
    throw new Error('Pilot 请求体指纹无效')
  }
  if (!Number.isSafeInteger(input.envelope?.inputTokenCeiling) || input.envelope.inputTokenCeiling <= 0
    || !Number.isSafeInteger(input.envelope?.outputTokenCeiling) || input.envelope.outputTokenCeiling <= 0) {
    throw new Error('Pilot 请求上界无效')
  }
  const db = getProjectDb()
  let reserved = 0
  db.transaction(() => {
    // 价格证据必须在审核注册表中，且包络费率与上界不得偏离证据。
    const evidence = getPilotReviewedPriceEvidence(input.envelope.priceEvidenceId)
    if (!evidence) throw new Error('Pilot 价格证据未审核，拒绝预留')
    if (input.envelope.inputRateMicrosPerMillion !== evidence.inputMicrosPerMillion
      || input.envelope.outputRateMicrosPerMillion !== evidence.outputMicrosPerMillion
      || input.envelope.extraCostCeilingMicros !== evidence.extraCostCeilingMicros
      || input.envelope.inputTokenCeiling > evidence.maxModelInputTokens
      || input.envelope.outputTokenCeiling > evidence.maxModelOutputTokens) {
      throw new Error('Pilot 请求包络与价格证据不一致')
    }
    const command = db.prepare(`SELECT project_id, grant_id, execution_id, state, reserved_cost_micros
      FROM pilot_commands WHERE id = ?`).get(input.commandId) as {
      project_id: string; grant_id: string; execution_id: string; state: string; reserved_cost_micros: number
    } | undefined
    const execution = getAgentExecution(input.executionId)
    const grant = command && db.prepare('SELECT state, expires_at FROM pilot_runtime_grants WHERE id = ? AND project_id = ?')
      .get(command.grant_id, command.project_id) as { state: string; expires_at: number } | undefined
    if (!command || !execution || !grant || command.state !== 'running' || grant.state !== 'active'
      || grant.expires_at <= now || execution.status !== 'running' || execution.projectId !== command.project_id
      || execution.pilotCommandId !== input.commandId || command.execution_id !== input.executionId
      || execution.sessionId !== input.sessionId) throw new Error('Pilot 请求归属或活动授权无法核验')
    // 不允许复用同一个 requestId 再次发送；既有占额保持不变，包括断流/崩溃。
    if (db.prepare('SELECT 1 FROM pilot_request_reservations WHERE request_id = ?').get(input.requestId)) {
      throw new Error('Pilot 请求 ID 已预留，不得重复发送')
    }
    // 同一执行内同一请求体指纹只允许预留一次：崩溃后换 requestId 也无法重复发送同一请求。
    if (db.prepare('SELECT 1 FROM pilot_request_reservations WHERE execution_id = ? AND request_evidence_id = ?')
      .get(input.executionId, input.envelope.requestEvidenceId)) {
      throw new Error('Pilot 请求体指纹已预留，不得重复发送')
    }
    const usage = db.prepare(`SELECT COALESCE(SUM(reserved_cost_micros), 0) AS total
      FROM pilot_request_reservations WHERE command_id = ?`).get(input.commandId) as { total: number }
    if (!Number.isSafeInteger(usage.total) || !Number.isSafeInteger(command.reserved_cost_micros)) {
      throw new Error('Pilot 请求累计费用无法核验')
    }
    const remaining = command.reserved_cost_micros - usage.total
    reserved = calculatePilotRequestCeiling(input.envelope, remaining)
    db.prepare(`INSERT INTO pilot_request_reservations
      (request_id, command_id, execution_id, session_id, request_evidence_id, price_evidence_id,
       reserved_cost_micros, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`).run(
      input.requestId, input.commandId, input.executionId, input.sessionId,
      input.envelope.requestEvidenceId, input.envelope.priceEvidenceId, reserved, now,
    )
  })()
  return reserved
}

/** 最终 HTTP 出口在发送前调用：请求体指纹必须与预留一致，否则拒绝发送。 */
export function verifyPilotRequestBody(requestId: string, body: string): void {
  if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('Pilot 请求身份无效')
  const expected = getProjectDb().prepare('SELECT request_evidence_id FROM pilot_request_reservations WHERE request_id = ?')
    .get(requestId) as { request_evidence_id: string } | undefined
  if (!expected) throw new Error('Pilot 请求预留不存在，拒绝发送')
  if (expected.request_evidence_id !== pilotRequestFingerprint(body)) {
    throw new Error('Pilot 请求体与预留指纹不一致，拒绝发送')
  }
}
