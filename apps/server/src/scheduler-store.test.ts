import { expect, test } from 'bun:test'
import { PostgresServerSchedulerStore } from './scheduler-store.ts'

test('服务端 Scheduler 的 due claim 使用行锁并保留 worker 归属', async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = []
  const store = new PostgresServerSchedulerStore({ query: async <Row extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params }); return { rows: (sql.includes('RETURNING *') ? [{ tenant_id: 't', user_id: 'u', run_id: 'r', schedule_id: 's', session_id: 'session', prompt: '检查状态', status: 'claimed', worker_id: 'alpha', started_at: 1 }] : []) as unknown as Row[] }
  } })
  const claimed = await store.claimDue({ tenantId: 't', userId: 'u', scheduleId: 's', sessionId: 'session', prompt: '检查状态', schedule: { type: 'interval', intervalMs: 60_000 }, enabled: true, nextRunAt: 1 }, 'alpha', 60_001, 1)
  expect(calls[0]?.sql).toContain('FOR UPDATE SKIP LOCKED')
  expect(calls[0]?.sql).toContain('next_run_at = $5')
  expect(calls[0]?.sql).toContain('session_id,prompt,status')
  expect(claimed).toMatchObject({ tenantId: 't', workerId: 'alpha', status: 'claimed' })
})
