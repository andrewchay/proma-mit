import { describe, expect, test } from 'bun:test'
import { streamText } from 'ai'
import { createOpenAICompatibleAISDKModel } from '@gravitas/core/providers/ai-sdk-bridge'
import { buildAISDKModelMessages } from '../agent-runtime/ai-sdk-runtime-core'

describe('AI SDK image API payload', () => {
  test('given a JPEG user block when AI SDK serializes the request then the final HTTP payload contains the image data URL', async () => {
    const originalFetch = globalThis.fetch
    let finalRequestBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_input, init) => {
      finalRequestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response([
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash-vision-exp","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash-vision-exp","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
        '',
      ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof globalThis.fetch

    try {
      const model = createOpenAICompatibleAISDKModel({
        apiKey: 'test-key',
        baseUrl: 'https://api.deepseek.com/v1',
        modelId: 'deepseek-v4-flash-vision-exp',
        providerName: 'deepseek',
      })
      const messages = buildAISDKModelMessages([], '理解这幅图', [{
        mediaType: 'image/jpeg',
        data: 'AQID',
      }])

      const result = streamText({ model, messages })
      await result.text

      const apiMessages = finalRequestBody?.messages as Array<Record<string, unknown>> | undefined
      expect(apiMessages?.at(-1)?.content).toEqual([
        { type: 'text', text: '理解这幅图' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQID' } },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
