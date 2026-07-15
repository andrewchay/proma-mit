import { describe, test, expect } from 'bun:test'
import { OpenAIAdapter } from '@proma/core'
import type { StreamRequestInput } from '@proma/core'

function makeInput(providerType: string): StreamRequestInput {
  return {
    providerType: providerType as StreamRequestInput['providerType'],
    baseUrl: 'https://api.example.com',
    apiKey: 'test-key',
    modelId: 'test-model',
    history: [],
    userMessage: 'hello',
    systemMessage: 'system',
    readImageAttachments: () => [],
  }
}

describe('OpenAI 适配器', () => {
  test('OpenAI provider 请求包含 stream_options.include_usage', () => {
    const adapter = new OpenAIAdapter()
    const request = adapter.buildStreamRequest(makeInput('openai'))
    const body = JSON.parse(request.body)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  test('DeepSeek provider 请求包含 stream_options.include_usage', () => {
    const adapter = new OpenAIAdapter()
    const request = adapter.buildStreamRequest(makeInput('deepseek'))
    const body = JSON.parse(request.body)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  test('zhipu provider 请求不包含 stream_options', () => {
    const adapter = new OpenAIAdapter()
    const request = adapter.buildStreamRequest(makeInput('zhipu'))
    const body = JSON.parse(request.body)
    expect(body.stream_options).toBeUndefined()
  })

  test('doubao provider 请求不包含 stream_options', () => {
    const adapter = new OpenAIAdapter()
    const request = adapter.buildStreamRequest(makeInput('doubao'))
    const body = JSON.parse(request.body)
    expect(body.stream_options).toBeUndefined()
  })

  test('qwen provider 请求不包含 stream_options', () => {
    const adapter = new OpenAIAdapter()
    const request = adapter.buildStreamRequest(makeInput('qwen'))
    const body = JSON.parse(request.body)
    expect(body.stream_options).toBeUndefined()
  })

  test('custom provider 请求不包含 stream_options', () => {
    const adapter = new OpenAIAdapter()
    const request = adapter.buildStreamRequest(makeInput('custom'))
    const body = JSON.parse(request.body)
    expect(body.stream_options).toBeUndefined()
  })
})
