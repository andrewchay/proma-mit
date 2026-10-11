import { describe, expect, test } from 'bun:test'
import { assessToolCallBatchIntegrity, type ObservedToolCall } from './tool-call-integrity'

const call = (change: Partial<ObservedToolCall> = {}): ObservedToolCall => ({ toolCallId: 'call-1', toolName: 'Read', ...change })

describe('批次完整性判定不撤销已执行效果', () => {
  test('完整tool-calls与stop批次，身份稳定可复制', () => {
    for (const finishReason of ['tool-calls', 'stop', 'end_turn', 'tool_use'] as const) {
      const batch = assessToolCallBatchIntegrity([call()], finishReason)
      expect(batch).toMatchObject({ version: 1, complete: true, unexecutedMandatory: false })
      expect(batch.reasons).toEqual([])
      expect(batch).toEqual(assessToolCallBatchIntegrity([call()], finishReason))
    }
  })
  for (const finishReason of ['length', 'error', 'content-filter', 'other', undefined, 'unknown', '', 'TOOL-CALLS', 'end_turn:'] as const) {
    test(`finishReason=${String(finishReason)}不完整`, () => {
      const batch = assessToolCallBatchIntegrity([call()], finishReason)
      expect(batch.complete).toBe(false)
      expect(batch.unexecutedMandatory).toBe(false)
      expect(batch.reasons.length).toBeGreaterThan(0)
    })
  }
  test('invalid调用与空工具名拒绝；缺失错误字段视为未知而非完整', () => {
    expect(assessToolCallBatchIntegrity([call({ toolName: '' })], 'tool-calls').reasons).toContain('empty_tool_name')
    expect(assessToolCallBatchIntegrity([call({ toolName: '   ' })], 'tool-calls').reasons).toContain('empty_tool_name')
    const invalid = assessToolCallBatchIntegrity([{ toolCallId: 'x', toolName: 'Nope', dynamic: true, invalid: true }], 'tool-calls')
    expect(invalid.complete).toBe(false)
    expect(invalid.reasons).toContain('invalid_tool_call')
    expect(assessToolCallBatchIntegrity([call({ dynamic: true, invalid: undefined })], 'tool-calls').complete).toBe(true)
  })
  test('重复与空toolCallId拒绝；id仅去重检查不重排', () => {
    expect(assessToolCallBatchIntegrity([call(), call()], 'tool-calls').reasons).toContain('duplicate_tool_call_id')
    expect(assessToolCallBatchIntegrity([call({ toolCallId: '' })], 'tool-calls').reasons).toContain('empty_tool_call_id')
    const batch = assessToolCallBatchIntegrity([call({ toolCallId: 'b' }), call({ toolCallId: 'a', toolName: 'Write' })], 'tool-calls')
    expect(batch.complete).toBe(true)
  })
  test('非数组calls、伪造原型与额外字段保守拒绝', () => {
    expect(assessToolCallBatchIntegrity(null, 'stop').complete).toBe(false)
    expect(assessToolCallBatchIntegrity([Object.create(call())], 'stop').complete).toBe(false)
    expect(assessToolCallBatchIntegrity([{ ...call(), trusted: true }], 'stop').complete).toBe(false)
    expect(assessToolCallBatchIntegrity([{ ...call(), dynamic: 'yes' as unknown as boolean }], 'stop').complete).toBe(false)
  })
  test('长度截断与无效调用组合只报告事实，不声称零执行', () => {
    const batch = assessToolCallBatchIntegrity([call({ toolName: 'Write' }), { toolCallId: 'call-2', toolName: '', dynamic: true, invalid: true }], 'length')
    expect(batch.complete).toBe(false)
    expect(batch.reasons).toEqual(expect.arrayContaining(['finish_reason:length', 'invalid_tool_call', 'empty_tool_name']))
  })
})
