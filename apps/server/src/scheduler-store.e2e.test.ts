import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PostgresServerSchedulerStore } from './scheduler-store.ts'

const databaseUrl = process.env.PROMA_P2_TEST_DATABASE_URL

describe.skipIf(!databaseUrl)('服务端 Scheduler 的真实多 worker E2E', () => {
  const sql = new Bun.SQL(databaseUrl!)
  const client = {
    query: async <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[] = []) => ({
      rows: await sql.unsafe<Row[]>(statement, [...params]),
    }),
  }
  const store = new PostgresServerSchedulerStore(client)
  const scope = { tenantId: `scheduler-e2e-${crypto.randomUUID()}`, userId: 'user-a' }

  beforeAll(async () => { await store.initializeSchema() })
  afterAll(async () => {
    await sql.unsafe('DELETE FROM proma_runtime_schedule_runs WHERE tenant_id = $1 AND user_id = $2', [scope.tenantId, scope.userId])
    await sql.unsafe('DELETE FROM proma_runtime_schedules WHERE tenant_id = $1 AND user_id = $2', [scope.tenantId, scope.userId])
    await sql.close()
  })

  test('两个 worker 对同一个 overdue schedule 只能领取一次，且不会积压补跑', async () => {
    const now = Date.now()
    const schedule = await store.create({
      ...scope,
      sessionId: 'session-a',
      prompt: '检查状态',
      schedule: { type: 'interval', intervalMs: 60_000 },
      enabled: true,
      nextRunAt: now - 300_000,
    })

    const claims = await Promise.all([
      store.claimDue(schedule, 'worker-alpha', now + 60_000, now),
      store.claimDue(schedule, 'worker-beta', now + 60_000, now),
    ])
    const claimed = claims.filter((run): run is NonNullable<typeof run> => Boolean(run))

    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({ scheduleId: schedule.scheduleId, prompt: '检查状态' })

    const secondClaim = await store.claimDue(schedule, 'worker-gamma', now + 60_000, now + 1)
    expect(secondClaim).toBeUndefined()
  })

  test('Cron 计划将 IANA 时区持久化，并可由多 worker 原子领取', async () => {
    const now = Date.now()
    const schedule = await store.create({
      ...scope, sessionId: 'cron-session', prompt: 'Cron 检查', enabled: true,
      schedule: { type: 'cron', expression: '*/5 * * * * *', timezone: 'Asia/Shanghai' }, nextRunAt: now - 1,
    })
    const listed = await store.list(scope)
    expect(listed.find((item) => item.scheduleId === schedule.scheduleId)?.schedule).toEqual(schedule.schedule)
    const run = await store.claimDue(schedule, 'worker-alpha', now + 5_000, now)
    expect(run).toMatchObject({ scheduleId: schedule.scheduleId, prompt: 'Cron 检查' })
  })
})
