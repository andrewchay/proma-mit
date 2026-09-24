/**
 * Project ↔ AgentWorkspace 绑定服务
 *
 * Project 是业务实体，AgentWorkspace 是执行环境；两者的多对多「正式绑定」
 * 仅表示授权（项目检索记忆时可将该工作区纳入范围），不代表自动共享资料。
 *
 * 存储：复用项目 SQLite（paa.db）的 project_workspace_bindings 表；
 * 迁移由 project-sqlite-store.ts 的 migrate() 幂等创建，数据库重开即可用。
 * 删除项目时由 deleteProject() 级联清理绑定；删除工作区暂不清理（见未覆盖项）。
 */

import type { ProjectWorkspaceBinding } from '@gravitas/shared'
import { getProject, getProjectDb } from './project-sqlite-store'
import { getAgentWorkspace } from './agent-workspace-manager'

interface BindingRow {
  project_id: string
  workspace_id: string
  created_at: number
}

function rowToBinding(row: BindingRow): ProjectWorkspaceBinding {
  return {
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    createdAt: row.created_at,
  }
}

/**
 * 绑定项目与工作区。
 * 绑定前先用 getProject / getAgentWorkspace 验证两个实体都存在；
 * 任一不存在返回 null。重复绑定幂等：直接返回已存在的绑定。
 */
export function bindWorkspaceToProject(projectId: string, workspaceId: string): ProjectWorkspaceBinding | null {
  if (!getProject(projectId)) return null
  if (!getAgentWorkspace(workspaceId)) return null
  const database = getProjectDb()
  const existing = database
    .prepare(`SELECT * FROM project_workspace_bindings WHERE project_id = ? AND workspace_id = ?`)
    .get(projectId, workspaceId) as BindingRow | undefined
  if (existing) return rowToBinding(existing)
  const createdAt = Date.now()
  database
    .prepare(`INSERT INTO project_workspace_bindings (project_id, workspace_id, created_at) VALUES (?, ?, ?)`)
    .run(projectId, workspaceId, createdAt)
  return { projectId, workspaceId, createdAt }
}

/** 判断绑定当前是否有效：除数据库行存在外，还必须实时验证项目与工作空间实体仍存在。 */
export function hasProjectWorkspaceBinding(projectId: string, workspaceId: string): boolean {
  if (!getProject(projectId)) return false
  if (!getAgentWorkspace(workspaceId)) return false
  const database = getProjectDb()
  const row = database
    .prepare(`SELECT project_id FROM project_workspace_bindings WHERE project_id = ? AND workspace_id = ?`)
    .get(projectId, workspaceId)
  return Boolean(row)
}

/** 解绑；返回是否有实际删除（未绑定时返回 false） */
export function unbindWorkspaceFromProject(projectId: string, workspaceId: string): boolean {
  const database = getProjectDb()
  const result = database
    .prepare(`DELETE FROM project_workspace_bindings WHERE project_id = ? AND workspace_id = ?`)
    .run(projectId, workspaceId)
  return result.changes > 0
}

/** 按项目列出全部绑定（按创建时间升序） */
export function listProjectWorkspaceBindings(projectId: string): ProjectWorkspaceBinding[] {
  if (!getProject(projectId)) return []
  const database = getProjectDb()
  const rows = database
    .prepare(`SELECT * FROM project_workspace_bindings WHERE project_id = ? ORDER BY created_at ASC`)
    .all(projectId) as BindingRow[]
  return rows
    .filter((row) => Boolean(getAgentWorkspace(row.workspace_id)))
    .map(rowToBinding)
}

/** 按工作区列出全部绑定（按创建时间升序） */
export function listWorkspaceProjectBindings(workspaceId: string): ProjectWorkspaceBinding[] {
  if (!getAgentWorkspace(workspaceId)) return []
  const database = getProjectDb()
  const rows = database
    .prepare(`SELECT * FROM project_workspace_bindings WHERE workspace_id = ? ORDER BY created_at ASC`)
    .all(workspaceId) as BindingRow[]
  return rows
    .filter((row) => Boolean(getProject(row.project_id)))
    .map(rowToBinding)
}
