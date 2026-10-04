import { describe, expect, test } from 'bun:test'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'

// 仅发往内存 fake fetch，验证 SDK 的原生 Codex endpoint/鉴权和流事件。
describe('Pi native Codex transport', () => {
  test('OAuth access token 经内置 provider 发往 Codex Responses（非普通 OpenAI API）', async () => {
    const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test' } })).toString('base64url')
    const access = `eyJhbGciOiJub25lIn0.${payload}.signature`
    const runtime = await ModelRuntime.create({
      modelsPath: null, allowModelNetwork: false,
      credentials: {
        async read() { return { type: 'oauth' as const, access, refresh: 'refresh', expires: Date.now() + 3_600_000 } },
        async list() { return [{ providerId: 'openai-codex', type: 'oauth' as const }] },
        async modify(_id, fn) { return fn({ type: 'oauth', access, refresh: 'refresh', expires: Date.now() + 3_600_000 }) },
        async delete() {},
      },
    })
    const model = runtime.getModels('openai-codex')[0]
    expect(model?.api).toBe('openai-codex-responses')
    if (!model) throw new Error('Pi SDK 缺 Codex 模型')
    let requestedUrl = ''
    let authorization = ''
    const response = [
      'data: {"type":"response.created","response":{"id":"resp-1","status":"in_progress","output":[]}}',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg-1","role":"assistant","content":[]}}',
      'data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}',
      'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"hello"}',
      'data: {"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[{"type":"message","id":"msg-1","role":"assistant","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      'data: [DONE]',
    ].join('\n\n') + '\n\n'
    const events = [] as string[]
    const fakeFetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
      requestedUrl = String(url)
      authorization = new Headers(init?.headers).get('Authorization') ?? ''
      return new Response(response, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }) as typeof fetch
    const stream = runtime.streamSimple(model, { messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }] }, {
      transport: 'sse', maxRetries: 0, fetch: fakeFetch,
    })
    for await (const event of stream) events.push(event.type)
    const result = await stream.result()
    expect(requestedUrl).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(authorization).toBe(`Bearer ${access}`)
    expect(events).toContain('text_delta')
    expect(events).toContain('done')
    expect(result.stopReason).toBe('stop')
    expect(result.content).toMatchObject([{ type: 'text', text: 'hello' }])
  })
})
