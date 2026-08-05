import { describe, expect, test } from 'bun:test'
import type { AgentRuntimeScope } from '@gravitas/shared/utils'
import { PostgresRunProfileAggregator } from './run-profile.ts'

const scope: AgentRuntimeScope = { tenantId: 'tenant', userId: 'user' }

class MemoryClient {
  spans: Record<string, unknown>[] = []
  usage: Record<string, unknown>[] = []
  audit: Record<string, unknown>[] = []

  async query<RowType extends Record<string, unknown> = Record<string, unknown>>(sql: string, _params: readonly unknown[] = []): Promise<{ rows: RowType[] }> {
    if (sql.includes('FROM proma_runtime_usage')) return { rows: this.usage as RowType[] }
    if (sql.includes('FROM proma_runtime_audit_log')) return { rows: this.audit as RowType[] }
    return { rows: this.spans as RowType[] }
  }
}

/** 用最小 span 查询 mock（仅需 listTask）。 */
function spanQuery(tree: unknown) {
  return { listTask: async () => tree } as unknown as import('./spans.ts').PostgresRuntimeSpanStore
}

describe('PostgresRunProfileAggregator（P-I 运行档案聚合）', () => {
  test('聚合 span 树 + usage + audit（traceId=taskId 关联）', async () => {
    const client = new MemoryClient()
    client.spans = []
    client.usage = [{ input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, cost_microusd: 123 }]
    client.audit = [{ action: 'POST /agent/sessions/x/run', resource: '/agent/sessions/x/run', result: 'success', created_at: 5 }]
    const agg = new PostgresRunProfileAggregator(client as never, spanQuery([]))
    const profile = await agg.profile(scope, 'task-1')
    expect(profile).toMatchObject({
      taskId: 'task-1',
      usage: { inputTokens: 10, outputTokens: 20, costMicroUsd: 123 },
      audit: [{ action: 'POST /agent/sessions/x/run', result: 'success', createdAt: 5 }],
    })
  })

  test('无任何数据时返回 undefined', async () => {
    const client = new MemoryClient()
    const agg = new PostgresRunProfileAggregator(client as never, spanQuery([]))
    const profile = await agg.profile(scope, 'ghost')
    expect(profile).toBeUndefined()
  })

  test('有 span 树但无 usage/audit 仍返回（span 树是主档案）', async () => {
    const client = new MemoryClient()
    const tree = [{ spanId: 'p', kind: 'provider', name: 'provider:x:y', status: 'ok', children: [] }]
    const agg = new PostgresRunProfileAggregator(client as never, spanQuery(tree))
    const profile = await agg.profile(scope, 'task-2')
    expect(profile?.trace).toHaveLength(1)
    expect(profile?.usage).toBeUndefined()
    expect(profile?.audit).toEqual([])
  })
})
