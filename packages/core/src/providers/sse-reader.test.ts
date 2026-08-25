import { describe, expect, test } from 'bun:test'
import { streamSSE } from './sse-reader'
import type { ProviderAdapter, ProviderRequest, StreamEvent, StreamUsageEvent } from './types.ts'

/** 构造一个可控制 chunk 序列的 mock fetch */
function makeFetch(chunks: Uint8Array[], opts?: { failAt?: number }): typeof globalThis.fetch {
  return (async () => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < chunks.length; i++) {
          controller.enqueue(chunks[i])
          if (opts?.failAt !== undefined && i === opts.failAt) {
            // 模拟网络断流：直接关闭流，不发送剩余 chunk
            controller.close()
            return
          }
        }
        controller.close()
      },
    })
    return new Response(body, { status: 200 })
  }) as unknown as typeof globalThis.fetch
}

function openaiChunk(json: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(json)}\n\n`)
}

/** OpenAI 协议 adapter，正常结束以 [DONE] 哨兵或 finish_reason 终止 */
const openaiAdapter: ProviderAdapter = {
  providerType: 'openai',
  buildStreamRequest(): ProviderRequest {
    return { url: 'http://x', headers: {}, body: '' }
  },
  parseSSELine(jsonLine: string): StreamEvent[] {
    const chunk = JSON.parse(jsonLine) as {
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const events: StreamEvent[] = []
    if (chunk.choices?.[0]?.delta?.content) {
      events.push({ type: 'chunk', delta: chunk.choices[0].delta.content })
    }
    if (chunk.choices?.[0]?.finish_reason) {
      events.push({ type: 'done', stopReason: chunk.choices[0].finish_reason })
    }
    if (chunk.usage) {
      events.push({ type: 'usage', usage: { input_tokens: chunk.usage.prompt_tokens, output_tokens: chunk.usage.completion_tokens } as StreamUsageEvent['usage'] })
    }
    return events
  },
  buildTitleRequest() {
    return { url: 'http://x', headers: {}, body: '' }
  },
  parseTitleResponse() {
    return null
  },
}

/** Google 协议 adapter：流自然结束，无 [DONE] 哨兵 */
const googleAdapter: ProviderAdapter = {
  ...openaiAdapter,
  providerType: 'google',
  requiresTerminator: false,
  parseSSELine(jsonLine: string): StreamEvent[] {
    const chunk = JSON.parse(jsonLine) as { text?: string }
    return chunk.text ? [{ type: 'chunk', delta: chunk.text }] : []
  },
}

describe('streamSSE 提前终止检测', () => {
  test('OpenAI 协议正常收到 [DONE] 哨兵时正常返回', async () => {
    const fetchFn = makeFetch([
      openaiChunk({ choices: [{ delta: { content: '你好' } }] }),
      new TextEncoder().encode('data: [DONE]\n\n'),
    ])
    const result = await streamSSE({ request: { url: 'http://x', headers: {}, body: '' }, adapter: openaiAdapter, fetchFn, onEvent: () => {} })
    expect(result.content).toBe('你好')
  })

  test('OpenAI 协议正常收到 finish_reason 时正常返回', async () => {
    const fetchFn = makeFetch([
      openaiChunk({ choices: [{ delta: { content: '世界' } }] }),
      openaiChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      new TextEncoder().encode('data: [DONE]\n\n'),
    ])
    const result = await streamSSE({ request: { url: 'http://x', headers: {}, body: '' }, adapter: openaiAdapter, fetchFn, onEvent: () => {} })
    expect(result.content).toBe('世界')
    expect(result.stopReason).toBe('stop')
  })

  test('OpenAI 协议流在收到终止信号前被关闭时抛出断流错误', async () => {
    const fetchFn = makeFetch(
      [
        openaiChunk({ choices: [{ delta: { content: '只输出了一半' } }] }),
        // 模拟服务端/网络提前关闭：不再发送 [DONE] 或 finish_reason
      ],
      { failAt: 0 },
    )
    await expect(
      streamSSE({ request: { url: 'http://x', headers: {}, body: '' }, adapter: openaiAdapter, fetchFn, onEvent: () => {} }),
    ).rejects.toThrow(/stream ended prematurely/)
  })

  test('Google 协议流自然结束不抛错', async () => {
    const fetchFn = makeFetch([
      new TextEncoder().encode('data: {"text":"部分输出"}\n\n'),
      new TextEncoder().encode('data: {"text":"完整"}\n\n'),
    ])
    const result = await streamSSE({ request: { url: 'http://x', headers: {}, body: '' }, adapter: googleAdapter, fetchFn, onEvent: () => {} })
    expect(result.content).toBe('部分输出完整')
  })

  test('空响应（无任何 chunk）对需要终止信号的协议仍视为断流', async () => {
    const fetchFn = makeFetch([])
    await expect(
      streamSSE({ request: { url: 'http://x', headers: {}, body: '' }, adapter: openaiAdapter, fetchFn, onEvent: () => {} }),
    ).rejects.toThrow(/stream ended prematurely/)
  })
})

describe('streamSSE 空闲看门狗', () => {
  /** 构造一个「发出首 chunk 后永久停滞」的流：既不再发数据也不关闭，模拟静默挂起 */
  function makeHangingFetch(after: number): typeof globalThis.fetch {
    return (async () => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: {"text":"开场"}\n\n`))
          // 之后不再 enqueue 也不再 close → reader.read() 永久 pending
          void after
        },
      })
      return new Response(body, { status: 200 })
    }) as unknown as typeof globalThis.fetch
  }

  test('空闲超时后抛出可重试的瞬时错误，而不是永远挂起', async () => {
    const fetchFn = makeHangingFetch(50)
    await expect(
      streamSSE({
        request: { url: 'http://x', headers: {}, body: '' },
        adapter: googleAdapter,
        fetchFn,
        onEvent: () => {},
        idleTimeoutMs: 80,
      }),
    ).rejects.toThrow(/空闲超时|ended without data/i)
  })

  test('常规数据流在 idleTimeoutMs 内完成时不触发看门狗', async () => {
    const fetchFn = makeFetch([
      new TextEncoder().encode('data: {"text":"快速"}\n\n'),
      new TextEncoder().encode('data: {"text":"完成"}\n\n'),
    ])
    const result = await streamSSE({
      request: { url: 'http://x', headers: {}, body: '' },
      adapter: googleAdapter,
      fetchFn,
      onEvent: () => {},
      idleTimeoutMs: 2000,
    })
    expect(result.content).toBe('快速完成')
  })

  test('idleTimeoutMs=0 时禁用看门狗（保持旧行为，流挂起则由调用方处理）', async () => {
    // 这里不等待真实挂起，只验证正常流不受影响
    const fetchFn = makeFetch([new TextEncoder().encode('data: {"text":"ok"}\n\n')])
    const result = await streamSSE({
      request: { url: 'http://x', headers: {}, body: '' },
      adapter: googleAdapter,
      fetchFn,
      onEvent: () => {},
      idleTimeoutMs: 0,
    })
    expect(result.content).toBe('ok')
  })
})
