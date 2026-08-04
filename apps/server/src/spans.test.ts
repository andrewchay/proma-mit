import { describe, expect, test } from 'bun:test'
import { PostgresRuntimeSpanStore } from './spans.ts'

interface Row extends Record<string, unknown> {}

/** 内存 mock Postgres：记录所有 insert/update/select 到 rows 列表，供断言。 */
class MemorySpanClient {
  rows: Row[] = []

  async query<RowType extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<{ rows: RowType[] }> {
    if (sql.includes('INSERT INTO proma_runtime_spans')) {
      this.rows.push({
        trace_id: params[0],
        tenant_id: params[1],
        user_id: params[2],
        session_id: params[3],
        task_id: params[4],
        parent_span_id: params[5] ?? null,
        span_id: params[6],
        kind: params[7],
        name: params[8],
        started_at: params[9],
        ended_at: null,
        status: null,
        error: null,
        meta: null,
      })
      return { rows: [] }
    }
    if (sql.includes('UPDATE proma_runtime_spans')) {
      const [status, endedAt, error, meta, spanId] = params
      const target = this.rows.find((row) => row.span_id === spanId)
      if (target) {
        target.status = status
        target.ended_at = endedAt
        target.error = error
        target.meta = meta
      }
      return { rows: [] }
    }
    if (sql.includes('CREATE INDEX')) return { rows: [] }
    // SELECT
    const filtered = this.rows.filter((row) => row.tenant_id === params[0] && row.user_id === params[1] && row.task_id === params[2])
    return { rows: filtered as RowType[] }
  }
}

const scope = { tenantId: 'tenant', userId: 'user' }

function sqlClient(sqls: string[]): import('@proma/shared/utils').AgentRuntimePostgresClient {
  return {
    query: async <RowType extends Record<string, unknown> = Record<string, unknown>>(_sql: string): Promise<{ rows: RowType[] }> => {
      sqls.push(_sql)
      return { rows: [] as RowType[] }
    },
  }
}

describe('PostgresRuntimeSpanStore (P1 run profile)', () => {
  test('schema 初始化执行建表与索引语句', async () => {
    const sqls: string[] = []
    const store = new PostgresRuntimeSpanStore(sqlClient(sqls))
    await store.initializeSchema()
    expect(sqls.join('\n')).toContain('CREATE TABLE IF NOT EXISTS proma_runtime_spans')
    expect(sqls.join('\n')).toContain('CREATE INDEX')
  })

  test('provider span begin/end 后可按 task 组装为树节点且带 token meta', async () => {
    const client = new MemorySpanClient()
    const store = new PostgresRuntimeSpanStore(client)
    const traceId = 'trace-1'
    const taskId = 'task-1'
    const sessionId = 'session-1'
    const providerSpanId = 'provider-1'

    await store.begin({ ...scope, traceId, taskId, sessionId, spanId: providerSpanId, kind: 'provider', name: 'provider:openai:gpt-4o', startedAt: 100 })
    await store.end(providerSpanId, { status: 'ok', meta: { inputTokens: 10, outputTokens: 20 } })

    const tree = await store.listTask({ ...scope, taskId })
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ spanId: providerSpanId, kind: 'provider', name: 'provider:openai:gpt-4o', status: 'ok', meta: { inputTokens: 10, outputTokens: 20 }, children: [] })
    expect(tree[0]!.startedAt).toBeLessThanOrEqual(tree[0]!.endedAt)
  })

  test('provider → tool 通过 parent_span_id 组装为嵌套树', async () => {
    const client = new MemorySpanClient()
    const store = new PostgresRuntimeSpanStore(client)
    const traceId = 'trace-2'
    const taskId = 'task-2'
    const sessionId = 'session-2'
    const providerSpanId = 'provider-2'
    const bashSpanId = 'tool-2'

    await store.begin({ ...scope, traceId, taskId, sessionId, spanId: providerSpanId, kind: 'provider', name: 'provider:openai:gpt-4o', startedAt: 100 })
    await store.begin({ ...scope, traceId, taskId, sessionId, parentSpanId: providerSpanId, spanId: bashSpanId, kind: 'tool', name: 'tool:Bash', startedAt: 200 })
    await store.end(bashSpanId, { status: 'error', meta: { error: 'command failed …' } })
    await store.end(providerSpanId, { status: 'ok', meta: { inputTokens: 5 } })

    const tree = await store.listTask({ ...scope, taskId })
    expect(tree).toHaveLength(1)
    const provider = tree[0]!
    expect(provider.children).toHaveLength(1)
    expect(provider.children[0]!).toMatchObject({ spanId: bashSpanId, kind: 'tool', status: 'error', meta: { error: 'command failed …' }, children: [] })
  })

  test('无 parent 的多个 span 作为多个根返回', async () => {
    const client = new MemorySpanClient()
    const store = new PostgresRuntimeSpanStore(client)
    const traceId = 'trace-3'
    const taskId = 'task-3'
    const sessionId = 'session-3'
    await store.begin({ ...scope, traceId, taskId, sessionId, spanId: 'a', kind: 'provider', name: 'provider:a:a1', startedAt: 1 })
    await store.begin({ ...scope, traceId, taskId, sessionId, spanId: 'b', kind: 'provider', name: 'provider:b:b1', startedAt: 2 })
    await store.end('a', { status: 'ok' })
    await store.end('b', { status: 'ok' })
    const tree = await store.listTask({ ...scope, taskId })
    expect(tree).toHaveLength(2)
  })

  test('begin 写入不落完整负载，只有轻量 meta', async () => {
    const client = new MemorySpanClient()
    const store = new PostgresRuntimeSpanStore(client)
    await store.begin({ ...scope, traceId: 't', taskId: 'task', sessionId: 's', spanId: 'p', kind: 'provider', name: 'provider:x:y', startedAt: 1 })
    const stored = client.rows[0]!
    // meta 在 begin 阶段必须为 null；完整 prompt/output 不应进入。
    expect(stored.meta).toBeNull()
    expect(stored.error).toBeNull()
  })
})
