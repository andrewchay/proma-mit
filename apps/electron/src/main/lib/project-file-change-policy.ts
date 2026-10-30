import { randomUUID } from 'node:crypto'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getProjectDb } from './project-sqlite-store'
import { hasProjectWorkspaceBinding } from './project-workspace-bindings'

export interface ProjectFileChangePolicy { revision: string; enabledAt: number }
interface PolicyRow { revision: string; enabled_at: number }

/** 绑定撤销后策略立即失效；重新绑定不会恢复旧授权。 */
export function getProjectFileChangePolicy(projectId: string, workspaceId: string): ProjectFileChangePolicy | null {
  if (!hasProjectWorkspaceBinding(projectId, workspaceId) || !getAgentWorkspace(workspaceId)?.rootPath) return null
  const row = getProjectDb().prepare('SELECT revision, enabled_at FROM project_file_change_policies WHERE project_id = ? AND workspace_id = ?').get(projectId, workspaceId) as PolicyRow | undefined
  return row ? { revision: row.revision, enabledAt: row.enabled_at } : null
}

/** 仅供用户明确开启或关闭；开启只覆盖此时之后发生的扫描观察。 */
export function setProjectFileChangePolicy(projectId: string, workspaceId: string, enabled: boolean): ProjectFileChangePolicy | null {
  if (typeof enabled !== 'boolean' || !hasProjectWorkspaceBinding(projectId, workspaceId) || !getAgentWorkspace(workspaceId)?.rootPath) throw new Error('项目工作区绑定无效')
  const database = getProjectDb()
  if (!enabled) {
    database.prepare('DELETE FROM project_file_change_policies WHERE project_id = ? AND workspace_id = ?').run(projectId, workspaceId)
    return null
  }
  const current = getProjectFileChangePolicy(projectId, workspaceId)
  if (current) return current
  const policy = { revision: randomUUID(), enabledAt: Date.now() }
  database.prepare('INSERT INTO project_file_change_policies (project_id, workspace_id, revision, enabled_at) VALUES (?, ?, ?, ?)').run(projectId, workspaceId, policy.revision, policy.enabledAt)
  return policy
}
