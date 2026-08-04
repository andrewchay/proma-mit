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

  /**
   * 跨 task 扫描窗口内的 span（P-II Signals 检测依赖）。
   * 可按 kind / status / toolName(name 前缀) 过滤。
   */
  async querySpansInWindow(scope: AgentRuntimeScope, input: {
    from: number
    kind?: RuntimeSpan['kind']
    status?: RuntimeSpanStatus
    /** 完全匹配 tool:xxx 或 provider:xxx 的 name 前缀（如 'tool:Bash'）。 */
    namePrefix?: string
    limit?: number
  }): Promise<RuntimeSpan[]> {
    const limit = Math.min(input.limit ?? 1_000, 5_000)
    const conditions = ['tenant_id = $1', 'user_id = $2', 'started_at >= $3']
    const params: unknown[] = [scope.tenantId, scope.userId, input.from]
    if (input.kind) { conditions.push(`kind = $${params.length + 1}`); params.push(input.kind) }
    if (input.status) { conditions.push(`status = $${params.length + 1}`); params.push(input.status) }
    if (input.namePrefix) { conditions.push(`name LIKE $${params.length + 1}`); params.push(`${input.namePrefix}%`) }
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT trace_id, tenant_id, user_id, session_id, task_id, parent_span_id, span_id,
              kind, name, started_at, ended_at, status, error, meta
       FROM proma_runtime_spans
       WHERE ${conditions.join(' AND ')}
       ORDER BY started_at ASC LIMIT $${params.length + 1}`,
      [...params, limit],
    )
    return result.rows.map(toRuntimeSpan)
  }

  /** 窗口内指定 name 前缀的 span 错误计数（provider / tool 失败频率检测）。 */
  async countErrorsInWindow(scope: AgentRuntimeScope, input: { from: number; namePrefix?: string; kind?: RuntimeSpan['kind'] }): Promise<number> {
    const conditions = ['tenant_id = $1', 'user_id = $2', 'started_at >= $3', "status = 'error'"]
    const params: unknown[] = [scope.tenantId, scope.userId, input.from]
    if (input.kind) { conditions.push(`kind = $${params.length + 1}`); params.push(input.kind) }
    if (input.namePrefix) { conditions.push(`name LIKE $${params.length + 1}`); params.push(`${input.namePrefix}%`) }
    const result = await this.client.query<{ count: number | string | null }>(
      `SELECT COUNT(*) AS count FROM proma_runtime_spans WHERE ${conditions.join(' AND ')}`,
      params,
    )
    return toSafeNumber(result.rows[0]?.count)
  }

  /** 同一 name 前缀在窗口内不同 task/session 是否重复出现错误（循环/卡死雏形——简化：按错误次数聚合）。 */
  async toolFailureRuns(scope: AgentRuntimeScope, input: {
    from: number
    namePrefix: string
    minFailures: number
  }): Promise<{ spanValues: Array<{ taskId: string; count: number }> }> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT task_id, COUNT(*) AS cnt
       FROM proma_runtime_spans
       WHERE tenant_id = $1 AND user_id = $2 AND started_at >= $3 AND status = 'error'
         AND name LIKE $4
       GROUP BY task_id HAVING COUNT(*) >= $5
       ORDER BY cnt DESC LIMIT 100`,
      [scope.tenantId, scope.userId, input.from, `${input.namePrefix}%`, input.minFailures],
    )
    return {
      spanValues: result.rows.map((row) => ({ taskId: String(row.task_id), count: toSafeNumber(row.cnt) })),
    }
  }

  /** P-III：列出当前 scope 最近任务最小元数据（供 Agent 自查 ListRecentRuns）。 */
  async listRecentTasks(scope: AgentRuntimeScope, limit = 20): Promise<Array<{ taskId: string; sessionId: string; status: string; startedAt: number; completedAt?: number }>> {
    const limited = Math.min(limit, 100)
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT task_id, session_id, status, started_at, completed_at
       FROM proma_runtime_tasks
       WHERE tenant_id = $1 AND user_id = $2
       ORDER BY started_at DESC LIMIT $3`,
      [scope.tenantId, scope.userId, limited],
    )
    return result.rows.map((row) => ({
      taskId: String(row.task_id),
      sessionId: String(row.session_id),
      status: String(row.status),
      startedAt: toSafeNumber(row.started_at),
      ...(row.completed_at == null ? {} : { completedAt: toSafeNumber(row.completed_at) }),
    }))
  }

  /** P-III：按关键字（name/error）搜索 window 内 span。 */
  async searchSpans(scope: AgentRuntimeScope, input: {
    query?: string
    kind?: RuntimeSpan['kind']
    status?: RuntimeSpanStatus
    sinceMs?: number
    limit?: number
  }): Promise<RuntimeSpan[]> {
    const limited = Math.min(input.limit ?? 50, 200)
    const from = input.sinceMs == null ? 0 : Date.now() - input.sinceMs
    const conditions = ['tenant_id = $1', 'user_id = $2', 'started_at >= $3']
    const params: unknown[] = [scope.tenantId, scope.userId, from]
    if (input.kind) { conditions.push(`kind = $${params.length + 1}`); params.push(input.kind) }
    if (input.status) { conditions.push(`status = $${params.length + 1}`); params.push(input.status) }
    if (input.query) { conditions.push(`(name ILIKE $${params.length + 1} OR COALESCE(error,'') ILIKE $${params.length + 1})`); params.push(`%${input.query}%`) }
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT trace_id, tenant_id, user_id, session_id, task_id, parent_span_id, span_id,
              kind, name, started_at, ended_at, status, error, meta
       FROM proma_runtime_spans WHERE ${conditions.join(' AND ')}
       ORDER BY started_at DESC LIMIT $${params.length + 1}`,
      [...params, limited],
    )
    return result.rows.map(toRuntimeSpan)
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
