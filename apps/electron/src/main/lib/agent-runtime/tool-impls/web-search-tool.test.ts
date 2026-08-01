/**
 * WebSearch 工具单元测试
 *
 * 验证双后端（Tavily / MetaSo）的路由、请求格式与结果格式化。
 * 通过 mock.module 隔离凭据配置，避免读取真实 ~/.proma/chat-tools.json。
 */

import { describe, expect, mock, test, beforeEach, afterEach } from 'bun:test'
import type { WebSearchCredentials } from './web-search-tool'

let mockCredentials: WebSearchCredentials = {}
mock.module('../../chat-tool-config', () => ({
  getToolCredentials: (toolId: string) => (toolId === 'web-search' ? mockCredentials : {}),
}))

const {
  executeWebSearchTool,
  createWebSearchToolDefinition,
  resolveWebSearchProvider,
  WEB_SEARCH_TOOL_NAME,
} = await import('./web-search-tool')

describe('WebSearch 工具', () => {
  const ctx = { cwd: '/tmp/workspace', sessionId: 'test-session' }
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    mockCredentials = { apiKey: 'test-tavily-key' }
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('工具定义包含名称与必填参数', () => {
    const def = createWebSearchToolDefinition()
    expect(def.name).toBe(WEB_SEARCH_TOOL_NAME)
    expect(def.parameters.required).toContain('query')
  })

  // ===== provider 路由 =====

  test('provider 解析：默认 Tavily', () => {
    expect(resolveWebSearchProvider({ apiKey: 'k' })).toBe('tavily')
    expect(resolveWebSearchProvider({})).toBe('tavily')
  })

  test('provider 解析：只配 MetaSo key 时自动用 MetaSo', () => {
    expect(resolveWebSearchProvider({ metasoApiKey: 'mk' })).toBe('metaso')
  })

  test('provider 解析：显式指定覆盖自动选择', () => {
    expect(resolveWebSearchProvider({ apiKey: 'k', metasoApiKey: 'mk', provider: 'metaso' })).toBe('metaso')
    expect(resolveWebSearchProvider({ metasoApiKey: 'mk', provider: 'tavily' })).toBe('tavily')
  })

  // ===== Tavily =====

  test('未配置任何 API Key 时返回可读错误', async () => {
    mockCredentials = {}
    const result = await executeWebSearchTool({ query: '上海天气' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('未配置 API Key')
  })

  test('缺少 query 参数时返回错误', async () => {
    const result = await executeWebSearchTool({}, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('query')
  })

  test('Tavily 成功搜索时格式化结果包含概要', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      answer: '上海今天多云，气温 28°C。',
      results: [
        { title: '上海天气', url: 'https://example.com/weather', content: '今日多云转晴。' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch

    const result = await executeWebSearchTool({ query: '上海今天天气' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('上海今天多云')
    expect(result.content).toContain('https://example.com/weather')
  })

  test('Tavily 返回非 200 时透传错误', async () => {
    globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch

    const result = await executeWebSearchTool({ query: '测试' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('429')
  })

  // ===== MetaSo =====

  test('MetaSo：只配 metasoApiKey 时发送 Bearer 认证与正确请求体', async () => {
    mockCredentials = { metasoApiKey: 'mk-test-key' }
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedInit = init
      return new Response(JSON.stringify({ webpages: [], total: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    const result = await executeWebSearchTool({ query: '上海天气' }, ctx)

    expect(capturedUrl).toBe('https://metaso.cn/api/v1/search')
    const headers = capturedInit?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer mk-test-key')
    expect(headers['Content-Type']).toContain('application/json')
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>
    expect(body.q).toBe('上海天气')
    expect(body.scope).toBe('webpage')
    expect(result.isError).toBeFalsy()
  })

  test('MetaSo：显式 provider 指定时走 MetaSo', async () => {
    mockCredentials = { apiKey: 'tavily-key', metasoApiKey: 'mk-key', provider: 'metaso' }
    let capturedUrl = ''
    globalThis.fetch = (async (url: unknown) => {
      capturedUrl = String(url)
      return new Response(JSON.stringify({ webpages: [], total: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    await executeWebSearchTool({ query: '测试' }, ctx)
    expect(capturedUrl).toBe('https://metaso.cn/api/v1/search')
  })

  test('MetaSo：未配置 metasoApiKey 时返回配置提示', async () => {
    mockCredentials = { provider: 'metaso' }
    const result = await executeWebSearchTool({ query: '测试' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('MetaSo 搜索未配置 API Key')
  })

  test('MetaSo：格式化 webpages 结果', async () => {
    mockCredentials = { metasoApiKey: 'mk-key' }
    globalThis.fetch = (async () => new Response(JSON.stringify({
      total: 20,
      webpages: [
        {
          title: '上海天气预报',
          link: 'https://example.com/shanghai-weather',
          snippet: '今日多云 29℃—37℃ |||',
          position: 1,
          date: '2026年08月01日',
          authors: ['上海市气象台'],
          authorityDomain: 'example.com',
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch

    const result = await executeWebSearchTool({ query: '上海天气' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('上海天气预报')
    expect(result.content).toContain('https://example.com/shanghai-weather')
    expect(result.content).toContain('今日多云')
    expect(result.content).toContain('上海市气象台')
    expect(result.content).toContain('共 20 条')
  })

  test('MetaSo：无结果时返回空提示', async () => {
    mockCredentials = { metasoApiKey: 'mk-key' }
    globalThis.fetch = (async () => new Response(JSON.stringify({ webpages: [], total: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch

    const result = await executeWebSearchTool({ query: '不存在的查询' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('未找到相关结果')
  })
})
