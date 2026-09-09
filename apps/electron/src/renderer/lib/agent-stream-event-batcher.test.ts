import { describe, expect, test } from 'bun:test'
import type { AgentStreamEvent, SDKMessage } from '@gravitas/shared'
import { createAgentStreamEventBatcher } from './agent-stream-event-batcher'

function partial(sessionId: string, text: string): AgentStreamEvent {
  const message = {
    type: 'assistant',
    _partial: true,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as unknown as SDKMessage
  return { sessionId, payload: { kind: 'sdk_message', message } }
}

describe('Agent 流事件逐帧合并', () => {
  test('同一帧同一会话只交付最新累计快照', () => {
    const dispatched: AgentStreamEvent[] = []
    let frameCallback: FrameRequestCallback | null = null
    const batcher = createAgentStreamEventBatcher({
      dispatch: (event) => dispatched.push(event),
      requestFrame: (callback) => { frameCallback = callback; return 1 },
      cancelFrame: () => undefined,
      scheduleFallback: () => 2,
      cancelFallback: () => undefined,
    })

    batcher.push(partial('session-a', 'A'))
    batcher.push(partial('session-a', 'AB'))
    expect(dispatched).toHaveLength(0)
    expect(frameCallback).not.toBeNull()
    ;(frameCallback as unknown as (time: number) => void)(0)
    expect(dispatched).toHaveLength(1)
    const message = dispatched[0]?.payload.kind === 'sdk_message'
      ? dispatched[0].payload.message as Record<string, unknown>
      : null
    expect(JSON.stringify(message)).toContain('AB')
  })

  test('终态事件立即交付并丢弃尚未渲染的旧 partial', () => {
    const dispatched: AgentStreamEvent[] = []
    const batcher = createAgentStreamEventBatcher({
      dispatch: (event) => dispatched.push(event),
      requestFrame: () => 1,
      cancelFrame: () => undefined,
      scheduleFallback: () => 2,
      cancelFallback: () => undefined,
    })
    batcher.push(partial('session-a', '旧快照'))
    batcher.push({
      sessionId: 'session-a',
      payload: { kind: 'agent_event', event: { type: 'text_complete', text: '完成', isIntermediate: false } },
    })
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.payload.kind).toBe('agent_event')
  })
})
