/** Owner命令终态证据：只做本地确定性归因，不推断账单、不改授权、不重放请求。 */
import type { OwnerTerminalEvidence } from '@gravitas/shared'

/** Runtime 原始回执：除下列已知字段外还允许透传其他字段（如 type / usage）。 */
interface OwnerRuntimeTerminalReceipt {
  subtype?: string
  finish_reason?: string
  provider_request_id?: string
  provider_response_id?: string
  toolCallBatchIntegrity?: { complete?: boolean; [key: string]: unknown }
  [key: string]: unknown
}

interface TerminalEvidenceInput {
  executionId: string
  commandId: string
  role: 'executor' | 'reviewer'
  executionStatus: string
  stopped: boolean
  runtimeResult?: OwnerRuntimeTerminalReceipt | null
  messages: readonly unknown[]
  error: string
  cost: OwnerTerminalEvidence['cost']
  development: OwnerTerminalEvidence['development']
  capturedAt: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** 与 Owner 恢复提示同口径的脱敏：不得泄漏凭据、绝对路径或正文。 */
export function sanitizeOwnerDiagnostic(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk|key|token)[-_][A-Za-z0-9_-]{12,}\b/gi, '[凭证已隐藏]')
    .replace(/(api[_-]?key|authorization|access[_-]?token)\s*[:=]\s*[^,;\s]+/gi, '$1=[已隐藏]')
    .replace(/(?:\/Users\/[^\s:]+|\/tmp\/[^\s:]+|[A-Z]:\\[^\s:]+)/g, '[本地路径]')
    .replace(/\s+/g, ' ').trim().slice(0, 300)
}

function toolStats(messages: readonly unknown[]): OwnerTerminalEvidence['tools'] {
  let calls = 0, results = 0
  let lastToolName: string | null = null
  let lastResultStatus: OwnerTerminalEvidence['tools']['lastResultStatus'] = null
  for (const item of messages) {
    const body = record(record(item)?.message)
    if (!Array.isArray(body?.content)) continue
    for (const blockValue of body.content) {
      const block = record(blockValue)
      if (block?.type === 'tool_use') { calls += 1; lastToolName = typeof block.name === 'string' ? block.name : null }
      if (block?.type === 'tool_result') { results += 1; lastResultStatus = block.is_error === true ? 'error' : 'ok' }
    }
  }
  if (calls > results) lastResultStatus = 'missing'
  return { calls, results, lastToolName, lastResultStatus, incompleteBatch: calls !== results }
}

function classify(input: TerminalEvidenceInput, tools: OwnerTerminalEvidence['tools']): OwnerTerminalEvidence['reason'] {
  if (input.stopped) return 'stopped_by_user'
  if (input.runtimeResult?.finish_reason === 'length') return 'output_limit'
  if (input.runtimeResult?.toolCallBatchIntegrity?.complete === false) return 'tool_call_incomplete'
  if (input.runtimeResult && input.runtimeResult.subtype !== 'success') return 'provider_stop'
  if (tools.incompleteBatch) return 'tool_call_incomplete'
  const hasOutput = input.messages.some(item => record(item)?.type === 'assistant')
  if (!hasOutput) return 'no_output'
  if (input.error.trim()) return 'runtime_error'
  return 'unknown'
}

export function classifyOwnerTerminalEvidence(input: TerminalEvidenceInput): OwnerTerminalEvidence {
  const tools = toolStats(input.messages)
  const result = input.runtimeResult ?? null
  return {
    schemaVersion: 1,
    executionId: input.executionId,
    commandId: input.commandId,
    role: input.role,
    executionStatus: input.executionStatus,
    provider: result ? {
      subtype: typeof result.subtype === 'string' ? result.subtype : null,
      finishReason: typeof result.finish_reason === 'string' ? result.finish_reason : null,
      requestId: typeof result.provider_request_id === 'string' ? result.provider_request_id : null,
      responseId: typeof result.provider_response_id === 'string' ? result.provider_response_id : null,
    } : null,
    reason: classify(input, tools),
    detail: sanitizeOwnerDiagnostic(input.error || '未记录失败说明'),
    tools,
    cost: input.cost,
    development: input.development,
    capturedAt: input.capturedAt,
  }
}
