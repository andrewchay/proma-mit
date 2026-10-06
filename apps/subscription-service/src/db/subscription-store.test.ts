import { describe, expect, test } from 'bun:test'
import { SubscriptionStore } from './subscription-store'
import type { AgentRuntimePostgresClient } from '@gravitas/shared/utils'

interface FakeRow {
  [key: string]: unknown
}

function createFakeClient(): { client: AgentRuntimePostgresClient; calls: Array<{ sql: string; params: readonly unknown[] }>; rows: Map<string, FakeRow[]> } {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = []
  const rows = new Map<string, FakeRow[]>()
  const client: AgentRuntimePostgresClient = {
    query: async <Row extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params })
      const normalized = sql.trim().replace(/\s+/g, ' ')
      if (normalized.startsWith('SELECT id, phone_hash')) {
        const key = `account:${String(params[0])}`
        return { rows: (rows.get(key) ?? []) as Row[] }
      }
      if (normalized.startsWith('SELECT id, account_id, refresh_token_hash')) {
        const key = `session:${String(params[0])}`
        return { rows: (rows.get(key) ?? []) as Row[] }
      }
      if (normalized.startsWith('SELECT id, account_id, plan_id, provider')) {
        const key = `order:${String(params[0])}`
        return { rows: (rows.get(key) ?? []) as Row[] }
      }
      if (normalized.startsWith('SELECT id, order_id, provider, event_type')) {
        const key = `event:${String(params[0])}`
        return { rows: (rows.get(key) ?? []) as Row[] }
      }
      if (normalized.startsWith('SELECT plan_id, current_period_end')) {
        const key = `active-sub:${String(params[0])}`
        return { rows: (rows.get(key) ?? []) as Row[] }
      }
      if (normalized.startsWith('SELECT id, account_id, plan_id, capabilities')) {
        const key = `revision:${String(params[0])}`
        return { rows: (rows.get(key) ?? []) as Row[] }
      }
      if (normalized.startsWith('SELECT MAX(revision)')) {
        const key = `revision-max:${String(params[0])}`
        return { rows: (rows.get(key) ?? [{ revision: 0 }]) as Row[] }
      }
      if (normalized.startsWith('UPDATE subscription_orders')) {
        const key = `order:${String(params[0])}`
        const existing = rows.get(key) ?? []
        const updated = existing.map((row) => ({ ...row, status: 'paid', provider_transaction_id: params[1], paid_at: params[2], updated_at: params[3] }))
        rows.set(key, updated)
        return { rows: updated as unknown as Row[] }
      }
      return { rows: [] as Row[] }
    },
  }
  return { client, calls, rows }
}

