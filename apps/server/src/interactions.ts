import type {
  AgentRuntimeInteractionRecord,
  AgentRuntimeInteractionResponse,
  AgentRuntimeInteractionStore,
  CreateAgentRuntimeInteractionInput,
  ListAgentRuntimeInteractionsInput,
  ResolveAgentRuntimeInteractionInput,
} from '@proma/shared/utils'
import type { AgentRuntimePostgresClient, AgentRuntimeScope } from '@proma/shared/utils'

/** Postgres 持久化审批记录，供跨 worker 的 Web 权限/问答流程恢复。 */
export class PostgresAgentRuntimeInteractionStore implements AgentRuntimeInteractionStore {
  constructor(private readonly client: AgentRuntimePostgresClient) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_runtime_interactions (
      tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, request_id TEXT NOT NULL,
      session_id TEXT NOT NULL, task_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL,
      request_json JSONB NOT NULL, response_json JSONB, created_at BIGINT NOT NULL,
      expires_at BIGINT, resolved_at BIGINT,
      version INTEGER NOT NULL DEFAULT 1, resolution_id TEXT,
      PRIMARY KEY (tenant_id, user_id, request_id)
    )`)
    await this.client.query('ALTER TABLE proma_runtime_interactions ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1')
    await this.client.query('ALTER TABLE proma_runtime_interactions ADD COLUMN IF NOT EXISTS resolution_id TEXT')
  }

  async createInteraction(input: CreateAgentRuntimeInteractionInput): Promise<AgentRuntimeInteractionRecord> {
    const createdAt = input.createdAt ?? Date.now()
    await this.client.query(
      `INSERT INTO proma_runtime_interactions (tenant_id,user_id,request_id,session_id,task_id,kind,status,request_json,created_at,expires_at,version)
      VALUES ($1,$2,$3,$4,$5,$6,'pending',$7::jsonb,$8,$9,1)`,
      [input.tenantId, input.userId, input.request.requestId, input.request.sessionId, input.taskId ?? null, input.kind, JSON.stringify(input.request), createdAt, input.expiresAt ?? null],
    )
    return { ...input, requestId: input.request.requestId, sessionId: input.request.sessionId, status: 'pending', createdAt, version: 1 }
  }

  async getInteraction(scope: AgentRuntimeScope, requestId: string): Promise<AgentRuntimeInteractionRecord | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT * FROM proma_runtime_interactions WHERE tenant_id = $1 AND user_id = $2 AND request_id = $3`,
      [scope.tenantId, scope.userId, requestId],
    )
    return result.rows[0] ? interactionFromRow(result.rows[0]) : undefined
  }

  async listInteractions(input: ListAgentRuntimeInteractionsInput): Promise<AgentRuntimeInteractionRecord[]> {
    if (input.now != null) await this.expireInteractions(input, input.now)
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT * FROM proma_runtime_interactions WHERE tenant_id = $1 AND user_id = $2
       AND ($3::text IS NULL OR session_id = $3) AND ($4::text IS NULL OR task_id = $4)
       AND ($5::text IS NULL OR kind = $5) AND ($6::text IS NULL OR status = $6)
       ORDER BY created_at ASC`,
      [input.tenantId, input.userId, input.sessionId ?? null, input.taskId ?? null, input.kind ?? null, input.status ?? null],
    )
    return result.rows.map(interactionFromRow)
  }

  async resolveInteraction(scope: AgentRuntimeScope, requestId: string, input: ResolveAgentRuntimeInteractionInput): Promise<AgentRuntimeInteractionRecord | undefined> {
    return this.updatePending(scope, requestId, 'resolved', input)
  }

  async cancelInteraction(scope: AgentRuntimeScope, requestId: string): Promise<AgentRuntimeInteractionRecord | undefined> {
    return this.updatePending(scope, requestId, 'cancelled')
  }

  async expireInteractions(scope: AgentRuntimeScope, now: number): Promise<AgentRuntimeInteractionRecord[]> {
    const result = await this.client.query<Record<string, unknown>>(
      `UPDATE proma_runtime_interactions SET status = 'expired', resolved_at = $3, version = version + 1
       WHERE tenant_id = $1 AND user_id = $2 AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= $3 RETURNING *`,
      [scope.tenantId, scope.userId, now],
    )
    return result.rows.map(interactionFromRow)
  }

  private async updatePending(scope: AgentRuntimeScope, requestId: string, status: 'resolved' | 'cancelled', input?: ResolveAgentRuntimeInteractionInput): Promise<AgentRuntimeInteractionRecord | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `UPDATE proma_runtime_interactions SET status = $4, response_json = $5::jsonb, resolution_id = $6, resolved_at = $7, version = version + 1
       WHERE tenant_id = $1 AND user_id = $2 AND request_id = $3 AND status = 'pending'
       AND ($8::integer IS NULL OR version = $8) RETURNING *`,
      [scope.tenantId, scope.userId, requestId, status, input ? JSON.stringify(input.response) : null, input?.resolutionId ?? null, Date.now(), input?.expectedVersion ?? null],
    )
    return result.rows[0] ? interactionFromRow(result.rows[0]) : undefined
  }
}

function interactionFromRow(row: Record<string, unknown>): AgentRuntimeInteractionRecord {
  return {
    tenantId: String(row.tenant_id), userId: String(row.user_id), requestId: String(row.request_id), sessionId: String(row.session_id),
    taskId: stringOrUndefined(row.task_id), kind: interactionKind(row.kind),
    status: interactionStatus(row.status), request: parseJson(row.request_json), response: row.response_json == null ? undefined : parseJson(row.response_json),
    createdAt: Number(row.created_at), expiresAt: numberOrUndefined(row.expires_at), resolvedAt: numberOrUndefined(row.resolved_at),
    version: numberOrUndefined(row.version) ?? 1, resolutionId: stringOrUndefined(row.resolution_id),
  }
}

function parseJson(value: unknown): never { return JSON.parse(typeof value === 'string' ? value : JSON.stringify(value)) as never }
function stringOrUndefined(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
function numberOrUndefined(value: unknown): number | undefined { return value == null ? undefined : Number(value) }
function interactionStatus(value: unknown): AgentRuntimeInteractionRecord['status'] {
  return value === 'resolved' || value === 'cancelled' || value === 'expired' ? value : 'pending'
}
function interactionKind(value: unknown): AgentRuntimeInteractionRecord['kind'] {
  return value === 'ask_user' || value === 'plan' ? value : 'permission'
}
