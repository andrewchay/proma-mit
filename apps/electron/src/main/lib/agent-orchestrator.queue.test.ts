import { describe, test, expect, mock, beforeAll } from 'bun:test'
import { buildElectronMock } from './testing/electron-mock'
import type { SDKMessage, AgentStreamPayload, AgentSendInput } from '@gravitas/shared'
import type { AgentProviderAdapter } from '@gravitas/shared'

// mock electron：orchestrator 顶层及相关服务 import { app, BrowserWindow } from 'electron'，测试环境无真实 Electron
mock.module('electron', () => buildElectronMock())

// 延迟引入，确保 electron mock 生效
const { AgentOrchestrator } = await import('./agent-orchestrator')
const { AgentEventBus } = await import('./agent-event-bus')
import type { SessionCallbacks } from './agent-orchestrator'

type Orchestrator = InstanceType<typeof AgentOrchestrator>

function makeFakeAdapter(): AgentProviderAdapter {
  return {
    query(): AsyncIterable<SDKMessage> {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } } as unknown as SDKMessage
          yield { type: 'result', subtype: 'success' } as unknown as SDKMessage
        },
      }
    },
    abort() {},
    dispose() {},
  }
}

function makeFakeRuntimeServices(emit: (sessionId: string, payload: AgentStreamPayload) => void) {
  return {
    credentials: { resolveChannel: async () => undefined },
    workspaces: { resolveWorkspaceContext: () => ({ cwd: '/tmp' }) },
    sessions: {
      getHistoryMessages: () => [],
      appendMessages: () => {},
      truncateMessages: () => [],
    },
    events: { emit },
    mcp: {},
  } as unknown as ConstructorParameters<typeof AgentOrchestrator>[2]
}

const EMPTY_CALLBACKS: SessionCallbacks = {
  onError: () => {},
  onComplete: () => {},
  onTitleUpdated: () => {},
}

const EMPTY_INPUT = { userMessage: 'x', channelId: 'c', sessionId: 's' } as AgentSendInput

describe('Agent 编排 会话级发送队列', () => {
  let orchestrator: Orchestrator
  const queueStates: Array<{ sessionId: string; event: unknown }> = []

  beforeAll(() => {
    const eventBus = new AgentEventBus()
    eventBus.on((sessionId: string, payload: AgentStreamPayload) => {
      if (payload.kind === 'queue_state') {
        queueStates.push({ sessionId, event: payload.event })
      }
    })
    orchestrator = new AgentOrchestrator(
      makeFakeAdapter(),
      eventBus,
      makeFakeRuntimeServices((sid: string, payload: AgentStreamPayload) => eventBus.emit(sid, payload)),
    )
  })

  test('初始无排队消息，getQueuedMessageCount 返回 0', () => {
    expect(orchestrator.getQueuedMessageCount('s-abc')).toBe(0)
  })

  test('promoteQueuedMessage 对不存在的 queueId 返回 false', () => {
    expect(orchestrator.promoteQueuedMessage('s-abc', 'nope')).toBe(false)
  })

  test('cancelQueuedMessage 对不存在的 queueId 返回 false', () => {
    expect(orchestrator.cancelQueuedMessage('s-abc', 'nope')).toBe(false)
  })

  test('手动注入队列后可计数、撤回、插队，并广播 queue_state', () => {
    const queueOf = (): Array<{ queueId: string; input: AgentSendInput; callbacks: SessionCallbacks }> =>
      (orchestrator as unknown as { sessionSendQueue: Map<string, Array<{ queueId: string; input: AgentSendInput; callbacks: SessionCallbacks }>> }).sessionSendQueue.get('s-q') ?? []

    ;(orchestrator as unknown as { sessionSendQueue: Map<string, Array<{ queueId: string; input: AgentSendInput; callbacks: SessionCallbacks }>> }).sessionSendQueue.set('s-q', [
      { queueId: 'a', input: EMPTY_INPUT, callbacks: EMPTY_CALLBACKS },
      { queueId: 'b', input: EMPTY_INPUT, callbacks: EMPTY_CALLBACKS },
    ])

    expect(orchestrator.getQueuedMessageCount('s-q')).toBe(2)

    const beforePromote = queueStates.length
    // 插队：把 'b' 提到队首
    expect(orchestrator.promoteQueuedMessage('s-q', 'b')).toBe(true)
    expect(queueOf()[0]!.queueId).toBe('b')
    // 插队应广播 queue_state
    expect(queueStates.length).toBeGreaterThan(beforePromote)

    // 撤回 'a'：还剩 1 条
    expect(orchestrator.cancelQueuedMessage('s-q', 'a')).toBe(true)
    expect(orchestrator.getQueuedMessageCount('s-q')).toBe(1)

    // 撤回不存在：false
    expect(orchestrator.cancelQueuedMessage('s-q', 'ghost')).toBe(false)

    // 清空
    ;(orchestrator as unknown as { sessionSendQueue: Map<string, unknown> }).sessionSendQueue.delete('s-q')
    expect(orchestrator.getQueuedMessageCount('s-q')).toBe(0)
  })

  test('stop 会清空该会话待发送队列', () => {
    ;(orchestrator as unknown as { sessionSendQueue: Map<string, unknown> }).sessionSendQueue.set('s-stop', [
      { queueId: 'x', input: EMPTY_INPUT, callbacks: EMPTY_CALLBACKS },
    ])
    expect(orchestrator.getQueuedMessageCount('s-stop')).toBe(1)
    orchestrator.stop('s-stop')
    expect(orchestrator.getQueuedMessageCount('s-stop')).toBe(0)
  })
})
