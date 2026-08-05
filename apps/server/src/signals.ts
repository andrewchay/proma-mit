import type { AgentRuntimePostgresClient, AgentRuntimeScope } from '@gravitas/shared/utils'

/**
 * P-II Signals：自然语言描述 + 确定性监测谓词。
 *
 * Signal 是用户用"人话"描述要盯的 Agent 行为；底层翻译成结构化 matcher，
 * 由 SignalScanner 周期扫描 span/task/usage 表确定性判定（不跑 per-run LLM）。
 */

export type SignalMatcherType =
  | 'task_failure_rate'
  | 'tool_repeat_failure'
  | 'task_cost_threshold'
  | 'stale_task'
  | 'provider_error'

export type SignalMatcher =
  | { type: 'task_failure_rate'; minFailRate: number; windowMs: number } // 0..1
  | { type: 'tool_repeat_failure'; namePrefix: string; minFailures: number; windowMs: number }
  | { type: 'task_cost_threshold'; thresholdMicroUsd: number; windowMs: number }
  | { type: 'stale_task'; staleAfterMs: number }
  | { type: 'provider_error'; namePrefix: string; minErrors: number; windowMs: number }

export interface Signal extends AgentRuntimeScope {
  signalId: string
  /** 人话描述，如"如果 agent 卡在循环里提醒我"。 */
  description: string
  matcher: SignalMatcher
  enabled: boolean
  lastCheckedAt?: number
  hitCount: number
  createdAt: number
  updatedAt: number
}

export interface SignalHit extends AgentRuntimeScope {
  hitId: string
  signalId: string
  /** 由 matcher 类型生成的人话 message。 */
  message: string
  /** 命中证据（taskId / spanId / 计数等）。 */
  evidence: Record<string, unknown>
  createdAt: number
}

export interface SignalHitQuery extends AgentRuntimeScope {
  from?: number
  to?: number
  limit?: number
  signalId?: string
}

