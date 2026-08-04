import type { AgentRuntimePostgresClient, AgentRuntimeScope } from '@proma/shared/utils'
import type { RuntimeSpan } from '@proma/shared'

/**
 * P-IV：评估数据集（Eval Datasets）。
 * 把 P-I 累积的真实运行（span 树 + meta）抽样成轻量结构化样本，供未来
 * 评估/回归流程消费，形成"追踪→采样→评估→再追踪"飞轮（对照 Laminar D4）。
 * 刻意不存完整 prompt/output，保持 local-first 轻量。
 */

export interface EvalDataset extends AgentRuntimeScope {
  datasetId: string
  name: string
  description?: string
  /** 0..1 抽样比例；1 表示全采。 */
  sampleRate: number
  /** 采样时间窗（毫秒）。 */
  windowMs: number
  count: number
  createdAt: number
}

export interface EvalSample extends AgentRuntimeScope {
  sampleId: string
  datasetId: string
  taskId: string
  kind: RuntimeSpan['kind']
  /** span 聚合名（如 provider:openai:gpt-4o / task:run）。 */
  name: string
  status: RuntimeSpan['status']
  durationMs: number
  /** 从 span meta 聚合的 token（若有）。 */
  inputTokens?: number
  outputTokens?: number
  costMicroUsd?: number
  error?: string
  rootedAt: number
}

export interface EvalDatasetQuery extends AgentRuntimeScope {
  limit?: number
}

export interface EvalSampleQuery extends AgentRuntimeScope {
  datasetId: string
  limit?: number
}

/** 采样需要的跨 task span 数据源（复用 span store，保持解耦）。 */
export interface EvalSpanSource {
  querySpansInWindow(scope: AgentRuntimeScope, input: { from: number; kind?: RuntimeSpan['kind']; status?: RuntimeSpan['status']; namePrefix?: string; limit?: number }): Promise<RuntimeSpan[]>
  listTaskTree(scope: AgentRuntimeScope, taskId: string): Promise<import('@proma/shared').RuntimeSpanNode[]>
}

