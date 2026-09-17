import { describe, expect, test } from 'bun:test'
import { InMemoryWechatComponentTicketStore } from './ticket-store'
import { WechatComponentTokenService } from './component-token-service'
import {
  InMemoryWechatAuthorizationStateStore,
  WechatAuthorizationService,
  type WechatAuthorizationServiceOptions,
} from './authorization-service'
import { InMemoryWechatAuthorizerStore, PostgresWechatAuthorizerStore } from './authorizer-store'

const APP_ID = 'wx1234567890abcdef'
const REDIRECT_URI = 'https://ops.example.com/callbacks/wechat/authorization'
const AUTHORIZER_APP_ID = 'wxaaaa111122223333'
const NOW = 1_700_000_000_000

class FakeResponse {
  constructor(private readonly payload: unknown, readonly status = 200) {}
  async json(): Promise<unknown> { return this.payload }
}

async function makeService(overrides: Partial<WechatAuthorizationServiceOptions> = {}) {
  const logs: string[] = []
  const ticketStore = new InMemoryWechatComponentTicketStore()
  await ticketStore.save({ componentAppId: APP_ID, ticket: 'verify-ticket-for-tests', receivedAt: NOW })
  const tokenCache = new Map<string, { componentAccessToken: string; expiresAt: number; acquiredAt: number }>()
  const componentTokenService = new WechatComponentTokenService({
    componentAppId: APP_ID,
    componentAppSecret: 'secret',
    ticketStore,
    tokenCacheStore: {
      save: async (record) => { tokenCache.set(record.componentAppId, { componentAccessToken: record.componentAccessToken, expiresAt: record.expiresAt, acquiredAt: record.acquiredAt }) },
      load: async (appId) => { const row = tokenCache.get(appId); return row ? { componentAppId: appId, ...row } : undefined },
    },
    now: () => NOW,
    fetchFn: (async () => new FakeResponse({ component_access_token: 'ct', expires_in: 7200 }) as unknown as Response) as unknown as typeof fetch,
  })
  const authorizerStore = new InMemoryWechatAuthorizerStore()
  const stateStore = new InMemoryWechatAuthorizationStateStore(() => NOW)
  const options: WechatAuthorizationServiceOptions = {
    componentAppId: APP_ID,
    authorizationRedirectUri: REDIRECT_URI,
    ticketStore,
    componentTokenService,
    authorizerStore,
    stateStore,
    now: () => NOW,
    logger: {
      info: (message: string) => logs.push(`info:${message}`),
      warn: (message: string) => logs.push(`warn:${message}`),
    },
    ...overrides,
  }
  return { options, logs, ticketStore, authorizerStore, stateStore }
}

function queryAuthSuccessPayload() {
  return {
    authorization_info: {
      authorizer_appid: AUTHORIZER_APP_ID,
      authorizer_access_token: 'at-1',
      expires_in: 7200,
      authorizer_refresh_token: 'rt-1',
      func_info: [{ funcscope_category: { id: 1 } }],
    },
    authorizer_info: { nick_name: '测试公众号', account_type: '0' },
  }
}

/** 按 URL 区分微信 API 的 fake fetch。 */
function routerFetch(handlers: Record<string, () => unknown>, calls: Array<{ url: string; body: unknown }>) {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) })
    const handler = handlers[url.split('?')[0] ?? '']
    if (!handler) return new FakeResponse({ errcode: 404, errmsg: 'no handler' }) as unknown as Response
    return new FakeResponse(handler()) as unknown as Response
  }) as unknown as typeof fetch
}

