import type { AgentRuntimePostgresClient, AgentRuntimeScope } from '@gravitas/shared/utils'

export type SharedWorkspaceRole = 'owner' | 'editor' | 'viewer'
export interface SharedWorkspaceMember { userId: string; role: 'editor' | 'viewer'; updatedAt: number }

/** 成员登记以现有 (tenant, owner, slug) 工作区为权威；此表本身不授予 Runtime 访问权。 */
export class PostgresWorkspaceMembershipStore {
  constructor(private readonly client: AgentRuntimePostgresClient) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_workspace_members (
      tenant_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, workspace_slug TEXT NOT NULL,
      member_user_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, owner_user_id, workspace_slug, member_user_id),
      FOREIGN KEY (tenant_id, owner_user_id, workspace_slug)
        REFERENCES proma_runtime_workspaces (tenant_id, user_id, workspace_slug) ON DELETE CASCADE
    )`)
  }

  /** 只为当前认证用户拥有的工作区设置成员；不根据同名 slug 推断其他所有者。 */
  async setMember(scope: AgentRuntimeScope, workspaceSlug: string, memberUserId: string, role: 'editor' | 'viewer'): Promise<boolean> {
    if (!workspaceSlug.trim() || !memberUserId.trim() || memberUserId === scope.userId || (role !== 'editor' && role !== 'viewer')) throw new Error('工作区成员或角色无效')
    const result = await this.client.query(
      `INSERT INTO proma_workspace_members (tenant_id, owner_user_id, workspace_slug, member_user_id, role, updated_at)
       SELECT tenant_id, user_id, workspace_slug, $4, $5, $6 FROM proma_runtime_workspaces
       WHERE tenant_id=$1 AND user_id=$2 AND workspace_slug=$3
       ON CONFLICT (tenant_id, owner_user_id, workspace_slug, member_user_id)
       DO UPDATE SET role=EXCLUDED.role, updated_at=EXCLUDED.updated_at RETURNING member_user_id`,
      [scope.tenantId, scope.userId, workspaceSlug, memberUserId, role, Date.now()],
    )
    return result.rows.length === 1
  }

  async removeMember(scope: AgentRuntimeScope, workspaceSlug: string, memberUserId: string): Promise<boolean> {
    const result = await this.client.query('DELETE FROM proma_workspace_members WHERE tenant_id=$1 AND owner_user_id=$2 AND workspace_slug=$3 AND member_user_id=$4 RETURNING member_user_id', [scope.tenantId, scope.userId, workspaceSlug, memberUserId])
    return result.rows.length === 1
  }

  async listMembers(scope: AgentRuntimeScope, workspaceSlug: string): Promise<SharedWorkspaceMember[]> {
    const result = await this.client.query('SELECT member_user_id, role, updated_at FROM proma_workspace_members WHERE tenant_id=$1 AND owner_user_id=$2 AND workspace_slug=$3 ORDER BY member_user_id', [scope.tenantId, scope.userId, workspaceSlug])
    return result.rows.map((row) => {
      if (typeof row.member_user_id !== 'string' || (row.role !== 'editor' && row.role !== 'viewer') || !Number.isSafeInteger(Number(row.updated_at))) throw new Error('工作区成员记录无效')
      return { userId: row.member_user_id, role: row.role, updatedAt: Number(row.updated_at) }
    })
  }

  async getRole(scope: AgentRuntimeScope, ownerUserId: string, workspaceSlug: string): Promise<SharedWorkspaceRole | null> {
    const result = await this.client.query(`SELECT CASE WHEN w.user_id=$4 THEN 'owner' ELSE m.role END AS role
      FROM proma_runtime_workspaces w LEFT JOIN proma_workspace_members m
      ON m.tenant_id=w.tenant_id AND m.owner_user_id=w.user_id AND m.workspace_slug=w.workspace_slug AND m.member_user_id=$4
      WHERE w.tenant_id=$1 AND w.user_id=$2 AND w.workspace_slug=$3`, [scope.tenantId, ownerUserId, workspaceSlug, scope.userId])
    const role = result.rows[0]?.role
    return role === 'owner' || role === 'editor' || role === 'viewer' ? role : null
  }
}
