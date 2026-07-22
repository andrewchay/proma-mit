import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '../types/agent'
import {
  AGENT_RUNTIME_POSTGRES_SCHEMA_SQL,
  PostgresTenantRuntimeStore,
  type AgentRuntimePostgresClient,
} from './agent-runtime-postgres-store'

const scope = { tenantId: 'tenant-a', userId: 'user-a' }

describe('PostgresTenantRuntimeStore', () => {
  test('given initializeSchema then required runtime tables are created', async () => {
    const client = new RecordingPostgresClient()
    const store = new PostgresTenantRuntimeStore(client)

    await store.initializeSchema()

    expect(client.calls[0]?.sql).toBe(AGENT_RUNTIME_POSTGRES_SCHEMA_SQL)
    expect(client.calls[0]?.sql).toContain('proma_runtime_credentials')
    expect(client.calls[0]?.sql).toContain('proma_runtime_session_messages')
    expect(client.calls[0]?.sql).toContain('proma_runtime_mcp_client_secrets')
  })

  test('given credential row then it maps from and to Postgres columns with tenant scope', async () => {
    const client = new RecordingPostgresClient()
    client.enqueueRows([
      {
        tenant_id: 'tenant-a',
        user_id: 'user-a',
        channel_id: 'deepseek',
        provider: 'deepseek',
        api_key: 'encoded-key',
        api_key_encoding: 'encoded',
        base_url: 'https://api.deepseek.com',
        default_model: 'deepseek-chat',
      },
    ])
    const store = new PostgresTenantRuntimeStore(client)

    await store.setCredential({
      ...scope,
      channelId: 'deepseek',
      provider: 'deepseek',
      apiKey: 'encoded-key',
      apiKeyEncoding: 'encoded',
      baseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek-chat',
    })
    const credential = await store.getCredential(scope, 'deepseek')

    expect(client.calls[0]?.params?.slice(0, 3)).toEqual(['tenant-a', 'user-a', 'deepseek'])
    expect(client.calls[1]?.sql).toContain('WHERE tenant_id = $1 AND user_id = $2 AND channel_id = $3')
    expect(client.calls[1]?.params).toEqual(['tenant-a', 'user-a', 'deepseek'])
    expect(credential).toMatchObject({
      tenantId: 'tenant-a',
      userId: 'user-a',
      channelId: 'deepseek',
      apiKeyEncoding: 'encoded',
    })
  })

  test('given workspace and messages then JSON values are written as jsonb and read back in order', async () => {
    const client = new RecordingPostgresClient()
    client.enqueueRows([
      { message_json: { type: 'user', uuid: 'u1' } },
      { message_json: JSON.stringify({ type: 'assistant', uuid: 'a1' }) },
    ])
    const store = new PostgresTenantRuntimeStore(client)
    const messages = [
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'a1' },
    ] as unknown as SDKMessage[]

    await store.setWorkspace({
      ...scope,
      workspaceSlug: 'main',
      cwd: '/tmp/workspace',
      mcpServers: { fs: { type: 'stdio', enabled: true, command: 'node', args: [] } },
    })
    await store.appendSessionMessages(scope, 'session-1', messages)
    const loaded = await store.getSessionMessages(scope, 'session-1')

    expect(client.calls[0]?.sql).toContain('$5::jsonb')
    expect(client.calls[0]?.params?.[4]).toContain('"fs"')
    expect(client.calls[1]?.sql).toContain('message_json')
    expect(client.calls[1]?.params?.slice(0, 3)).toEqual(['tenant-a', 'user-a', 'session-1'])
    expect(client.calls.at(-1)?.sql).toContain('ORDER BY message_index ASC')
    expect(loaded.map((message) => (message as { uuid?: string }).uuid)).toEqual(['u1', 'a1'])
  })

  test('given truncate request then delete is scoped by tenant, user, session and message index', async () => {
    const client = new RecordingPostgresClient()
    client.enqueueRows([{ message_index: 1 }])
    client.enqueueRows([{ message_json: { type: 'user', uuid: 'u1' } }])
    const store = new PostgresTenantRuntimeStore(client)

    const kept = await store.truncateSessionMessages(scope, 'session-1', 'u1')

    expect(client.calls[0]?.params).toEqual(['tenant-a', 'user-a', 'session-1', 'u1'])
    expect(client.calls[1]?.sql).toContain('message_index > $4')
    expect(client.calls[1]?.params).toEqual(['tenant-a', 'user-a', 'session-1', 1])
    expect(kept).toHaveLength(1)
  })
})

interface RecordedCall {
  sql: string
  params?: readonly unknown[]
}

class RecordingPostgresClient implements AgentRuntimePostgresClient {
  readonly calls: RecordedCall[] = []
  private readonly queuedRows: Record<string, unknown>[][] = []

  enqueueRows(rows: Record<string, unknown>[]): void {
    this.queuedRows.push(rows)
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Row[] }> {
    this.calls.push({ sql, params })
    const isRead = sql.trim().toUpperCase().startsWith('SELECT')
    return { rows: (isRead ? this.queuedRows.shift() ?? [] : []) as Row[] }
  }
}