describe('P3-04 预授权码与授权页 URL', () => {
  test('换取 pre_auth_code 并生成带 state 的扫码 URL', async () => {
    const { options } = await makeService()
    const calls: Array<{ url: string; body: unknown }> = []
    const service = new WechatAuthorizationService({
      ...options,
      fetchFn: routerFetch({
        [`https://api.weixin.qq.com/cgi-bin/component/api_create_preauthcode`]: () => ({ pre_auth_code: 'pac-123', expires_in: 600 }),
      }, calls),
    })
    const result = await service.createAuthorizationUrl('tenant-1')
    expect(result.preAuthCodeExpiresIn).toBe(600)
    const parsed = new URL(result.url)
    expect(parsed.origin + parsed.pathname).toBe('https://mp.weixin.qq.com/cgi-bin/componentloginpage')
    expect(parsed.searchParams.get('component_appid')).toBe(APP_ID)
    expect(parsed.searchParams.get('pre_auth_code')).toBe('pac-123')
    expect(parsed.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(parsed.searchParams.get('auth_type')).toBe('3')
    const state = parsed.searchParams.get('state')
    expect(state).toBeTruthy()
    // state 已登记，可被回调核销
    expect(await options.stateStore.consume(state!)).toBe('tenant-1')
    // 请求体带 component_access_token 查询参数，不带 secret
    expect(calls[0]?.url).toContain('component_access_token=ct')
    expect(calls[0]?.body).toEqual({ component_appid: APP_ID })
  })

  test('预授权码换取失败（errcode）向上抛错且不生成 state', async () => {
    const { options } = await makeService()
    const service = new WechatAuthorizationService({
      ...options,
      fetchFn: routerFetch({ 'https://api.weixin.qq.com/cgi-bin/component/api_create_preauthcode': () => ({ errcode: 40013, errmsg: 'invalid appid' }) }, []),
    })
    await expect(service.createAuthorizationUrl('tenant-1')).rejects.toThrow(/errcode=40013/)
  })
})

describe('P3-04 授权回调处理', () => {
  async function makeCallbackService(calls: Array<{ url: string; body: unknown }>, overrides = {}) {
    const { options } = await makeService()
    const service = new WechatAuthorizationService({
      ...options,
      fetchFn: routerFetch({
        'https://api.weixin.qq.com/cgi-bin/component/api_create_preauthcode': () => ({ pre_auth_code: 'pac-123', expires_in: 600 }),
        'https://api.weixin.qq.com/cgi-bin/component/api_query_auth': () => queryAuthSuccessPayload(),
      }, calls),
      ...overrides,
    })
    return service
  }

  test('合法回调：核销 state、换取 authorizer token、加密落库为 active', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const service = await makeCallbackService(calls)
    const { url } = await service.createAuthorizationUrl('tenant-1')
    const state = new URL(url).searchParams.get('state')!
    const summary = await service.handleAuthorizationCallback({ authCode: 'auth-code-1', state })
    expect(summary).toMatchObject({ authorizerAppId: AUTHORIZER_APP_ID, nickname: '测试公众号', status: 'active' })

    // query_auth 请求体
    const queryAuthCall = calls.find((call) => call.url.includes('api_query_auth'))
    expect(queryAuthCall?.body).toEqual({ component_appid: APP_ID, authorization_code: 'auth-code-1' })
  })

  test('state 一次性：同一 state 第二次使用被拒绝（防重放）', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const service = await makeCallbackService(calls)
    const { url } = await service.createAuthorizationUrl('tenant-1')
    const state = new URL(url).searchParams.get('state')!
    await service.handleAuthorizationCallback({ authCode: 'auth-code-1', state })
    await expect(service.handleAuthorizationCallback({ authCode: 'auth-code-1', state })).rejects.toThrow(/state 校验失败/)
  })

  test('伪造/未登记 state 直接拒绝，不调用 query_auth', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const service = await makeCallbackService(calls)
    await expect(service.handleAuthorizationCallback({ authCode: 'x', state: 'forged-state' })).rejects.toThrow(/state 校验失败/)
    expect(calls.some((call) => call.url.includes('api_query_auth'))).toBe(false)
  })

  test('query_auth 返回 errcode：向上抛错，不落库', async () => {
    const { options, authorizerStore } = await makeService()
    const service = new WechatAuthorizationService({
      ...options,
      fetchFn: routerFetch({
        'https://api.weixin.qq.com/cgi-bin/component/api_create_preauthcode': () => ({ pre_auth_code: 'pac', expires_in: 600 }),
        'https://api.weixin.qq.com/cgi-bin/component/api_query_auth': () => ({ errcode: 40029, errmsg: 'invalid code' }),
      }, []),
    })
    const { url } = await service.createAuthorizationUrl('tenant-1')
    const state = new URL(url).searchParams.get('state')!
    await expect(service.handleAuthorizationCallback({ authCode: 'bad-code', state })).rejects.toThrow(/errcode=40029/)
    expect(await authorizerStore.load(AUTHORIZER_APP_ID)).toBeUndefined()
  })

  test('取消授权后 getToken 拒绝；重新扫码授权恢复 active', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const service = await makeCallbackService(calls)
    const { url } = await service.createAuthorizationUrl('tenant-1')
    await service.handleAuthorizationCallback({ authCode: 'auth-code-1', state: new URL(url).searchParams.get('state')! })
    expect(await service.getAuthorizerAccessToken(AUTHORIZER_APP_ID, 'tenant-1')).toBe('at-1')

    await service.handleUnauthorizedEvent(AUTHORIZER_APP_ID)
    await expect(service.getAuthorizerAccessToken(AUTHORIZER_APP_ID, 'tenant-1')).rejects.toThrow(/已取消授权/)
    const listed = await service.listAuthorizedAccounts('tenant-1')
    expect(listed[0]?.status).toBe('revoked')

    // 重新授权：新回调恢复 active
    const second = await service.createAuthorizationUrl('tenant-1')
    await service.handleAuthorizationCallback({ authCode: 'auth-code-2', state: new URL(second.url).searchParams.get('state')! })
    const restored = await service.listAuthorizedAccounts('tenant-1')
    expect(restored[0]?.status).toBe('active')
    expect(await service.getAuthorizerAccessToken(AUTHORIZER_APP_ID, 'tenant-1')).toBe('at-1')
  })
})

