import { expect, test } from 'bun:test'
import { buildOwnerLateCompletionEvidence } from './project-owner-late-completion-evidence'

const terminal = { type: 'result', subtype: 'success', finish_reason: 'stop', session_id: 'session',
  toolCallBatchIntegrity: { version: 1, complete: true, unexecutedMandatory: false, reasons: [] }, usage: { input_tokens: 10, output_tokens: 5 } }
const request = { requestId: 'request', executionId: 'execution', sessionId: 'session', state: 'settled', settledCostMicros: 42,
  requestEvidenceId: 'a'.repeat(64), priceEvidenceId: 'reviewed-price' }
const assistant = { type: 'assistant', session_id: 'session', message: { content: [{ type: 'text', text: '已完成' }] } }

test('Given同一会话的完整成功终态和已结算请求 When只读核验 Then返回准确费用与终态摘要', () => {
  expect(buildOwnerLateCompletionEvidence('execution', 'session', [assistant, terminal], [request])).toMatchObject({
    executionId: 'execution', sessionId: 'session', requestSettlementIds: ['request'], costMicros: 42,
    terminalHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  })
})

test('Given终态、工具批次、身份或费用不完整 When核验 Then不构造可恢复证据', () => {
  const build = (messages: unknown[], requests = [request]) => buildOwnerLateCompletionEvidence('execution', 'session', [assistant, ...messages], requests)
  expect(build([{ ...terminal, subtype: 'error_during_execution' }])).toBeNull()
  expect(build([{ ...terminal, session_id: 'other' }])).toBeNull()
  expect(build([{ ...terminal, toolCallBatchIntegrity: { ...terminal.toolCallBatchIntegrity, complete: false } }])).toBeNull()
  expect(build([{ ...terminal, usage: { input_tokens: 10 } }])).toBeNull()
  expect(build([terminal, { type: 'assistant' }])).toBeNull()
  expect(build([terminal], [{ ...request, state: 'needs_reconcile' }])).toBeNull()
  expect(build([terminal], [{ ...request, sessionId: 'other' }])).toBeNull()
  expect(build([terminal], [{ ...request, priceEvidenceId: '' }])).toBeNull()
  expect(build([terminal], [request, request])).toBeNull()
  expect(buildOwnerLateCompletionEvidence('execution', 'session', [terminal], [request])).toBeNull()
  expect(buildOwnerLateCompletionEvidence('execution', 'session', [{ ...assistant, session_id: 'other' }, terminal], [request])).toBeNull()
  expect(build([{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SendExternalMessage' }] } }, assistant, terminal])).toBeNull()
  expect(build([{ type: 'user', message: { content: [{ type: 'tool_result', is_error: true }] } }, assistant, terminal])).toBeNull()
})
