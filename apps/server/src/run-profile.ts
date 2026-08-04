import type { AgentRuntimePostgresClient, AgentRuntimeScope } from '@proma/shared/utils'
import type { RuntimeSpanNode } from '@proma/shared'
import type { PostgresRuntimeSpanStore } from './spans.ts'

/**
 * 运行档案聚合：把一次 run（traceId=taskId）的 span 树 + usage + audit 关联起来，
 * 支撑规格要求的"audit 事件、usage、provider 调用能被 trace_id 聚合成一棵树"。
 */

export interface RunProfileUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costMicroUsd?: number
}

export interface RunProfileAuditEvent {
  action: string
  resource: string
  result: string
  createdAt?: number
}

export interface RunProfile {
  taskId: string
  /** span 树（provider → tool），provider span meta 已含 costMicroUsd。 */
  trace: RuntimeSpanNode[]
  usage?: RunProfileUsage
  audit: RunProfileAuditEvent[]
}

export class PostgresRunProfileAggregator {
  constructor(private readonly client: AgentRuntimePostgresClient, private readonly spans: PostgresRuntimeSpanStore) {}

  async profile(scope: AgentRuntimeScope, taskId: string): Promise<RunProfile | undefined> {
    const trace = await this.spans.listTask({ ...scope, taskId })
    const usage = await this.loadUsage(scope, taskId)
    const audit = await this.loadAudit(scope, taskId)
    if (trace.length === 0 && !usage && audit.length === 0) return undefined
    return {
      taskId,
      trace,
      ...(usage ? { usage } : {}),
      audit,
    }
  }

  private async loadUsage(scope: AgentRuntimeScope, taskId: string): Promise<RunProfileUsage | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_microusd
       FROM proma_runtime_usage
       WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
       LIMIT 1`,
      [scope.tenantId, scope.userId, taskId],
    )
    const row = result.rows[0]
    if (!row) return undefined
    return {
      inputTokens: toNum(row.input_tokens),
      outputTokens: toNum(row.output_tokens),
      cacheReadTokens: toNum(row.cache_read_tokens),
      cacheWriteTokens: toNum(row.cache_write_tokens),
      ...(row.cost_microusd == null ? {} : { costMicroUsd: toNum(row.cost_microusd) }),
    }
  }

  private async loadAudit(scope: AgentRuntimeScope, taskId: string): Promise<RunProfileAuditEvent[]> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT action, resource, result, created_at
       FROM proma_runtime_audit_log
       WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
       ORDER BY created_at ASC LIMIT 200`,
      [scope.tenantId, scope.userId, taskId],
    )
    return result.rows.map((row) => ({
      action: String(row.action),
      resource: String(row.resource),
      result: String(row.result),
      ...(row.created_at == null ? {} : { createdAt: toNum(row.created_at) }),
    }))
  }
}

function toNum(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
