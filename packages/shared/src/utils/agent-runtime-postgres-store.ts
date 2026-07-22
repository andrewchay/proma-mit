import type {
  McpServerEntry,
  SDKMessage,
} from '../types/agent'
import type { ProviderType } from '../types/channel'
import type { AgentRuntimeScope, AgentRuntimeTaskMeta, AgentRuntimeTaskStatus } from './agent-runtime-server'
import type {
  TenantMcpClientSecret,
  TenantMcpOAuthTokens,
  TenantRuntimeCredential,
  TenantRuntimeSecretEncoding,
  TenantRuntimeSession,
  TenantRuntimeStore,
  TenantRuntimeWorkspace,
} from './agent-runtime-tenant-store'

export interface AgentRuntimePostgresQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[]
}

export interface AgentRuntimePostgresClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<AgentRuntimePostgresQueryResult<Row>>
}

export const AGENT_RUNTIME_POSTGRES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS proma_runtime_credentials (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  api_key TEXT NOT NULL,
  api_key_encoding TEXT NOT NULL DEFAULT 'plain',
  base_url TEXT NOT NULL,
  default_model TEXT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS proma_runtime_workspaces (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_slug TEXT NOT NULL,
  cwd TEXT NOT NULL,
  mcp_servers JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, workspace_slug)
);

CREATE TABLE IF NOT EXISTS proma_runtime_sessions (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  workspace_slug TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  title TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, session_id)
);

CREATE TABLE IF NOT EXISTS proma_runtime_session_messages (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_index INTEGER NOT NULL,
  message_uuid TEXT,
  message_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, session_id, message_index)
);

CREATE INDEX IF NOT EXISTS proma_runtime_session_messages_uuid_idx
  ON proma_runtime_session_messages (tenant_id, user_id, session_id, message_uuid);

CREATE TABLE IF NOT EXISTS proma_runtime_tasks (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  completed_at BIGINT,
  error TEXT,
  PRIMARY KEY (tenant_id, user_id, task_id)
);

CREATE TABLE IF NOT EXISTS proma_runtime_mcp_oauth_tokens (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_slug TEXT NOT NULL,
  server_name TEXT NOT NULL,
  tokens_json JSONB NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, workspace_slug, server_name)
);

