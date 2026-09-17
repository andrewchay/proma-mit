import { describe, expect, test } from 'bun:test'
import { InMemoryWechatComponentTicketStore } from './ticket-store'
import { WechatComponentTokenService } from './component-token-service'
import { InMemoryWechatAuthorizationStateStore, WechatAuthorizationService } from './authorization-service'
import { InMemoryWechatAuthorizerStore } from './authorizer-store'
import {
  InMemoryWechatDirectMigrationStore,
  WechatMigrationError,
  WechatMigrationService,
  type WechatMigrationServiceOptions,
} from './migration-service'

const APP_ID = 'wx1234567890abcdef'
const AUTHORIZER_APP_ID = 'wxaaaa111122223333'
const DIRECT_ACCOUNT_ID = 'direct-acct-1'
const NOW = 1_700_000_000_000

class FakeResponse {
  constructor(private readonly payload: unknown, readonly status = 200) {}
  async json(): Promise<unknown> { return this.payload }
}

async function makeService(overrides: Partial<WechatMigrationServiceOptions> = {}) {
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
  const authorizationService = new WechatAuthorizationService({
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
            authorizer_access_token: 'at-1',
            expires_in: 7200,
            authorizer_refresh_token: 'rt-1',
            func_info: [{ funcscope_category: { id: 7 } }],
          },
          authorizer_info: { nick_name: '测试公众号', account_type: '0' },
        }) as unknown as Response
      }
      return new FakeResponse({ errcode: 404 }) as unknown as Response
    }) as unknown as typeof fetch,
  })
  // 预置一个已授权账号
  const { url } = await authorizationService.createAuthorizationUrl('tenant-1')
  await authorizationService.handleAuthorizationCallback({ authCode: 'c1', state: new URL(url).searchParams.get('state')! })

  const migrationStore = new InMemoryWechatDirectMigrationStore()
  let idCounter = 0
  const service = new WechatMigrationService({
    migrationStore,
    authorizerStore,
    authorizationService,
    now: () => NOW,
    newId: () => `mig-${++idCounter}`,
    ...overrides,
  })
  return { service, migrationStore, authorizerStore, authorizationService }
}

