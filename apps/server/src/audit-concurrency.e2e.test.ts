import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PostgresAuditLog } from './audit.ts'

const databaseUrl = process.env.PROMA_AUDIT_TEST_DATABASE_URL

describe.skipIf(!databaseUrl)('审计链真实 Postgres 并发', () => {
  const sql = new Bun.SQL(databaseUrl!)
  const otherSql = new Bun.SQL(databaseUrl!)
  const query = <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[] = []) => sql.unsafe<Row[]>(statement, [...params]).then((rows) => ({ rows }))
  const client = {
    query,
    transaction: async (run: (tx: { query: typeof query }) => Promise<void>) => {
      await sql.begin(async (transaction) => {
        await run({ query: (statement, params = []) => transaction.unsafe(statement, [...params]).then((rows) => ({ rows })) })
      })
    },
  }
  const first = new PostgresAuditLog(client)
  const second = new PostgresAuditLog({
    query: (statement, params = []) => otherSql.unsafe(statement, [...params]).then((rows) => ({ rows })),
    transaction: async (run) => { await otherSql.begin(async (transaction) => { await run({ query: (statement, params = []) => transaction.unsafe(statement, [...params]).then((rows) => ({ rows })) }) }) },
  })
  const scope = { tenantId: `audit-e2e-${crypto.randomUUID()}`, userId: 'user-a' }
  beforeAll(async () => { await first.initializeSchema() })
  afterAll(async () => {
    await sql.unsafe('DELETE FROM proma_runtime_audit_log WHERE tenant_id = $1', [scope.tenantId])
    await sql.close()
    await otherSql.close()
  })

  test('Given 同租户两个 worker 并发追加 When 校验链 Then 所有记录连续', async () => {
    await Promise.all(Array.from({ length: 50 }, (_, index) => (index % 2 ? first : second).append({ ...scope, action: `action-${index}`, resource: '/task', result: 'success' })))
    const chain = await first.verifyChain(scope)
    expect(chain.records).toHaveLength(50)
    expect(chain.valid).toBe(true)
  })

  test('Given 事务提交前失败 When 追加审计 Then 插入回滚且链仍完整', async () => {
    const failing = new PostgresAuditLog({
      query,
      transaction: async (run) => { await client.transaction(async (transaction) => { await run(transaction); throw new Error('模拟提交前失败') }) },
    })
    const before = await first.verifyChain(scope)
    await expect(failing.append({ ...scope, action: 'rolled-back', resource: '/task', result: 'success' })).rejects.toThrow('模拟提交前失败')
    const after = await first.verifyChain(scope)
    expect(after.records).toHaveLength(before.records.length)
    expect(after.valid).toBe(true)
  })
})
