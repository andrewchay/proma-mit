import { describe, expect, test } from 'bun:test'
import { selectCanUseCapability, type SubscriptionState } from './subscription-atoms'
import type { EntitlementSnapshot } from '@gravitas/shared'

const NOW = new Date('2026-09-13T00:00:00.000Z')

function snapshot(overrides: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot {
  return {
    accountId: 'acct-1',
    planId: 'pro',
    capabilities: ['influencer', 'paid-media'],
    status: 'active',
    validUntil: '2026-09-20T00:00:00.000Z',
    lastVerifiedAt: NOW.toISOString(),
    signature: 'sig',
    keyId: 'dev-1',
    ...overrides,
  }
}

describe('subscription atoms', () => {
  test('free 状态不能使用付费能力', () => {
    const state: SubscriptionState = { entitlement: snapshot({ planId: 'free', capabilities: [] }), status: 'none' }
    expect(selectCanUseCapability(state, 'influencer')).toBe(false)
  })

  test('active pro 可以使用已授予能力', () => {
    const state: SubscriptionState = { entitlement: snapshot(), status: 'active' }
    expect(selectCanUseCapability(state, 'influencer')).toBe(true)
    expect(selectCanUseCapability(state, 'outbound-sourcing')).toBe(false)
  })

  test('grace 状态可以继续使用能力', () => {
    const state: SubscriptionState = {
      entitlement: snapshot({ status: 'grace', graceUntil: '2026-09-14T00:00:00.000Z', validUntil: undefined }),
      status: 'grace',
    }
    expect(selectCanUseCapability(state, 'paid-media')).toBe(true)
  })

  test('expired 状态不能使用能力', () => {
    const state: SubscriptionState = {
      entitlement: snapshot({ status: 'expired', validUntil: '2026-09-01T00:00:00.000Z' }),
      status: 'expired',
    }
    expect(selectCanUseCapability(state, 'influencer')).toBe(false)
  })
})
