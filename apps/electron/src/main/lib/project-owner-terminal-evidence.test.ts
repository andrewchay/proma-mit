import { expect, test } from 'bun:test'
import {
  classifyOwnerTerminalEvidence,
  type TerminalEvidenceInput,
} from './project-owner-terminal-evidence'

/** SDKMessage 形状：正文在 message.content block 数组里。 */
const messages = [
  { type: 'assistant', message: { content: [
    { type: 'text', text: '先读取现有页面结构。' },
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'index.html' } },
  ] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: '开始实现。' }] } },
]

const baseInput: TerminalEvidenceInput = {
  executionId: 'e', commandId: 'c', role: 'executor', executionStatus: 'failed', stopped: false,
  messages, error: '', cost: { state: 'settled', actualCostMicros: 1, requestCount: 1 }, development: null, capturedAt: 1,
}

test('Given Provider异常终态 When分类 Then保留原始终止原因且不把过程说明当成果', () => {
  const evidence = classifyOwnerTerminalEvidence({
    executionId: 'exec-1', commandId: 'cmd-1', role: 'executor', executionStatus: 'failed', stopped: false,
    // 生产回执形状：AI SDK Runtime 的 Owner 终态总会带 toolCallBatchIntegrity。
    runtimeResult: { type: 'result', subtype: 'error_during_execution', finish_reason: 'other',
      provider_request_id: 'req-abc', provider_response_id: 'resp-def', usage: { input_tokens: 0, output_tokens: 0 },
      toolCallBatchIntegrity: { version: 1, complete: false, reasons: ['finish_reason:other'], unexecutedMandatory: false } },
    messages, error: 'Owner模型未完整结束（error_during_execution），过程说明不能作为成果',
    cost: { state: 'settled', actualCostMicros: 12345, requestCount: 2 }, development: null, capturedAt: 1_700_000_000_000,
  })
  // finish_reason:other 是根因；工具批次不完整只是后果，不能把后果当根因。
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
    // 正常停止但批次完整性判定为不完整：只能由 toolCallBatchIntegrity 判定，工具计数本身是平衡的。
    runtimeResult: { type: 'result', subtype: 'error_during_execution', finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 2 },
      toolCallBatchIntegrity: { version: 1, complete: false, reasons: ['duplicate_tool_call_id'], unexecutedMandatory: false } },
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

test('Given裸凭证赋值与非用户目录路径 When分类 Then一并脱敏', () => {
  const evidence = classifyOwnerTerminalEvidence({
    ...baseInput,
    error: 'token=abc123 password=hunter2 secret:s3cr3t at /home/runner/app and /opt/deploy and /var/tmp/x',
  })
  expect(evidence.detail).not.toContain('abc123')
  expect(evidence.detail).not.toContain('hunter2')
  expect(evidence.detail).not.toContain('s3cr3t')
  expect(evidence.detail).not.toContain('/home/runner')
  expect(evidence.detail).not.toContain('/opt/deploy')
  expect(evidence.detail).not.toContain('/var/tmp')
  expect(evidence.detail).toContain('[本地路径]')
})

test('GivenAgentMessage形状 When分类 Then工具统计诚实降级为零且不判为no_output', () => {
  const evidence = classifyOwnerTerminalEvidence({
    ...baseInput,
    // 真实调用方 agent-employee-service.onComplete 传的是 AgentMessage[]（content 为字符串，不含工具信息）。
    messages: [{ id: 'm1', role: 'assistant', content: '已写入 index.html', createdAt: 1 }],
  })
  expect(evidence.tools).toEqual({ calls: 0, results: 0, lastToolName: null, lastResultStatus: null, incompleteBatch: false })
  expect(evidence.reason).not.toBe('no_output')
})

test('GivenSDKMessage与AgentMessage混合 When分类 Then两种形状都能处理', () => {
  const evidence = classifyOwnerTerminalEvidence({
    ...baseInput,
    messages: [...messages, { id: 'm2', role: 'assistant', content: '补充说明', createdAt: 2 }],
  })
  expect(evidence.tools).toEqual({ calls: 1, results: 1, lastToolName: 'Read', lastResultStatus: 'ok', incompleteBatch: false })
  expect(evidence.reason).not.toBe('no_output')
})

test('Given没有任何消息 When分类 Then归为no_output', () => {
  const evidence = classifyOwnerTerminalEvidence({ ...baseInput, messages: [] })
  expect(evidence.reason).toBe('no_output')
  expect(evidence.tools).toEqual({ calls: 0, results: 0, lastToolName: null, lastResultStatus: null, incompleteBatch: false })
})

test('Given缺少Runtime回执 When分类 Thenundefined与null行为一致', () => {
  const withUndefined = classifyOwnerTerminalEvidence({ ...baseInput })
  const withNull = classifyOwnerTerminalEvidence({ ...baseInput, runtimeResult: null })
  expect(withUndefined.reason).toBe(withNull.reason)
  expect(withUndefined.provider).toBeNull()
  expect(withNull.provider).toBeNull()
})

test('Given工具结果报错 When分类 Then最后一次工具结果状态为error', () => {
  const evidence = classifyOwnerTerminalEvidence({
    ...baseInput,
    messages: [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'false' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] } },
    ],
  })
  expect(evidence.tools.lastResultStatus).toBe('error')
  expect(evidence.tools.calls).toBe(1)
  expect(evidence.tools.results).toBe(1)
})