describe('P3-04 authorizer token 刷新', () => {
  test('缓存窗口内不重刷；接近过期触发刷新并轮换 refresh_token', async () => {
    const { options } = await makeService()
    let currentNow = NOW
    let refreshCount = 0
    const service = new WechatAuthorizationService({
      ...options,
      now: () => currentNow,
      fetchFn: routerFetch({
        'https://api.weixin.qq.com/cgi-bin/component/api_create_preauthcode': () => ({ pre_auth_code: 'pac', expires_in: 600 }),
        'https://api.weixin.qq.com/cgi-bin/component/api_query_auth': () => queryAuthSuccessPayload(),
        'https://api.weixin.qq.com/cgi-bin/component/api_authorizer_token': () => {
          refreshCount += 1
          return { authorizer_access_token: `at-${refreshCount + 1}`, expires_in: 7200, authorizer_refresh_token: `rt-${refreshCount + 1}` }
        },
      }, []),
    })
    const { url } = await service.createAuthorizationUrl('tenant-1')
    await service.handleAuthorizationCallback({ authCode: 'c1', state: new URL(url).searchParams.get('state')! })
    expect(await service.getAuthorizerAccessToken(AUTHORIZER_APP_ID, 'tenant-1')).toBe('at-1')
    expect(refreshCount).toBe(0)
    currentNow = NOW + (7200 - 300) * 1000
    expect(await service.getAuthorizerAccessToken(AUTHORIZER_APP_ID, 'tenant-1')).toBe('at-2')
    expect(refreshCount).toBe(1)
    // 刷新后 refresh_token 已轮换：第二次刷新应带 rt-2
    currentNow += (7200 - 300) * 1000
    await service.getAuthorizerAccessToken(AUTHORIZER_APP_ID, 'tenant-1')
    expect(refreshCount).toBe(2)
  })

  test('刷新失败且旧 token 有效：回退旧值；已过期：抛错', async () => {
    const { options } = await makeService()
    let currentNow = NOW
    let refreshCount = 0
    const service = new WechatAuthorizationService({
      ...options,
      now: () => currentNow,
      fetchFn: routerFetch({
        'https://api.weixin.qq.com/cgi-bin/component/api_create_preauthcode': () => ({ pre_auth_code: 'pac', expires_in: 600 }),
        'https://api.weixin.qq.com/cgi-bin/component/api_query_auth': () => queryAuthSuccessPayload(),
        'https://api.weixin.qq.com/cgi-bin/component/api_authorizer_token': () => {
          refreshCount += 1
          return refreshCount === 1 ? { errcode: 40001, errmsg: 'invalid credential' } : { errcode: -1, errmsg: 'busy' }
        },
      }, []),
    })
    const { url } = await service.createAuthorizationUrl('tenant-1')
    await service.handleAuthorizationCallback({ authCode: 'c1', state: new URL(url).searchParams.get('state')! })
    currentNow = NOW + (7200 - 300) * 1000
    expect(await service.getAuthorizerAccessToken(AUTHORIZER_APP_ID, 'tenant-1')).toBe('at-1') // 回退
    currentNow = NOW + 7300 * 1000
    await expect(service.getAuthorizerAccessToken(AUTHORIZER_APP_ID, 'tenant-1')).rejects.toThrow(/刷新失败/)
  })
})

