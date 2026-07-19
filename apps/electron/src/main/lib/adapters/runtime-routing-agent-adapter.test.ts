import { describe, expect, test } from 'bun:test'
import type {
  AgentProviderAdapter,
  AgentQueryInput,
  AgentRuntime,
  SendQueuedMessageOptions,
  SDKMessage,
  SDKUserMessageInput,
} from '@proma/shared'
import { RuntimeRoutingAgentAdapter } from './runtime-routing-agent-adapter'

interface RecordedCall {
  method: string
  sessionId: string
  value?: string
}

class RecordingAdapter implements AgentProviderAdapter {
  readonly calls: RecordedCall[] = []

  constructor(private readonly label: string) {}

  async *query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    this.calls.push({ method: 'query', sessionId: input.sessionId, value: this.label })
    yield {
      type: 'result',
      subtype: 'success',
      session_id: input.sessionId,
    } as unknown as SDKMessage
  }

  abort(sessionId: string): void {
    this.calls.push({ method: 'abort', sessionId })
  }

  dispose(): void {
    this.calls.push({ method: 'dispose', sessionId: '*' })
  }

  async interruptQuery(sessionId: string): Promise<void> {
    this.calls.push({ method: 'interruptQuery', sessionId })
  }

  async sendQueuedMessage(
    sessionId: string,
    message: SDKUserMessageInput,
    options?: SendQueuedMessageOptions,
  ): Promise<void> {
    this.calls.push({ method: 'sendQueuedMessage', sessionId, value: options?.interrupt ? 'interrupt' : message.uuid })
  }

  async cancelQueuedMessage(sessionId: string, messageUuid: string): Promise<void> {
    this.calls.push({ method: 'cancelQueuedMessage', sessionId, value: messageUuid })
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    this.calls.push({ method: 'setPermissionMode', sessionId, value: mode })
  }
}

function createAdapters(): Record<AgentRuntime, RecordingAdapter> {
  return {
    claude: new RecordingAdapter('claude'),
    proma: new RecordingAdapter('proma'),
    pi: new RecordingAdapter('pi'),
    'ai-sdk': new RecordingAdapter('ai-sdk'),
  }
}

describe('RuntimeRoutingAgentAdapter', () => {
  test('query 按输入 runtime 路由，并让后续控制命令命中同一 adapter', async () => {
    const adapters = createAdapters()
    const router = new RuntimeRoutingAgentAdapter(adapters)

    for await (const _message of router.query({ sessionId: 's1', prompt: 'hi', agentRuntime: 'proma' })) {
      // 消费异步迭代，触发 query 记录。
    }

    await router.setPermissionMode('s1', 'bypassPermissions')
    await router.interruptQuery('s1')
    await router.sendQueuedMessage(
      's1',
      {
        type: 'user',
        message: { role: 'user', content: 'next' },
        parent_tool_use_id: null,
        session_id: 's1',
        uuid: 'queued-1',
      },
      { interrupt: true },
    )
    await router.cancelQueuedMessage('s1', 'queued-1')
    router.abort('s1')

    expect(adapters.proma.calls.map((call) => call.method)).toEqual([
      'query',
      'setPermissionMode',
      'interruptQuery',
      'sendQueuedMessage',
      'cancelQueuedMessage',
      'abort',
    ])
    expect(adapters.claude.calls).toHaveLength(0)
    expect(adapters.pi.calls).toHaveLength(0)
    expect(adapters['ai-sdk'].calls).toHaveLength(0)
  })

  test('缺失或非法 runtime 默认走 Claude', async () => {
    const adapters = createAdapters()
    const router = new RuntimeRoutingAgentAdapter(adapters)

    for await (const _message of router.query({ sessionId: 's2', prompt: 'hi', agentRuntime: 'unknown' as never })) {
      // 消费异步迭代，触发 query 记录。
    }

    expect(adapters.claude.calls).toEqual([{ method: 'query', sessionId: 's2', value: 'claude' }])
    expect(adapters.proma.calls).toHaveLength(0)
    expect(adapters.pi.calls).toHaveLength(0)
    expect(adapters['ai-sdk'].calls).toHaveLength(0)
  })

  test('Pi runtime 会路由到 Pi adapter', async () => {
    const adapters = createAdapters()
    const router = new RuntimeRoutingAgentAdapter(adapters)

    for await (const _message of router.query({ sessionId: 's-pi', prompt: 'hi', agentRuntime: 'pi' })) {
      // 消费异步迭代，触发 query 记录。
    }

    expect(adapters.pi.calls).toEqual([{ method: 'query', sessionId: 's-pi', value: 'pi' }])
    expect(adapters.claude.calls).toHaveLength(0)
    expect(adapters.proma.calls).toHaveLength(0)
    expect(adapters['ai-sdk'].calls).toHaveLength(0)
  })

  test('AI SDK runtime 会路由到对应 adapter', async () => {
    const adapters = createAdapters()
    const router = new RuntimeRoutingAgentAdapter(adapters)

    for await (const _message of router.query({ sessionId: 's-ai', prompt: 'hi', agentRuntime: 'ai-sdk' })) {
      // 消费异步迭代，触发 query 记录。
    }

    expect(adapters['ai-sdk'].calls).toEqual([{ method: 'query', sessionId: 's-ai', value: 'ai-sdk' }])
    expect(adapters.claude.calls).toHaveLength(0)
    expect(adapters.proma.calls).toHaveLength(0)
    expect(adapters.pi.calls).toHaveLength(0)
  })

  test('未知会话 abort 会广播到所有 runtime adapter', () => {
    const adapters = createAdapters()
    const router = new RuntimeRoutingAgentAdapter(adapters)

    router.abort('missing')

    expect(adapters.claude.calls).toEqual([{ method: 'abort', sessionId: 'missing' }])
    expect(adapters.proma.calls).toEqual([{ method: 'abort', sessionId: 'missing' }])
    expect(adapters.pi.calls).toEqual([{ method: 'abort', sessionId: 'missing' }])
    expect(adapters['ai-sdk'].calls).toEqual([{ method: 'abort', sessionId: 'missing' }])
  })
})