export class PostgresEvalDatasetStore {
  constructor(private readonly client: AgentRuntimePostgresClient, private readonly spans: EvalSpanSource) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_runtime_eval_datasets (
      tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, dataset_id TEXT NOT NULL,
      name TEXT NOT NULL, description TEXT, sample_rate DOUBLE PRECISION NOT NULL,
      window_ms BIGINT NOT NULL, count BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, user_id, dataset_id))`)
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_runtime_eval_samples (
      tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, sample_id TEXT NOT NULL,
      dataset_id TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
      status TEXT NOT NULL, duration_ms BIGINT NOT NULL,
      input_tokens BIGINT, output_tokens BIGINT, cost_microusd BIGINT,
      error TEXT, rooted_at BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, user_id, dataset_id, task_id, sample_id))`)
  }

  /** 采样创建：窗口内按 sampleRate 抽运行画像成数据集。 */
  async createDatasetFromWindow(input: {
    scope: AgentRuntimeScope
    name: string
    description?: string
    windowMs: number
    sampleRate: number
  }): Promise<EvalDataset> {
    const now = Date.now()
    const dataset: EvalDataset = {
      ...input.scope,
      datasetId: randomUUID(),
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      sampleRate: input.sampleRate,
      windowMs: input.windowMs,
      count: 0,
      createdAt: now,
    }
    await this.client.query(
      `INSERT INTO proma_runtime_eval_datasets (tenant_id,user_id,dataset_id,name,description,sample_rate,window_ms,count,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8)`,
      [dataset.tenantId, dataset.userId, dataset.datasetId, dataset.name, dataset.description ?? null, dataset.sampleRate, dataset.windowMs, now],
    )
    // 采样生成样本
    const spanLimit = 5_000
    const spans = await this.spans.querySpansInWindow(input.scope, { from: now - input.windowMs, limit: spanLimit })
    const samples = await this.buildSamplesFromSpans(dataset, spans)
    for (const sample of samples) {
      await this.insertSample(dataset, sample.sampleId, sample)
    }
    if (samples.length > 0) {
      await this.client.query(
        `UPDATE proma_runtime_eval_datasets SET count = $4 WHERE tenant_id = $1 AND user_id = $2 AND dataset_id = $3`,
        [dataset.tenantId, dataset.userId, dataset.datasetId, samples.length],
      )
    }
    return dataset
  }

  /** 手工归档：把一个具体 run 的 span 树固化为样本。 */
  async archiveRun(input: { scope: AgentRuntimeScope; datasetId: string; taskId: string }): Promise<EvalSample | undefined> {
    const dataset = await this.getDataset(input.scope, input.datasetId)
    if (!dataset) return undefined
    const tree = await this.spans.listTaskTree(input.scope, input.taskId)
    if (tree.length === 0) return undefined
    const root = tree[0]!
    const sample = flattenSample(dataset, root)
    await this.insertSample(dataset, randomUUID(), sample)
    await this.client.query(
      `UPDATE proma_runtime_eval_datasets SET count = count + 1 WHERE tenant_id = $1 AND user_id = $2 AND dataset_id = $3`,
      [input.scope.tenantId, input.scope.userId, input.datasetId],
    )
    return sample
  }

  async getDataset(scope: AgentRuntimeScope, datasetId: string): Promise<EvalDataset | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT tenant_id,user_id,dataset_id,name,description,sample_rate,window_ms,count,created_at
       FROM proma_runtime_eval_datasets WHERE tenant_id = $1 AND user_id = $2 AND dataset_id = $3`,
      [scope.tenantId, scope.userId, datasetId],
    )
    const row = result.rows[0]
    return row ? toDataset(row) : undefined
  }

  async listDatasets(query: EvalDatasetQuery): Promise<EvalDataset[]> {
    const limit = Math.min(query.limit ?? 100, 500)
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT tenant_id,user_id,dataset_id,name,description,sample_rate,window_ms,count,created_at
       FROM proma_runtime_eval_datasets WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [query.tenantId, query.userId, limit],
    )
    return result.rows.map(toDataset)
  }

  async deleteDataset(scope: AgentRuntimeScope, datasetId: string): Promise<boolean> {
    await this.client.query(
      `DELETE FROM proma_runtime_eval_samples WHERE tenant_id = $1 AND user_id = $2 AND dataset_id = $3`,
      [scope.tenantId, scope.userId, datasetId],
    )
    const result = await this.client.query<{ dataset_id: string }>(
      `DELETE FROM proma_runtime_eval_datasets WHERE tenant_id = $1 AND user_id = $2 AND dataset_id = $3 RETURNING dataset_id`,
      [scope.tenantId, scope.userId, datasetId],
    )
    return result.rows.length > 0
  }

  async listSamples(query: EvalSampleQuery): Promise<EvalSample[]> {
    const limit = Math.min(query.limit ?? 200, 1_000)
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT tenant_id,user_id,sample_id,dataset_id,task_id,kind,name,status,duration_ms,input_tokens,output_tokens,cost_microusd,error,rooted_at
       FROM proma_runtime_eval_samples WHERE tenant_id = $1 AND user_id = $2 AND dataset_id = $3
       ORDER BY rooted_at DESC LIMIT $4`,
      [query.tenantId, query.userId, query.datasetId, limit],
    )
    return result.rows.map(toSample)
  }

  private async buildSamplesFromSpans(dataset: EvalDataset, spans: RuntimeSpan[]): Promise<EvalSample[]> {
    const byTask = new Map<string, RuntimeSpan[]>()
    for (const span of spans) {
      const list = byTask.get(span.taskId) ?? []
      list.push(span)
      byTask.set(span.taskId, list)
    }
    const samples: EvalSample[] = []
    for (const [taskId, taskSpans] of byTask) {
      // 抽样：按 sampleRate 决定是否纳入该 task
      if (dataset.sampleRate < 1 && Math.random() > dataset.sampleRate) continue
      const sample = aggregateTaskSpans(dataset, taskId, taskSpans)
      if (sample) samples.push(sample)
    }
    return samples
  }

  private async insertSample(dataset: EvalDataset, sampleId: string, sample: EvalSample): Promise<void> {
    await this.client.query(
      `INSERT INTO proma_runtime_eval_samples (tenant_id,user_id,sample_id,dataset_id,task_id,kind,name,status,duration_ms,input_tokens,output_tokens,cost_microusd,error,rooted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (tenant_id, user_id, dataset_id, task_id, sample_id) DO NOTHING`,
      [sample.tenantId, sample.userId, sampleId, sample.datasetId, sample.taskId, sample.kind, sample.name, sample.status,
        sample.durationMs, sample.inputTokens ?? null, sample.outputTokens ?? null, sample.costMicroUsd ?? null,
        sample.error ?? null, sample.rootedAt],
    )
  }
}

