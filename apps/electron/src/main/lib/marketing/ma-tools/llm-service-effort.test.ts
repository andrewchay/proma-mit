/**
 * LLM 服务的推理强度透传测试。
 *
 * 只验证「请求体里 effort 落在正确字段」这一层，
 * 不验证模型真实行为（那需要真实 API Key，不适合单测）。
 *
 * 两套协议字段不同：
 * - Anthropic 兼容（GLM/DeepSeek）：output_config.effort
 * - OpenAI 兼容（智谱）：reasoning_effort
 * 传错字段不会报错，只会静默失效——所以必须锁住。
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test'

/** 捕获 fetch 收到的请求体 */
let capturedBody: Record<string, unknown> | null = null
let capturedUrl = ''

const fakeFetch = (async (url: string, init?: RequestInit) => {
  capturedUrl = String(url)
  capturedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: '{"reply":"好的"}' } }],
      content: [{ type: 'text', text: '{"reply":"好的"}' }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}) as typeof fetch

// 渠道模拟：通过 mock 让 complete() 走指定 provider 分支
let mockProvider: 'anthropic' | 'openai' = 'anthropic'

mock.module('../../channel-manager', () => ({
  listChannels: () => [
    {
      id: 'test-channel',
      provider: mockProvider,
      baseUrl: 'https://example.test/v1',
      models: [{ id: 'glm-5.3', enabled: true }],
    },
  ],
  decryptApiKey: () => 'test-key',
}))

mock.module('../../proxy-fetch', () => ({
  getFetchFn: () => fakeFetch,
}))

mock.module('../../proxy-settings-service', () => ({
  getEffectiveProxyUrl: () => null,
}))

describe('LLM 推理强度透传', () => {
  beforeEach(() => {
    capturedBody = null
    capturedUrl = ''
  })

  it('Anthropic 兼容端点：effort 落在 output_config.effort', async () => {
    mockProvider = 'anthropic'
    const { complete } = await import('./llm-service')

    await complete([{ role: 'user', content: '写一句回复' }], {
      modelId: 'glm-5.3',
      effort: 'low',
    })

    expect(capturedUrl).toContain('/messages')
    expect(capturedBody).not.toBeNull()
    expect((capturedBody!.output_config as { effort?: string } | undefined)?.effort).toBe('low')
  })

  it('OpenAI 兼容端点：effort 落在顶层 reasoning_effort', async () => {
    mockProvider = 'openai'
    const { complete } = await import('./llm-service')

    await complete([{ role: 'user', content: '写一句回复' }], {
      modelId: 'glm-5.3',
      effort: 'low',
    })

    expect(capturedUrl).toContain('/chat/completions')
    expect(capturedBody!.reasoning_effort).toBe('low')
  })

  it('不传 effort 时请求体不含该字段（用模型默认值）', async () => {
    mockProvider = 'anthropic'
    const { complete } = await import('./llm-service')

    await complete([{ role: 'user', content: '写一句回复' }], { modelId: 'glm-5.3' })

    expect(capturedBody!.output_config).toBeUndefined()
  })

  it('effort=high 同样透传', async () => {
    mockProvider = 'anthropic'
    const { complete } = await import('./llm-service')

    await complete([{ role: 'user', content: 'x' }], { modelId: 'glm-5.3', effort: 'high' })

    expect((capturedBody!.output_config as { effort?: string } | undefined)?.effort).toBe('high')
  })
})
