import { describe, expect, test } from 'bun:test'
import type { AgentStreamPayload, SDKAssistantMessage, SDKResultMessage, SDKSystemMessage, PromaEvent } from '@proma/shared'

import { toAppEvent } from './app-event-bus'

describe('toAppEvent 归一化', () => {
  test('permission_request → waiting_action(permission)', () => {
    const event: PromaEvent = { type: 'permission_request', request: { requestId: 'r1', sessionId: 's1', toolName: 'Bash', toolInput: {}, description: '运行命令', dangerLevel: 'normal' } }
    const payload: AgentStreamPayload = { kind: 'proma_event', event }
    const out = toAppEvent('s1', payload)
    expect(out?.type).toBe('waiting_action')
    if (out?.type === 'waiting_action') expect(out.actionKind).toBe('permission')
  })

  test('ask_user_request → waiting_action(ask_user_question)', () => {
    const event: PromaEvent = { type: 'ask_user_request', request: { requestId: 'r2', sessionId: 's1', questions: [{ question: '继续吗？', header: '确认', options: [] }], toolInput: {} } }
    const payload: AgentStreamPayload = { kind: 'proma_event', event }
    const out = toAppEvent('s1', payload)
    expect(out?.type).toBe('waiting_action')
    if (out?.type === 'waiting_action') expect(out.detail).toContain('继续吗')
  })

  test('agent complete → completed', () => {
    const payload: AgentStreamPayload = { kind: 'agent_event', event: { type: 'complete' } }
    const out = toAppEvent('s1', payload)
    expect(out?.type).toBe('completed')
  })

  test('agent error → failed', () => {
    const payload: AgentStreamPayload = { kind: 'agent_event', event: { type: 'error', message: '网络错误' } }
    const out = toAppEvent('s1', payload)
    expect(out?.type).toBe('failed')
    if (out?.type === 'failed') expect(out.detail).toBe('网络错误')
  })

  test('SDK assistant tool_use → progress(正在使用 工具名)', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { _displayName: 'Bash' } }] },
      parent_tool_use_id: null,
    }
    const payload: AgentStreamPayload = { kind: 'sdk_message', message: assistant }
    const out = toAppEvent('s1', payload)
    expect(out?.type).toBe('progress')
    if (out?.type === 'progress') expect(out.detail).toContain('Bash')
  })

  test('SDK result success → completed；error → failed', () => {
    const success: SDKResultMessage = { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }
    expect(toAppEvent('s1', { kind: 'sdk_message', message: success } as AgentStreamPayload)?.type).toBe('completed')

    const failed: SDKResultMessage = { type: 'result', subtype: 'error', usage: { input_tokens: 1, output_tokens: 0 }, errors: ['超时'] }
    const failedOut = toAppEvent('s1', { kind: 'sdk_message', message: failed } as AgentStreamPayload)
    expect(failedOut?.type).toBe('failed')
    if (failedOut?.type === 'failed') expect(failedOut.detail).toBe('超时')
  })

  test('SDK permission_denied → waiting_action(permission)', () => {
    const system: SDKSystemMessage = { type: 'system', subtype: 'permission_denied', message: '权限被拒绝' }
    const out = toAppEvent('s1', { kind: 'sdk_message', message: system } as AgentStreamPayload)
    expect(out?.type).toBe('waiting_action')
    if (out?.type === 'waiting_action') expect(out.actionKind).toBe('permission')
  })

  test('不可归一的普通事件返回 null', () => {
    const event: PromaEvent = { type: 'model_resolved', model: 'claude' }
    const out = toAppEvent('s1', { kind: 'proma_event', event })
    expect(out).toBeNull()
  })
})
