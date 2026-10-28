/**
 * WebFetch 工具单元测试
 *
 * 验证 URL 校验、协议限制、HTML 文本提取与错误处理。
 */

import { describe, expect, mock, test, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { executeWebFetchTool, createWebFetchToolDefinition, WEB_FETCH_TOOL_NAME } = await import('./web-fetch-tool')

const testConfigDir = mkdtempSync(join(tmpdir(), 'gravitas-web-tool-db-'))
const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = testConfigDir
  await (await import('../../project-sqlite-store')).initProjectDb()
})
afterAll(async () => {
  const { closeProjectDb } = await import('../../project-sqlite-store')
  closeProjectDb()
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
  rmSync(testConfigDir, { recursive: true, force: true })
})

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

  test('响应流超出限制时取消读取，不先缓存整页', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2_000_001)) },
      cancel() { cancelled = true },
    })
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
    const result = await executeWebFetchTool({ url: 'https://example.invalid' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('页面过大')
    expect(cancelled).toBe(true)
  })

  test('调用方已经取消时不发出网络请求', async () => {
    let calls = 0
    globalThis.fetch = (async () => { calls++; return new Response('unexpected') }) as unknown as typeof fetch
    const abort = new AbortController(); abort.abort()
    const result = await executeWebFetchTool({ url: 'https://example.invalid' }, { ...ctx, abortSignal: abort.signal })
    expect(result.isError).toBe(true)
    expect(calls).toBe(0)
  })

  test('调用方取消时停止等待未完成的响应体', async () => {
    let cancelled = false
    let signalStart = () => {}
    const started = new Promise<void>(resolve => { signalStart = resolve })
    const body = new ReadableStream<Uint8Array>({ pull() { signalStart() }, cancel() { cancelled = true } }, { highWaterMark: 0 })
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
    const abort = new AbortController()
    const pending = executeWebFetchTool({ url: 'https://example.invalid' }, { ...ctx, abortSignal: abort.signal })
    await started
    abort.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content).toContain('取消或超时')
    expect(cancelled).toBe(true)
  })

  test('HTTP 错误时返回失败信息', async () => {
    globalThis.fetch = (async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch

    const result = await executeWebFetchTool({ url: 'https://example.com/missing' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('404')
  })
})
