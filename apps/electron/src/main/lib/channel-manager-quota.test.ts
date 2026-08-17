import { describe, expect, test, beforeEach, afterAll, mock } from 'bun:test'
import type { Channel } from '@gravitas/shared'

// mock channel-manager 的 electron 依赖：避免真实 safeStorage。
// 注意：bun 的 mock.module('electron') 是跨文件共享的，必须同时提供其他测试文件
//（agent-session-manager / runtime-services）所需的字段，否则并发执行会互相破坏。
mock.module('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8'),
  },
  app: { isPackaged: false },
  BrowserWindow: class {},
  dialog: {},
}))

mock.module('./proxy-fetch', () => ({
  getFetchFn: () => globalThis.fetch,
}))

mock.module('./proxy-settings-service', () => ({
  getEffectiveProxyUrl: async () => undefined,
}))

function makeChannel(id: string, provider: Channel['provider'], baseUrl: string): Channel {
  return {
    id,
    name: id,
    provider,
    baseUrl,
    apiKey: 'sk-test-key',
    models: [],
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
}
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testDir = mkdtempSync(join(tmpdir(), 'proma-quota-test-'))
process.env.PROMA_TEST_CONFIG_DIR = testDir

function resetChannelsFile(): void {
  writeFileSync(
    join(testDir, 'channels.json'),
    JSON.stringify({ version: 1, channels: [] }),
  )
}

describe('getChannelPlanQuota', () => {
  beforeEach(() => {
    resetChannelsFile()
  })

  afterAll(() => {
    try { rmSync(testDir, { recursive: true, force: true }) } catch { /* ignore */ }
    delete process.env.PROMA_TEST_CONFIG_DIR
  })

  test('DeepSeek 查询 /user/balance，CNY 优先显示 ¥ 余额', async () => {
    writeFileSync(
      join(testDir, 'channels.json'),
      JSON.stringify({
        version: 1,
        channels: [makeChannel('ds', 'deepseek', 'https://api.deepseek.com/anthropic')],
      }),
    )

    let seenUrl = ''
    const origFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input)
      void init
      return Promise.resolve(new Response(JSON.stringify({
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '42.50', granted_balance: '30', topped_up_balance: '20' },
          { currency: 'USD', total_balance: '1.00' },
        ],
      }), { status: 200 }))
    }) as unknown as typeof fetch

    // 重新动态加载以绕过 mock 缓存问题
    const mod = await import('./channel-manager')
    const result = await mod.getChannelPlanQuota('ds')
    globalThis.fetch = origFetch

    expect(seenUrl).toBe('https://api.deepseek.com/user/balance')
    expect(result.supported).toBe(true)
    expect(result.provider).toBe('deepseek')
    expect(result.windows[0]).toMatchObject({
      type: 'custom',
      label: '账户余额',
      remainingLabel: '¥42.50',
    })
  })

  test('DeepSeek (OpenAI 兼容) 同样可查询 /user/balance', async () => {
    writeFileSync(
      join(testDir, 'channels.json'),
      JSON.stringify({
        version: 1,
        channels: [makeChannel('ds-oa', 'deepseek-openai', 'https://api.deepseek.com')],
      }),
    )

    let seenUrl = ''
    const origFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input)
      void init
      return Promise.resolve(new Response(JSON.stringify({
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '10.00', granted_balance: '10', topped_up_balance: '0' },
        ],
      }), { status: 200 }))
    }) as unknown as typeof fetch

    const mod = await import('./channel-manager')
    const result = await mod.getChannelPlanQuota('ds-oa')
    globalThis.fetch = origFetch

    expect(seenUrl).toBe('https://api.deepseek.com/user/balance')
    expect(result.supported).toBe(true)
    expect(result.provider).toBe('deepseek-openai')
    expect(result.windows[0]).toMatchObject({
      type: 'custom',
      label: '账户余额',
      remainingLabel: '¥10.00',
    })
  })

  test('自定义 OpenAI 兼容渠道若 Base URL 是 DeepSeek，也能查余额', async () => {
    writeFileSync(
      join(testDir, 'channels.json'),
      JSON.stringify({
        version: 1,
        channels: [makeChannel('ds-custom', 'custom', 'https://api.deepseek.com/v1')],
      }),
    )

    let seenUrl = ''
    const origFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input)
      void init
      return Promise.resolve(new Response(JSON.stringify({
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '5.00', granted_balance: '5', topped_up_balance: '0' },
        ],
      }), { status: 200 }))
    }) as unknown as typeof fetch

    const mod = await import('./channel-manager')
    const result = await mod.getChannelPlanQuota('ds-custom')
    globalThis.fetch = origFetch

    expect(seenUrl).toBe('https://api.deepseek.com/user/balance')
    expect(result.supported).toBe(true)
    expect(result.provider).toBe('deepseek')
    expect(result.windows[0]).toMatchObject({
      type: 'custom',
      label: '账户余额',
      remainingLabel: '¥5.00',
    })
  })

  test('Kimi Coding 查询 /coding/v1/usages，返回 月度/每周/5H 窗口', async () => {
    writeFileSync(
      join(testDir, 'channels.json'),
      JSON.stringify({
        version: 1,
        channels: [makeChannel('kc', 'kimi-coding', 'https://api.kimi.com/coding/v1')],
      }),
    )

    let seenUrl = ''
    const origFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input)
      void init
      return Promise.resolve(new Response(JSON.stringify({
        usage: { remaining: 80, used: 20, resetTime: 1750000000000 },
        limits: [
          { window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { remaining: 60, used: 40, resetTime: 1750000000000 } },
          { window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' }, detail: { remaining: 90, used: 10 } },
        ],
      }), { status: 200 }))
    }) as unknown as typeof fetch

    const mod = await import('./channel-manager')
    const result = await mod.getChannelPlanQuota('kc')
    globalThis.fetch = origFetch

    expect(seenUrl).toBe('https://api.kimi.com/coding/v1/usages')
    expect(result.supported).toBe(true)
    expect(result.windows).toHaveLength(3)
    // data.usage → monthly
    expect(result.windows[0]).toMatchObject({ type: 'monthly', remainingPercent: 80 })
    // 5h window
    expect(result.windows[1]).toMatchObject({ type: '5h', remainingPercent: 60 })
    // 7 day window → weekly
    expect(result.windows[2]).toMatchObject({ type: 'weekly', remainingPercent: 90 })
  })

  test('不支持的 provider（anthropic）返回 supported:false', async () => {
    writeFileSync(
      join(testDir, 'channels.json'),
      JSON.stringify({
        version: 1,
        channels: [makeChannel('an', 'anthropic', 'https://api.anthropic.com')],
      }),
    )

    const mod = await import('./channel-manager')
    const result = await mod.getChannelPlanQuota('an')
    expect(result.supported).toBe(false)
  })

  test('HTTP 失败静默降级为 supported:false', async () => {
    writeFileSync(
      join(testDir, 'channels.json'),
      JSON.stringify({
        version: 1,
        channels: [makeChannel('ds', 'deepseek', 'https://api.deepseek.com')],
      }),
    )

    const origFetch = globalThis.fetch
    globalThis.fetch = (() => Promise.resolve(new Response('unauthorized', { status: 401 }))) as unknown as typeof fetch

    const mod = await import('./channel-manager')
    const result = await mod.getChannelPlanQuota('ds')
    globalThis.fetch = origFetch
    expect(result.supported).toBe(false)
    expect(result.message).toContain('HTTP 401')
  })
})
