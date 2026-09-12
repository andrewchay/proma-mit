import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_ENTITLEMENT_GRACE_MS,
  SUBSCRIPTION_IPC_CHANNELS,
  canUseCapability,
  getEntitlementStatus,
  type EntitlementSnapshot,
} from './subscription'

const NOW = new Date('2026-09-13T00:00:00.000Z')

function snapshot(overrides: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot {
  return {
    accountId: 'acct-1',
    planId: 'pro',
    capabilities: ['influencer', 'paid-media'],
    status: 'active',
    validUntil: '2026-09-20T00:00:00.000Z',
    lastVerifiedAt: '2026-09-13T00:00:00.000Z',
    signature: 'sig',
    keyId: 'dev-1',
    ...overrides,
  }
}

describe('subscription entitlement domain', () => {
  test('IPC 通道保持显式且稳定', () => {
    expect(SUBSCRIPTION_IPC_CHANNELS.GET_STATE).toBe('subscription:get-state')
    expect(SUBSCRIPTION_IPC_CHANNELS.LOGIN).toBe('subscription:login')
    expect(SUBSCRIPTION_IPC_CHANNELS.LOGOUT).toBe('subscription:logout')
    expect(SUBSCRIPTION_IPC_CHANNELS.REFRESH).toBe('subscription:refresh')
    expect(SUBSCRIPTION_IPC_CHANNELS.CREATE_CHECKOUT).toBe('subscription:create-checkout')
    expect(SUBSCRIPTION_IPC_CHANNELS.GET_ORDER).toBe('subscription:get-order')
  })

  test('free 快照不能使用付费能力', () => {
    expect(canUseCapability(snapshot({ planId: 'free', capabilities: [] }), 'influencer', NOW)).toBe(false)
  })

  test('active pro 快照可以使用已授予能力', () => {
    expect(canUseCapability(snapshot(), 'influencer', NOW)).toBe(true)
    expect(canUseCapability(snapshot(), 'outbound-sourcing', NOW)).toBe(false)
  })

  test('宽限期内可以继续使用最近已验证权益', () => {
    const lastVerifiedAt = new Date(NOW.getTime() - DEFAULT_ENTITLEMENT_GRACE_MS + 60_000).toISOString()
    const graceSnapshot = snapshot({ status: 'grace', lastVerifiedAt, validUntil: undefined })
    expect(getEntitlementStatus(graceSnapshot, NOW)).toBe('grace')
    expect(canUseCapability(graceSnapshot, 'paid-media', NOW)).toBe(true)
  })

  test('宽限期过期后降级为不可用', () => {
    const lastVerifiedAt = new Date(NOW.getTime() - DEFAULT_ENTITLEMENT_GRACE_MS - 60_000).toISOString()
    const expiredSnapshot = snapshot({ status: 'grace', lastVerifiedAt, validUntil: undefined })
    expect(getEntitlementStatus(expiredSnapshot, NOW)).toBe('expired')
    expect(canUseCapability(expiredSnapshot, 'paid-media', NOW)).toBe(false)
  })
})