CREATE TABLE IF NOT EXISTS proma_runtime_mcp_client_secrets (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_slug TEXT NOT NULL,
  server_name TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, workspace_slug, server_name)
);
`.trim()

interface CredentialRow extends Record<string, unknown> {
  tenant_id: string
  user_id: string
  channel_id: string
  provider: string
  api_key: string
  api_key_encoding?: string
  base_url: string
  default_model?: string | null
}

interface WorkspaceRow extends Record<string, unknown> {
  tenant_id: string
  user_id: string
  workspace_slug: string
  cwd: string
  mcp_servers: unknown
}

interface SessionRow extends Record<string, unknown> {
  tenant_id: string
  user_id: string
  session_id: string
  workspace_slug: string
  channel_id: string
  model_id: string
  runtime: TenantRuntimeSession['runtime']
  title?: string | null
  created_at: number | string
  updated_at: number | string
}

interface MessageRow extends Record<string, unknown> {
  message_json: unknown
}

interface TaskRow extends Record<string, unknown> {
  tenant_id: string
  user_id: string
  session_id: string
  task_id: string
  status: AgentRuntimeTaskStatus
  started_at: number | string
  completed_at?: number | string | null
  error?: string | null
}

interface TokensRow extends Record<string, unknown> {
  tokens_json: unknown
}

interface ClientSecretRow extends Record<string, unknown> {
  client_secret: string
}

interface MessageIndexRow extends Record<string, unknown> {
  message_index?: number | null
}

export class PostgresTenantRuntimeStore implements TenantRuntimeStore {
  constructor(private readonly client: AgentRuntimePostgresClient) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(AGENT_RUNTIME_POSTGRES_SCHEMA_SQL)
  }

  async setCredential(credential: TenantRuntimeCredential): Promise<void> {
    await this.client.query(
      `INSERT INTO proma_runtime_credentials (
        tenant_id, user_id, channel_id, provider, api_key, api_key_encoding, base_url, default_model, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (tenant_id, user_id, channel_id)
      DO UPDATE SET
        provider = EXCLUDED.provider,
        api_key = EXCLUDED.api_key,
        api_key_encoding = EXCLUDED.api_key_encoding,
        base_url = EXCLUDED.base_url,
        default_model = EXCLUDED.default_model,
        updated_at = EXCLUDED.updated_at`,
      [
        credential.tenantId,
        credential.userId,
        credential.channelId,
        credential.provider,
        credential.apiKey,
        credential.apiKeyEncoding ?? 'plain',
        credential.baseUrl,
        credential.defaultModel ?? null,
        Date.now(),
      ],
    )
  }

  async getCredential(scope: AgentRuntimeScope, channelId: string): Promise<TenantRuntimeCredential | undefined> {
    const result = await this.client.query<CredentialRow>(
      `SELECT tenant_id, user_id, channel_id, provider, api_key, api_key_encoding, base_url, default_model
      FROM proma_runtime_credentials
      WHERE tenant_id = $1 AND user_id = $2 AND channel_id = $3`,
      [scope.tenantId, scope.userId, channelId],
    )
    const row = result.rows[0]
    return row ? credentialFromRow(row) : undefined
  }

  async setWorkspace(workspace: TenantRuntimeWorkspace): Promise<void> {
    await this.client.query(
      `INSERT INTO proma_runtime_workspaces (
        tenant_id, user_id, workspace_slug, cwd, mcp_servers, updated_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      ON CONFLICT (tenant_id, user_id, workspace_slug)
      DO UPDATE SET
        cwd = EXCLUDED.cwd,
        mcp_servers = EXCLUDED.mcp_servers,
        updated_at = EXCLUDED.updated_at`,
      [
        workspace.tenantId,
        workspace.userId,
        workspace.workspaceSlug,
        workspace.cwd,
        JSON.stringify(workspace.mcpServers),
        Date.now(),
      ],
    )
  }

  async getWorkspace(scope: AgentRuntimeScope, workspaceSlug: string): Promise<TenantRuntimeWorkspace | undefined> {
    const result = await this.client.query<WorkspaceRow>(
      `SELECT tenant_id, user_id, workspace_slug, cwd, mcp_servers
      FROM proma_runtime_workspaces
      WHERE tenant_id = $1 AND user_id = $2 AND workspace_slug = $3`,
      [scope.tenantId, scope.userId, workspaceSlug],
    )
    const row = result.rows[0]
    return row ? workspaceFromRow(row) : undefined
  }

  async createSession(session: TenantRuntimeSession): Promise<TenantRuntimeSession> {
    await this.client.query(
      `INSERT INTO proma_runtime_sessions (
        tenant_id, user_id, session_id, workspace_slug, channel_id, model_id, runtime, title, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (tenant_id, user_id, session_id)
      DO UPDATE SET
        workspace_slug = EXCLUDED.workspace_slug,
        channel_id = EXCLUDED.channel_id,
        model_id = EXCLUDED.model_id,
        runtime = EXCLUDED.runtime,
        title = EXCLUDED.title,
        updated_at = EXCLUDED.updated_at`,
      sessionParams(session),
    )
    return cloneRuntimeValue(session)
  }

  async getSession(scope: AgentRuntimeScope, sessionId: string): Promise<TenantRuntimeSession | undefined> {
    const result = await this.client.query<SessionRow>(
      `SELECT tenant_id, user_id, session_id, workspace_slug, channel_id, model_id, runtime, title, created_at, updated_at
      FROM proma_runtime_sessions
      WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3`,
      [scope.tenantId, scope.userId, sessionId],
    )
    const row = result.rows[0]
    return row ? sessionFromRow(row) : undefined
  }

  async updateSession(session: TenantRuntimeSession): Promise<TenantRuntimeSession> {
    await this.client.query(
      `UPDATE proma_runtime_sessions
      SET workspace_slug = $4, channel_id = $5, model_id = $6, runtime = $7, title = $8, created_at = $9, updated_at = $10
      WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3`,
      sessionParams(session),
    )
    return cloneRuntimeValue(session)
  }

  async deleteSession(scope: AgentRuntimeScope, sessionId: string): Promise<boolean> {
    const params = [scope.tenantId, scope.userId, sessionId]
    const deleted = await this.client.query<Record<string, unknown>>(
      `DELETE FROM proma_runtime_sessions WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3 RETURNING session_id`,
      params,
    )
    if (deleted.rows.length === 0) return false
    await this.client.query(`DELETE FROM proma_runtime_session_messages WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3`, params)
    return true
  }

  async appendSessionMessages(scope: AgentRuntimeScope, sessionId: string, messages: SDKMessage[]): Promise<void> {
    for (const message of messages) {
      const messageUuid = getSDKMessageUuid(message)
      await this.client.query(
        `INSERT INTO proma_runtime_session_messages (
          tenant_id, user_id, session_id, message_index, message_uuid, message_json, created_at
        ) VALUES (
          $1, $2, $3,
          (
            SELECT COALESCE(MAX(message_index) + 1, 0)
            FROM proma_runtime_session_messages
            WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3
          ),
          $4, $5::jsonb, $6
        )`,
        [
          scope.tenantId,
          scope.userId,
          sessionId,
          messageUuid ?? null,
          JSON.stringify(message),
          Date.now(),
        ],
      )
    }
  }

  async getSessionMessages(scope: AgentRuntimeScope, sessionId: string): Promise<SDKMessage[]> {
    const result = await this.client.query<MessageRow>(
      `SELECT message_json
      FROM proma_runtime_session_messages
      WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3
      ORDER BY message_index ASC`,
      [scope.tenantId, scope.userId, sessionId],
    )
    return result.rows.map((row) => parseJsonValue<SDKMessage>(row.message_json))
  }

  async truncateSessionMessages(
    scope: AgentRuntimeScope,
    sessionId: string,
    upToUuidInclusive: string,
  ): Promise<SDKMessage[]> {
    const indexResult = await this.client.query<MessageIndexRow>(
      `SELECT message_index
      FROM proma_runtime_session_messages
      WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3 AND message_uuid = $4
      ORDER BY message_index ASC
      LIMIT 1`,
      [scope.tenantId, scope.userId, sessionId, upToUuidInclusive],
    )
    const messageIndex = indexResult.rows[0]?.message_index
    if (typeof messageIndex === 'number') {
      await this.client.query(
        `DELETE FROM proma_runtime_session_messages
        WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3 AND message_index > $4`,
        [scope.tenantId, scope.userId, sessionId, messageIndex],
      )
    }
    return this.getSessionMessages(scope, sessionId)
  }

  async setTask(task: AgentRuntimeTaskMeta): Promise<void> {
    await this.client.query(
      `INSERT INTO proma_runtime_tasks (
        tenant_id, user_id, session_id, task_id, status, started_at, completed_at, error
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (tenant_id, user_id, task_id)
      DO UPDATE SET
        session_id = EXCLUDED.session_id,
        status = EXCLUDED.status,
        started_at = EXCLUDED.started_at,
        completed_at = EXCLUDED.completed_at,
        error = EXCLUDED.error`,
      [
        task.tenantId,
        task.userId,
        task.sessionId,
        task.taskId,
        task.status,
        task.startedAt,
        task.completedAt ?? null,
        task.error ?? null,
      ],
    )
  }

  async getTask(scope: AgentRuntimeScope, taskId: string): Promise<AgentRuntimeTaskMeta | undefined> {
    const result = await this.client.query<TaskRow>(
      `SELECT tenant_id, user_id, session_id, task_id, status, started_at, completed_at, error
      FROM proma_runtime_tasks
      WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3`,
      [scope.tenantId, scope.userId, taskId],
    )
    const row = result.rows[0]
    return row ? taskFromRow(row) : undefined
  }

  async setMcpOAuthTokens(
    scope: AgentRuntimeScope,
    workspaceSlug: string,
    serverName: string,
    tokens: TenantMcpOAuthTokens,
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO proma_runtime_mcp_oauth_tokens (
        tenant_id, user_id, workspace_slug, server_name, tokens_json, updated_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      ON CONFLICT (tenant_id, user_id, workspace_slug, server_name)
      DO UPDATE SET tokens_json = EXCLUDED.tokens_json, updated_at = EXCLUDED.updated_at`,
      [scope.tenantId, scope.userId, workspaceSlug, serverName, JSON.stringify(tokens), Date.now()],
    )
  }

  async getMcpOAuthTokens(
    scope: AgentRuntimeScope,
    workspaceSlug: string,
    serverName: string,
  ): Promise<TenantMcpOAuthTokens | undefined> {
    const result = await this.client.query<TokensRow>(
      `SELECT tokens_json
      FROM proma_runtime_mcp_oauth_tokens
      WHERE tenant_id = $1 AND user_id = $2 AND workspace_slug = $3 AND server_name = $4`,
      [scope.tenantId, scope.userId, workspaceSlug, serverName],
    )
    const row = result.rows[0]
    return row ? parseJsonValue<TenantMcpOAuthTokens>(row.tokens_json) : undefined
  }

  async setMcpClientSecret(secret: TenantMcpClientSecret): Promise<void> {
    await this.client.query(
      `INSERT INTO proma_runtime_mcp_client_secrets (
        tenant_id, user_id, workspace_slug, server_name, client_secret, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tenant_id, user_id, workspace_slug, server_name)
      DO UPDATE SET client_secret = EXCLUDED.client_secret, updated_at = EXCLUDED.updated_at`,
      [
        secret.tenantId,
        secret.userId,
        secret.workspaceSlug,
        secret.serverName,
        secret.clientSecret,
        Date.now(),
      ],
    )
  }

  async getMcpClientSecret(
    scope: AgentRuntimeScope,
    workspaceSlug: string,
    serverName: string,
  ): Promise<string | undefined> {
    const result = await this.client.query<ClientSecretRow>(
      `SELECT client_secret
      FROM proma_runtime_mcp_client_secrets
      WHERE tenant_id = $1 AND user_id = $2 AND workspace_slug = $3 AND server_name = $4`,
      [scope.tenantId, scope.userId, workspaceSlug, serverName],
    )
    return result.rows[0]?.client_secret
  }
}

function credentialFromRow(row: CredentialRow): TenantRuntimeCredential {
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    channelId: row.channel_id,
    provider: row.provider as ProviderType,
    apiKey: row.api_key,
    apiKeyEncoding: normalizeSecretEncoding(row.api_key_encoding),
    baseUrl: row.base_url,
    defaultModel: row.default_model ?? undefined,
  }
}

