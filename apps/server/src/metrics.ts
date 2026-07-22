import type { AgentRuntimePostgresClient, AgentRuntimeScope } from '@proma/shared/utils'

export interface RuntimeMetrics {
  runningTasks: number
  completedTasks24h: number
  failedTasks24h: number
  cancelledTasks24h: number
  inputTokens24h: number
  outputTokens24h: number
  costMicroUsd24h: number
}

export class PostgresRuntimeMetrics {
  constructor(private readonly client: AgentRuntimePostgresClient) {}

  async get(scope: AgentRuntimeScope): Promise<RuntimeMetrics> {
    const since = Date.now() - 24 * 60 * 60 * 1_000
    const tasks = await this.client.query<Record<string, unknown>>(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'running') AS running_tasks,
        COUNT(*) FILTER (WHERE status = 'completed' AND completed_at >= $3) AS completed_tasks,
        COUNT(*) FILTER (WHERE status = 'failed' AND completed_at >= $3) AS failed_tasks,
        COUNT(*) FILTER (WHERE status = 'cancelled' AND completed_at >= $3) AS cancelled_tasks
      FROM proma_runtime_tasks WHERE tenant_id = $1 AND user_id = $2`,
      [scope.tenantId, scope.userId, since],
    )
    const usage = await this.client.query<Record<string, unknown>>(
      `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cost_microusd), 0) AS cost_microusd
      FROM proma_runtime_usage WHERE tenant_id = $1 AND user_id = $2 AND recorded_at >= $3`,
      [scope.tenantId, scope.userId, since],
    )
    const task = tasks.rows[0] ?? {}
    const cost = usage.rows[0] ?? {}
    return {
      runningTasks: number(task.running_tasks), completedTasks24h: number(task.completed_tasks), failedTasks24h: number(task.failed_tasks), cancelledTasks24h: number(task.cancelled_tasks),
      inputTokens24h: number(cost.input_tokens), outputTokens24h: number(cost.output_tokens), costMicroUsd24h: number(cost.cost_microusd),
    }
  }
}

function number(value: unknown): number { return typeof value === 'number' ? value : Number(value ?? 0) }
