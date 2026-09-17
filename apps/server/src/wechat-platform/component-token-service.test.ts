import { describe, expect, test } from 'bun:test'
import { InMemoryWechatComponentTicketStore } from './ticket-store'
import {
  PostgresWechatComponentTokenCacheStore,
  WechatComponentTokenService,
  type WechatComponentTokenServiceOptions,
} from './component-token-service'

const APP_ID = 'wx1234567890abcdef'
const APP_SECRET = 'app-secret-value'
const TICKET = 'verify-ticket-abc'
const NOW = 1_700_000_000_000

class FakeResponse {
  constructor(private readonly payload: unknown, readonly status = 200) {}
  async json(): Promise<unknown> { return this.payload }
}

function makeService(overrides: Partial<WechatComponentTokenServiceOptions> = {}) {
  const logs: string[] = []
  const ticketStore = new InMemoryWechatComponentTicketStore()
  const tokenCacheStore = new MapCacheStore()
  const options: WechatComponentTokenServiceOptions = {
    componentAppId: APP_ID,
    componentAppSecret: APP_SECRET,
    ticketStore,
    tokenCacheStore,
    now: () => NOW,
    logger: {
      info: (message: string) => logs.push(`info:${message}`),
      warn: (message: string) => logs.push(`warn:${message}`),
    },
    ...overrides,
  }
  return { options, logs, ticketStore, tokenCacheStore }
}

class MapCacheStore {
  private records = new Map<string, { encryptedToken: string; expiresAt: number; acquiredAt: number }>()
  async save(record: { componentAppId: string; componentAccessToken: string; expiresAt: number; acquiredAt: number }): Promise<void> {
    this.records.set(record.componentAppId, { encryptedToken: `enc:${record.componentAccessToken}`, expiresAt: record.expiresAt, acquiredAt: record.acquiredAt })
  }
  async load(componentAppId: string) {
    const row = this.records.get(componentAppId)
    if (!row) return undefined
    return { componentAppId, componentAccessToken: row.encryptedToken.slice(4), expiresAt: row.expiresAt, acquiredAt: row.acquiredAt }
  }
  raw(componentAppId: string) { return this.records.get(componentAppId) }
}

async function withTicket(ticketStore: InMemoryWechatComponentTicketStore, ticket = TICKET): Promise<void> {
  await ticketStore.save({ componentAppId: APP_ID, ticket, receivedAt: NOW })
}

