import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../testing/electron-mock'
import type { AISDKAgentTurnInput } from './ai-sdk-runtime-core'
const dir = mkdtempSync(join(tmpdir(), 'owner-offline-'))
process.env.PROMA_TEST_CONFIG_DIR = dir
afterAll(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })
mock.module('electron', () => buildElectronMock())
const { AISDKRuntimeCore } = await import('./ai-sdk-runtime-core')
function input(fetchFn: typeof globalThis.fetch): AISDKAgentTurnInput {
  return { sessionId: 'owner', prompt: 'evil', systemPrompt: 'evil', modelId: 'offline-model', provider: 'openai', protocol: 'openai-chat', apiKey: 'fake', baseUrl: 'https://offline.invalid/v1', cwd: dir,
    runtimeTools: [], activeSession: { controller: new AbortController(), permissionMode: 'safe', planModeEntered: false }, maxTurns: 20, maxRetries: 9,
    ownerPlanningRequest: { systemPrompt: 'authority-system', userPrompt: 'authority-user' }, fetchFn,
    historyMessages: [{ type: 'user', message: { content: 'evil-history' } } as never], attachments: [{ localPath: '/should/not/read', mediaType: 'text/plain' } as never], workspaceSlug: 'evil',
  }
}
describe('Owner real AI SDK offline serialization', () => {
  test('given authority turn then the real OpenAI adapter sends one tool-free capped payload and preserves raw answer/tokens', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchFn = (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response([
        'data: {"id":"offline","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{"content":"raw-answer"},"finish_reason":null}]}',
        'data: {"id":"offline","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}',
        'data: [DONE]', '',
      ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof globalThis.fetch
    const messages = await new AISDKRuntimeCore().runAgentTurn(input(fetchFn))
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ model: 'offline-model', max_tokens: 4096, messages: [{ role: 'system', content: 'authority-system' }, { role: 'user', content: 'authority-user' }] })
    expect(bodies[0]?.tools).toBeUndefined()
    expect(JSON.stringify(bodies)).not.toContain('evil')
    expect(messages.at(-1)).toMatchObject({ type: 'result', result: 'raw-answer', finish_reason: 'stop', usage: { input_tokens: 12, output_tokens: 4 } })
  })
  test('given Anthropic then real SDK maps 4096 to max_tokens without tools', async () => {
    let body: Record<string, unknown> | undefined
    const fetchFn = (async (_url, init) => {
      body = JSON.parse(String(init?.body))
      const events = [
        { type: 'message_start', message: { id: 'offline', type: 'message', role: 'assistant', model: 'offline-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'raw-answer' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
        { type: 'message_stop' },
      ]
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof globalThis.fetch
    const messages = await new AISDKRuntimeCore().runAgentTurn({ ...input(fetchFn), provider: 'anthropic', protocol: 'anthropic-messages' })
    expect(body).toMatchObject({ max_tokens: 4096, system: [{ type: 'text', text: 'authority-system' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'authority-user' }] }] })
    expect(body?.tools).toBeUndefined()
    expect(messages.at(-1)).toMatchObject({ result: 'raw-answer', usage: { input_tokens: 12, output_tokens: 4 } })
  })
  test('given Google then real SDK maps 4096 to generationConfig.maxOutputTokens without tools', async () => {
    let body: Record<string, unknown> | undefined
    const fetchFn = (async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return new Response('data: ' + JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'raw-answer' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof globalThis.fetch
    const messages = await new AISDKRuntimeCore().runAgentTurn({ ...input(fetchFn), provider: 'google', protocol: 'google-generative' })
    expect(body).toMatchObject({ generationConfig: { maxOutputTokens: 4096 }, systemInstruction: { parts: [{ text: 'authority-system' }] }, contents: [{ role: 'user', parts: [{ text: 'authority-user' }] }] })
    expect(body?.tools).toBeUndefined()
    expect(messages.at(-1)).toMatchObject({ result: 'raw-answer', usage: { input_tokens: 12, output_tokens: 4 } })
  })
  test('given abort then a single real SDK HTTP attempt is cancelled without continuation', async () => {
    let calls = 0
    let entered: (() => void) | undefined
    const started = new Promise<void>(resolve => { entered = resolve })
    const fetchFn = (async (_url, init) => {
      calls++; entered?.()
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) reject(new DOMException('aborted', 'AbortError'))
        else signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    }) as typeof globalThis.fetch
    const turn = input(fetchFn)
    const promise = new AISDKRuntimeCore().runAgentTurn(turn)
    await started
    turn.activeSession.controller.abort()
    await expect(promise).rejects.toThrow()
    expect(calls).toBe(1)
  })
  test('given HTTP 503 then real SDK does not retry', async () => {
    let calls = 0
    const fetchFn = (async (_url, _init) => { calls++; return new Response('{"error":{"message":"offline unavailable"}}', { status: 503, headers: { 'content-type': 'application/json' } }) }) as typeof globalThis.fetch
    await expect(new AISDKRuntimeCore().runAgentTurn(input(fetchFn))).rejects.toThrow()
    expect(calls).toBe(1)
  })
})
test('given Owner收紧字段但无fetch出口 then 不回退普通自由Caller', async () => {
  const supplied = input(Object.assign(async () => new Response('unused'), { preconnect: () => {} }))
  await expect(new AISDKRuntimeCore().runAgentTurn({ ...supplied, fetchFn: undefined })).rejects.toThrow('受控模型出口')
})
test('given Provider未报告usage then Owner专用证据保留unknown而非兼容0，length保留文本但不success', async () => {
  for (const reason of ['stop', 'length']) {
    const transport: typeof fetch = Object.assign(async () => new Response('data: '+JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'offline-model', choices: [{ index: 0, delta: { content: 'partial-answer' }, finish_reason: reason }] })+'\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }), { preconnect: () => {} })
    const messages = await new AISDKRuntimeCore().runAgentTurn(input(transport)); expect(messages.at(-1)).toMatchObject({ result: 'partial-answer', subtype: reason === 'stop' ? 'success' : 'error_during_execution', owner_planning_usage: { inputTokens: null, outputTokens: null } })
  }
})
