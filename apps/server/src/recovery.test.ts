import { describe, expect, test } from 'bun:test'
import { PostgresTaskRecoveryInspector } from './recovery.ts'

describe('P5 任务恢复诊断', () => {
  test('只返回当前租户中失去有效租约的运行任务', async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = []
    const inspector = new PostgresTaskRecoveryInspector({
      query: async <Row extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params })
        return { rows: [
          { tenant_id: 'tenant', user_id: 'user', task_id: 'missing', session_id: 's-1', started_at: '10', lease_expires_at: null },
          { tenant_id: 'tenant', user_id: 'user', task_id: 'expired', session_id: 's-2', started_at: '20', lease_expires_at: '30' },
        ] as unknown as Row[] }
      },
    }, 60_000)

    expect(await inspector.listStale({ tenantId: 'tenant', userId: 'user' })).toEqual([
      { tenantId: 'tenant', userId: 'user', taskId: 'missing', sessionId: 's-1', startedAt: 10, reason: 'lease_missing' },
      { tenantId: 'tenant', userId: 'user', taskId: 'expired', sessionId: 's-2', startedAt: 20, leaseExpiresAt: 30, reason: 'lease_expired' },
    ])
    expect(calls[0]?.sql).toContain("t.status = 'running'")
    expect(calls[0]?.params.slice(0, 2)).toEqual(['tenant', 'user'])
  })
})
