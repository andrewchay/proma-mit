/** 评测 trace 的工具调用解析与行为断言（纯函数，可离线回放）。 */

import type { ToolTraceAssertion } from './types'

interface TraceToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  isError?: boolean
}

interface TraceContentBlock {
  type?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
  is_error?: unknown
}

/** 从 TraceWriter 的 JSONL 中提取已关联 tool_use / tool_result。 */
export function readTraceToolCalls(traceText: string | undefined): TraceToolCall[] {
  if (!traceText) return []
  const calls = new Map<string, TraceToolCall>()
  for (const line of traceText.split('\n')) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const blocks = getContentBlocks(parsed)
    for (const block of blocks) {
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        calls.set(block.id, {
          id: block.id,
          name: block.name,
          arguments: isRecord(block.input) ? block.input : {},
        })
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const call = calls.get(block.tool_use_id)
        if (call) call.isError = block.is_error === true
      }
    }
  }
  return [...calls.values()]
}

/** 判断 trace 是否满足工具调用、参数、执行结果与禁止调用约束。 */
export function matchesToolTraceAssertion(traceText: string | undefined, assertion: ToolTraceAssertion): boolean {
  const calls = readTraceToolCalls(traceText)
  if (assertion.forbiddenNames?.some((name) => calls.some((call) => call.name === name))) return false
  if (!assertion.name) return true

  const acceptedNames = Array.isArray(assertion.name) ? assertion.name : [assertion.name]
  return calls.some((call) => {
    if (!acceptedNames.includes(call.name)) return false
    if (assertion.requiredArguments?.some((name) => !(name in call.arguments))) return false
    if (assertion.expectedArguments && !matchesExpectedArguments(call.arguments, assertion.expectedArguments)) return false
    if (assertion.result === 'error' && call.isError !== true) return false
    if (assertion.result === 'success' && call.isError === true) return false
    return true
  })
}

function getContentBlocks(value: unknown): TraceContentBlock[] {
  if (!isRecord(value) || value.type !== 'message' || !isRecord(value.msg) || !isRecord(value.msg.message)) return []
  const content = value.msg.message.content
  return Array.isArray(content) ? content.filter(isRecord) : []
}

function matchesExpectedArguments(actual: Record<string, unknown>, expected: Record<string, string | number | boolean>): boolean {
  return Object.entries(expected).every(([name, value]) => actual[name] === value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
