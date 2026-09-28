import { createHash } from 'node:crypto'
import type { SDKResultMessage } from '@gravitas/shared'
import { settlePilotCommandUsage, type PilotCommandSettlement } from './project-pilot-budget-ledger'
import { summarizePilotCommandRequestSettlements } from './project-pilot-request-settlement'
import { getAgentExecution, getProjectDb } from './project-sqlite-store'

interface PilotRuntimeBinding {
  channelId: string
  modelId: string
}

interface PilotRuntimeReceiptRow {
  id: string
  execution_id: string
  project_id: string
  session_id: string
  channel_id: string
  model_id: string
  runtime_source: string
  raw_payload: string
  payload_hash: string
  input_tokens: number
  output_tokens: number
  cost_micros: number | null
  captured_at: number
}

function getPilotRuntimeBinding(commandId: string, projectId: string, executionId: string): PilotRuntimeBinding {
  const grant = getProjectDb().prepare(`SELECT g.channel_id AS channelId, g.model_id AS modelId
    FROM pilot_commands c JOIN pilot_runtime_grants g ON g.id = c.grant_id AND g.project_id = c.project_id
    WHERE c.id = ? AND c.project_id = ? AND c.execution_id = ?`)
    .get(commandId, projectId, executionId) as PilotRuntimeBinding | undefined
  if (!grant) throw new Error('Pilot 终结执行缺少冻结授权，无法记录用量')
  return grant
}

function usdToMicros(value: number | undefined): number | null {
  if (value === undefined) return null
  if (!Number.isFinite(value) || value < 0) throw new Error('Runtime 回执费用无效')
  const micros = Math.round(value * 1_000_000)
  if (!Number.isSafeInteger(micros)) throw new Error('Runtime 回执费用超出可核验范围')
  return micros
}

function readTokens(result: SDKResultMessage): { inputTokens: number; outputTokens: number } {
  const inputTokens = result.usage?.input_tokens
  const outputTokens = result.usage?.output_tokens
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0
    || !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
    throw new Error('Runtime 回执 token 用量无效')
  }
  return { inputTokens, outputTokens }
}

function sameReceipt(left: PilotRuntimeReceiptRow, right: Omit<PilotRuntimeReceiptRow, 'id'>): boolean {
  return left.execution_id === right.execution_id && left.project_id === right.project_id
    && left.session_id === right.session_id && left.channel_id === right.channel_id
    && left.model_id === right.model_id && left.runtime_source === right.runtime_source
    && left.raw_payload === right.raw_payload && left.payload_hash === right.payload_hash
    && left.input_tokens === right.input_tokens && left.output_tokens === right.output_tokens
    && left.cost_micros === right.cost_micros && left.captured_at === right.captured_at
}

function pausePilotGrant(commandId: string, projectId: string): void {
  getProjectDb().prepare(`UPDATE pilot_runtime_grants SET state = 'paused'
    WHERE id = (SELECT grant_id FROM pilot_commands WHERE id = ? AND project_id = ?)
      AND state = 'active'`).run(commandId, projectId)
}

/**
 * 保存 Runtime 原样终态并据其可核验字段结算。
 * `total_cost_usd` 是 Runtime 转述值，不宣称为带 Provider 请求 ID 的直接回执。
 */