function workspaceFromRow(row: WorkspaceRow): TenantRuntimeWorkspace {
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    workspaceSlug: row.workspace_slug,
    cwd: row.cwd,
    mcpServers: parseJsonValue<Record<string, McpServerEntry>>(row.mcp_servers),
  }
}

function sessionFromRow(row: SessionRow): TenantRuntimeSession {
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    sessionId: row.session_id,
    workspaceSlug: row.workspace_slug,
    channelId: row.channel_id,
    modelId: row.model_id,
    runtime: row.runtime,
    title: row.title ?? undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function taskFromRow(row: TaskRow): AgentRuntimeTaskMeta {
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    status: row.status,
    startedAt: Number(row.started_at),
    completedAt: row.completed_at == null ? undefined : Number(row.completed_at),
    error: row.error ?? undefined,
  }
}

function sessionParams(session: TenantRuntimeSession): readonly unknown[] {
  return [
    session.tenantId,
    session.userId,
    session.sessionId,
    session.workspaceSlug,
    session.channelId,
    session.modelId,
    session.runtime,
    session.title ?? null,
    session.createdAt,
    session.updatedAt,
  ]
}

function normalizeSecretEncoding(value: unknown): TenantRuntimeSecretEncoding {
  return value === 'encoded' ? 'encoded' : 'plain'
}

function getSDKMessageUuid(message: SDKMessage): string | undefined {
  const value = (message as { uuid?: unknown }).uuid
  return typeof value === 'string' ? value : undefined
}

function parseJsonValue<T>(value: unknown): T {
  if (typeof value === 'string') {
    return JSON.parse(value) as T
  }
  return cloneRuntimeValue(value) as T
}

function cloneRuntimeValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value)
  }
  return JSON.parse(JSON.stringify(value)) as T
}