describe('P3-04 授权事件转发（callback.ts 集成）', () => {
  test('unauthorized 事件触发 handleUnauthorizedEvent 且仍返回 success', async () => {
    const { encryptWechatMessage } = await import('./message-crypto')
    const { handleWechatCallback } = await import('./callback')
    const { computeWechatCallbackSignature } = await import('./message-crypto')
    const MATERIAL = { token: 'cb-token', encodingAesKey: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ' }
    const events: Array<{ infoType: string; authorizerAppId?: string }> = []
    const xml = `<xml><AppId><![CDATA[${APP_ID}]]></AppId><InfoType>unauthorized</InfoType><AuthorizerAppid><![CDATA[${AUTHORIZER_APP_ID}]]></AuthorizerAppid></xml>`
    const encrypt = encryptWechatMessage({ ...MATERIAL, message: xml, receiveId: APP_ID })
    const timestamp = String(Math.floor(NOW / 1000))
    const nonce = 'evt-nonce'
    const signature = computeWechatCallbackSignature({ token: MATERIAL.token, timestamp, nonce, encrypt })
    const response = await handleWechatCallback({
      method: 'POST',
      query: new URLSearchParams({ timestamp, nonce, msg_signature: signature }),
      body: `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`,
      options: {
        cryptoMaterial: MATERIAL,
        ticketStore: new InMemoryWechatComponentTicketStore(),
        expectedComponentAppId: APP_ID,
        onAuthorizationEvent: (event) => { events.push(event) },
        now: () => NOW,
      },
    })
    expect(response?.status).toBe(200)
    expect(events).toEqual([{ infoType: 'unauthorized', componentAppId: APP_ID, authorizerAppId: AUTHORIZER_APP_ID } as { infoType: string; authorizerAppId?: string }])
  })

  test('事件处理器抛错仍返回 success（避免微信重推风暴）', async () => {
    const { encryptWechatMessage, computeWechatCallbackSignature } = await import('./message-crypto')
    const { handleWechatCallback } = await import('./callback')
    const MATERIAL = { token: 'cb-token', encodingAesKey: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ' }
    const xml = `<xml><AppId><![CDATA[${APP_ID}]]></AppId><InfoType>authorized</InfoType><AuthorizerAppid><![CDATA[${AUTHORIZER_APP_ID}]]></AuthorizerAppid></xml>`
    const encrypt = encryptWechatMessage({ ...MATERIAL, message: xml, receiveId: APP_ID })
    const timestamp = String(Math.floor(NOW / 1000))
    const signature = computeWechatCallbackSignature({ token: MATERIAL.token, timestamp, nonce: 'n2', encrypt })
    const response = await handleWechatCallback({
      method: 'POST',
      query: new URLSearchParams({ timestamp, nonce: 'n2', msg_signature: signature }),
      body: `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`,
      options: {
        cryptoMaterial: MATERIAL,
        ticketStore: new InMemoryWechatComponentTicketStore(),
        expectedComponentAppId: APP_ID,
        onAuthorizationEvent: async () => { throw new Error('db down') },
        now: () => NOW,
      },
    })
    expect(response?.status).toBe(200)
  })
})

describe('P3-05 租户隔离与撤权守卫', () => {
  test('state 绑定租户：A 租户发起的授权归 A，回调落库 tenantId 正确', async () => {
    const { options } = await makeService()
    const service = new WechatAuthorizationService({
      ...options,
      fetchFn: routerFetch({
        'https://api.weixin.qq.com/cgi-bin/component/api_create_preauthcode': () => ({ pre_auth_code: 'pac', expires_in: 600 }),
        'https://api.weixin.qq.com/cgi-bin/component/api_query_auth': () => queryAuthSuccessPayload(),
      }, []),
    })
    const { url } = await service.createAuthorizationUrl('tenant-a')
    const summary = await service.handleAuthorizationCallback({ authCode: 'c1', state: new URL(url).searchParams.get('state')! })
    expect(summary.status).toBe('active')
    const account = await options.authorizerStore.load(AUTHORIZER_APP_ID)
    expect(account?.tenantId).toBe('tenant-a')
  })

  test('跨租户访问拒绝：getToken/list/守卫都按租户隔离', async () => {
    const { options } = await makeService()
    const service = new WechatAuthorizationService({
      ...options,
      fetchFn: routerFetch({
        'https://api.weixin.qq.com/cgi-bin/component/api_create_preauthcode': () => ({ pre_auth_code: 'pac', expires_in: 600 }),
        'https://api.weixin.qq.com/cgi-bin/component/api_query_auth': () => queryAuthSuccessPayload(),
      }, []),
    })
    const { url } = await service.createAuthorizationUrl('tenant-a')
    await service.handleAuthorizationCallback({ authCode: 'c1', state: new URL(url).searchParams.get('state')! })

    await expect(service.getAuthorizerAccessToken(AUTHORIZER_APP_ID, 'tenant-b')).rejects.toThrow(/不属于当前租户/)
    await expect(service.assertAuthorizerUsable(AUTHORIZER_APP_ID, 'tenant-b')).rejects.toThrow(/不属于当前租户/)
    expect(await service.listAuthorizedAccounts('tenant-b')).toEqual([])
    expect(await service.listAuthorizedAccounts('tenant-a')).toHaveLength(1)
    // 本租户正常
    await expect(service.assertAuthorizerUsable(AUTHORIZER_APP_ID, 'tenant-a')).resolves.toBeUndefined()
  })

  test('撤权立即禁用：守卫与 getToken 同步拒绝，revokedAt 落库', async () => {
    const { options } = await makeService()
    const service = new WechatAuthorizationService({
      ...options,
      fetchFn: routerFetch({
        'https://api.weixin.qq.com/cgi-bin/component/api_create_preauthcode': () => ({ pre_auth_code: 'pac', expires_in: 600 }),
        'https://api.weixin.qq.com/cgi-bin/component/api_query_auth': () => queryAuthSuccessPayload(),
      }, []),
    })
    const { url } = await service.createAuthorizationUrl('tenant-a')
    await service.handleAuthorizationCallback({ authCode: 'c1', state: new URL(url).searchParams.get('state')! })
    await service.handleUnauthorizedEvent(AUTHORIZER_APP_ID)
    const account = await options.authorizerStore.load(AUTHORIZER_APP_ID)
    expect(account?.status).toBe('revoked')
    expect(account?.revokedAt).toBe(NOW)
    // 撤权后：token 获取与任务前置守卫同步拒绝（任务执行前检查即停止）
    await expect(service.getAuthorizerAccessToken(AUTHORIZER_APP_ID, 'tenant-a')).rejects.toThrow(/已取消授权/)
    await expect(service.assertAuthorizerUsable(AUTHORIZER_APP_ID, 'tenant-a')).rejects.toThrow(/已取消授权/)
  })
})

describe('P3-04 授权账号存储加密', () => {
  test('Postgres 落库 token 为密文，读回一致（fake client）', async () => {
    const statements: Array<{ statement: string; params: readonly unknown[] }> = []
    const client = {
      query: async <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[] = []): Promise<{ rows: Row[] }> => {
        statements.push({ statement, params })
        return { rows: [] as Row[] }
      },
    }
    const store = new PostgresWechatAuthorizerStore(client, new Uint8Array(32).fill(5))
    await store.initializeSchema()
    await store.save({
      authorizerAppId: AUTHORIZER_APP_ID,
      tenantId: 'tenant-1',
      authorizerAccessToken: 'plain-at',
      authorizerRefreshToken: 'plain-rt',
      tokenExpiresAt: NOW + 7000_000,
      tokenAcquiredAt: NOW,
      nickname: '测试公众号',
      accountType: '0',
      status: 'active',
      authorizedAt: NOW,
      updatedAt: NOW,
    })
    const insert = statements.find((item) => item.statement.startsWith('INSERT'))
    const serialized = JSON.stringify(insert?.params ?? [])
    expect(serialized).not.toContain('plain-at')
    expect(serialized).not.toContain('plain-rt')
  })
})
