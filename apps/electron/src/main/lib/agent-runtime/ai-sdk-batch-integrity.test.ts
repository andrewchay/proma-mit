import { describe, expect, test } from 'bun:test'
import { assessStepsToolCallBatchIntegrity, buildAISDKMessagesFromSteps } from './ai-sdk-runtime-core'
import type { SDKResultMessage } from '@gravitas/shared'

describe('E03接线：批次观察随结果持久化，不撤销已执行调用', () => {
  const call = (toolCallId: string, toolName = 'Read') => ({ toolCallId, toolName, input: {} })
  test('完整end_turn/tool_use批次complete', () => {
    for (const finishReason of ['end_turn', 'tool_use']) {
      const batch = assessStepsToolCallBatchIntegrity([{ toolCalls: [call('a')], finishReason }])
      expect(batch).toMatchObject({ version: 1, complete: true, unexecutedMandatory: false })
      expect(batch.reasons).toEqual([])
    }
  })
  test('截断与空名按step编号报告，多step独立', () => {
    const batch = assessStepsToolCallBatchIntegrity([
      { toolCalls: [call('a', 'Write')], finishReason: 'end_turn' },
      { toolCalls: [call('b'), call('b')], finishReason: 'length' },
      { toolCalls: [call('')], finishReason: 'end_turn' },
    ])
    expect(batch.complete).toBe(false)
    expect(batch.reasons).toEqual([
      'step_1:finish_reason:length',
      'step_1:duplicate_tool_call_id',
      'step_2:empty_tool_call_id',
    ])
  })
  test('无快照不伪造不完整，也不冒充Provider确认', () => {
    expect(assessStepsToolCallBatchIntegrity([]).complete).toBe(true)
  })
  test('result消息可携带观察字段且不影响既有消息构建', () => {
    const messages = buildAISDKMessagesFromSteps([{ text: 'ok', toolCalls: [call('a')], toolResults: [], finishReason: 'end_turn' }], 'session-1', 'model-1')
    expect(messages.map((message) => message.type)).toEqual(['assistant'])
    const result: SDKResultMessage = {
      type: 'result', subtype: 'success',
      usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'session-1',
      toolCallBatchIntegrity: assessStepsToolCallBatchIntegrity([{ toolCalls: [call('a')], finishReason: 'end_turn' }]),
    }
    expect(result.toolCallBatchIntegrity).toMatchObject({ complete: true, version: 1 })
    expect(Object.keys(result)).not.toContain('unexecutedMandatory_override')
  })
})
