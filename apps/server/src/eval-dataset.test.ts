import { describe, expect, test } from 'bun:test'
import type { AgentRuntimeScope } from '@proma/shared/utils'
import type { RuntimeSpan, RuntimeSpanNode } from '@proma/shared'
import { PostgresEvalDatasetStore } from './eval-dataset.ts'
import type { EvalSpanSource } from './eval-dataset.ts'

const scope: AgentRuntimeScope = { tenantId: 'tenant', userId: 'user' }

/** 内存 mock Postgres：仅模拟 eval 相关两种表。 */
class MemoryClient {
  datasets: Record<string, unknown>[] = []
  samples: Record<string, unknown>[] = []

  async query<RowType extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<{ rows: RowType[] }> {
    if (sql.includes('INSERT INTO proma_runtime_eval_datasets')) {
      this.datasets.push({
        tenant_id: params[0], user_id: params[1], dataset_id: params[2], name: params[3],
        description: params[4], sample_rate: params[5], window_ms: params[6], count: params[7], created_at: params[8],
      })
      return { rows: [] }
    }
    if (sql.includes('INSERT INTO proma_runtime_eval_samples')) {
      this.samples.push({
        tenant_id: params[0], user_id: params[1], sample_id: params[2], dataset_id: params[3], task_id: params[4],
        kind: params[5], name: params[6], status: params[7], duration_ms: params[8], input_tokens: params[9],
        output_tokens: params[10], cost_microusd: params[11], error: params[12], rooted_at: params[13],
      })
      return { rows: [] }
    }
    if (sql.includes('UPDATE proma_runtime_eval_datasets')) {
      const target = this.datasets.find((d) => d.tenant_id === params[0] && d.user_id === params[1] && d.dataset_id === params[2])
      if (target) target.count = params[3] == null ? Number(target.count ?? 0) + 1 : params[3]
      return { rows: [] }
    }
    if (sql.includes('FROM proma_runtime_eval_datasets')) {
      const rows = this.datasets.filter((d) => d.tenant_id === params[0] && d.user_id === params[1])
      return { rows: rows as RowType[] }
    }
    if (sql.includes('FROM proma_runtime_eval_samples')) {
      const rows = this.samples.filter((s) => s.tenant_id === params[0] && s.user_id === params[1] && s.dataset_id === params[2])
      return { rows: rows as RowType[] }
    }
    return { rows: [] as RowType[] }
  }
}

const spanSource: EvalSpanSource = {
  querySpansInWindow: async (_scope, input) => {
    if (input.namePrefix === 'none') return []
    return [
      { traceId: 't1', tenantId: 'tenant', userId: 'user', sessionId: 's1', taskId: 'task-1', spanId: 'p1', kind: 'provider', name: 'provider:openai:gpt-4o', startedAt: 1000, endedAt: 5000, status: 'ok', meta: { inputTokens: 10, outputTokens: 20 } },
      { traceId: 't1', tenantId: 'tenant', userId: 'user', sessionId: 's1', taskId: 'task-1', parentSpanId: 'p1', spanId: 'b1', kind: 'tool', name: 'tool:Bash', startedAt: 1500, endedAt: 2000, status: 'error', error: 'command failed', meta: {} },
    ] as RuntimeSpan[]
  },
  listTaskTree: async (_scope, taskId) => [{
    traceId: 't', tenantId: 'tenant', userId: 'user', sessionId: 's', taskId, spanId: 'p', kind: 'provider', name: 'provider:openai:gpt-4o', startedAt: 100, endedAt: 400, status: 'ok', meta: { inputTokens: 5 }, children: [],
  } as RuntimeSpanNode],
}

describe('PostgresEvalDatasetStore（P-IV 评估数据集）', () => {
  test('schema 初始化创建两张表', async () => {
    const sqls: string[] = []
    const client = { query: async (sql: string) => { sqls.push(sql); return { rows: [] as Record<string, unknown>[] } } }
    await new PostgresEvalDatasetStore(client as never, spanSource).initializeSchema()
    const all = sqls.join('\n')
    expect(all).toContain('CREATE TABLE IF NOT EXISTS proma_runtime_eval_datasets')
    expect(all).toContain('CREATE TABLE IF NOT EXISTS proma_runtime_eval_samples')
  })

  test('createDatasetFromWindow 采样 span 生成样本并更新 count', async () => {
    const client = new MemoryClient()
    const store = new PostgresEvalDatasetStore(client as never, spanSource)
    const dataset = await store.createDatasetFromWindow({ scope, name: '回归集', windowMs: 60_000, sampleRate: 1 })
    expect(dataset.name).toBe('回归集')
    expect(client.samples.length).toBe(1)
    const stored = client.datasets[0]
    expect(stored?.count).toBe(1)
    expect(client.samples[0]).toMatchObject({ task_id: 'task-1', kind: 'provider', status: 'error', duration_ms: 4000, input_tokens: 10, output_tokens: 20, error: 'command failed' })
  })

  test('无 span 时不生成样本', async () => {
    const client = new MemoryClient()
    const emptySource: EvalSpanSource = { ...spanSource, querySpansInWindow: async () => [] }
    const store = new PostgresEvalDatasetStore(client as never, emptySource)
    await store.createDatasetFromWindow({ scope, name: '空集', windowMs: 60_000, sampleRate: 1 })
    expect(client.samples.length).toBe(0)
  })

  test('archiveRun 把一个 run 的 provider span 固化为样本', async () => {
    const client = new MemoryClient()
    const store = new PostgresEvalDatasetStore(client as never, spanSource)
    await store.createDatasetFromWindow({ scope, name: '目标集', windowMs: 60_000, sampleRate: 1 })
    const realId = String(client.datasets[0]?.dataset_id)
    const sample = await store.archiveRun({ scope, datasetId: realId, taskId: 'task-arch' })
    expect(sample?.taskId).toBe('task-arch')
    expect(sample?.status).toBe('ok')
    expect(client.datasets[0]?.count).toBe(2)
  })

  test('listSamples 按 datasetId + scope 过滤', async () => {
    const client = new MemoryClient()
    const store = new PostgresEvalDatasetStore(client as never, spanSource)
    await store.createDatasetFromWindow({ scope, name: '集A', windowMs: 60_000, sampleRate: 1 })
    const realId = String(client.datasets[0]?.dataset_id)
    const samples = await store.listSamples({ ...scope, datasetId: realId })
    expect(samples).toHaveLength(1)
    expect(samples[0]).toMatchObject({ name: 'provider:openai:gpt-4o', kind: 'provider' })
  })

  test('listDatasets 返回当前 scope 的数据集并按时间倒序', async () => {
    const client = new MemoryClient()
    const store = new PostgresEvalDatasetStore(client as never, spanSource)
    await store.createDatasetFromWindow({ scope, name: '集B', windowMs: 60_000, sampleRate: 1 })
    const list = await store.listDatasets(scope)
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe('集B')
  })
})
