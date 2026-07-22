import type { AgentRuntimePostgresClient, AgentRuntimeScope } from '@proma/shared/utils'

export interface AuditRecord extends AgentRuntimeScope {
  action: string
  resource: string
  result: 'success' | 'failure'
  requestId?: string
  traceId?: string
  taskId?: string
  createdAt?: number
}

export interface AuditQuery extends AgentRuntimeScope {
  action?: string
  result?: AuditRecord['result']
  taskId?: string
  from?: number
  to?: number
  limit?: number
}

export interface AuditLegalHold extends AgentRuntimeScope {
  holdId: string
  reason: string
  createdAt?: number
  releasedAt?: number
}

/** 仅追加的审计记录；不保存请求体、凭证或模型输出。 */
export class PostgresAuditLog {
  constructor(private readonly client: AgentRuntimePostgresClient) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_runtime_audit_log (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      resource TEXT NOT NULL,
      result TEXT NOT NULL,
      request_id TEXT,
      trace_id TEXT,
      task_id TEXT,
      created_at BIGINT NOT NULL
    )`)
    await this.client.query('ALTER TABLE proma_runtime_audit_log ADD COLUMN IF NOT EXISTS trace_id TEXT')
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_runtime_audit_legal_holds (
      tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, hold_id TEXT NOT NULL,
      reason TEXT NOT NULL, created_at BIGINT NOT NULL, released_at BIGINT,
      PRIMARY KEY (tenant_id, user_id, hold_id)
    )`)
  }

  async append(record: AuditRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO proma_runtime_audit_log (tenant_id, user_id, action, resource, result, request_id, trace_id, task_id, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [record.tenantId, record.userId, record.action, record.resource, record.result, record.requestId ?? null, record.traceId ?? null, record.taskId ?? null, record.createdAt ?? Date.now()],
    )
  }

  async list(query: AuditQuery): Promise<AuditRecord[]> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT tenant_id, user_id, action, resource, result, request_id, trace_id, task_id, created_at
      FROM proma_runtime_audit_log
      WHERE tenant_id = $1 AND user_id = $2
        AND ($3::text IS NULL OR action = $3) AND ($4::text IS NULL OR result = $4)
        AND ($5::text IS NULL OR task_id = $5) AND ($6::bigint IS NULL OR created_at >= $6)
        AND ($7::bigint IS NULL OR created_at <= $7)
      ORDER BY id DESC LIMIT $8`,
      [query.tenantId, query.userId, query.action ?? null, query.result ?? null, query.taskId ?? null, query.from ?? null, query.to ?? null, Math.min(query.limit ?? 100, 500)],
    )
    return result.rows.map((row) => ({
      tenantId: String(row.tenant_id), userId: String(row.user_id), action: String(row.action), resource: String(row.resource),
      result: row.result === 'failure' ? 'failure' : 'success', requestId: typeof row.request_id === 'string' ? row.request_id : undefined,
      traceId: typeof row.trace_id === 'string' ? row.trace_id : undefined,
      taskId: typeof row.task_id === 'string' ? row.task_id : undefined, createdAt: Number(row.created_at),
    }))
  }

  /** 按保留期清理旧审计记录；调用方必须先完成管理员授权。 */
  async purgeBefore(scope: AgentRuntimeScope, timestamp: number): Promise<void> {
    if (await this.hasActiveLegalHold(scope)) throw new Error('当前租户存在有效法律保全，禁止清理审计记录')
    await this.client.query(
      'DELETE FROM proma_runtime_audit_log WHERE tenant_id = $1 AND user_id = $2 AND created_at < $3',
      [scope.tenantId, scope.userId, timestamp],
    )
  }

  async createLegalHold(hold: AuditLegalHold): Promise<void> {
    await this.client.query(
      `INSERT INTO proma_runtime_audit_legal_holds (tenant_id, user_id, hold_id, reason, created_at, released_at)
       VALUES ($1,$2,$3,$4,$5,NULL)
       ON CONFLICT (tenant_id, user_id, hold_id) DO UPDATE SET reason = EXCLUDED.reason, created_at = EXCLUDED.created_at, released_at = NULL`,
      [hold.tenantId, hold.userId, hold.holdId, hold.reason, hold.createdAt ?? Date.now()],
    )
  }

  async releaseLegalHold(scope: AgentRuntimeScope, holdId: string): Promise<boolean> {
    const result = await this.client.query(
      'UPDATE proma_runtime_audit_legal_holds SET released_at = $4 WHERE tenant_id = $1 AND user_id = $2 AND hold_id = $3 AND released_at IS NULL',
      [scope.tenantId, scope.userId, holdId, Date.now()],
    )
    return (result.rows.length > 0) || Boolean((result as { rowCount?: number }).rowCount)
  }

  async hasActiveLegalHold(scope: AgentRuntimeScope): Promise<boolean> {
    const result = await this.client.query<Record<string, unknown>>(
      'SELECT hold_id FROM proma_runtime_audit_legal_holds WHERE tenant_id = $1 AND user_id = $2 AND released_at IS NULL LIMIT 1',
      [scope.tenantId, scope.userId],
    )
    return result.rows.length > 0
  }
}