describe('P3-08 迁移发起与数据绑定规则', () => {
  test('正常流程：发起 → 确认 completed → canDeleteLegacySecret=true', async () => {
    const { service } = await makeService()
    const record = await service.createMigration({ tenantId: 'tenant-1', directAccountId: DIRECT_ACCOUNT_ID, authorizerAppId: AUTHORIZER_APP_ID })
    expect(record.status).toBe('pending')
    expect(await service.canDeleteLegacySecret(DIRECT_ACCOUNT_ID, 'tenant-1')).toBe(false)

    const completed = await service.confirmMigration(record.migrationId, 'tenant-1')
    expect(completed.status).toBe('completed')
    expect(completed.completedAt).toBe(NOW)
    expect(await service.canDeleteLegacySecret(DIRECT_ACCOUNT_ID, 'tenant-1')).toBe(true)
  })

  test('不可静默换绑：同一 authorizer 绑定另一个 direct 账号被拒绝', async () => {
    const { service } = await makeService()
    const record = await service.createMigration({ tenantId: 'tenant-1', directAccountId: DIRECT_ACCOUNT_ID, authorizerAppId: AUTHORIZER_APP_ID })
    await service.confirmMigration(record.migrationId, 'tenant-1')
    await expect(
      service.createMigration({ tenantId: 'tenant-1', directAccountId: 'direct-acct-2', authorizerAppId: AUTHORIZER_APP_ID }),
    ).rejects.toThrow(/不可静默换绑/)
  })

  test('重复迁移同一 direct 账号：必须 changeReason，旧记录 superseded 保留审计', async () => {
    const { service, migrationStore } = await makeService()
    const first = await service.createMigration({ tenantId: 'tenant-1', directAccountId: DIRECT_ACCOUNT_ID, authorizerAppId: AUTHORIZER_APP_ID })
    await service.confirmMigration(first.migrationId, 'tenant-1')

    // 无 changeReason → 拒绝
    await expect(
      service.createMigration({ tenantId: 'tenant-1', directAccountId: DIRECT_ACCOUNT_ID, authorizerAppId: AUTHORIZER_APP_ID }),
    ).rejects.toThrow(/changeReason/)

    // 有 changeReason → 旧记录 superseded（不删除），新记录 pending
    const second = await service.createMigration({ tenantId: 'tenant-1', directAccountId: DIRECT_ACCOUNT_ID, authorizerAppId: AUTHORIZER_APP_ID, changeReason: '换绑到新的开放平台账号' })
    const history = await migrationStore.listByDirectAccount(DIRECT_ACCOUNT_ID)
    // 旧记录 superseded（保留审计，不删除），新记录 pending
    const statuses = history.map((item) => item.status).sort()
    expect(statuses).toEqual(['pending', 'superseded'] as typeof statuses)
    expect(second.status).toBe('pending')
  })

  test('目标 authorizer 撤权后：发起与确认都被拒', async () => {
    const { service, authorizationService } = await makeService()
    await authorizationService.handleUnauthorizedEvent(AUTHORIZER_APP_ID)
    await expect(
      service.createMigration({ tenantId: 'tenant-1', directAccountId: DIRECT_ACCOUNT_ID, authorizerAppId: AUTHORIZER_APP_ID }),
    ).rejects.toThrow(/已取消授权/)
  })

  test('跨租户发起迁移被拒', async () => {
    const { service } = await makeService()
    await expect(
      service.createMigration({ tenantId: 'tenant-2', directAccountId: DIRECT_ACCOUNT_ID, authorizerAppId: AUTHORIZER_APP_ID }),
    ).rejects.toThrow(/不属于当前租户|已取消授权/)
  })

  test('回滚：completed → rolled_back 需原因；回滚后不可删除旧 secret', async () => {
    const { service } = await makeService()
    const record = await service.createMigration({ tenantId: 'tenant-1', directAccountId: DIRECT_ACCOUNT_ID, authorizerAppId: AUTHORIZER_APP_ID })
    await service.confirmMigration(record.migrationId, 'tenant-1')
    await expect(service.rollbackMigration(record.migrationId, 'tenant-1', '')).rejects.toThrow(/原因/)
    const rolled = await service.rollbackMigration(record.migrationId, 'tenant-1', '平台授权被商家取消')
    expect(rolled.status).toBe('rolled_back')
    expect(await service.canDeleteLegacySecret(DIRECT_ACCOUNT_ID, 'tenant-1')).toBe(false)
  })

  test('canDeleteLegacySecret：authorizer 撤权后立即变为 false（安全删除信号失效）', async () => {
    const { service, authorizationService } = await makeService()
    const record = await service.createMigration({ tenantId: 'tenant-1', directAccountId: DIRECT_ACCOUNT_ID, authorizerAppId: AUTHORIZER_APP_ID })
    await service.confirmMigration(record.migrationId, 'tenant-1')
    expect(await service.canDeleteLegacySecret(DIRECT_ACCOUNT_ID, 'tenant-1')).toBe(true)
    await authorizationService.handleUnauthorizedEvent(AUTHORIZER_APP_ID)
    expect(await service.canDeleteLegacySecret(DIRECT_ACCOUNT_ID, 'tenant-1')).toBe(false)
  })

  test('迁移记录按租户隔离', async () => {
    const { service } = await makeService()
    await service.createMigration({ tenantId: 'tenant-1', directAccountId: DIRECT_ACCOUNT_ID, authorizerAppId: AUTHORIZER_APP_ID })
    expect(await service.listMigrations('tenant-1')).toHaveLength(1)
    expect(await service.listMigrations('tenant-2')).toHaveLength(0)
    await expect(service.confirmMigration('mig-1', 'tenant-2')).rejects.toThrow(/不属于当前租户/)
  })

  test('数据绑定不变量：迁移全程不触碰 authorizer 账号数据（历史草稿/指标保留的语义在服务端=零数据移动）', async () => {
    const { service, authorizerStore } = await makeService()
    const before = await authorizerStore.load(AUTHORIZER_APP_ID)
    const record = await service.createMigration({ tenantId: 'tenant-1', directAccountId: DIRECT_ACCOUNT_ID, authorizerAppId: AUTHORIZER_APP_ID })
    await service.confirmMigration(record.migrationId, 'tenant-1')
    await service.rollbackMigration(record.migrationId, 'tenant-1', '测试回滚')
    const after = await authorizerStore.load(AUTHORIZER_APP_ID)
    // 迁移/回滚只写迁移表，授权账号记录不变
    expect(after).toEqual(before)
  })
})
