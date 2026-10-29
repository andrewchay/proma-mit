import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configDir = mkdtempSync(join(tmpdir(), 'model-context-fetch-'))
process.env.PROMA_TEST_CONFIG_DIR = configDir
afterAll(() => { rmSync(configDir, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })

// channel-manager 顶层 import { safeStorage } from 'electron'，bun 环境加载失败；
// codex-oauth-service 顶层 import { shell }。替身替掉 electron 原生导出。
await mock.module('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => Buffer.from(v),
    decryptString: (v: Buffer) => v.toString(),
  },
  app: { getPath: () => '/tmp', getName: () => 'gravitas', getVersion: () => '0.0.0' },
  shell: { openExternal: async () => undefined },
}))

const { fetchModels } = await import('./channel-manager')

/**
 * 动态模型发现行为测试：
 * 订阅制 Coding Plan 端点没有公开 /models API，必须走预设清单；
 * 其余 provider 继续走协议族通用拉取。
 * 不发真实网络请求——预设分支在 fetch 之前短路返回。
 */

describe('fetchModels：订阅制预设清单', () => {
  test('qwen-token-plan 返回预设模型（不发网络请求）', async () => {
    // 传一个必然无法访问的 baseUrl：预设分支短路，不会真的 fetch
    const result = await fetchModels({
      provider: 'qwen-token-plan',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'test-key',
    } as Parameters<typeof fetchModels>[0])
    expect(result.success).toBe(true)
    expect(result.models.length).toBeGreaterThan(0)
    expect(result.models.every((m) => m.enabled)).toBe(true)
    expect(result.models.some((m) => m.id.startsWith('qwen'))).toBe(true)
  })

  test('ark-coding-plan 返回预设模型', async () => {
    const result = await fetchModels({
      provider: 'ark-coding-plan',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'test-key',
    } as Parameters<typeof fetchModels>[0])
    expect(result.success).toBe(true)
    expect(result.models.some((m) => m.id === 'doubao-seed-2.0-code')).toBe(true)
    expect(result.models.some((m) => m.id === 'glm-5.3')).toBe(true)
  })

  test('xiaomi 返回预设模型', async () => {
    const result = await fetchModels({
      provider: 'xiaomi',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'test-key',
    } as Parameters<typeof fetchModels>[0])
    expect(result.success).toBe(true)
    expect(result.models.some((m) => m.id.startsWith('mimo-'))).toBe(true)
  })

  test('未预设的 provider 不走预设分支（会尝试网络）', async () => {
    // anthropic 走通用拉取：连接 127.0.0.1:1 必然失败，返回 success: false
    const result = await fetchModels({
      provider: 'anthropic',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'test-key',
    } as Parameters<typeof fetchModels>[0])
    expect(result.success).toBe(false)
    expect(result.models).toEqual([])
  })
})


describe('fetchModels：保留窗口元数据', () => {
  test('Google inputTokenLimit、Anthropic max_input_tokens 与兼容端点 context_window 均可保留', async () => {
    const originalFetch = globalThis.fetch
    const requests: string[] = []
    globalThis.fetch = (async (request: string | URL | Request) => {
      const url = String(request)
      requests.push(url)
      return Response.json(url.includes('google.test')
        ? { models: [{ name: 'models/gemini-4-argon', inputTokenLimit: 1_048_576, supportedGenerationMethods: ['generateContent'] }] }
        : url.includes('anthropic.test')
          ? { data: [{ id: 'claude-test', max_input_tokens: 800_000 }] }
          : { data: [{ id: 'relay-alias', context_window: 600_000 }] })
    }) as typeof fetch
    try {
      for (const [provider, baseUrl, expected] of [
        ['google', 'https://google.test/v1beta', 1_048_576],
        ['anthropic', 'https://anthropic.test', 800_000],
        ['custom', 'https://relay.test/v1', 600_000],
      ] as const) {
        const result = await fetchModels({ provider, baseUrl, apiKey: 'fake-key' })
        expect(result.success).toBe(true)
        expect(result.models[0]?.contextWindow).toBe(expected)
        expect(result.models[0]?.contextWindowSource).toBe('api')
      }
      expect(requests[0]).toBe('https://google.test/v1beta/models?key=fake-key')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
