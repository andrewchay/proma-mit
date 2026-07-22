import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { RedisAgentRuntimeEventStore } from '@proma/shared/utils'
import { createClient } from 'redis'
import { PostgresTaskLease } from './app.ts'

const databaseUrl = process.env.PROMA_P2_TEST_DATABASE_URL
const redisUrl = process.env.PROMA_P2_TEST_REDIS_URL
const canRun = Boolean(databaseUrl && redisUrl)

describe.skipIf(!canRun)('P2 多实例真实基础设施验收', () => {
  const sql = new Bun.SQL(databaseUrl!)
  const redis = createClient({ url: redisUrl! })
  const query = async <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[] = []) => ({
    rows: await sql.unsafe<Row[]>(statement, [...params]),
  })
  const alpha = new PostgresTaskLease({ query }, 'worker-alpha', 30_000)
  const beta = new PostgresTaskLease({ query }, 'worker-beta', 30_000)
  const scope = { tenantId: `p2-${crypto.randomUUID()}`, userId: 'user-a' }
  const sessionId = 'session-a'

  beforeAll(async () => {
    await alpha.initializeSchema()
    await redis.connect()
  })

  afterAll(async () => {
    if (redis.isOpen) await redis.close()
    await sql.close()
  })

  test('两个 worker 不能同时取得同一 session 的 lease', async () => {
    expect(await alpha.acquire(scope, sessionId, 'task-alpha')).toBe(true)
    expect(await beta.acquire(scope, sessionId, 'task-beta')).toBe(false)
    await alpha.release(scope, sessionId, 'task-alpha')
    expect(await beta.acquire(scope, sessionId, 'task-beta')).toBe(true)
  })

  test('Redis durable event 可由另一实例重放', async () => {
    const client = {
      xadd: async (key: string, id: string, fields: Record<string, string>) => redis.xAdd(key, id, fields),
      xrange: async (key: string, start: string, end: string, options?: { count?: number }) =>
        (await redis.xRange(key, start, end, options?.count ? { COUNT: options.count } : undefined))
          .map((entry) => ({ id: entry.id, fields: entry.message })),
      set: async (key: string, value: string) => { await redis.set(key, value) },
      get: async (key: string) => (await redis.get(key)) ?? undefined,
      del: async (key: string) => { await redis.del(key) },
    }
    const writer = new RedisAgentRuntimeEventStore({ client })
    const reader = new RedisAgentRuntimeEventStore({ client })
    await writer.append({
      id: `${Date.now()}-1`,
      ...scope,
      sessionId,
      createdAt: Date.now(),
      payload: { kind: 'agent_event', event: { type: 'complete' } },
    })
    expect((await reader.replay({ ...scope, sessionId })).length).toBeGreaterThan(0)
  })
})
