import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EntitlementService } from './entitlement-service'
import { EntitlementCache } from './entitlement-cache'
import type { EntitlementSnapshot } from '@gravitas/shared'

const NOW = new Date('2026-09-13T00:00:00.000Z')

function snapshot(overrides: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot {
  return {
    accountId: 'acct-1',
    planId: 'pro',
    capabilities: ['influencer'],
    status: 'active',
    validUntil: '2026-09-20T00:00:00.000Z',
    lastVerifiedAt: NOW.toISOString(),
    signature: 'sig',
    keyId: 'dev-1',
    ...overrides,
  }
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
    const service = new EntitlementService(
      { login: async () => { throw new Error('unused') }, refresh: async () => { throw new Error('unused') }, getEntitlements: async () => { throw new Error('unused') }, createCheckout: async () => { throw new Error('unused') }, getOrder: async () => { throw new Error('unused') } } as any,
      { load: () => undefined, save: () => {}, clear: () => {} } as any,
      new EntitlementCache(),
    )
    const state = service.getState()
    expect(state.status).toBe('none')
    expect(state.canUse('influencer')).toBe(false)
  })

  test('登录后保存权益并允许使用已授予能力', async () => {
    const cache = new EntitlementCache()
    const service = new EntitlementService(
      {
        login: async () => ({ accountId: 'acct-1', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 60_000, entitlement: snapshot() }),
        refresh: async () => { throw new Error('unused') },
        getEntitlements: async () => { throw new Error('unused') },
        createCheckout: async () => { throw new Error('unused') },
        getOrder: async () => { throw new Error('unused') },
      } as any,
      { load: () => undefined, save: () => {}, clear: () => {} } as any,
      cache,
    )
    await service.login({ phone: '13800000000' })
    const state = service.getState()
    expect(state.status).toBe('active')
    expect(state.canUse('influencer')).toBe(true)
  })

  test('刷新失败时保留缓存权益', async () => {
    const cache = new EntitlementCache()
    cache.save(snapshot())
    const service = new EntitlementService(
      {
        login: async () => { throw new Error('unused') },
        refresh: async () => { throw new Error('network error') },
        getEntitlements: async () => { throw new Error('unused') },
        createCheckout: async () => { throw new Error('unused') },
        getOrder: async () => { throw new Error('unused') },
      } as any,
      { load: () => ({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 60_000 }), save: () => {}, clear: () => {} } as any,
      cache,
    )
    await service.refresh()
    const state = service.getState()
    expect(state.status).toBe('active')
    expect(state.canUse('influencer')).toBe(true)
  })
})
