import { describe, expect, test } from 'bun:test'
import { PostgresAuditLog } from './audit.ts'
import type { AgentRuntimePostgresClient } from '@gravitas/shared/utils'

interface AuditRow {
  id?: number
  tenant_id: string
  user_id: string
  action: string
  resource: string
  result: string
  request_id?: string | null
  trace_id?: string | null
  task_id?: string | null
  created_at: number
  prev_hash?: string | null
  hash?: string | null
}

const SCOPE = { tenantId: 'tenant-a', userId: 'user-a' }

/** 内存假库：模拟 Postgres 中最新的 hash 查询 + 插入 + 全量返回，供 hash chain 测试 */
function makeMemoryDb() {
  const rows: AuditRow[] = []
  let nextId = 1
  const client: AgentRuntimePostgresClient = {
    query: async <Row extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
      // SELECT 链尾 hash
      if (sql.includes('ORDER BY id DESC LIMIT 1')) {
        const tenant = String(params[0])
        const last = [...rows].filter((r) => r.tenant_id === tenant).sort((a, b) => (a.id ?? 0) - (b.id ?? 0)).at(-1)
        return { rows: (last ? [{ hash: last.hash ?? null }] : []) as unknown as Row[] }
      }
      // INSERT
      if (sql.startsWith('INSERT INTO proma_runtime_audit_log')) {
        const row: AuditRow = {
          id: nextId++, tenant_id: String(params[0]), user_id: String(params[1]),
          action: String(params[2]), resource: String(params[3]), result: String(params[4]),
          request_id: params[5] == null ? null : String(params[5]),
          trace_id: params[6] == null ? null : String(params[6]),
          task_id: params[7] == null ? null : String(params[7]),
          created_at: Number(params[8]),
          prev_hash: params[9] == null ? null : String(params[9]),
          hash: params[10] == null ? null : String(params[10]),
        }
        rows.push(row)
        return { rows: [] }
      }
      // SELECT 全量（verifyChain）
      if (sql.includes('ORDER BY id ASC')) {
        const tenant = String(params[0])
        const filtered = [...rows].filter((r) => r.tenant_id === tenant).sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
        return { rows: filtered as unknown as Row[] }
      }
      return { rows: [] }
    },
  }
  return { client, rows }
}

describe('P4 audit log hash chain', () => {
  test('append 会计算并按租户链接 hash（首条 prev_hash 为空）', async () => {
    const { client } = makeMemoryDb()
    const audit = new PostgresAuditLog(client)
    await audit.append({ ...SCOPE, action: 'POST /x', resource: '/x', result: 'success', createdAt: 1000 })

    const chain = await audit.verifyChain(SCOPE)
    expect(chain.records).toHaveLength(1)
    expect(chain.records[0]?.prevHash).toBe('')
    expect(chain.records[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(chain.valid).toBe(true)
  })

  test('两条记录形成链表：第二条 prev_hash 等于第一条 hash', async () => {
    const { client } = makeMemoryDb()
    const audit = new PostgresAuditLog(client)
    await audit.append({ ...SCOPE, action: 'a1', resource: '/1', result: 'success', createdAt: 1 })
    await audit.append({ ...SCOPE, action: 'a2', resource: '/2', result: 'success', createdAt: 2 })

    const chain = await audit.verifyChain(SCOPE)
    expect(chain.records).toHaveLength(2)
    expect(chain.records[1]?.prevHash).toBe(chain.records[0]?.hash)
    expect(chain.valid).toBe(true)
  })

  test('篡改中间记录的字段后 verifyChain 检测为 invalid', async () => {
    const { client, rows } = makeMemoryDb()
    const audit = new PostgresAuditLog(client)
    await audit.append({ ...SCOPE, action: 'a1', resource: '/1', result: 'success', createdAt: 1 })
    await audit.append({ ...SCOPE, action: 'a2', resource: '/2', result: 'success', createdAt: 2 })
    await audit.append({ ...SCOPE, action: 'a3', resource: '/3', result: 'success', createdAt: 3 })

    // 篡改第 2 条的 action
    const row = rows.find((r) => r.action === 'a2')!
    row.action = 'HACKED'

    const chain = await audit.verifyChain(SCOPE)
    expect(chain.valid).toBe(false)
  })

  test('不同租户的链互不影响（按 tenant 隔离）', async () => {
    const { client } = makeMemoryDb()
    const audit = new PostgresAuditLog(client)
    await audit.append({ ...SCOPE, action: 'x', resource: '/t-a', result: 'success', createdAt: 1 })
    await audit.append({ tenantId: 'tenant-b', userId: 'user-b', action: 'y', resource: '/t-b', result: 'success', createdAt: 1 })

    const chainA = await audit.verifyChain(SCOPE)
    const chainB = await audit.verifyChain({ tenantId: 'tenant-b', userId: 'user-b' })

    expect(chainA.records).toHaveLength(1)
    expect(chainB.records).toHaveLength(1)
    expect(chainA.records[0]?.resource).toBe('/t-a')
    expect(chainA.records[0]?.hash).not.toBe(chainB.records[0]?.hash)
  })
})