export class PostgresSignalStore {
  constructor(private readonly client: AgentRuntimePostgresClient) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_runtime_signals (
      tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, signal_id TEXT NOT NULL,
      description TEXT NOT NULL, matcher_json TEXT NOT NULL, enabled BOOLEAN NOT NULL,
      last_checked_at BIGINT, hit_count BIGINT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, user_id, signal_id))`)
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_runtime_signal_hits (
      tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, hit_id TEXT NOT NULL, signal_id TEXT NOT NULL,
      message TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, user_id, hit_id))`)
    await this.client.query('CREATE INDEX IF NOT EXISTS proma_runtime_signal_hits_signal_idx ON proma_runtime_signal_hits (tenant_id, user_id, signal_id, created_at)')
  }

  async create(input: Omit<Signal, 'signalId' | 'hitCount' | 'createdAt' | 'updatedAt' | 'lastCheckedAt'>): Promise<Signal> {
    const now = Date.now()
    const signal: Signal = { ...input, signalId: randomUUID(), hitCount: 0, createdAt: now, updatedAt: now }
    await this.client.query(
      `INSERT INTO proma_runtime_signals (tenant_id,user_id,signal_id,description,matcher_json,enabled,last_checked_at,hit_count,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,0,$7,$7)`,
      [signal.tenantId, signal.userId, signal.signalId, signal.description, JSON.stringify(signal.matcher), signal.enabled, now],
    )
    return signal
  }

  async list(scope: AgentRuntimeScope): Promise<Signal[]> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT tenant_id,user_id,signal_id,description,matcher_json,enabled,last_checked_at,hit_count,created_at,updated_at
       FROM proma_runtime_signals WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at ASC LIMIT 500`,
      [scope.tenantId, scope.userId],
    )
    return result.rows.map(toSignal)
  }

  async get(scope: AgentRuntimeScope, signalId: string): Promise<Signal | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT tenant_id,user_id,signal_id,description,matcher_json,enabled,last_checked_at,hit_count,created_at,updated_at
       FROM proma_runtime_signals WHERE tenant_id = $1 AND user_id = $2 AND signal_id = $3`,
      [scope.tenantId, scope.userId, signalId],
    )
    const row = result.rows[0]
    return row ? toSignal(row) : undefined
  }

  async listEnabled(scope: AgentRuntimeScope): Promise<Signal[]> {
    return (await this.list(scope)).filter((signal) => signal.enabled)
  }

  /** 列出所有拥有 signal 的 tenant/user 作用域，供全局扫描。 */
  async listScopes(): Promise<AgentRuntimeScope[]> {
    const result = await this.client.query<Record<string, unknown>>(
      'SELECT DISTINCT tenant_id, user_id FROM proma_runtime_signals',
    )
    return result.rows.map((row) => ({ tenantId: String(row.tenant_id), userId: String(row.user_id) }))
  }

  async delete(scope: AgentRuntimeScope, signalId: string): Promise<boolean> {
    const result = await this.client.query<{ signal_id: string }>(
      `DELETE FROM proma_runtime_signals WHERE tenant_id = $1 AND user_id = $2 AND signal_id = $3 RETURNING signal_id`,
      [scope.tenantId, scope.userId, signalId],
    )
    return result.rows.length > 0
  }

  /** 记录一次检查并推进 lastCheckedAt（避免重复扫描同一窗口命中）。 */
  async markChecked(scope: AgentRuntimeScope, signalId: string, checkedAt: number): Promise<void> {
    await this.client.query(
      `UPDATE proma_runtime_signals SET last_checked_at = $4, updated_at = $4 WHERE tenant_id = $1 AND user_id = $2 AND signal_id = $3`,
      [scope.tenantId, scope.userId, signalId, checkedAt],
    )
  }

  async appendHit(hit: Omit<SignalHit, 'hitId' | 'createdAt'>): Promise<SignalHit> {
    const stored: SignalHit = { ...hit, hitId: randomUUID(), createdAt: Date.now() }
    await this.client.query(
      `INSERT INTO proma_runtime_signal_hits (tenant_id,user_id,hit_id,signal_id,message,evidence_json,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [stored.tenantId, stored.userId, stored.hitId, stored.signalId, stored.message, JSON.stringify(stored.evidence), stored.createdAt],
    )
    await this.client.query(
      `UPDATE proma_runtime_signals SET hit_count = hit_count + 1, updated_at = $3 WHERE tenant_id = $1 AND user_id = $2 AND signal_id = $3`,
      [stored.tenantId, stored.userId, stored.signalId, stored.createdAt],
    )
    return stored
  }

  async listHits(query: SignalHitQuery): Promise<SignalHit[]> {
    const limit = Math.min(query.limit ?? 100, 500)
    const conditions = ['tenant_id = $1', 'user_id = $2']
    const params: unknown[] = [query.tenantId, query.userId]
    if (query.signalId) { conditions.push(`signal_id = $${params.length + 1}`); params.push(query.signalId) }
    if (query.from != null) { conditions.push(`created_at >= $${params.length + 1}`); params.push(query.from) }
    if (query.to != null) { conditions.push(`created_at <= $${params.length + 1}`); params.push(query.to) }
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT tenant_id,user_id,hit_id,signal_id,message,evidence_json,created_at
       FROM proma_runtime_signal_hits WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC LIMIT $${params.length + 1}`,
      [...params, limit],
    )
    return result.rows.map(toSignalHit)
  }
}

function toSignal(row: Record<string, unknown>): Signal {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    signalId: String(row.signal_id),
    description: String(row.description),
    matcher: parseMatcher(row.matcher_json),
    enabled: Boolean(row.enabled),
    ...(row.last_checked_at == null ? {} : { lastCheckedAt: toNum(row.last_checked_at) }),
    hitCount: toNum(row.hit_count),
    createdAt: toNum(row.created_at),
    updatedAt: toNum(row.updated_at),
  }
}

function toSignalHit(row: Record<string, unknown>): SignalHit {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    hitId: String(row.hit_id),
    signalId: String(row.signal_id),
    message: String(row.message),
    evidence: JSON.parse(String(row.evidence_json)) as Record<string, unknown>,
    createdAt: toNum(row.created_at),
  }
}

function parseMatcher(value: unknown): SignalMatcher {
  try {
    const parsed = JSON.parse(String(value)) as SignalMatcher
    return parsed
  } catch {
    return { type: 'task_failure_rate', minFailRate: 1, windowMs: 60_000 }
  }
}

function toNum(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function randomUUID(): string {
  const uuid = globalThis.crypto?.randomUUID
  if (uuid) return uuid.call(globalThis.crypto)
  return `signal-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