test('Given正常成功终态 When分类 Then归为completed而不是unknown', () => {
  const evidence = classifyOwnerTerminalEvidence({
    ...baseInput,
    executionStatus: 'completed',
    runtimeResult: { type: 'result', subtype: 'success', finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 2 },
      toolCallBatchIntegrity: { version: 1, complete: true, reasons: [], unexecutedMandatory: false } },
  })
  expect(evidence.reason).toBe('completed')
})

test('Given正常停止但调用与结果不平衡 When分类 Then归为tool_call_incomplete', () => {
  const evidence = classifyOwnerTerminalEvidence({
    ...baseInput,
    messages: [
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.html' } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'b.html' } },
      ] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    ],
    runtimeResult: { type: 'result', subtype: 'success', finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 2 } },
  })
  expect(evidence.tools.incompleteBatch).toBe(true)
  expect(evidence.reason).toBe('tool_call_incomplete')
})

test('Given失败说明为空串或纯空白 When分类 Then使用统一兜底文案', () => {
  expect(classifyOwnerTerminalEvidence({ ...baseInput, error: '' }).detail).toBe('未记录失败说明')
  expect(classifyOwnerTerminalEvidence({ ...baseInput, error: '   \n\t ' }).detail).toBe('未记录失败说明')
})

test('Given非法消息形状 When分类 Then不崩溃且不误判输出', () => {
  const evidence = classifyOwnerTerminalEvidence({
    ...baseInput,
    messages: [null, 42, ['x'], { type: 'assistant' }, { type: 'assistant', message: { content: 'text' } }, { role: 'assistant', content: { nested: true } }],
  })
  expect(evidence.tools).toEqual({ calls: 0, results: 0, lastToolName: null, lastResultStatus: null, incompleteBatch: false })
  expect(classifyOwnerTerminalEvidence({ ...baseInput, messages: [null, 42, ['x']] }).reason).toBe('no_output')
})

test('Given超长诊断说明 When截断 Then不得切坏占位符', () => {
  const evidence = classifyOwnerTerminalEvidence({
    ...baseInput,
    // 295 个字符 + 脱敏后的 [本地路径]（6 字符）恰好跨越 300 截断点。
    error: `${'a'.repeat(295)}/Users/someone/secret`,
  })
  expect(evidence.detail.length).toBeLessThanOrEqual(300)
  // 尾部不得残留未闭合的占位符片段（如 "[本地路径" / "[凭证已"）。
  expect(/\[[^\]]*$/.test(evidence.detail)).toBe(false)
  expect(evidence.detail.endsWith('[本地路')).toBe(false)
  expect(evidence.detail.endsWith('[凭证已')).toBe(false)
})
