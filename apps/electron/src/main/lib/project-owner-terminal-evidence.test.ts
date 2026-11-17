import { expect, test } from 'bun:test'
import { classifyOwnerTerminalEvidence } from './project-owner-terminal-evidence'

const messages = [
  { type: 'assistant', message: { content: [
    { type: 'text', text: '先读取现有页面结构。' },
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'index.html' } },
  ] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: '开始实现。' }] } },
]

test('Given Provider异常终态 When分类 Then保留原始终止原因且不把过程说明当成果', () => {
  const evidence = classifyOwnerTerminalEvidence({
    executionId: 'exec-1', commandId: 'cmd-1', role: 'executor', executionStatus: 'failed', stopped: false,
    runtimeResult: { type: 'result', subtype: 'error_during_execution', finish_reason: 'other',
      provider_request_id: 'req-abc', provider_response_id: 'resp-def', usage: { input_tokens: 0, output_tokens: 0 } },
    messages, error: 'Owner模型未完整结束（error_during_execution），过程说明不能作为成果',
    cost: { state: 'settled', actualCostMicros: 12345, requestCount: 2 }, development: null, capturedAt: 1_700_000_000_000,
  })
  expect(evidence.reason).toBe('provider_stop')
  expect(evidence.provider).toEqual({ subtype: 'error_during_execution', finishReason: 'other', requestId: 'req-abc', responseId: 'resp-def' })
  expect(evidence.tools).toEqual({ calls: 1, results: 1, lastToolName: 'Read', lastResultStatus: 'ok', incompleteBatch: false })
  expect(evidence.cost).toEqual({ state: 'settled', actualCostMicros: 12345, requestCount: 2 })
  expect(evidence.detail).not.toContain('sk-')
})

test('Given输出达到上限 When分类 Then归为output_limit而不是网络错误', () => {
  const evidence = classifyOwnerTerminalEvidence({
    executionId: 'e', commandId: 'c', role: 'executor', executionStatus: 'failed', stopped: false,
    runtimeResult: { type: 'result', subtype: 'error_during_execution', finish_reason: 'length', usage: { input_tokens: 1, output_tokens: 2 } },
    messages, error: '', cost: { state: 'unknown', actualCostMicros: null, requestCount: 1 }, development: null, capturedAt: 1,
  })
  expect(evidence.reason).toBe('output_limit')
  expect(evidence.cost.state).toBe('unknown')
})

test('Given工具批次不完整 When分类 Then优先报告未完成调用', () => {
  const evidence = classifyOwnerTerminalEvidence({
    executionId: 'e', commandId: 'c', role: 'executor', executionStatus: 'failed', stopped: false,
    runtimeResult: { type: 'result', subtype: 'success', finish_reason: 'tool-calls', usage: { input_tokens: 1, output_tokens: 2 },
      toolCallBatchIntegrity: { version: 1, complete: false, reasons: ['finish_reason:length'], unexecutedMandatory: false } },
    messages, error: '', cost: { state: 'settled', actualCostMicros: 1, requestCount: 1 }, development: null, capturedAt: 1,
  })
  expect(evidence.reason).toBe('tool_call_incomplete')
  expect(evidence.tools.incompleteBatch).toBe(false)
})

test('Given用户请求停止 When分类 Then归为stopped_by_user且优先于Provider终态', () => {
  const evidence = classifyOwnerTerminalEvidence({
    executionId: 'e', commandId: 'c', role: 'executor', executionStatus: 'cancelled', stopped: true,
    runtimeResult: { type: 'result', subtype: 'error_during_execution', finish_reason: 'other', usage: { input_tokens: 1, output_tokens: 2 } },
    messages, error: '', cost: { state: 'settled', actualCostMicros: 1, requestCount: 1 }, development: null, capturedAt: 1,
  })
  expect(evidence.reason).toBe('stopped_by_user')
})

test('Given敏感信息与绝对路径 When分类 Then诊断说明必须脱敏', () => {
  const evidence = classifyOwnerTerminalEvidence({
    executionId: 'e', commandId: 'c', role: 'executor', executionStatus: 'failed', stopped: false,
    runtimeResult: null, messages, error: 'failed at /Users/chaihao/secret with Bearer sk-abcdefghijklmnop',
    cost: { state: 'unknown', actualCostMicros: null, requestCount: 0 }, development: null, capturedAt: 1,
  })
  expect(evidence.detail).not.toContain('/Users/chaihao')
  expect(evidence.detail).not.toContain('sk-abcdefghijklmnop')
  expect(evidence.detail).toContain('[本地路径]')
})
