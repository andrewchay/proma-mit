import type { AgentRuntimePostgresClient, AgentRuntimeScope } from '@proma/shared/utils'
import type {
  RuntimeSpan,
  RuntimeSpanBegin,
  RuntimeSpanNode,
  RuntimeSpanSink,
  RuntimeSpanStatus,
} from '@proma/shared'

export interface RuntimeSpanQuery extends AgentRuntimeScope {
  /** 按 task 聚合查询；P-I 阶段稳定 key。 */
  taskId: string
  /** 也可按 trace 聚合查询。 */
  traceId?: string
}

/**
 * 运行档案（Runtime Span）Postgres 存储。
 *
 * 一次 Agent 运行被持久化为一颗 span 树（provider → tool），支持按 task/trace
 * 聚合、按 parent_span_id 组装为嵌套树。表只存轻量 meta，不存完整 prompt/output。
 */
export class PostgresRuntimeSpanStore implements RuntimeSpanSink {
  constructor(private readonly client: AgentRuntimePostgresClient) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_runtime_spans (
      trace_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      parent_span_id TEXT,
      span_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      started_at BIGINT NOT NULL,
      ended_at BIGINT,
      status TEXT,
      error TEXT,
      meta JSONB,
      PRIMARY KEY (tenant_id, user_id, trace_id, span_id)
    )`)
    await this.client.query('CREATE INDEX IF NOT EXISTS proma_runtime_spans_task_idx ON proma_runtime_spans (tenant_id, user_id, task_id, started_at)')
    await this.client.query('CREATE INDEX IF NOT EXISTS proma_runtime_spans_parent_idx ON proma_runtime_spans (tenant_id, user_id, trace_id, parent_span_id)')
  }

  async begin(span: RuntimeSpanBegin): Promise<void> {
    await this.client.query(
      `INSERT INTO proma_runtime_spans (
        trace_id, tenant_id, user_id, session_id, task_id, parent_span_id, span_id,
        kind, name, started_at, ended_at, status, error, meta
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,NULL,NULL)
      ON CONFLICT (tenant_id, user_id, trace_id, span_id) DO NOTHING`,
      [span.traceId, span.tenantId, span.userId, span.sessionId, span.taskId, span.parentSpanId ?? null, span.spanId,
        span.kind, span.name, span.startedAt],
    )
  }

  async end(spanId: string, patch: { status: RuntimeSpanStatus; error?: string; meta?: Record<string, unknown> }): Promise<void> {
    await this.client.query(
      `UPDATE proma_runtime_spans SET status = $1, ended_at = $2, error = $3, meta = $4
       WHERE span_id = $5`,
      [patch.status, Date.now(), patch.error ?? null, patch.meta ? JSON.stringify(patch.meta) : null, spanId],
    )
  }

  async listTask(query: RuntimeSpanQuery): Promise<RuntimeSpanNode[]> {
    const spans = await this.querySpans(query)
    return buildSpanTree(spans)
  }

  private async querySpans(query: RuntimeSpanQuery): Promise<RuntimeSpan[]> {
    const limit = 2_000
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT trace_id, tenant_id, user_id, session_id, task_id, parent_span_id, span_id,
              kind, name, started_at, ended_at, status, error, meta
       FROM proma_runtime_spans
       WHERE tenant_id = $1 AND user_id = $2
         AND task_id = $3
       ORDER BY started_at ASC LIMIT $4`,
      [query.tenantId, query.userId, query.taskId, limit],
    )
    return result.rows.map(toRuntimeSpan)
  }
}

function toRuntimeSpan(row: Record<string, unknown>): RuntimeSpan {
  return {
    traceId: String(row.trace_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    taskId: String(row.task_id),
    ...(row.parent_span_id == null ? {} : { parentSpanId: String(row.parent_span_id) }),
    spanId: String(row.span_id),
    kind: String(row.kind) as RuntimeSpan['kind'],
    name: String(row.name),
    startedAt: toSafeNumber(row.started_at),
    endedAt: toSafeNumber(row.ended_at),
    status: String(row.status ?? 'ok') as RuntimeSpanStatus,
    ...(row.error == null ? {} : { error: String(row.error) }),
    ...(row.meta == null ? {} : { meta: parseJsonObject(row.meta) }),
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function toSafeNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

/** 把扁平的 span 列表按 parent_span_id 组装为嵌套树；根是不带 parent 或 parent 缺失的 span。 */
function buildSpanTree(spans: RuntimeSpan[]): RuntimeSpanNode[] {
  const byId = new Map<string, RuntimeSpanNode>()
  for (const span of spans) byId.set(span.spanId, { ...span, children: [] })
  const roots: RuntimeSpanNode[] = []
  for (const span of spans) {
    const node = byId.get(span.spanId)
    if (!node) continue
    const parent = span.parentSpanId ? byId.get(span.parentSpanId) : undefined
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}
