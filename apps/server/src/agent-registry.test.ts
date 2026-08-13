import { describe, expect, it } from 'bun:test'
import { AgentRegistryStore } from './agent-registry'
import type { AgentRuntimePostgresClient } from '@gravitas/shared/utils'

/** 用 mock query 函数记录 SQL 与参数，避免真实 Postgres 依赖（与 scheduler-store.test.ts 同模式） */
function makeMockClient(rowsForLatestOnly = false): {
  client: AgentRuntimePostgresClient
  calls: Array<{ sql: string; params: readonly unknown[] }>
} {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = []
  const client: AgentRuntimePostgresClient = {
    query: async <Row extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params })
      // 仅当 SQL 带 RETURNING 或该用例显式需要返回行时返回数据
      return { rows: (sql.includes('SELECT') && !rowsForLatestOnly ? [] : []) as unknown as Row[] }
    },
  }
  return { client, calls }
}

const SCOPE = { tenantId: 'tenant-a', userId: 'user-a' }

describe('AgentRegistryStore', () => {
  it('initializeSchema 创建 registry 表（幂等）', async () => {
    const { client, calls } = makeMockClient()
    const store = new AgentRegistryStore(client)
    await store.initializeSchema()
    expect(calls[0]?.sql).toContain('CREATE TABLE IF NOT EXISTS proma_runtime_agent_registry')
    expect(calls[0]?.sql).toContain('PRIMARY KEY (tenant_id, card_id)')
  })

  it('upsert 带租户隔离写库并触发 ON CONFLICT 更新', async () => {
    const { client, calls } = makeMockClient()
    const store = new AgentRegistryStore(client)
    await store.upsert(SCOPE, {
      cardId: 'emp-1', source: 'employee', employeeId: 'emp-1', name: '小王', role: '内容运营',
      description: '', capabilities: ['docx'], enabled: true, createdAt: 1, updatedAt: 2,
    })
    const upsert = calls.find((c) => c.sql.includes('INSERT INTO proma_runtime_agent_registry'))
    expect(upsert).toBeDefined()
    expect(upsert?.sql).toContain('ON CONFLICT (tenant_id, card_id) DO UPDATE')
    expect(upsert?.params[0]).toBe('tenant-a') // tenant_id
    expect(JSON.parse(String(upsert?.params[6]))).toEqual(['docx']) // capabilities
    expect(upsert?.params[9]).toBe(1) // enabled
  })

  it('list 按租户 scope 过滤，仅返回该租户的卡片', async () => {
    const rows = [{
      card_id: 'emp-1', source: 'employee', name: '小王', role: '内容运营',
      description: '', capabilities: '["docx"]', fixed_workflow_id: null,
      execution_stats: JSON.stringify({ totalRuns: 3, completedRuns: 2, failureCount: 1, avgDurationMs: 12000 }),
      enabled: 1, created_at: 1, updated_at: 2,
    }]
    let sqlSeen = ''
    const client: AgentRuntimePostgresClient = {
      query: async <Row extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
        sqlSeen = sql
        return { rows: rows as unknown as Row[] }
      },
    }
    const store = new AgentRegistryStore(client)
    const cards = await store.list(SCOPE, { source: 'employee' })

    expect(sqlSeen).toContain('WHERE tenant_id = $1')
    expect(sqlSeen).toContain('source = $2')
    expect(cards).toHaveLength(1)
    expect(cards[0]?.cardId).toBe('emp-1')
    expect(cards[0]?.capabilities).toEqual(['docx'])
    expect(cards[0]?.fixedWorkflowId).toBeUndefined()
    expect(cards[0]?.executionStats).toEqual({ totalRuns: 3, completedRuns: 2, failureCount: 1, avgDurationMs: 12000 })
    expect(cards[0]?.enabled).toBe(true)
  })

  it('list 解析 fixed_workflow_id 与 disabled 卡片', async () => {
    const rows = [{
      card_id: 'emp-2', source: 'employee', name: '小王2', role: 'SOP岗',
      description: '', capabilities: '[]', fixed_workflow_id: 'wf-9', execution_stats: null,
      enabled: 0, created_at: 1, updated_at: 2,
    }]
    const client: AgentRuntimePostgresClient = {
      query: async <Row extends Record<string, unknown>>(_sql: string, _params: readonly unknown[] = []) => ({ rows: rows as unknown as Row[] }),
    }
    const store = new AgentRegistryStore(client)
    const cards = await store.list(SCOPE, { enabled: false })
    expect(cards[0]?.fixedWorkflowId).toBe('wf-9')
    expect(cards[0]?.enabled).toBe(false)
    expect(cards[0]?.executionStats).toBeUndefined()
  })
})
