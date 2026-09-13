import { describe, expect, test } from 'bun:test'
import { SubscriptionLifecycleService } from './subscription-lifecycle-service'
import type { SubscriptionStore } from '../db/subscription-store'
import type { EntitlementService } from './entitlement-service'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

interface FakeSubscription {
  id: string
  accountId: string
  planId: string
  status: 'active' | 'expired' | 'revoked'
  currentPeriodEnd: number
  orderId: string
}

function createHarness(options: {
  expiredSubscriptions?: FakeSubscription[]
  orders?: Record<string, { id: string; accountId: string; status: string }>
}) {
  const calls = {
    markedExpired: [] as string[],
    revokedFor: [] as string[],
    refunded: [] as string[],
    entitlements: [] as Array<Record<string, unknown>>,
  }

  const subscriptions = new Map<string, FakeSubscription>()
  for (const sub of options.expiredSubscriptions ?? []) {
    subscriptions.set(sub.id, { ...sub })
  }
  const orders = new Map(Object.entries(options.orders ?? {}))

  const store = {
    findExpiredActiveSubscriptions: async ({ now, limit }: { now: number; limit: number }) => {
      return [...subscriptions.values()]
        .filter((sub) => sub.status === 'active' && sub.currentPeriodEnd <= now)
        .sort((a, b) => a.currentPeriodEnd - b.currentPeriodEnd)
        .slice(0, limit)
        .map((sub) => ({
          id: sub.id,
          accountId: sub.accountId,
          planId: sub.planId,
          currentPeriodEnd: sub.currentPeriodEnd,
        }))
    },
    markSubscriptionExpired: async ({ subscriptionId }: { subscriptionId: string }) => {
      calls.markedExpired.push(subscriptionId)
      const sub = subscriptions.get(subscriptionId)
      if (sub) sub.status = 'expired'
    },
    findOrderById: async (id: string) => orders.get(id),
    markOrderRefunded: async ({ orderId }: { orderId: string }) => {
      const order = orders.get(orderId)
      // 模拟 SQL 中 status='paid' 的条件约束
      if (!order || order.status !== 'paid') return undefined
      order.status = 'refunded'
      calls.refunded.push(orderId)
      return order
    },
    revokeActiveSubscriptions: async ({ accountId }: { accountId: string }) => {
      calls.revokedFor.push(accountId)
      let count = 0
      for (const sub of subscriptions.values()) {
        if (sub.accountId === accountId && sub.status === 'active') {
          sub.status = 'revoked'
          count += 1
        }
      }
      return count
    },
    findCurrentSubscription: async (accountId: string) => {
      const list = [...subscriptions.values()].filter((sub) => sub.accountId === accountId)
      if (list.length === 0) return undefined
      return list.sort((a, b) => b.currentPeriodEnd - a.currentPeriodEnd)[0]
    },
  } as unknown as SubscriptionStore

  const entitlementService = {
    issueEntitlement: async (input: Record<string, unknown>) => {
      calls.entitlements.push(input)
      return input
    },
  } as unknown as EntitlementService

  return { store, entitlementService, calls, subscriptions, orders }
}

