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

  test('usage 映射扣减 cached_tokens，避免缓存双计', () => {
    const adapter = new OpenAIAdapter()
    const events = adapter.parseSSELine(JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1500, completion_tokens: 100, total_tokens: 1600, prompt_tokens_details: { cached_tokens: 1000 } },
    }))
    const usageEvent = events.find((e) => e.type === 'usage')
    expect(usageEvent).toBeDefined()
    const usage = (usageEvent as { usage: { input_tokens?: number; cache_read_input_tokens?: number } }).usage
    // prompt_tokens(1500) 已含缓存，input_tokens 扣减 cached(1000) → 500
    expect(usage.input_tokens).toBe(500)
    // cache_read 单独携带缓存命中
    expect(usage.cache_read_input_tokens).toBe(1000)
    // input + cache_read = 原始 prompt_tokens，不重复
    expect(usage.input_tokens! + (usage.cache_read_input_tokens ?? 0)).toBe(1500)
  })

  test('usage 映射无 cached_tokens 时保持原值', () => {
    const adapter = new OpenAIAdapter()
    const events = adapter.parseSSELine(JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 800, completion_tokens: 50, total_tokens: 850 },
    }))
    const usageEvent = events.find((e) => e.type === 'usage')
    const usage = (usageEvent as { usage: { input_tokens?: number; cache_read_input_tokens?: number } }).usage
    expect(usage.input_tokens).toBe(800)
    expect(usage.cache_read_input_tokens).toBeUndefined()
  })
})