export function settlePilotExecutionRuntimeUsage(
  executionId: string,
  runtimeSource: string,
  result: SDKResultMessage,
  capturedAt = Date.now(),
): PilotCommandSettlement | null {
  const execution = getAgentExecution(executionId)
  if (!execution?.pilotCommandId) return null
  try {
    if (!execution.sessionId?.trim() || !runtimeSource?.trim()) {
      throw new Error('Pilot 终结执行缺少会话或 Runtime 来源，无法记录用量')
    }
    if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) throw new Error('Runtime 回执时间无效')
    if (result.session_id && result.session_id !== execution.sessionId) {
      throw new Error('Runtime 回执会话与执行会话不匹配')
    }
    const binding = getPilotRuntimeBinding(execution.pilotCommandId, execution.projectId, execution.id)
    const rawPayload = JSON.stringify(result)
    const payloadHash = createHash('sha256').update(rawPayload).digest('hex')
    const receiptId = createHash('sha256').update(JSON.stringify({
      executionId: execution.id,
      sessionId: execution.sessionId,
      channelId: binding.channelId,
      modelId: binding.modelId,
      runtimeSource,
      payloadHash,
    })).digest('hex')
    const { inputTokens, outputTokens } = readTokens(result)
    const costMicros = usdToMicros(result.total_cost_usd)
    const receipt: Omit<PilotRuntimeReceiptRow, 'id'> = {
      execution_id: execution.id,
      project_id: execution.projectId,
      session_id: execution.sessionId,
      channel_id: binding.channelId,
      model_id: binding.modelId,
      runtime_source: runtimeSource,
      raw_payload: rawPayload,
      payload_hash: payloadHash,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_micros: costMicros,
      captured_at: capturedAt,
    }
    const existing = getProjectDb().prepare('SELECT * FROM pilot_runtime_usage_receipts WHERE execution_id = ?')
      .get(execution.id) as PilotRuntimeReceiptRow | undefined
    if (existing) {
      if (existing.id !== receiptId || !sameReceipt(existing, receipt)) {
        throw new Error('Pilot 执行已有不同的 Runtime 用量回执')
      }
    } else {
      getProjectDb().prepare(`INSERT INTO pilot_runtime_usage_receipts
        (id, execution_id, project_id, session_id, channel_id, model_id, runtime_source, raw_payload,
         payload_hash, input_tokens, output_tokens, cost_micros, captured_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(receiptId, receipt.execution_id, receipt.project_id, receipt.session_id, receipt.channel_id,
          receipt.model_id, receipt.runtime_source, receipt.raw_payload, receipt.payload_hash,
          receipt.input_tokens, receipt.output_tokens, receipt.cost_micros, receipt.captured_at)
    }
    const evidenceBase = {
      executionId: execution.id, sessionId: execution.sessionId,
      channelId: binding.channelId, modelId: binding.modelId, capturedAt,
      runtimeReceiptId: receiptId, payloadHash,
    }
    if (costMicros === null) {
      // ai-sdk 终态只有 token 没有费用字段；若本命令全部请求已按真实 usage 逐笔
      // settled，则费用证据已闭合，按逐请求结算总额落账（清单与总额在账本内核验）。
      const summary = summarizePilotCommandRequestSettlements(execution.pilotCommandId)
      if (summary.settledCount >= 1 && summary.pendingCount === 0) {
        return settlePilotCommandUsage(execution.pilotCommandId, {
          executionId: execution.id,
          sessionId: execution.sessionId,
          channelId: binding.channelId,
          modelId: binding.modelId,
          capturedAt,
          source: 'request_settled',
          requestSettlementIds: summary.requestIds,
          costMicros: summary.totalSettledCostMicros,
        }, capturedAt)
      }
      return settlePilotCommandUsage(execution.pilotCommandId, {
        ...evidenceBase, source: 'unknown',
        reason: 'Runtime 终态回执未提供费用，不能用本地估价替代实际结算',
      }, capturedAt)
    }
    return settlePilotCommandUsage(execution.pilotCommandId, {
      ...evidenceBase, source: 'runtime_reported', inputTokens, outputTokens, costMicros,
    }, capturedAt)
  } catch (error) {
    pausePilotGrant(execution.pilotCommandId, execution.projectId)
    throw error
  }
}

/** Runtime 没有给出可核验 Provider 回执时，显式以 unknown 结算并撤权停等。 */
export function settlePilotExecutionUnknownUsage(
  executionId: string,
  reason: string,
  capturedAt = Date.now(),
): PilotCommandSettlement | null {
  const execution = getAgentExecution(executionId)
  if (!execution?.pilotCommandId) return null
  try {
    if (!execution.sessionId?.trim()) throw new Error('Pilot 终结执行缺少会话，无法记录未知用量')
    const grant = getPilotRuntimeBinding(execution.pilotCommandId, execution.projectId, execution.id)
    return settlePilotCommandUsage(execution.pilotCommandId, {
      source: 'unknown',
      executionId: execution.id,
      sessionId: execution.sessionId,
      channelId: grant.channelId,
      modelId: grant.modelId,
      capturedAt,
      reason,
    }, capturedAt)
  } catch (error) {
    // 用量无法入账时也要撤权；破损命令留给恢复对账，不允许继续预留新费用。
    pausePilotGrant(execution.pilotCommandId, execution.projectId)
    throw error
  }
}
