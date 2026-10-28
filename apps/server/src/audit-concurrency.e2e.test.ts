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
    await sql.unsafe('DELETE FROM proma_runtime_audit_legal_holds WHERE tenant_id = $1', [scope.tenantId])
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

  test('Given 同租户其他用户设置法律保全 When 清理审计 Then 拒绝删除', async () => {
    await first.createLegalHold({ ...scope, userId: 'legal-user', holdId: 'hold-1', reason: '保全' })
    await expect(second.purgeBefore(scope, Date.now() + 1000)).rejects.toThrow('法律保全')
    expect((await first.verifyChain(scope)).valid).toBe(true)
    expect(await first.releaseLegalHold({ ...scope, userId: 'legal-user' }, 'hold-1')).toBe(true)
  })

  test('Given 保全事务先持有租户锁 When 清理并发执行 Then 等待保全提交并拒绝清理', async () => {
    let signalLocked = () => {}
    let release = () => {}
    const locked = new Promise<void>((resolve) => { signalLocked = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const holding = client.transaction(async (transaction) => {
      await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 17493621))', [scope.tenantId])
      signalLocked()
      await gate
      await transaction.query('INSERT INTO proma_runtime_audit_legal_holds (tenant_id, user_id, hold_id, reason, created_at) VALUES ($1,$2,$3,$4,$5)', [scope.tenantId, 'legal-user', 'hold-2', '保全', Date.now()])
    })
    await locked
    const purging = second.purgeBefore(scope, Date.now() + 1000)
    const result = purging.then(() => '', (error: unknown) => error instanceof Error ? error.message : String(error))
    release()
    await holding
    expect(await result).toContain('法律保全')
    expect(await first.releaseLegalHold({ ...scope, userId: 'legal-user' }, 'hold-2')).toBe(true)
  })
})
