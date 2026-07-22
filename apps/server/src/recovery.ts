import type { AgentRuntimePostgresClient, AgentRuntimeScope } from '@proma/shared/utils'

export interface StaleRuntimeTask extends AgentRuntimeScope {
  taskId: string
  sessionId: string
  startedAt: number
  leaseExpiresAt?: number
  reason: 'lease_expired' | 'lease_missing'
}

/**
 * 只读地识别失去有效租约的运行中任务。
 * 不直接改写 task 状态：远端 worker 可能仍在收尾，实际终止应通过拥有该任务的 worker 完成。
 */
export class PostgresTaskRecoveryInspector {
  constructor(private readonly client: AgentRuntimePostgresClient, private readonly staleAfterMs: number) {}

  async listStale(scope: AgentRuntimeScope): Promise<StaleRuntimeTask[]> {
    const now = Date.now()
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT t.tenant_id, t.user_id, t.task_id, t.session_id, t.started_at, l.lease_expires_at
      FROM proma_runtime_tasks t
      LEFT JOIN proma_runtime_task_leases l
        ON l.tenant_id = t.tenant_id AND l.user_id = t.user_id AND l.session_id = t.session_id AND l.task_id = t.task_id
      WHERE t.tenant_id = $1 AND t.user_id = $2 AND t.status = 'running' AND t.started_at <= $3
        AND (l.task_id IS NULL OR l.lease_expires_at < $4)
      ORDER BY t.started_at ASC LIMIT 100`,
      [scope.tenantId, scope.userId, now - this.staleAfterMs, now],
    )
    return result.rows.map((row) => {
      const leaseExpiresAt = nullableNumber(row.lease_expires_at)
      return {
        tenantId: String(row.tenant_id),
        userId: String(row.user_id),
        taskId: String(row.task_id),
        sessionId: String(row.session_id),
        startedAt: Number(row.started_at),
        leaseExpiresAt,
        reason: leaseExpiresAt == null ? 'lease_missing' : 'lease_expired',
      }
    })
  }
}

function nullableNumber(value: unknown): number | undefined {
  if (value == null) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
