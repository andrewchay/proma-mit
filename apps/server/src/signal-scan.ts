import type { AgentRuntimePostgresClient, AgentRuntimeScope } from '@proma/shared/utils'
import type { RuntimeSpan, RuntimeSpanStatus } from '@proma/shared'
import type { PostgresSignalStore, Signal, SignalHit, SignalMatcher } from './signals.ts'
import type { PostgresRuntimeSpanStore } from './spans.ts'

/**
 * Signal 判定所需的底层数据访问（span / task / usage）。
 * 让 SignalScanner 只依赖抽象接口，便于用 mock 单测各 matcher。
 */
export interface SignalDataSource {
  querySpansInWindow(scope: AgentRuntimeScope, input: { from: number; kind?: RuntimeSpan['kind']; status?: RuntimeSpanStatus; namePrefix?: string; limit?: number }): Promise<RuntimeSpan[]>
  countErrorsInWindow(scope: AgentRuntimeScope, input: { from: number; namePrefix?: string; kind?: RuntimeSpan['kind'] }): Promise<number>
  toolFailureRuns(scope: AgentRuntimeScope, input: { from: number; namePrefix: string; minFailures: number }): Promise<{ spanValues: Array<{ taskId: string; count: number }> }>
  /** 窗口内失败任务数（用于 task_failure_rate）。 */
  countFailedTasksSince(scope: AgentRuntimeScope, from: number): Promise<number>
  countTasksSince(scope: AgentRuntimeScope, from: number): Promise<number>
  /** 单 task 累计 cost（用于 task_cost_threshold）。 */
  maxTaskCostMicroUsdSince(scope: AgentRuntimeScope, from: number): Promise<number>
  /** stale task 计数。 */
  countStaleTasks(scope: AgentRuntimeScope, staleAfterMs: number): Promise<number>
}

export interface SignalHitSink {
  appendHit(hit: Omit<SignalHit, 'hitId' | 'createdAt'>): Promise<SignalHit>
}

type SignalStore = Pick<PostgresSignalStore, 'listEnabled' | 'markChecked'> & SignalHitSink

export interface SignalScannerOptions {
  store: SignalStore
  data: SignalDataSource
  now?: () => number
}

/**
 * 周期扫描 enabled signals，对每个 matcher 确定性判定并落 hit。
 * 与 ServerScheduler 一样由外部用 setInterval 驱动；本类只做单次扫描。
 */
export class SignalScanner {
  private readonly store: SignalStore
  private readonly data: SignalDataSource
  private readonly now: () => number

  constructor(options: SignalScannerOptions) {
    this.store = options.store
    this.data = options.data
    this.now = options.now ?? (() => Date.now())
  }

  /** 扫描一个 scope 的全部 enabled signals，返回已持久化的 hits（供上层处理通知/呈现）。 */
  async scan(scope: AgentRuntimeScope): Promise<SignalHit[]> {
    const signals = await this.store.listEnabled(scope)
    const hits: SignalHit[] = []
    for (const signal of signals) {
      const evaluated = await this.evaluate(scope, signal)
      if (evaluated) {
        // strip placeholder id/timestamp; store 会生成真实值并返回已持久化的 hit
        const { hitId: _hitId, createdAt: _createdAt, ...rest } = evaluated
        const stored = await this.store.appendHit(rest)
        hits.push(stored)
      }
      await this.store.markChecked(scope, signal.signalId, this.now())
    }
    return hits
  }

  /** 判定单个 signal，命中返回带证据的 hit（尚未持久化）。 */
  async evaluate(scope: AgentRuntimeScope, signal: Signal): Promise<SignalHit | undefined> {
    const matcher = signal.matcher
    const now = this.now()
    switch (matcher.type) {
      case 'task_failure_rate': return this.evalTaskFailureRate(scope, signal, matcher, now)
      case 'tool_repeat_failure': return this.evalToolRepeatFailure(scope, signal, matcher, now)
      case 'task_cost_threshold': return this.evalTaskCostThreshold(scope, signal, matcher, now)
      case 'stale_task': return this.evalStaleTask(scope, signal, matcher, now)
      case 'provider_error': return this.evalProviderError(scope, signal, matcher, now)
    }
  }

  private async evalTaskFailureRate(scope: AgentRuntimeScope, signal: Signal, m: Extract<SignalMatcher, { type: 'task_failure_rate' }>, now: number): Promise<SignalHit | undefined> {
    const from = now - m.windowMs
    const failed = await this.data.countFailedTasksSince(scope, from)
    const total = await this.data.countTasksSince(scope, from)
    if (total < 1) return undefined
    const rate = failed / total
    if (rate < m.minFailRate) return undefined
    return this.hit(scope, signal, `任务失败率 ${(rate * 100).toFixed(0)}% 超过阈值 ${(m.minFailRate * 100).toFixed(0)}%（${failed}/${total}）`, { failed, total, rate, windowMs: m.windowMs })
  }

  private async evalToolRepeatFailure(scope: AgentRuntimeScope, signal: Signal, m: Extract<SignalMatcher, { type: 'tool_repeat_failure' }>, now: number): Promise<SignalHit | undefined> {
    const from = now - m.windowMs
    const runs = await this.data.toolFailureRuns(scope, { from, namePrefix: m.namePrefix, minFailures: m.minFailures })
    if (runs.spanValues.length === 0) return undefined
    const worst = runs.spanValues[0]!
    return this.hit(scope, signal, `工具 ${m.namePrefix} 在 ${m.windowMs / 1000}s 内同一任务连续失败 ${worst.count} 次（≥${m.minFailures}，疑似卡死/循环）`, { taskId: worst.taskId, failures: worst.count, namePrefix: m.namePrefix, minFailures: m.minFailures })
  }

