import { describe, expect, it } from 'bun:test'
import { PostgresAuthSessionStore } from './auth-session-store'
import type { AgentRuntimePostgresClient } from '@gravitas/shared/utils'

describe('PostgresAuthSessionStore', () => {
  it('initializeSchema 创建会话表（幂等）', async () => {
    const calls: string[] = []
    const client: AgentRuntimePostgresClient = { query: async (_sql: string) => { calls.push(_sql); return { rows: [] } } }
    const store = new PostgresAuthSessionStore(client)
    await store.initializeSchema()
    expect(calls[0]).toContain('CREATE TABLE IF NOT EXISTS proma_runtime_auth_sessions')
    expect(calls.join(' ')).toContain('CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires')
  })

  it('create 写入会话；get 按 sessionId 读取未过期会话', async () => {
    const future = Date.now() + 60_000
    const rows = [{ session_id: 's1', tenant_id: 'tenant-a', user_id: 'admin-1', roles: '["admin"]', expires_at: future }]
    const calls: string[] = []
    const client: AgentRuntimePostgresClient = {
      query: async <Row extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
        calls.push(`${sql}::${params.join(',')}`)
        return { rows: (sql.includes('WHERE session_id') ? rows : []) as unknown as Row[] }
      },
    }
    const store = new PostgresAuthSessionStore(client)
    await store.create({ tenantId: 'tenant-a', userId: 'admin-1' }, 's1', ['admin'], future)
    const got = await store.get('s1', Date.now())
    expect(got).toEqual({ sessionId: 's1', tenantId: 'tenant-a', userId: 'admin-1', roles: ['admin'], expiresAt: future })
  })

  it('get 对过期会话返回 null', async () => {
    const expired = Date.now() - 1_000
    const rows = [{ session_id: 's1', tenant_id: 't', user_id: 'u', roles: '[]', expires_at: expired }]
    const client: AgentRuntimePostgresClient = {
      query: async <Row extends Record<string, unknown>>(sql: string, _params: readonly unknown[] = []) => ({ rows: (sql.includes('WHERE session_id') ? rows : []) as unknown as Row[] }),
    }
    const store = new PostgresAuthSessionStore(client)
    expect(await store.get('s1', Date.now())).toBeNull()
  })

  it('destroy 删除会话', async () => {
    const calls: string[] = []
    const client: AgentRuntimePostgresClient = { query: async (sql: string) => { calls.push(sql); return { rows: [] } } }
    const store = new PostgresAuthSessionStore(client)
    await store.destroy('s1')
    expect(calls[0]).toContain('DELETE FROM proma_runtime_auth_sessions')
  })
})
