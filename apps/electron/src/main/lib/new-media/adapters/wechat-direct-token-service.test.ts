import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PlatformAdapterError } from '../platform-adapter'
import { loadWechatDirectCredential, saveWechatDirectCredential } from './wechat-direct-credential'
import {
  WECHAT_STABLE_TOKEN_ENDPOINT,
  WechatApiCallError,
  clearWechatTokenCache,
  getWechatAccessToken,
  getWechatTokenInFlightCount,
  withWechatAccessToken,
  type WechatTokenTransport,
} from './wechat-direct-token-service'
import { clearNewMediaRecordsForTests, closeNewMediaDb } from '../new-media-sqlite-store'

let testDir = ''
const APP_ID = 'wx1234567890abcdef'
const APP_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const REF = 'ref-token'

beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-nm-wechat-token-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { clearWechatTokenCache(); await clearNewMediaRecordsForTests() })
afterAll(() => { clearWechatTokenCache(); closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

/** 记录调用次数的假传输层。 */
function fakeTransport(responses: Array<{ status?: number; body: unknown } | (() => { status?: number; body: unknown })>) {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = []
  const transport: WechatTokenTransport = async (input) => {
    calls.push({ url: input.url, body: input.body, headers: input.headers })
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]
    const resolved = typeof next === 'function' ? next() : next
    return { status: resolved?.status ?? 200, text: async () => JSON.stringify(resolved?.body ?? {}) }
  }
  return { transport, calls }
}

function configureCredential(): void {
  saveWechatDirectCredential(REF, { appId: APP_ID, appSecret: APP_SECRET }, { accessToken: '' })
}

describe('P2-02 微信 stable token', () => {
  test('换取成功并写回加密 Store，请求体与端点符合官方约定', async () => {
    configureCredential()
    const { transport, calls } = fakeTransport([{ body: { access_token: 'TOKEN-1', expires_in: 7200 } }])
    const token = await getWechatAccessToken(REF, { dependencies: { transport, now: () => 1_000_000 } })

    expect(token.accessToken).toBe('TOKEN-1')
    expect(token.refreshed).toBe(true)
    expect(token.expiresAt).toBe(1_000_000 + 7200 * 1000)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(WECHAT_STABLE_TOKEN_ENDPOINT)
    const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>
    expect(body.grant_type).toBe('client_credential')
    expect(body.appid).toBe(APP_ID)
    expect(body.force_refresh).toBe(false)
    expect(calls[0]?.headers['content-type']).toBe('application/json')

    // token 与过期时间持久化在加密 Store，可跨进程复用
    const material = loadWechatDirectCredential(REF)
    expect(material?.accessToken).toBe('TOKEN-1')
    expect(material?.expiresAt).toBe(1_000_000 + 7200 * 1000)
  })

  test('缓存有效期内直接复用，不出网', async () => {
    configureCredential()
    const { transport, calls } = fakeTransport([{ body: { access_token: 'TOKEN-1', expires_in: 7200 } }])
    await getWechatAccessToken(REF, { dependencies: { transport, now: () => 1_000_000 } })
    const cached = await getWechatAccessToken(REF, { dependencies: { transport, now: () => 1_000_000 + 60_000 } })
    expect(cached.accessToken).toBe('TOKEN-1')
    expect(cached.refreshed).toBe(false)
    expect(calls).toHaveLength(1)
  })

  test('接近过期时按安全余量提前刷新', async () => {
    configureCredential()
    const { transport, calls } = fakeTransport([
      { body: { access_token: 'TOKEN-1', expires_in: 600 } },
      { body: { access_token: 'TOKEN-2', expires_in: 7200 } },
    ])
    await getWechatAccessToken(REF, { dependencies: { transport, now: () => 1_000_000 } })
    // 600s 有效期，安全余量 5 分钟：+400s 时已进入余量区间，必须重新换取
    const refreshed = await getWechatAccessToken(REF, { dependencies: { transport, now: () => 1_000_000 + 400_000 } })
    expect(refreshed.accessToken).toBe('TOKEN-2')
    expect(refreshed.refreshed).toBe(true)
    expect(calls).toHaveLength(2)
  })

  test('并发刷新合并为一次网络请求', async () => {
    configureCredential()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let callCount = 0
    const transport: WechatTokenTransport = async () => {
      callCount += 1
      await gate
      return { status: 200, text: async () => JSON.stringify({ access_token: 'TOKEN-SHARED', expires_in: 7200 }) }
    }
    const pending = Promise.all([
      getWechatAccessToken(REF, { dependencies: { transport } }),
      getWechatAccessToken(REF, { dependencies: { transport } }),
      getWechatAccessToken(REF, { dependencies: { transport } }),
    ])
    expect(getWechatTokenInFlightCount()).toBe(1)
    release?.()
    const tokens = await pending
    expect(tokens.map((token) => token.accessToken)).toEqual(['TOKEN-SHARED', 'TOKEN-SHARED', 'TOKEN-SHARED'])
    expect(callCount).toBe(1)
    expect(getWechatTokenInFlightCount()).toBe(0)
  })

  test('出口 IP 未加白名单时给出可诊断原因', async () => {
    configureCredential()
    const { transport } = fakeTransport([{ body: { errcode: 40164, errmsg: 'invalid ip' } }])
    const error: Error = await getWechatAccessToken(REF, { dependencies: { transport } }).then(
      () => { throw new Error('预期 token 获取失败') },
      (caught: Error) => caught,
    )
    expect(error).toBeInstanceOf(PlatformAdapterError)
    expect((error as PlatformAdapterError).code).toBe('ip_not_whitelisted')
    expect(error.message).toContain('IP 白名单')
    expect(error.message).toContain('40164')
  })

  test('凭据错误、系统繁忙与致命错误分别映射', async () => {
    configureCredential()
    const invalidAppId = fakeTransport([{ body: { errcode: 40013, errmsg: 'invalid appid' } }])
    await expect(getWechatAccessToken(REF, { dependencies: { transport: invalidAppId.transport } })).rejects.toThrow(/AppID 无效/)

    const invalidSecret = fakeTransport([{ body: { errcode: 40125, errmsg: 'invalid appsecret' } }])
    await expect(getWechatAccessToken(REF, { dependencies: { transport: invalidSecret.transport } })).rejects.toThrow(/AppSecret 无效/)

    const busy = fakeTransport([{ body: { errcode: -1, errmsg: 'system error' } }])
    await expect(getWechatAccessToken(REF, { dependencies: { transport: busy.transport } })).rejects.toThrow(/系统繁忙/)

    const unknown = fakeTransport([{ body: { errcode: 99999, errmsg: 'something odd' } }])
    await expect(getWechatAccessToken(REF, { dependencies: { transport: unknown.transport } })).rejects.toThrow(/未识别错误（errcode=99999/)

    const notJson = fakeTransport([{ body: undefined }])
    const brokenTransport: WechatTokenTransport = async () => ({ status: 502, text: async () => '<html>bad gateway</html>' })
    await expect(getWechatAccessToken(REF, { dependencies: { transport: brokenTransport } })).rejects.toThrow(/无法解析的响应（HTTP 502）/)
    expect(notJson.calls).toHaveLength(0)

    const noToken = fakeTransport([{ body: { expires_in: 7200 } }])
    await expect(getWechatAccessToken(REF, { dependencies: { transport: noToken.transport } })).rejects.toThrow(/未返回 access_token/)

    const badExpiry = fakeTransport([{ body: { access_token: 'T', expires_in: 0 } }])
    await expect(getWechatAccessToken(REF, { dependencies: { transport: badExpiry.transport } })).rejects.toThrow(/expires_in 无效/)
  })

  test('错误信息与返回值都不回显 token 或 AppSecret', async () => {
    configureCredential()
    const { transport } = fakeTransport([{ body: { errcode: 40125, errmsg: 'invalid appsecret a1b2c3d4' } }])
    const error: Error = await getWechatAccessToken(REF, { dependencies: { transport } }).then(
      () => { throw new Error('预期 token 获取失败') },
      (caught: Error) => caught,
    )
    expect(error.message).not.toContain(APP_SECRET)
    expect(error.message).not.toContain('TOKEN')

    // 请求体包含 secret（这是协议要求），但错误对象不得携带请求体
    expect(JSON.stringify(error)).not.toContain(APP_SECRET)
  })

  test('缺少凭据时明确报错，不尝试出网', async () => {
    const { transport, calls } = fakeTransport([{ body: { access_token: 'T', expires_in: 7200 } }])
    await expect(getWechatAccessToken('missing-ref', { dependencies: { transport } })).rejects.toThrow('账号授权材料缺失')
    expect(calls).toHaveLength(0)
    await expect(getWechatAccessToken('')).rejects.toThrow('凭据引用不能为空')
  })

  test('业务调用遇到 40001 只强制刷新重试一次', async () => {
    configureCredential()
    const { transport, calls } = fakeTransport([
      { body: { access_token: 'TOKEN-1', expires_in: 7200 } },
      { body: { access_token: 'TOKEN-2', expires_in: 7200 } },
    ])
    let attempts = 0
    const result = await withWechatAccessToken(REF, async (accessToken) => {
      attempts += 1
      if (attempts === 1) throw new WechatApiCallError(40001, 'invalid credential', '/cgi-bin/draft/add')
      return `ok:${accessToken}`
    }, { transport })
    expect(result).toBe('ok:TOKEN-2')
    expect(attempts).toBe(2)
    expect(calls).toHaveLength(2)

    // 非刷新类错误不重试
    let otherAttempts = 0
    await expect(withWechatAccessToken(REF, async () => {
      otherAttempts += 1
      throw new WechatApiCallError(48001, 'api unauthorized', '/cgi-bin/freepublish/submit')
    }, { transport })).rejects.toThrow(/errcode=48001/)
    expect(otherAttempts).toBe(1)
  })
})
