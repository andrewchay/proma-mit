import { createHash } from 'node:crypto'
import type { AgentRuntimePostgresClient, AgentRuntimeScope } from '@gravitas/shared/utils'

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

export interface AuditChainRecord {
  id: number
  tenantId: string
  userId: string
  action: string
  resource: string
  result: string
  createdAt: number
  prevHash: string
  hash: string
}

export interface AuditChainVerification {
  /** 全部按 id 升序排列的审计记录（仅含链字段） */
  records: AuditChainRecord[]
  /** 链是否完整且未被篡改 */
  valid: boolean
  /** 首个不匹配位置的索引（valid 为 false 时有效，-1 表示链为空） */
  firstMismatchIndex: number
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
      created_at BIGINT NOT NULL,
      prev_hash TEXT NOT NULL DEFAULT '',
      hash TEXT NOT NULL DEFAULT ''
    )`)
    await this.client.query('ALTER TABLE proma_runtime_audit_log ADD COLUMN IF NOT EXISTS trace_id TEXT')
    await this.client.query('ALTER TABLE proma_runtime_audit_log ADD COLUMN IF NOT EXISTS prev_hash TEXT DEFAULT \'\'')
    await this.client.query('ALTER TABLE proma_runtime_audit_log ADD COLUMN IF NOT EXISTS hash TEXT DEFAULT \'\'')
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_runtime_audit_legal_holds (
      tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, hold_id TEXT NOT NULL,
      reason TEXT NOT NULL, created_at BIGINT NOT NULL, released_at BIGINT,
      PRIMARY KEY (tenant_id, user_id, hold_id)
    )`)
  }

  /** 计算审计记录的 hash：对审计内容（不含 hash/prev_hash 本身）做 SHA-256 */
  static computeHash(input: {
    tenantId: string
    userId: string
    action: string
    resource: string
    result: string
    createdAt: number
    prevHash: string
    seq: number
  }): string {
    const payload = [
      'v1', input.tenantId, input.userId, input.action, input.resource, input.result,
      String(input.createdAt), input.prevHash, String(input.seq),
    ].join('\x1f')
    return createHash('sha256').update(payload).digest('hex')
  }

  /**
   * 追加审计记录；自动计算与租户链尾相连的 hash 链。
   * 会先查询该 tenant 的最新 hash 作为 prev_hash，再插入并写入本行 hash。
   * 注意：此实现为两次查询（先读链尾再写），极端并发下可能断链；
   * 生产如需绝对并发安全应改用事务或数据库触发器（P8-3 阶段完善）。
   */
  async append(record: AuditRecord): Promise<void> {
    const createdAt = record.createdAt ?? Date.now()
    const prevRow = await this.client.query<Record<string, unknown>>(
      'SELECT hash FROM proma_runtime_audit_log WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1',
      [record.tenantId],
    )
    const prevHash = prevRow.rows[0] && typeof prevRow.rows[0].hash === 'string' ? String(prevRow.rows[0].hash) : ''
    const hash = PostgresAuditLog.computeHash({
      tenantId: record.tenantId, userId: record.userId, action: record.action, resource: record.resource,
      result: record.result, createdAt, prevHash, seq: 1,
    })
    await this.client.query(
      `INSERT INTO proma_runtime_audit_log (tenant_id, user_id, action, resource, result, request_id, trace_id, task_id, created_at, prev_hash, hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [record.tenantId, record.userId, record.action, record.resource, record.result, record.requestId ?? null, record.traceId ?? null, record.taskId ?? null, createdAt, prevHash, hash],
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

  /**
   * 校验该租户的审计 hash 链完整性（篡改检测）。
   * 从链尾回溯：逐条重算本行 hash 并校验其等于存储值，同时校验本行 prev_hash 等于前一条的 hash。
   * 若某条记录被篡改（action/resource 等被改），重算 hash 不匹配 → 判定 invalid。
   * 注意：首条记录 prev_hash 应为空；若首条 prev_hash 非空视为链不完整（历史被裁）。
   *
   * 与 purgeBefore 的关系：合规性清理会删掉链中记录，导致 verifyChain 判定 invalid。
   * 这是设计上"任何对审计日志的非常规改动都会被审计器察觉"的预期行为；法律保全期禁止清理正是配套约束。
   */
  async verifyChain(scope: AgentRuntimeScope): Promise<AuditChainVerification> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT id, tenant_id, user_id, action, resource, result, created_at, prev_hash, hash
       FROM proma_runtime_audit_log WHERE tenant_id = $1 ORDER BY id ASC`,
      [scope.tenantId],
    )
    const records: AuditChainRecord[] = result.rows.map((row) => ({
      id: Number(row.id),
      tenantId: String(row.tenant_id),
      userId: String(row.user_id),
      action: String(row.action),
      resource: String(row.resource),
      result: String(row.result),
      createdAt: Number(row.created_at),
      prevHash: typeof row.prev_hash === 'string' ? String(row.prev_hash) : '',
      hash: typeof row.hash === 'string' ? String(row.hash) : '',
    }))

    if (records.length === 0) return { records, valid: true, firstMismatchIndex: -1 }

    // 连锁：第一条必须 prev_hash 为空（链头），否则视为被裁
    if (records[0]?.prevHash !== '') {
      return { records, valid: false, firstMismatchIndex: 0 }
    }
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!
      // 校验本行 prev_hash 等于前一条 hash（i>0 时）
      if (i > 0 && record.prevHash !== records[i - 1]!.hash) {
        return { records, valid: false, firstMismatchIndex: i }
      }
      // 重算本行 hash 校验是否被篡改
      const recomputed = PostgresAuditLog.computeHash({
        tenantId: record.tenantId, userId: record.userId, action: record.action, resource: record.resource,
        result: record.result, createdAt: record.createdAt, prevHash: record.prevHash, seq: 1,
      })
      if (recomputed !== record.hash) {
        return { records, valid: false, firstMismatchIndex: i }
      }
    }
    return { records, valid: true, firstMismatchIndex: -1 }
  }

  /** 按保留期清理旧审计记录；调用方必须先完成管理员授权。 */
  async purgeBefore(scope: AgentRuntimeScope, timestamp: number): Promise<void> {    if (await this.hasActiveLegalHold(scope)) throw new Error('当前租户存在有效法律保全，禁止清理审计记录')
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
