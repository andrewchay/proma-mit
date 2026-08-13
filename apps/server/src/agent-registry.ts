/**
 * 服务端 Agent Registry（Postgres 多租户身份层种子）
 *
 * 把 Electron 侧 Agent Card 同步到服务端，按 tenant/user 隔离；
 * 是「私有部署 → SaaS 商业化」租户隔离种子的核心，也是未来跨 Agent 编排/发现的基础。
 */
import type { AgentRuntimePostgresClient, AgentRuntimeScope } from '@gravitas/shared/utils'
import type { AgentCard, AgentCardSource } from '@gravitas/shared'

export interface RegistryQuery {
  source?: string
  enabled?: boolean
  limit?: number
}

interface RegistryRow extends Record<string, unknown> {
  card_id: string
  source: string
  name: string
  role: string
  description: string
  capabilities: string
  fixed_workflow_id: string | null
  execution_stats: string | null
  enabled: number
  created_at: number
  updated_at: number
}

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS proma_runtime_agent_registry (
  tenant_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '[]',
  fixed_workflow_id TEXT,
  execution_stats TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, card_id)
)`

export class AgentRegistryStore {
  constructor(private readonly client: AgentRuntimePostgresClient) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(CREATE_SQL)
  }

  async upsert(scope: AgentRuntimeScope, card: AgentCard): Promise<void> {
    await this.client.query(
      `INSERT INTO proma_runtime_agent_registry
       (tenant_id, card_id, source, name, role, description, capabilities, fixed_workflow_id, execution_stats, enabled, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (tenant_id, card_id) DO UPDATE SET
         source=EXCLUDED.source, name=EXCLUDED.name, role=EXCLUDED.role,
         description=EXCLUDED.description, capabilities=EXCLUDED.capabilities,
         fixed_workflow_id=EXCLUDED.fixed_workflow_id, execution_stats=EXCLUDED.execution_stats,
         enabled=EXCLUDED.enabled, updated_at=EXCLUDED.updated_at`,
      [
        scope.tenantId, card.cardId, card.source, card.name, card.role, card.description,
        JSON.stringify(card.capabilities), card.fixedWorkflowId ?? null,
        card.executionStats ? JSON.stringify(card.executionStats) : null,
        card.enabled ? 1 : 0, card.createdAt, card.updatedAt,
      ],
    )
  }

  async list(scope: AgentRuntimeScope, query: RegistryQuery = {}): Promise<AgentCard[]> {
    const enabledInt = query.enabled === undefined ? null : query.enabled ? 1 : 0
    const result = await this.client.query<RegistryRow>(
      `SELECT card_id, source, name, role, description, capabilities, fixed_workflow_id, execution_stats, enabled, created_at, updated_at
       FROM proma_runtime_agent_registry
       WHERE tenant_id = $1
         AND ($2::text IS NULL OR source = $2) AND ($3::int IS NULL OR enabled = $3)
       ORDER BY updated_at DESC LIMIT $4`,
      [scope.tenantId, query.source ?? null, enabledInt, Math.min(query.limit ?? 200, 1000)],
    )
    return result.rows.map((row) => ({
      cardId: row.card_id,
      source: row.source as AgentCardSource,
      name: row.name,
      role: row.role,
      description: row.description,
      capabilities: JSON.parse(row.capabilities) as string[],
      fixedWorkflowId: typeof row.fixed_workflow_id === 'string' ? row.fixed_workflow_id : undefined,
      executionStats: row.execution_stats ? JSON.parse(row.execution_stats) as AgentCard['executionStats'] : undefined,
      enabled: Boolean(row.enabled),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }))
  }
}