describe('P3-03 component_access_token 生命周期', () => {
  test('首次获取：读取 ticket、调用微信 API、缓存返回', async () => {
    const { options, ticketStore } = makeService()
    await withTicket(ticketStore)
    const requests: Array<{ url: string; body: unknown }> = []
    const fetchFn = async (url: string, init?: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init?.body)) })
      return new FakeResponse({ component_access_token: 'token-aaa', expires_in: 7200 }) as unknown as Response
    }
    const service = new WechatComponentTokenService({ ...options, fetchFn: fetchFn as unknown as typeof fetch })
    const token = await service.getToken()
    expect(token).toBe('token-aaa')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.weixin.qq.com/cgi-bin/component/api_component_token')
    expect(requests[0]?.body).toMatchObject({ component_appid: APP_ID, component_appsecret: APP_SECRET, component_verify_ticket: TICKET })
    expect(service.getMetrics().refreshSuccessCount).toBe(1)
    // 日志含指纹不含明文
  })

  test('缓存命中：窗口内第二次调用不再请求微信', async () => {
    const { options, ticketStore } = makeService()
    await withTicket(ticketStore)
    let callCount = 0
    const fetchFn = async () => { callCount += 1; return new FakeResponse({ component_access_token: 'token-aaa', expires_in: 7200 }) as unknown as Response }
    const service = new WechatComponentTokenService({ ...options, fetchFn: fetchFn as unknown as typeof fetch })
    await service.getToken()
    await service.getToken()
    expect(callCount).toBe(1)
    expect(service.getMetrics().cacheHitCount).toBe(1)
  })

  test('接近过期触发刷新（refreshLeadMs 内）', async () => {
    const { options, ticketStore } = makeService()
    await withTicket(ticketStore)
    let currentNow = NOW
    let callCount = 0
    const fetchFn = async () => {
      callCount += 1
      return new FakeResponse({ component_access_token: `token-${callCount}`, expires_in: 7200 }) as unknown as Response
    }
    const service = new WechatComponentTokenService({ ...options, fetchFn: fetchFn as unknown as typeof fetch, now: () => currentNow })
    const first = await service.getToken()
    expect(first).toBe('token-1')
    // 推进到过期前 5 分钟（仍在有效期内，但进入刷新窗口）
    currentNow = NOW + (7200 - 300) * 1000
    const second = await service.getToken()
    expect(second).toBe('token-2')
    expect(callCount).toBe(2)
  })

  test('单飞模式：并发刷新只触发一次微信请求', async () => {
    const { options, ticketStore } = makeService()
    await withTicket(ticketStore)
    let callCount = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetchFn = async () => {
      callCount += 1
      await gate
      return new FakeResponse({ component_access_token: 'token-shared', expires_in: 7200 }) as unknown as Response
    }
    const service = new WechatComponentTokenService({ ...options, fetchFn: fetchFn as unknown as typeof fetch })
    const pending = Promise.all([service.getToken(), service.getToken(), service.getToken()])
    release()
    const tokens = await pending
    expect(callCount).toBe(1)
    expect(tokens).toEqual(['token-shared', 'token-shared', 'token-shared'])
  })

  test('刷新失败但旧 token 有效：回退旧值并告警', async () => {
    const { options, ticketStore, logs } = makeService()
    await withTicket(ticketStore)
    let callCount = 0
    let currentNow = NOW
    const fetchFn = async () => {
      callCount += 1
      if (callCount === 1) return new FakeResponse({ component_access_token: 'token-old', expires_in: 7200 }) as unknown as Response
      return new FakeResponse({ errcode: 40001, errmsg: 'invalid credential' }) as unknown as Response
    }
    const service = new WechatComponentTokenService({ ...options, fetchFn: fetchFn as unknown as typeof fetch, now: () => currentNow })
    await service.getToken()
    // 进入刷新窗口但旧 token 未过期
    currentNow = NOW + (7200 - 300) * 1000
    const token = await service.getToken()
    expect(token).toBe('token-old')
    expect(service.getMetrics().refreshFailureCount).toBe(1)
    expect(service.getMetrics().fallbackUsedCount).toBe(1)
    expect(logs.some((line) => line.includes('回退旧 token'))).toBe(true)
  })

  test('旧 token 已过期且刷新失败：抛出错误（调用方应向上游报错）', async () => {
    const { options, ticketStore } = makeService()
    await withTicket(ticketStore)
    let currentNow = NOW
    let callCount = 0
    const fetchFn = async () => {
      callCount += 1
      if (callCount === 1) return new FakeResponse({ component_access_token: 'token-old', expires_in: 7200 }) as unknown as Response
      return new FakeResponse({ errcode: -1, errmsg: 'system busy' }) as unknown as Response
    }
    const service = new WechatComponentTokenService({ ...options, fetchFn: fetchFn as unknown as typeof fetch, now: () => currentNow })
    await service.getToken()
    currentNow = NOW + 7300 * 1000 // 已超过 7200s 有效期
    await expect(service.getToken()).rejects.toThrow(/换取失败/)
  })

  test('尚未收到 ticket：抛出明确错误而不是请求微信', async () => {
    const { options } = makeService()
    let callCount = 0
    const fetchFn = async () => { callCount += 1; return new FakeResponse({}) as unknown as Response }
    const service = new WechatComponentTokenService({ ...options, fetchFn: fetchFn as unknown as typeof fetch })
    await expect(service.getToken()).rejects.toThrow(/尚未收到 component_verify_ticket/)
    expect(callCount).toBe(0)
  })

  test('微信返回异常结构：计数失败且不缓存', async () => {
    const { options, ticketStore } = makeService()
    await withTicket(ticketStore)
    const fetchFn = async () => new FakeResponse({ errcode: 40013, errmsg: 'invalid appid' }) as unknown as Response
    const service = new WechatComponentTokenService({ ...options, fetchFn: fetchFn as unknown as typeof fetch })
    await expect(service.getToken()).rejects.toThrow(/errcode=40013/)
    expect(service.getMetrics().refreshFailureCount).toBe(1)
    expect(await options.tokenCacheStore.load(APP_ID)).toBeUndefined()
  })

  test('token 落库为密文且不含明文（Postgres 缓存）', async () => {
    const statements: Array<{ statement: string; params: readonly unknown[] }> = []
    const client = {
      query: async <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[] = []): Promise<{ rows: Row[] }> => {
        statements.push({ statement, params })
        return { rows: [] as Row[] }
      },
    }
    const key = new Uint8Array(32).fill(3)
    const store = new PostgresWechatComponentTokenCacheStore(client, key)
    await store.initializeSchema()
    await store.save({ componentAppId: APP_ID, componentAccessToken: 'super-secret-token', expiresAt: NOW + 7000_000, acquiredAt: NOW })
    const insert = statements.find((item) => item.statement.startsWith('INSERT'))
    expect(String(insert?.params[1])).not.toContain('super-secret-token')
    expect(String(insert?.params[1])).toContain('v1.')
  })

  test('日志与指标不含 token 明文', async () => {
    const { options, ticketStore, logs } = makeService()
    await withTicket(ticketStore, 'leak-me-not-ticket')
    const fetchFn = async () => new FakeResponse({ component_access_token: 'leak-me-not-token', expires_in: 7200 }) as unknown as Response
    const service = new WechatComponentTokenService({ ...options, fetchFn: fetchFn as unknown as typeof fetch })
    const token = await service.getToken()
    expect(token).toBe('leak-me-not-token')
    const allLogs = logs.join('\n')
    expect(allLogs).not.toContain('leak-me-not-token')
    expect(allLogs).not.toContain('leak-me-not-ticket')
    expect(allLogs).toContain('指纹=')
  })
})
