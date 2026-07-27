import { describe, expect, test } from 'bun:test'
import { GoogleAdapter } from './google-adapter.ts'
import { OpenAIAdapter } from './openai-adapter.ts'
import type { ProviderRequest, StreamRequestInput } from './types.ts'

function buildInput(modelId: string): StreamRequestInput {
  return {
    providerType: 'openai',
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    modelId,
    history: [],
    userMessage: '继续完成任务',
    readImageAttachments: () => [],
    continuationMessages: [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_screenshot', name: 'ComputerUseScreenshot', arguments: {} }],
      },
      {
        role: 'tool',
        results: [{
          toolCallId: 'call_screenshot',
          content: '截图已附加。',
          imageData: [{ mediaType: 'image/png', data: 'AQID' }],
        }],
      },
    ],
  }
}

function requestBody(request: ProviderRequest): Record<string, unknown> {
  return JSON.parse(request.body) as Record<string, unknown>
}

describe('工具截图续接', () => {
  test('given OpenAI Chat Completions screenshot result when building continuation then keeps tool result and appends a multimodal user message', () => {
    const body = requestBody(new OpenAIAdapter().buildStreamRequest(buildInput('gpt-5')))
    const messages = body.messages as Array<Record<string, unknown>>
    const toolIndex = messages.findIndex((message) => message.role === 'tool')
    const imageMessage = messages[toolIndex + 1]

    expect(messages[toolIndex]).toMatchObject({ role: 'tool', tool_call_id: 'call_screenshot', content: '截图已附加。' })
    expect(imageMessage?.role).toBe('user')
    expect(imageMessage?.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
      { type: 'text', text: '以下是工具返回的截图。请先分析画面，再继续完成当前用户目标。' },
    ])
  })

  test('given Gemini 3 screenshot result when building continuation then embeds image in functionResponse', () => {
    const input = { ...buildInput('gemini-3.6-flash'), providerType: 'google' as const }
    const body = requestBody(new GoogleAdapter().buildStreamRequest(input))
    const contents = body.contents as Array<Record<string, unknown>>
    const parts = contents.at(-1)?.parts as Array<Record<string, unknown>>
    const functionResponse = parts[0]?.functionResponse as Record<string, unknown>

    expect(functionResponse.parts).toEqual([{
      inlineData: { mimeType: 'image/png', data: 'AQID', displayName: 'tool-call_screenshot-0.png' },
    }])
    expect(functionResponse.response).toEqual({
      content: '截图已附加。',
      screenshots: [{ $ref: 'tool-call_screenshot-0.png' }],
    })
  })

  test('given Gemini 2.5 screenshot result when building continuation then appends inline image after functionResponse', () => {
    const input = { ...buildInput('gemini-2.5-flash'), providerType: 'google' as const }
    const body = requestBody(new GoogleAdapter().buildStreamRequest(input))
    const contents = body.contents as Array<Record<string, unknown>>
    const parts = contents.at(-1)?.parts as Array<Record<string, unknown>>

    expect(parts).toHaveLength(2)
    expect(parts[0]?.functionResponse).toEqual({
      name: 'call_screenshot',
      response: { content: '截图已附加。' },
    })
    expect(parts[1]).toEqual({
      inlineData: { mimeType: 'image/png', data: 'AQID', displayName: 'tool-call_screenshot-0.png' },
    })
  })
})