describe('到期扫描', () => {
  test('到期订阅被标记过期并签发 free 权益', async () => {
    const harness = createHarness({
      expiredSubscriptions: [
        { id: 'sub-1', accountId: 'acc-1', planId: 'pro', status: 'active', currentPeriodEnd: NOW - DAY_MS, orderId: 'order-1' },
      ],
    })
    const service = new SubscriptionLifecycleService({
      store: harness.store,
      entitlementService: harness.entitlementService,
    })

    const result = await service.sweepExpiredSubscriptions(NOW)

    expect(result.scanned).toBe(1)
    expect(result.downgraded).toBe(1)
    expect(harness.calls.markedExpired).toEqual(['sub-1'])
    expect(harness.calls.entitlements).toHaveLength(1)
    expect(harness.calls.entitlements[0].planId).toBe('free')
    expect(harness.calls.entitlements[0].status).toBe('expired')
  })

  test('未到期订阅不被处理', async () => {
    const harness = createHarness({
      expiredSubscriptions: [
        { id: 'sub-2', accountId: 'acc-2', planId: 'pro', status: 'active', currentPeriodEnd: NOW + DAY_MS, orderId: 'order-2' },
      ],
    })
    const service = new SubscriptionLifecycleService({
      store: harness.store,
      entitlementService: harness.entitlementService,
    })

    const result = await service.sweepExpiredSubscriptions(NOW)

    expect(result.scanned).toBe(0)
    expect(harness.calls.entitlements).toHaveLength(0)
  })

  test('已过期的订阅不会重复处理', async () => {
    const harness = createHarness({
      expiredSubscriptions: [
        { id: 'sub-3', accountId: 'acc-3', planId: 'pro', status: 'expired', currentPeriodEnd: NOW - DAY_MS, orderId: 'order-3' },
      ],
    })
    const service = new SubscriptionLifecycleService({
      store: harness.store,
      entitlementService: harness.entitlementService,
    })

    const result = await service.sweepExpiredSubscriptions(NOW)

    expect(result.scanned).toBe(0)
  })

  test('多账号到期时逐个降级，互不影响', async () => {
    const harness = createHarness({
      expiredSubscriptions: [
        { id: 'sub-a', accountId: 'acc-a', planId: 'pro', status: 'active', currentPeriodEnd: NOW - DAY_MS, orderId: 'order-a' },
        { id: 'sub-b', accountId: 'acc-b', planId: 'pro', status: 'active', currentPeriodEnd: NOW - 2 * DAY_MS, orderId: 'order-b' },
      ],
    })
    const service = new SubscriptionLifecycleService({
      store: harness.store,
      entitlementService: harness.entitlementService,
    })

    const result = await service.sweepExpiredSubscriptions(NOW)

    expect(result.downgraded).toBe(2)
    expect(harness.calls.revokedFor).toHaveLength(0)
    const accountIds = harness.calls.entitlements.map((item) => item.accountId).sort()
    expect(accountIds).toEqual(['acc-a', 'acc-b'])
  })
})

describe('退款处理', () => {
  test('退款后撤销订阅并收回权益', async () => {
    const harness = createHarness({
      expiredSubscriptions: [
        { id: 'sub-1', accountId: 'acc-1', planId: 'pro', status: 'active', currentPeriodEnd: NOW + DAY_MS, orderId: 'order-1' },
      ],
      orders: { 'order-1': { id: 'order-1', accountId: 'acc-1', status: 'paid' } },
    })
    const service = new SubscriptionLifecycleService({
      store: harness.store,
      entitlementService: harness.entitlementService,
    })

    const result = await service.handleRefund({ orderId: 'order-1', refundedAt: NOW })

    expect(result.ok).toBe(true)
    expect(result.accountId).toBe('acc-1')
    expect(harness.calls.refunded).toEqual(['order-1'])
    expect(harness.calls.revokedFor).toEqual(['acc-1'])
    expect(harness.calls.entitlements[0].planId).toBe('free')
    expect(harness.calls.entitlements[0].status).toBe('revoked')
  })

  test('重复退款通知不会重复收回权益', async () => {
    const harness = createHarness({
      expiredSubscriptions: [
        { id: 'sub-1', accountId: 'acc-1', planId: 'pro', status: 'active', currentPeriodEnd: NOW + DAY_MS, orderId: 'order-1' },
      ],
      orders: { 'order-1': { id: 'order-1', accountId: 'acc-1', status: 'paid' } },
    })
    const service = new SubscriptionLifecycleService({
      store: harness.store,
      entitlementService: harness.entitlementService,
    })

    const first = await service.handleRefund({ orderId: 'order-1', refundedAt: NOW })
    const second = await service.handleRefund({ orderId: 'order-1', refundedAt: NOW })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    expect(second.reason).toBe('order_not_refundable')
    expect(harness.calls.entitlements).toHaveLength(1)
  })

  test('订单不存在时返回失败而非抛异常', async () => {
    const harness = createHarness({ orders: {} })
    const service = new SubscriptionLifecycleService({
      store: harness.store,
      entitlementService: harness.entitlementService,
    })

    const result = await service.handleRefund({ orderId: 'missing' })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('order_not_found')
  })

  test('未支付订单不可退款', async () => {
    const harness = createHarness({
      orders: { 'order-p': { id: 'order-p', accountId: 'acc-p', status: 'pending' } },
    })
    const service = new SubscriptionLifecycleService({
      store: harness.store,
      entitlementService: harness.entitlementService,
    })

    const result = await service.handleRefund({ orderId: 'order-p' })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('order_not_refundable')
    expect(harness.calls.revokedFor).toHaveLength(0)
  })
})