  private async evalTaskCostThreshold(scope: AgentRuntimeScope, signal: Signal, m: Extract<SignalMatcher, { type: 'task_cost_threshold' }>, now: number): Promise<SignalHit | undefined> {
    const from = now - m.windowMs
    const maxCost = await this.data.maxTaskCostMicroUsdSince(scope, from)
    if (maxCost < m.thresholdMicroUsd) return undefined
    return this.hit(scope, signal, `有任务的成本达到 ${(maxCost / 1_000_000).toFixed(4)} USD，超过阈值 ${(m.thresholdMicroUsd / 1_000_000).toFixed(4)} USD`, { maxCostMicroUsd: maxCost, thresholdMicroUsd: m.thresholdMicroUsd })
  }

  private async evalStaleTask(scope: AgentRuntimeScope, signal: Signal, m: Extract<SignalMatcher, { type: 'stale_task' }>, _now: number): Promise<SignalHit | undefined> {
    const stale = await this.data.countStaleTasks(scope, m.staleAfterMs)
    if (stale < 1) return undefined
    return this.hit(scope, signal, `发现 ${stale} 个失去租约的 stale 任务（超时 ${m.staleAfterMs / 1000}s）`, { staleCount: stale, staleAfterMs: m.staleAfterMs })
  }

  private async evalProviderError(scope: AgentRuntimeScope, signal: Signal, m: Extract<SignalMatcher, { type: 'provider_error' }>, now: number): Promise<SignalHit | undefined> {
    const from = now - m.windowMs
    const errors = await this.data.countErrorsInWindow(scope, { from, namePrefix: m.namePrefix, kind: 'provider' })
    if (errors < m.minErrors) return undefined
    return this.hit(scope, signal, `provider ${m.namePrefix} 在 ${m.windowMs / 1000}s 内出现 ${errors} 次错误（≥${m.minErrors}）`, { errors, namePrefix: m.namePrefix, minErrors: m.minErrors })
  }

  private hit(scope: AgentRuntimeScope, signal: Signal, message: string, evidence: Record<string, unknown>): SignalHit {
    return { ...scope, signalId: signal.signalId, message, evidence, hitId: '', createdAt: 0 }
  }
}

/** 基于 Postgres 的 SignalDataSource 实现：span 查询委托给 span store，task/usage 查表。 */
export class PostgresSignalDataSource implements SignalDataSource {
  constructor(private readonly client: AgentRuntimePostgresClient, private readonly spans: PostgresRuntimeSpanStore) {}

  querySpansInWindow(scope: AgentRuntimeScope, input: Parameters<SignalDataSource['querySpansInWindow']>[1]): Promise<RuntimeSpan[]> {
    return this.spans.querySpansInWindow(scope, input)
  }

  countErrorsInWindow(scope: AgentRuntimeScope, input: Parameters<SignalDataSource['countErrorsInWindow']>[1]): Promise<number> {
    return this.spans.countErrorsInWindow(scope, input)
  }

  toolFailureRuns(scope: AgentRuntimeScope, input: Parameters<SignalDataSource['toolFailureRuns']>[1]): Promise<{ spanValues: Array<{ taskId: string; count: number }> }> {
    return this.spans.toolFailureRuns(scope, input)
  }

  async countFailedTasksSince(scope: AgentRuntimeScope, from: number): Promise<number> {
    const result = await this.client.query<{ count: number | string | null }>(
      `SELECT COUNT(*) AS count FROM proma_runtime_tasks WHERE tenant_id = $1 AND user_id = $2 AND status = 'failed' AND started_at >= $3`,
      [scope.tenantId, scope.userId, from],
    )
    return toNum(result.rows[0]?.count)
  }

  async countTasksSince(scope: AgentRuntimeScope, from: number): Promise<number> {
    const result = await this.client.query<{ count: number | string | null }>(
      `SELECT COUNT(*) AS count FROM proma_runtime_tasks WHERE tenant_id = $1 AND user_id = $2 AND started_at >= $3`,
      [scope.tenantId, scope.userId, from],
    )
    return toNum(result.rows[0]?.count)
  }

  async maxTaskCostMicroUsdSince(scope: AgentRuntimeScope, from: number): Promise<number> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT task_id, SUM(cost_microusd) AS cost FROM proma_runtime_usage
       WHERE tenant_id = $1 AND user_id = $2 AND recorded_at >= $3
       GROUP BY task_id ORDER BY cost DESC LIMIT 1`,
      [scope.tenantId, scope.userId, from],
    )
    const row = result.rows[0]
    return row ? toNum(row.cost) : 0
  }

  async countStaleTasks(scope: AgentRuntimeScope, staleAfterMs: number): Promise<number> {
    const now = Date.now()
    const result = await this.client.query<{ count: number | string | null }>(
      `SELECT COUNT(*) AS count FROM proma_runtime_tasks t
       LEFT JOIN proma_runtime_task_leases l
         ON l.tenant_id = t.tenant_id AND l.user_id = t.user_id AND l.session_id = t.session_id AND l.task_id = t.task_id
       WHERE t.tenant_id = $1 AND t.user_id = $2 AND t.status = 'running' AND t.started_at <= $3
         AND (l.task_id IS NULL OR l.lease_expires_at < $4)`,
      [scope.tenantId, scope.userId, now - staleAfterMs, now],
    )
    return toNum(result.rows[0]?.count)
  }
}

function toNum(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
