import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const originalConfig = await import('../../chat-tool-config')
mock.module('../../chat-tool-config', () => ({ ...originalConfig, getToolCredentials: () => ({ apiKey: 'fake' }) }))
const { executeWebFetchTool } = await import('./web-fetch-tool')
const { executeWebSearchTool } = await import('./web-search-tool')
const store = await import('../../project-sqlite-store')
const directory = mkdtempSync(join(tmpdir(), 'network-gate-')), previous = process.env.PROMA_TEST_CONFIG_DIR, originalFetch = globalThis.fetch
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = directory; await store.initProjectDb() })
afterAll(() => { globalThis.fetch = originalFetch; store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })

test('Given 响应等待期间账本失效 When 网络工具完成 Then 不返回响应内容', async () => {
  for (const kind of ['fetch', 'search'] as const) {
    await store.initProjectDb()
    let finish!: (value: Response) => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    globalThis.fetch = (async () => { started(); return new Promise<Response>(resolve => { finish = resolve }) }) as unknown as typeof fetch
    const ctx = { cwd: directory, sessionId: 'ordinary' }
    const pending = kind === 'fetch' ? executeWebFetchTool({ url: 'https://example.invalid' }, ctx) : executeWebSearchTool({ query: '测试' }, ctx)
    await ready
    store.closeProjectDb()
    finish(new Response(kind === 'fetch' ? '私有响应' : JSON.stringify({ answer: '私有响应', results: [] })))
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content).not.toContain('私有响应')
  }
})
