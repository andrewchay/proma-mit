import { describe, expect, test } from 'bun:test'
import { EntitlementService } from './entitlement-service'
import { SubscriptionStore } from '../db/subscription-store'
import type { AgentRuntimePostgresClient } from '@gravitas/shared/utils'

function fakeClient(): AgentRuntimePostgresClient {
  return {
    query: async <Row extends Record<string, unknown>>(_sql: string, _params: readonly unknown[] = []) => ({ rows: [] as Row[] }),
  }
}

describe('EntitlementService', () => {
  test('未配置私钥时使用 dev 签名且可验证', async () => {
    const store = new SubscriptionStore(fakeClient())
    const service = new EntitlementService(store, undefined, undefined, 'dev-1')
    const snapshot = await service.issueEntitlement({ accountId: 'acct-1', planId: 'pro', status: 'active', reason: 'test' })
    expect(snapshot.signature.startsWith('dev.')).toBe(true)
    expect(service.verifySnapshot(snapshot, snapshot.signature)).toBe(true)
  })

  test('active entitlement 生成 active 状态', async () => {
    const store = new SubscriptionStore(fakeClient())
    const service = new EntitlementService(store, undefined, undefined, 'dev-1')
    const snapshot = await service.issueEntitlement({ accountId: 'acct-2', planId: 'pro', status: 'active', validUntil: Date.now() + 60_000, reason: 'test' })
    expect(snapshot.status).toBe('active')
    expect(snapshot.planId).toBe('pro')
  })

  test('过期 entitlement 生成 grace 状态', async () => {
    const store = new SubscriptionStore(fakeClient())
    const service = new EntitlementService(store, undefined, undefined, 'dev-1')
    const snapshot = await service.issueEntitlement({ accountId: 'acct-3', planId: 'pro', status: 'active', validUntil: Date.now() - 1000, reason: 'test' })
    expect(snapshot.status).toBe('grace')
    expect(snapshot.graceUntil).toBeDefined()
  })
})
