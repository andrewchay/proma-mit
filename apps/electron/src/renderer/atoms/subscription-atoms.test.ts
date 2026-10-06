import { describe, expect, test } from 'bun:test'
import { selectCanUseCapability, type SubscriptionState } from './subscription-atoms'
import type { EntitlementSnapshot } from '@gravitas/shared'

// 权益判定使用真实时钟（new Date()），夹具必须用相对时间，
// 避免写死日历日期形成“日期炸弹”（曾因 validUntil 写死当天过期导致测试失效）。
function snapshot(overrides: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot {
  const now = new Date()
  return {
    accountId: 'acct-1',
    planId: 'pro',
    capabilities: ['influencer', 'paid-media'],
    status: 'active',
    validUntil: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    lastVerifiedAt: now.toISOString(),
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
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const state: SubscriptionState = {
      entitlement: snapshot({ status: 'grace', graceUntil: futureDate, validUntil: undefined }),
      status: 'grace',
    }
    expect(selectCanUseCapability(state, 'paid-media')).toBe(true)
  })

  test('expired 状态不能使用能力', () => {
    const state: SubscriptionState = {
      entitlement: snapshot({ status: 'expired', validUntil: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() }),
      status: 'expired',
    }
    expect(selectCanUseCapability(state, 'influencer')).toBe(false)
  })
})