function aggregateTaskSpans(dataset: EvalDataset, taskId: string, spans: RuntimeSpan[]): EvalSample | undefined {
  const root = spans.find((span) => !span.parentSpanId && span.kind === 'provider') ?? spans.find((span) => span.kind === 'provider') ?? spans[0]
  if (!root) return undefined
  const durationMs = root.endedAt >= root.startedAt ? root.endedAt - root.startedAt : 0
  const meta = isRecord(root.meta) ? root.meta : {}
  const firstError = spans.find((span) => span.status === 'error' && span.error)?.error
  return {
    ...dataset,
    sampleId: randomUUID(),
    taskId,
    kind: root.kind,
    name: root.name,
    status: spans.some((span) => span.status === 'error') ? 'error' : root.status,
    durationMs,
    ...(meta.inputTokens != null ? { inputTokens: toNum(meta.inputTokens) } : {}),
    ...(meta.outputTokens != null ? { outputTokens: toNum(meta.outputTokens) } : {}),
    ...(meta.costMicroUsd != null ? { costMicroUsd: toNum(meta.costMicroUsd) } : {}),
    ...(firstError ? { error: firstError } : {}),
    rootedAt: root.startedAt,
  }
}

function flattenSample(dataset: EvalDataset, node: import('@proma/shared').RuntimeSpanNode): EvalSample {
  const meta = isRecord(node.meta) ? node.meta : {}
  return {
    ...dataset,
    sampleId: randomUUID(),
    taskId: node.taskId,
    kind: node.kind,
    name: node.name,
    status: node.status,
    durationMs: node.endedAt >= node.startedAt ? node.endedAt - node.startedAt : 0,
    ...(meta.inputTokens != null ? { inputTokens: toNum(meta.inputTokens) } : {}),
    ...(meta.outputTokens != null ? { outputTokens: toNum(meta.outputTokens) } : {}),
    ...(node.error ? { error: node.error } : {}),
    rootedAt: node.startedAt,
  }
}

function toDataset(row: Record<string, unknown>): EvalDataset {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    datasetId: String(row.dataset_id),
    name: String(row.name),
    ...(row.description == null ? {} : { description: String(row.description) }),
    sampleRate: toNumF(row.sample_rate),
    windowMs: toNum(row.window_ms),
    count: toNum(row.count),
    createdAt: toNum(row.created_at),
  }
}

function toSample(row: Record<string, unknown>): EvalSample {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    sampleId: String(row.sample_id),
    datasetId: String(row.dataset_id),
    taskId: String(row.task_id),
    kind: String(row.kind) as RuntimeSpan['kind'],
    name: String(row.name),
    status: String(row.status) as RuntimeSpan['status'],
    durationMs: toNum(row.duration_ms),
    ...(row.input_tokens == null ? {} : { inputTokens: toNum(row.input_tokens) }),
    ...(row.output_tokens == null ? {} : { outputTokens: toNum(row.output_tokens) }),
    ...(row.cost_microusd == null ? {} : { costMicroUsd: toNum(row.cost_microusd) }),
    ...(row.error == null ? {} : { error: String(row.error) }),
    rootedAt: toNum(row.rooted_at),
  }
}

function toNum(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function toNumF(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function randomUUID(): string {
  const uuid = globalThis.crypto?.randomUUID
  if (uuid) return uuid.call(globalThis.crypto)
  return `dataset-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