describe('SubscriptionStore', () => {
  test('initializeSchema 执行 schema SQL', async () => {
    const { client, calls } = createFakeClient()
    const store = new SubscriptionStore(client)
    await store.initializeSchema('CREATE TABLE test (id TEXT PRIMARY KEY);')
    expect(calls[0]?.sql).toContain('CREATE TABLE test')
  })

  test('创建账号后可按 phoneHash 查询', async () => {
    const { client, rows } = createFakeClient()
    const store = new SubscriptionStore(client)
    const account = await store.createAccount({ phoneHash: 'hash-1', displayName: 'Alice' })
    rows.set(`account:${account.id}`, [{
      id: account.id,
      phone_hash: 'hash-1',
      oauth_subject_hash: null,
      display_name: 'Alice',
      disabled_at: null,
      created_at: account.createdAt,
      updated_at: account.updatedAt,
    }])
    rows.set(`account:hash-1`, [])
    const found = await store.findAccountById(account.id)
    expect(found?.id).toBe(account.id)
    expect(found?.phoneHash).toBe('hash-1')
  })

  test('创建订单后可按 id 查询', async () => {
    const { client, rows } = createFakeClient()
    const store = new SubscriptionStore(client)
    const account = await store.createAccount({ phoneHash: 'hash-2' })
    const order = await store.createOrder({ accountId: account.id, planId: 'pro', provider: 'wechat-pay', amountCny: 6800, period: 'yearly', expiresAt: Date.now() + 60_000 })
    rows.set(`order:${order.id}`, [{
      id: order.id,
      account_id: account.id,
      plan_id: 'pro',
      provider: 'wechat-pay',
      amount_cny: 6800,
      currency: 'CNY',
      status: 'pending',
      period: 'yearly',
      provider_transaction_id: null,
      expires_at: order.expiresAt,
      paid_at: null,
      created_at: order.createdAt,
      updated_at: order.updatedAt,
    }])
    const found = await store.findOrderById(order.id)
    expect(found?.id).toBe(order.id)
    expect(found?.status).toBe('pending')
  })

  test('markOrderPaid 只更新 pending 订单', async () => {
    const { client, rows } = createFakeClient()
    const store = new SubscriptionStore(client)
    const account = await store.createAccount({ phoneHash: 'hash-3' })
    const order = await store.createOrder({ accountId: account.id, planId: 'pro', provider: 'alipay', amountCny: 6800, period: 'monthly', expiresAt: Date.now() + 60_000 })
    rows.set(`order:${order.id}`, [{
      id: order.id,
      account_id: account.id,
      plan_id: 'pro',
      provider: 'alipay',
      amount_cny: 6800,
      currency: 'CNY',
      status: 'pending',
      period: 'monthly',
      provider_transaction_id: null,
      expires_at: order.expiresAt,
      paid_at: null,
      created_at: order.createdAt,
      updated_at: order.updatedAt,
    }])
    const paid = await store.markOrderPaid({ orderId: order.id, providerTransactionId: 'txn-1', paidAt: Date.now() })
    expect(paid?.status).toBe('paid')
    expect(paid?.providerTransactionId).toBe('txn-1')
  })

  test('支付事件可按幂等键查询', async () => {
    const { client, rows } = createFakeClient()
    const store = new SubscriptionStore(client)
    const account = await store.createAccount({ phoneHash: 'hash-4' })
    const order = await store.createOrder({ accountId: account.id, planId: 'pro', provider: 'wechat-pay', amountCny: 6800, period: 'monthly', expiresAt: Date.now() + 60_000 })
    const event = await store.insertPaymentEvent({ orderId: order.id, provider: 'wechat-pay', eventType: 'payment.success', idempotencyKey: 'idem-1', verified: true, payloadSummary: { amount: 6800 } })
    rows.set(`event:${event.idempotencyKey}`, [{
      id: event.id,
      order_id: order.id,
      provider: 'wechat-pay',
      event_type: 'payment.success',
      idempotency_key: 'idem-1',
      verified: true,
      payload_summary: JSON.stringify({ amount: 6800 }),
      created_at: event.createdAt,
    }])
    const found = await store.findPaymentEventByIdempotencyKey('idem-1')
    expect(found?.idempotencyKey).toBe('idem-1')
    expect(found?.verified).toBe(true)
  })

  test('可创建 entitlement revision 并查询最新版本', async () => {
    const { client, rows } = createFakeClient()
    const store = new SubscriptionStore(client)
    const account = await store.createAccount({ phoneHash: 'hash-5' })
    const revision = await store.createEntitlementRevision({ accountId: account.id, planId: 'pro', capabilities: ['influencer'], status: 'active', validUntil: Date.now() + 30 * 24 * 60 * 60 * 1000, reason: 'order.paid', revision: 1 })
    rows.set(`revision:${account.id}`, [{
      id: revision.id,
      account_id: account.id,
      plan_id: 'pro',
      capabilities: JSON.stringify(['influencer']),
      status: 'active',
      valid_until: revision.validUntil ?? null,
      reason: 'order.paid',
      revision: 1,
      created_at: revision.createdAt,
    }])
    const latest = await store.findLatestEntitlementRevision(account.id)
    expect(latest?.revision).toBe(1)
    expect(latest?.capabilities).toEqual(['influencer'])
  })
})
