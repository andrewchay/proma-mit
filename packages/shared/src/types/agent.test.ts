import { describe, expect, test } from 'bun:test'
import {
  AGENT_RUNTIME_CAPABILITIES,
  createAgentStreamEnvelope,
  getAgentRuntimeHistorySemantics,
  getAgentRuntimeLabel,
  isAgentRuntime,
  normalizeAgentRuntime,
  serializeAgentStreamEnvelopeForSSE,
} from './agent'

describe('Agent runtime 类型', () => {
  test('识别 AI SDK runtime 并保留旧值回退行为', () => {
    expect(isAgentRuntime('ai-sdk')).toBe(true)
    expect(getAgentRuntimeLabel('ai-sdk')).toBe('AI SDK')
    expect(normalizeAgentRuntime('unknown')).toBe('claude')
  })

  test('AI SDK runtime 能力声明匹配当前工具体系接入状态', () => {
    expect(AGENT_RUNTIME_CAPABILITIES['ai-sdk']).toMatchObject({
      supportsTools: true,
      supportsMcp: true,
      supportsPlanMode: true,
      supportsAskUser: true,
      supportsSubAgent: true,
      supportsPartialStreaming: true,
      supportsNativeResume: false,
      supportsFileSnapshotRewind: false,
    })
  })

  test('Agent stream envelope 为服务端 SSE/WebSocket 提供稳定事件边界', () => {
    const envelope = createAgentStreamEnvelope(
      'session-1',
      { kind: 'agent_event', event: { type: 'text_delta', text: 'hello' } },
      { id: 'evt-1', createdAt: 123 },
    )

    expect(envelope).toEqual({
      id: 'evt-1',
      sessionId: 'session-1',
      createdAt: 123,
      payload: { kind: 'agent_event', event: { type: 'text_delta', text: 'hello' } },
    })
    expect(serializeAgentStreamEnvelopeForSSE(envelope)).toBe([
      'id: evt-1',
      'event: agent-stream',
      'data: {"id":"evt-1","sessionId":"session-1","createdAt":123,"payload":{"kind":"agent_event","event":{"type":"text_delta","text":"hello"}}}',
      '',
      '',
    ].join('\n'))
  })

  test('Agent runtime history semantics 明确区分 SDK snapshot 与 history replay', () => {
    expect(getAgentRuntimeHistorySemantics('claude')).toMatchObject({
      forkMode: 'sdk_snapshot',
      rewindMode: 'sdk_file_snapshot',
      restoresFileSnapshot: true,
      usesNativeSessionResume: true,
    })
    expect(getAgentRuntimeHistorySemantics('ai-sdk')).toMatchObject({
      forkMode: 'jsonl_history_copy',
      rewindMode: 'history_truncate',
      restoresFileSnapshot: false,
      usesNativeSessionResume: false,
    })
  })
})
