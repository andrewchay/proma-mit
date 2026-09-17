import { describe, expect, test } from 'bun:test'
import { InMemoryWechatComponentTicketStore } from './ticket-store'
import { WechatComponentTokenService } from './component-token-service'
import { WechatAuthorizationService } from './authorization-service'
import { InMemoryWechatAuthorizerStore } from './authorizer-store'
import {
  WECHAT_CAPABILITIES,
  WECHAT_CAPABILITY_CONFLICT_RULES,
  assertCapability,
  generateCapabilityMatrix,
  WechatCapabilityDeniedError,
} from './capability'

const APP_ID = 'wx1234567890abcdef'
const AUTHORIZER_APP_ID = 'wxaaaa111122223333'
const NOW = 1_700_000_000_000

class FakeResponse {
  constructor(private readonly payload: unknown, readonly status = 200) {}
  async json(): Promise<unknown> { return this.payload }
}

function queryAuthPayload(funcInfo: Array<{ funcscope_category: { id: number } }>) {
  return {
    authorization_info: {
      authorizer_appid: AUTHORIZER_APP_ID,
      authorizer_access_token: 'at-1',
      expires_in: 7200,
      authorizer_refresh_token: 'rt-1',
      func_info: funcInfo,
    },
    authorizer_info: { nick_name: '测试公众号', account_type: '0' },
  }
}

async function makeAuthorizedService(funcInfo: Array<{ funcscope_category: { id: number } }>) {
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
  const { InMemoryWechatAuthorizationStateStore } = await import('./authorization-service')
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
      if (url.includes('api_query_auth')) return new FakeResponse(queryAuthPayload(funcInfo)) as unknown as Response
      return new FakeResponse({ errcode: 404 }) as unknown as Response
    }) as unknown as typeof fetch,
  })
  const { url } = await service.createAuthorizationUrl('tenant-1')
  await service.handleAuthorizationCallback({ authCode: 'c1', state: new URL(url).searchParams.get('state')! })
  return { service, authorizerStore }
}

describe('P3-06 权限集 → 能力矩阵', () => {
  test('授权权限集落库：func_info 解析为 funcScopes', async () => {
    const { authorizerStore } = await makeAuthorizedService([{ funcscope_category: { id: 7 } }, { funcscope_category: { id: 2 } }])
    const account = await authorizerStore.load(AUTHORIZER_APP_ID)
    expect(account?.funcScopes).toEqual([7, 2])
  })

  test('已授权能力启用，未授权能力不生成启用条目', async () => {
    const { service } = await makeAuthorizedService([{ funcscope_category: { id: 7 } }, { funcscope_category: { id: 2 } }])
    const matrix = await service.getCapabilityMatrix(AUTHORIZER_APP_ID, 'tenant-1')
    const byId = Object.fromEntries(matrix.capabilities.map((item) => [item.id, item.enabled]))
    expect(byId).toMatchObject({ material: true, draft: true, publish: true, stats: true })
    expect(byId).toMatchObject({ comment: false, menu: false, customer_service: false, web_auth: false })
    // 未授权能力仍列出但 enabled=false（前端据此「不显示」），且携带所需权限集说明
    const comment = matrix.capabilities.find((item) => item.id === 'comment')
    expect(comment?.requiredFuncScopeIds).toEqual([1])
  })

  test('customer_service 多权限集任一满足即启用', async () => {
    const { service } = await makeAuthorizedService([{ funcscope_category: { id: 30 } }])
    const matrix = await service.getCapabilityMatrix(AUTHORIZER_APP_ID, 'tenant-1')
    expect(matrix.capabilities.find((item) => item.id === 'customer_service')?.enabled).toBe(true)
  })

  test('互斥规则命中产出显著警告', async () => {
    const { service } = await makeAuthorizedService([{ funcscope_category: { id: 7 } }, { funcscope_category: { id: 10 } }])
    const matrix = await service.getCapabilityMatrix(AUTHORIZER_APP_ID, 'tenant-1')
    expect(matrix.conflicts).toHaveLength(1)
    expect(matrix.conflicts[0]?.severity).toBe('warning')
    expect(matrix.conflicts[0]?.message).toContain('审批')
  })

  test('未命中互斥：只有 publish 无 customer_service 时无警告', async () => {
    const { service } = await makeAuthorizedService([{ funcscope_category: { id: 7 } }])
    const matrix = await service.getCapabilityMatrix(AUTHORIZER_APP_ID, 'tenant-1')
    expect(matrix.conflicts).toHaveLength(0)
  })

  test('跨租户取矩阵被拒绝', async () => {
    const { service } = await makeAuthorizedService([{ funcscope_category: { id: 7 } }])
    await expect(service.getCapabilityMatrix(AUTHORIZER_APP_ID, 'tenant-2')).rejects.toThrow(/不属于当前租户/)
  })

  test('assertCapability：未授权能力抛错（执行器不调用）', async () => {
    const { service } = await makeAuthorizedService([{ funcscope_category: { id: 2 } }])
    const matrix = await service.getCapabilityMatrix(AUTHORIZER_APP_ID, 'tenant-1')
    expect(() => assertCapability(matrix, 'stats')).not.toThrow()
    expect(() => assertCapability(matrix, 'publish')).toThrow(WechatCapabilityDeniedError)
    expect(() => assertCapability(matrix, 'publish')).toThrow(/能力未授权：publish/)
  })

  test('能力清单自身完整性：id 唯一、映射覆盖全部能力', () => {
    const ids = WECHAT_CAPABILITIES.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(WECHAT_CAPABILITY_CONFLICT_RULES.every((rule) => rule.when.every((id) => ids.includes(id)))).toBe(true)
  })

  test('纯函数：同一权限集生成稳定矩阵', () => {
    const a = generateCapabilityMatrix({ authorizerAppId: 'x', funcScopes: [7, 2, 10] })
    const b = generateCapabilityMatrix({ authorizerAppId: 'x', funcScopes: [7, 2, 10] })
    expect(a).toEqual(b)
    expect(a.capabilities.filter((item) => item.enabled).map((item) => item.id)).toEqual(['material', 'draft', 'publish', 'stats', 'customer_service'])
  })
})
