/**
 * E03第一片：工具调用批次完整性判定。
 *
 * 只对已观察到的调用与finishReason做事后分类；不能撤销已执行效果，
 * 也不构成宿主对Provider行为（流式执行/部分重试）的先验阻断或鉴权。
 */

/** 观察到的单条调用；字段是副本，不要求来源可鉴权。 */
export interface ObservedToolCall {
  readonly toolCallId: string
  readonly toolName: string
  /** 对齐AI SDK DynamicToolCall.invalid；未定义按未知处理而不是invalid。 */
  readonly invalid?: boolean
  /** 仅用于与invalid语义一致；true时按invalid调用保守处理。 */
  readonly dynamic?: boolean
}

export interface ToolCallBatchIntegrity {
  readonly version: 1
  /** 观察层面完整：不保证调用未执行或可撤销。 */
  readonly complete: boolean
  /** 稳定原因码，不含参数或输出正文。 */
  readonly reasons: readonly string[]
  /** 保留字段：后续分类未执行强制调用时置位；当前恒为false。 */
  readonly unexecutedMandatory: boolean
}

const INCOMPLETE_FINISH_REASONS: ReadonlySet<string> = new Set([
  'length', 'error', 'content-filter', 'other', 'unknown', '',
])
const VALID_FINISH_REASONS: ReadonlySet<string> = new Set([
  'tool-calls', 'stop', 'length', 'error', 'content-filter', 'other',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** 普通自有数据检查；不读getter、不接受继承或原型伪造。 */
function isPlainToolCall(value: unknown): value is ObservedToolCall {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  const allowed = new Set(['toolCallId', 'toolName', 'invalid', 'dynamic'])
  if (keys.length === 0 || keys.some((key) => !allowed.has(key))) return false
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) return false
    if ((key === 'invalid' || key === 'dynamic') && descriptor.value !== undefined && typeof descriptor.value !== 'boolean') return false
  }
  if (typeof value.toolCallId !== 'string' || typeof value.toolName !== 'string') return false
  return true
}

/**
 * 事后判定一个step的调用批次是否在观察层面完整。
 * finishReason缺失/未知一律按不完整处理，不猜测成功。
 */
export function assessToolCallBatchIntegrity(calls: unknown, finishReason: string | undefined): ToolCallBatchIntegrity {
  const reasons: string[] = []
  if (typeof finishReason !== 'string') {
    reasons.push('finish_reason:unknown')
  } else if (!VALID_FINISH_REASONS.has(finishReason)) {
    reasons.push('finish_reason:unknown')
  } else if (INCOMPLETE_FINISH_REASONS.has(finishReason)) {
    reasons.push(`finish_reason:${finishReason}`)
  }
  if (!Array.isArray(calls)) {
    reasons.push('calls_not_array')
    return { version: 1, complete: false, reasons, unexecutedMandatory: false }
  }
  const seenIds = new Set<string>()
  for (const entry of calls) {
    if (!isPlainToolCall(entry)) {
      reasons.push('malformed_tool_call')
      continue
    }
    const invalid = entry.dynamic === true && entry.invalid !== undefined ? entry.invalid : undefined
    if (entry.toolCallId.trim() === '') reasons.push('empty_tool_call_id')
    else if (seenIds.has(entry.toolCallId)) reasons.push('duplicate_tool_call_id')
    else seenIds.add(entry.toolCallId)
    if (entry.toolName.trim() === '') reasons.push('empty_tool_name')
    if (invalid === true) reasons.push('invalid_tool_call')
  }
  return { version: 1, complete: reasons.length === 0, reasons, unexecutedMandatory: false }
}
