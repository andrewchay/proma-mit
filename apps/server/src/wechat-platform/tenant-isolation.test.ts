import { describe, expect, test } from 'bun:test'
import { InMemoryWechatComponentTicketStore } from './ticket-store'
import { WechatComponentTokenService } from './component-token-service'
import {
  InMemoryWechatAuthorizationStateStore,
  WechatAuthorizationService,
  WechatAuthorizerUnavailableError,
} from './authorization-service'
import { InMemoryWechatAuthorizerStore } from './authorizer-store'
import { InMemoryWechatEventInbox } from './event-inbox'

const APP_ID = 'wx1234567890abcdef'
const AUTHORIZER_APP_ID = 'wxaaaa111122223333'
const NOW = 1_700_000_000_000

class FakeResponse {
  constructor(private readonly payload: unknown, readonly status = 200) {}
  async json(): Promise<unknown> { return this.payload }
}

async function makeService() {
  const ticketStore = new InMemoryWechatComponentTicketStore()
  await ticketStore.save({ componentAppId: APP_ID, ticket: 't', receivedAt: NOW })
  const tokenCache = new Map<string, { componentAccessToken: string; expiresAt: number; acquiredAt: number }>()
  const componentTokenService = new WechatComponentTokenService({
    componentAppId: APP_ID,
    componentAppSecret: 's',
    ticketStore,
    tokenCacheStore: {
      save: async (record) => { tokenCache.set(record.componentAppId, { componentAccessToken: record.componentAccessToken, expiresAt: record.expiresAt, acquiredAt: record.acquiredAt }) },
      load: async (appId) => { const row = tokenCache.get(appId); return row ? { componentAppId: appId, ...row } : undefined },
    },
    now: () => NOW,
    fetchFn: (async () => new FakeResponse({ component_access_token: 'ct', expires_in: 7200 }) as unknown as Response) as unknown as typeof fetch,
  })
  const authorizerStore = new InMemoryWechatAuthorizerStore()
  const service = new WechatAuthorizationService({
    componentAppId: APP_ID,
    authorizationRedirectUri: 'https://ops.example.com/cb',
    ticketStore,
    componentTokenService,
    authorizerStore,
    stateStore: new InMemoryWechatAuthorizationStateStore(() => NOW),
    now: () => NOW,
    fetchFn: (async (url: string) => {
      if (url.includes('api_create_preauthcode')) return new FakeResponse({ pre_auth_code: 'pac', expires_in: 600 }) as unknown as Response
      if (url.includes('api_query_auth')) {
        return new FakeResponse({
          authorization_info: {
            authorizer_appid: AUTHORIZER_APP_ID,
            authorizer_access_token: 'at-secret-1',
            expires_in: 7200,
            authorizer_refresh_token: 'rt-secret-1',
            func_info: [{ funcscope_category: { id: 7 } }],
          },
          authorizer_info: { nick_name: '测试公众号', account_type: '0' },
        }) as unknown as Response
      }
      return new FakeResponse({ errcode: 404 }) as unknown as Response
    }) as unknown as typeof fetch,
  })
  return { service, authorizerStore }
}

async function authorize(service: WechatAuthorizationService, tenantId: string): Promise<void> {
  const { url } = await service.createAuthorizationUrl(tenantId)
  await service.handleAuthorizationCallback({ authCode: `code-${tenantId}`, state: new URL(url).searchParams.get('state')! })
}

