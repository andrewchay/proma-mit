import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { EntitlementService } from './entitlement-service'
import { EntitlementCache } from './entitlement-cache'
import { buildEntitlementSigningPayload } from './entitlement-signature'
import type { EntitlementSnapshot } from '@gravitas/shared'

let privateKeyPem: string
let publicKeyPem: string

const pair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
privateKeyPem = pair.privateKey
publicKeyPem = pair.publicKey

/** 用测试密钥签发快照，模拟服务端下发的合法快照 */
function signedSnapshot(overrides: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot {
  const base: EntitlementSnapshot = {
    accountId: 'acct-1',
    planId: 'pro',
    capabilities: ['influencer'],
    status: 'active',
    validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    signature: '',
    keyId: 'prod-1',
    ...overrides,
  }
  const payload = buildEntitlementSigningPayload(base)
  const signature = createSign('RSA-SHA256').update(payload, 'utf8').sign(privateKeyPem, 'base64url')
  return { ...base, signature }
}

function createService(options: {
  cache: EntitlementCache
  tokens?: { accessToken: string; refreshToken: string; expiresAt: number } | undefined
  api?: Record<string, unknown>
  allowDevSignature?: boolean
  publicKeyPem?: string
}) {
  const api = {
    requestEmailOtp: async () => ({ ok: true, expiresInSeconds: 600 }),
    verifyEmailOtp: async () => { throw new Error('unused') },
    startOAuth: async () => { throw new Error('unused') },
    completeOAuth: async () => { throw new Error('unused') },
    refresh: async () => { throw new Error('network error') },
    logout: async () => { throw new Error('unused') },
    getEntitlements: async () => { throw new Error('unused') },
    createCheckout: async () => { throw new Error('unused') },
    getOrder: async () => { throw new Error('unused') },
    syncOrder: async () => { throw new Error('unused') },
    ...options.api,
  }

  const authService = {
    load: () => options.tokens,
    save: () => {},
    clear: () => {},
  }

  return new EntitlementService(
    api as never,
    authService as never,
    options.cache,
    {
      entitlementPublicKeyPem: options.publicKeyPem ?? publicKeyPem,
      allowDevSignature: options.allowDevSignature ?? false,
    },
  )
}

describe('EntitlementService', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'subscription-test-'))
    process.env.PROMA_TEST_CONFIG_DIR = tempDir
  })

  afterEach(() => {
    delete process.env.PROMA_TEST_CONFIG_DIR
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('未登录时返回 none 状态', () => {
    const service = createService({ cache: new EntitlementCache(), tokens: undefined })
    const state = service.getState()
    expect(state.status).toBe('none')
    expect(state.canUse('influencer')).toBe(false)
  })

  test('已验签的 pro 快照可正常授予能力', () => {
    const cache = new EntitlementCache()
    cache.save(signedSnapshot())
    const service = createService({ cache })

    const state = service.getState()
    expect(state.status).toBe('active')
    expect(state.canUse('influencer')).toBe(true)
  })

  test('签名被篡改的快照不授予任何能力（防改本地文件白嫖）', () => {
    const cache = new EntitlementCache()
    const valid = signedSnapshot({ planId: 'free', capabilities: [] })
    // 模拟用户手改本地缓存：把 free 提升为 pro 并塞满能力
    cache.save({
      ...valid,
      planId: 'pro',
      capabilities: ['influencer', 'paid-media', 'outbound-sourcing'],
    })

    const service = createService({ cache })
    const state = service.getState()

    expect(state.entitlement).toBeNull()
    expect(state.status).toBe('none')
    expect(state.canUse('influencer')).toBe(false)
    expect(state.canUse('paid-media')).toBe(false)
  })

  test('未配置公钥时拒绝接受已签名快照', () => {
    const cache = new EntitlementCache()
    cache.save(signedSnapshot())

    const service = createService({ cache, publicKeyPem: '' })
    const state = service.getState()

    expect(state.entitlement).toBeNull()
    expect(state.canUse('influencer')).toBe(false)
  })

  test('开发签名仅在显式允许时被接受', () => {
    const cache = new EntitlementCache()
    cache.save({
      accountId: 'acct-1',
      planId: 'pro',
      capabilities: ['influencer'],
      status: 'active',
      lastVerifiedAt: new Date().toISOString(),
      signature: 'dev.dev-1.xxx',
      keyId: 'dev-1',
    })

    // 默认拒绝
    expect(createService({ cache }).getState().entitlement).toBeNull()
    // 显式允许时接受
    expect(createService({ cache, allowDevSignature: true }).getState().entitlement).not.toBeNull()
  })

  test('刷新失败时保留已验签的缓存并标记离线', async () => {
    const cache = new EntitlementCache()
    cache.save(signedSnapshot())

    const service = createService({
      cache,
      tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 60_000 },
      api: { refresh: async () => { throw new Error('network error') } },
    })

    const state = await service.refresh()
    expect(state.status).toBe('active')
    expect(state.connectivity).toBe('offline')
    expect(state.canUse('influencer')).toBe(true)
  })

  test('刷新成功时更新为在线状态', async () => {
    const cache = new EntitlementCache()
    const service = createService({
      cache,
      tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 60_000 },
      api: {
        refresh: async () => ({
          accessToken: 'new-at',
          refreshToken: 'new-rt',
          expiresAt: Date.now() + 60_000,
          entitlement: signedSnapshot({ lastVerifiedAt: new Date().toISOString() }),
        }),
      },
    })

    const state = await service.refresh()
    expect(state.connectivity).toBe('online')
    expect(state.canUse('influencer')).toBe(true)
  })

  test('登出时通知服务端吊销会话', async () => {
    let logoutCalled = false
    const cache = new EntitlementCache()
    cache.save(signedSnapshot())

    const service = createService({
      cache,
      tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 60_000 },
      api: { logout: async () => { logoutCalled = true } },
    })

    await service.logout()
    expect(logoutCalled).toBe(true)
  })

  test('服务端不可达时登出仍然清空本地', async () => {
    const cache = new EntitlementCache()
    cache.save(signedSnapshot())

    const service = createService({
      cache,
      tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 60_000 },
      api: { logout: async () => { throw new Error('unreachable') } },
    })

    await service.logout()
    expect(cache.load()?.snapshot).toBeUndefined()
  })

  test('到期快照不再授予能力', () => {
    const cache = new EntitlementCache()
    cache.save(
      signedSnapshot({
        validUntil: new Date(Date.now() - 1000).toISOString(),
        lastVerifiedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    )

    const service = createService({ cache })
    const state = service.getState()
    expect(state.canUse('influencer')).toBe(false)
  })

  test('磁盘上的缓存文件被直接篡改后仍被拒绝', () => {
    const cacheDir = join(tempDir, 'subscription')
    mkdirSync(cacheDir, { recursive: true })
    // 完全绕过 EntitlementCache 写入，模拟直接编辑文件
    writeFileSync(
      join(cacheDir, 'entitlement-cache.json'),
      JSON.stringify({
        snapshot: {
          accountId: 'acct-1',
          planId: 'pro',
          capabilities: ['influencer', 'paid-media', 'outbound-sourcing'],
          status: 'active',
          lastVerifiedAt: new Date().toISOString(),
          signature: 'ZmFrZQ==',
          keyId: 'prod-1',
        },
      }),
    )

    const service = createService({ cache: new EntitlementCache() })
    expect(service.getState().canUse('influencer')).toBe(false)
  })
})
