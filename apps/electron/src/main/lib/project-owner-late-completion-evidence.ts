/** 迟到终态的只读核验；该证据本身不恢复授权、不重放请求，也不改变账本。 */
import { ownerExecutionHash } from './project-owner-execution-hash'

export interface OwnerLateRequestSettlement {
  requestId: string
  executionId: string
  sessionId: string
  state: string
  settledCostMicros: number | null
  requestEvidenceId: string | null
  priceEvidenceId: string | null
}

export interface OwnerLateCompletionEvidence {
  executionId: string
  sessionId: string
  terminalHash: string
  assistantSummary: string
  assistantSummaryHash: string
  requestSettlementIds: string[]
  costMicros: number
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** 必须拥有同一会话最后一条成功终态、完整工具批次和全部逐请求费用。 */
export function buildOwnerLateCompletionEvidence(
  executionId: string,
  sessionId: string,
  messages: readonly unknown[],
  requests: readonly OwnerLateRequestSettlement[],
): OwnerLateCompletionEvidence | null {
  if (!executionId.trim() || !sessionId.trim() || !messages.length || !requests.length) return null
  const terminal = record(messages.at(-1))
  const integrity = record(terminal?.toolCallBatchIntegrity)
  const usage = record(terminal?.usage)
  if (!terminal || terminal.type !== 'result' || terminal.subtype !== 'success' || terminal.finish_reason !== 'stop'
    || terminal.session_id !== sessionId || !integrity || integrity.version !== 1 || integrity.complete !== true
    || integrity.unexecutedMandatory !== false || !Array.isArray(integrity.reasons) || integrity.reasons.length !== 0
    || !usage || !Number.isSafeInteger(usage.input_tokens) || (usage.input_tokens as number) < 0
    || !Number.isSafeInteger(usage.output_tokens) || (usage.output_tokens as number) < 0) return null
  const assistant = record(messages.findLast(item => record(item)?.type === 'assistant'))
  const message = record(assistant?.message), content = message?.content
  if (!assistant || assistant.session_id !== sessionId || !Array.isArray(content) || content.length !== 1) return null
  const text = record(content[0])
  if (!text || text.type !== 'text' || typeof text.text !== 'string' || !text.text.trim()) return null
  const assistantSummary = text.text.trim().slice(0, 20000)
  // 当前自动恢复仅覆盖被工作区门禁约束的本地写入；外部动作或失败工具结果保守停等。
  for (const item of messages) {
    const entry = record(item), body = record(entry?.message)
    if (!Array.isArray(body?.content)) continue
    for (const blockValue of body.content) {
      const block = record(blockValue)
      if (!block) continue
      if (block.type === 'tool_use' && !['Write', 'Edit'].includes(String(block.name))) return null
      if (block.type === 'tool_result' && block.is_error === true) return null
    }
  }
  const ids = new Set<string>()
  let costMicros = 0
  for (const request of requests) {
    if (!request.requestId.trim() || ids.has(request.requestId) || request.executionId !== executionId
      || request.sessionId !== sessionId || request.state !== 'settled'
      || !Number.isSafeInteger(request.settledCostMicros) || (request.settledCostMicros ?? -1) < 0
      || !request.requestEvidenceId || !/^[a-f0-9]{64}$/.test(request.requestEvidenceId)
      || !request.priceEvidenceId?.trim()) return null
    ids.add(request.requestId)
    costMicros += request.settledCostMicros!
    if (!Number.isSafeInteger(costMicros)) return null
  }
  return { executionId, sessionId, terminalHash: ownerExecutionHash(terminal), assistantSummary,
    assistantSummaryHash: ownerExecutionHash(assistantSummary), requestSettlementIds: [...ids].sort(), costMicros }
}
