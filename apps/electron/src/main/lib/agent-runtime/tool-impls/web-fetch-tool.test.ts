/**
 * WebFetch 工具单元测试
 *
 * 验证 URL 校验、协议限制、HTML 文本提取与错误处理。
 */

import { describe, expect, mock, test, beforeEach, afterEach } from 'bun:test'

const { executeWebFetchTool, createWebFetchToolDefinition, WEB_FETCH_TOOL_NAME } = await import('./web-fetch-tool')

describe('WebFetch 工具', () => {
  const ctx = { cwd: '/tmp/workspace', sessionId: 'test-session' }
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('工具定义包含名称与必填参数', () => {
    const def = createWebFetchToolDefinition()
    expect(def.name).toBe(WEB_FETCH_TOOL_NAME)
    expect(def.parameters.required).toContain('url')
  })

  test('缺少 url 参数时返回错误', async () => {
    const result = await executeWebFetchTool({}, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('url')
  })

  test('拒绝非 http/https 协议', async () => {
    const result = await executeWebFetchTool({ url: 'file:///etc/passwd' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('不支持的协议')
  })

  test('无效 URL 返回错误', async () => {
    const result = await executeWebFetchTool({ url: 'not a url' }, ctx)
    expect(result.isError).toBe(true)
  })

  test('抓取 HTML 并提取可读文本', async () => {
    globalThis.fetch = (async () => new Response(
      '<html><head><style>.x{color:red}</style></head><body><h1>标题</h1><p>这是一段正文内容。</p><script>alert(1)</script></body></html>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    )) as unknown as typeof fetch

    const result = await executeWebFetchTool({ url: 'https://example.com/article' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('标题')
    expect(result.content).toContain('这是一段正文内容')
    expect(result.content).not.toContain('script')
  })

  test('非 HTML 内容直接返回文本', async () => {
    globalThis.fetch = (async () => new Response(
      '{"ok":true,"data":1}',
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch

    const result = await executeWebFetchTool({ url: 'https://api.example.com/data' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('{"ok":true')
  })

  test('HTTP 错误时返回失败信息', async () => {
    globalThis.fetch = (async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch

    const result = await executeWebFetchTool({ url: 'https://example.com/missing' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('404')
  })
})