describe('P3-07 租户边界：跨租户访问控制', () => {
  test('跨租户读取全被拒：token、能力矩阵、账号列表、守卫', async () => {
    const { service } = await makeService()
    await authorize(service, 'tenant-a')

    await expect(service.getAuthorizerAccessToken(AUTHORIZER_APP_ID, 'tenant-b')).rejects.toThrow(WechatAuthorizerUnavailableError)
    await expect(service.getCapabilityMatrix(AUTHORIZER_APP_ID, 'tenant-b')).rejects.toThrow(WechatAuthorizerUnavailableError)
    await expect(service.assertAuthorizerUsable(AUTHORIZER_APP_ID, 'tenant-b')).rejects.toThrow(WechatAuthorizerUnavailableError)
    expect(await service.listAuthorizedAccounts('tenant-b')).toEqual([])
    // 本租户全部放行
    await expect(service.getAuthorizerAccessToken(AUTHORIZER_APP_ID, 'tenant-a')).resolves.toBe('at-secret-1')
    await expect(service.assertAuthorizerUsable(AUTHORIZER_APP_ID, 'tenant-a')).resolves.toBeUndefined()
  })

  test('active 账号禁止跨租户静默换绑；撤权后允许新租户接管', async () => {
    const { service, authorizerStore } = await makeService()
    await authorize(service, 'tenant-a')
    // tenant-b 发起授权同一公众号 → 拒绝
    await expect(authorize(service, 'tenant-b')).rejects.toThrow(/不可静默换绑/)
    expect((await authorizerStore.load(AUTHORIZER_APP_ID))?.tenantId).toBe('tenant-a')

    // tenant-a 撤权后，tenant-b 可接管
    await service.handleUnauthorizedEvent(AUTHORIZER_APP_ID)
    await authorize(service, 'tenant-b')
    const account = await authorizerStore.load(AUTHORIZER_APP_ID)
    expect(account?.tenantId).toBe('tenant-b')
    expect(account?.status).toBe('active')
    // 原租户立即失去访问
    await expect(service.getAuthorizerAccessToken(AUTHORIZER_APP_ID, 'tenant-a')).rejects.toThrow(WechatAuthorizerUnavailableError)
  })

  test('同租户重复授权：更新 token、租户不变（非换绑）', async () => {
    const { service, authorizerStore } = await makeService()
    await authorize(service, 'tenant-a')
    await authorize(service, 'tenant-a')
    const account = await authorizerStore.load(AUTHORIZER_APP_ID)
    expect(account?.tenantId).toBe('tenant-a')
    expect(account?.status).toBe('active')
  })

  test('state 绑定租户：A 租户 state 不能被 B 租户回调利用', async () => {
    const { service } = await makeService()
    // tenant-a 生成 URL，把跳转链接交给 tenant-b 的“回调”（模拟 state 泄露）
    const { url } = await service.createAuthorizationUrl('tenant-a')
    const state = new URL(url).searchParams.get('state')!
    const summary = await service.handleAuthorizationCallback({ authCode: 'c-x', state })
    // 归属仍是发起租户 A，而非处理请求的上下文
    expect(summary.status).toBe('active')
    await expect(service.getAuthorizerAccessToken(AUTHORIZER_APP_ID, 'tenant-b')).rejects.toThrow(WechatAuthorizerUnavailableError)
  })

  test('接口输出零 token 泄漏：列表/矩阵/摘要均不含凭据明文', async () => {
    const { service } = await makeService()
    await authorize(service, 'tenant-a')
    const accounts = await service.listAuthorizedAccounts('tenant-a')
    const matrix = await service.getCapabilityMatrix(AUTHORIZER_APP_ID, 'tenant-a')
    const serialized = JSON.stringify({ accounts, matrix })
    expect(serialized).not.toContain('at-secret-1')
    expect(serialized).not.toContain('rt-secret-1')
    expect(Object.keys(accounts[0] ?? {}).sort()).toEqual(['accountType', 'authorizedAt', 'authorizerAppId', 'nickname', 'status'])
  })

  test('Postgres 授权存储：list(tenantId) 过滤生效（fake client）', async () => {
    const { PostgresWechatAuthorizerStore } = await import('./authorizer-store')
    const rows: Array<Record<string, unknown>> = []
    const client = {
      query: async <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[] = []): Promise<{ rows: Row[] }> => {
        if (statement.startsWith('INSERT')) rows.push({ authorizer_app_id: params[0], tenant_id: params[11], status: params[7], encrypted_access_token: params[1], encrypted_refresh_token: params[2], token_expires_at: params[3], token_acquired_at: params[4], nickname: params[5], account_type: params[6], func_scopes: params[10], revoked_at: params[12], authorized_at: params[8], updated_at: params[9] })
        if (statement.startsWith('SELECT') && params.length > 0) return { rows: rows.filter((row) => row.tenant_id === params[0]) as unknown as Row[] }
        if (statement.startsWith('SELECT')) return { rows: rows as unknown as Row[] }
        return { rows: [] as Row[] }
      },
    }
    const key = new Uint8Array(32).fill(1)
    const store = new PostgresWechatAuthorizerStore(client, key)
    const base = {
      authorizerAccessToken: 'a', authorizerRefreshToken: 'r', tokenExpiresAt: NOW, tokenAcquiredAt: NOW,
      nickname: 'n', accountType: '0', funcScopes: [], status: 'active' as const, authorizedAt: NOW, updatedAt: NOW,
    }
    await store.save({ ...base, authorizerAppId: 'wx-ta', tenantId: 'tenant-a' })
    await store.save({ ...base, authorizerAppId: 'wx-tb', tenantId: 'tenant-b' })
    expect((await store.list('tenant-a')).map((item) => item.authorizerAppId)).toEqual(['wx-ta'])
    expect((await store.list()).map((item) => item.authorizerAppId).sort()).toEqual(['wx-ta', 'wx-tb'])
  })

  test('inbox dead-letter 属平台级：payload 含 ticket，访问需 operator/admin 角色（路由已控）', async () => {
    // 平台级组件凭据的 dead-letter 不按租户切分；其访问控制由路由层角色校验承担。
    // 本用例锁定语义：inbox 本身不做租户过滤，防止误假设。
    const inbox = new InMemoryWechatEventInbox()
    await inbox.append({ dedupeKey: 'k', eventType: 'component_verify_ticket', payload: '{"componentAppId":"x","ticket":"t"}' })
    await inbox.markDead('k', 'boom')
    const dead = await inbox.listDead()
    expect(dead).toHaveLength(1)
    expect(dead[0]?.eventType).toBe('component_verify_ticket')
  })
})
