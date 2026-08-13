import type { AgentRuntimePostgresClient, AgentRuntimeRole } from '@gravitas/shared/utils'

export interface AuthSessionRecord {
  sessionId: string
  tenantId: string
  userId: string
  roles: AgentRuntimeRole[]
  expiresAt: number
}

/** Postgres 会话存储：session_id → scope；对应 HTTP-only cookie。 */
export class PostgresAuthSessionStore {
  constructor(private readonly client: AgentRuntimePostgresClient) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_runtime_auth_sessions (
      session_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      roles TEXT NOT NULL DEFAULT '[]',
      expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL
    )`)
    await this.client.query('CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON proma_runtime_auth_sessions(expires_at)')
  }

  async create(scope: { tenantId: string; userId: string }, sessionId: string, roles: AgentRuntimeRole[], expiresAt: number): Promise<void> {
    await this.client.query(
      `INSERT INTO proma_runtime_auth_sessions (session_id, tenant_id, user_id, roles, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [sessionId, scope.tenantId, scope.userId, JSON.stringify(roles), expiresAt, Date.now()],
    )
  }

  async get(sessionId: string, now: number): Promise<AuthSessionRecord | null> {
    const result = await this.client.query<Record<string, unknown>>(
      'SELECT session_id, tenant_id, user_id, roles, expires_at FROM proma_runtime_auth_sessions WHERE session_id = $1',
      [sessionId],
    )
    const row = result.rows[0]
    if (!row) return null
    const expiresAt = Number(row.expires_at)
    if (expiresAt <= now) return null
    return {
      sessionId: String(row.session_id),
      tenantId: String(row.tenant_id),
      userId: String(row.user_id),
      roles: JSON.parse(String(row.roles)) as AgentRuntimeRole[],
      expiresAt,
    }
  }

  async destroy(sessionId: string): Promise<void> {
    await this.client.query('DELETE FROM proma_runtime_auth_sessions WHERE session_id = $1', [sessionId])
  }
}
