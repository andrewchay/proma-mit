import { describe, expect, test } from 'bun:test'
import {
  decideSubscriptionTransition,
  shouldDowngrade,
  type SubscriptionTransitionInput,
} from './subscription-lifecycle'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

function input(overrides: Partial<SubscriptionTransitionInput> = {}): SubscriptionTransitionInput {
  return {
    currentPlanId: 'pro',
    subscriptionStatus: 'active',
    currentPeriodEnd: NOW + 10 * DAY_MS,
    orderStatus: 'paid',
    now: NOW,
    ...overrides,
  }
}

describe('订阅状态推导', () => {
  test('有效期内保持当前套餐', () => {
    const decision = decideSubscriptionTransition(input())
    expect(decision.action).toBe('keep')
    expect(decision.effectivePlanId).toBe('pro')
  })

  test('到期后降级为 free', () => {
    const decision = decideSubscriptionTransition(
      input({ currentPeriodEnd: NOW - 1000 }),
    )
    expect(decision.action).toBe('downgrade')
    expect(decision.effectivePlanId).toBe('free')
  })

  test('到期边界：恰好等于当前时刻视为已到期', () => {
    const decision = decideSubscriptionTransition(input({ currentPeriodEnd: NOW }))
    expect(decision.action).toBe('downgrade')
  })

  test('退款后立即降级为 free', () => {
    const decision = decideSubscriptionTransition(input({ orderStatus: 'refunded' }))
    expect(decision.action).toBe('revoke')
    expect(decision.effectivePlanId).toBe('free')
  })

  test('订阅被撤销后降级为 free', () => {
    const decision = decideSubscriptionTransition(
      input({ subscriptionStatus: 'revoked' }),
    )
    expect(decision.action).toBe('revoke')
    expect(decision.effectivePlanId).toBe('free')
  })

  test('订阅已标记过期时降级', () => {
    const decision = decideSubscriptionTransition(
      input({ subscriptionStatus: 'expired' }),
    )
    expect(decision.action).toBe('downgrade')
    expect(decision.effectivePlanId).toBe('free')
  })

  test('免费套餐本身无需变更', () => {
    const decision = decideSubscriptionTransition(
      input({ currentPlanId: 'free', currentPeriodEnd: NOW - 1000 }),
    )
    expect(decision.action).toBe('keep')
    expect(decision.effectivePlanId).toBe('free')
  })

  test('未支付订单不产生任何权益变更', () => {
    const decision = decideSubscriptionTransition(
      input({ orderStatus: 'pending', subscriptionStatus: 'active' }),
    )
    expect(decision.action).toBe('keep')
  })
})

describe('离线宽限判定', () => {
  test('宽限窗口内仍可使用', () => {
    const result = shouldDowngrade({
      planId: 'pro',
      validUntil: NOW + 1000,
      now: NOW,
      graceMs: 72 * 60 * 60 * 1000,
      lastVerifiedAt: NOW - 1000,
    })
    expect(result).toBe(false)
  })

  test('超过宽限窗口后降级', () => {
    const result = shouldDowngrade({
      planId: 'pro',
      validUntil: NOW - 100 * 60 * 60 * 1000,
      now: NOW,
      graceMs: 72 * 60 * 60 * 1000,
      lastVerifiedAt: NOW - 100 * 60 * 60 * 1000,
    })
    expect(result).toBe(true)
  })

  test('免费套餐始终不降级', () => {
    const result = shouldDowngrade({
      planId: 'free',
      validUntil: NOW - 100 * 60 * 60 * 1000,
      now: NOW,
      graceMs: 72 * 60 * 60 * 1000,
      lastVerifiedAt: NOW - 100 * 60 * 60 * 1000,
    })
    expect(result).toBe(false)
  })
})
