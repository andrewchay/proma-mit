import { createHash } from 'node:crypto'
import type { ProjectWorkspaceFileChange } from '@gravitas/shared'
import { getProjectDb } from './project-sqlite-store'
import { getProjectFileChangePolicy } from './project-file-change-policy'

export interface ProjectFileChangeObservation {
  id: string
  projectId: string
  workspaceId: string
  policyRevision: string
  observedAt: number
  changes: ProjectWorkspaceFileChange[]
  totalChanges: number
}

/** 按一次扫描合并，稳定标识去重；只接收授权开启后观察到的变化。 */
export function recordProjectFileChangeObservation(projectId: string, workspaceId: string, changes: ProjectWorkspaceFileChange[]): ProjectFileChangeObservation | null {
  const policy = getProjectFileChangePolicy(projectId, workspaceId)
  if (!policy || !changes.length) return null
  const observedAt = changes[0]!.observedAt
  if (!Number.isSafeInteger(observedAt) || observedAt <= policy.enabledAt || changes.some(item => item.observedAt !== observedAt)) return null
  if (changes.some(item => typeof item.path !== 'string' || !item.path || item.path.length > 1000 || !['added', 'modified', 'deleted', 'renamed'].includes(item.kind) || (item.previousPath !== undefined && (typeof item.previousPath !== 'string' || item.previousPath.length > 1000)))) return null
  const selected = changes.slice(0, 20)
  const identity = { projectId, workspaceId, policyRevision: policy.revision, observedAt, changes: selected, totalChanges: changes.length }
  const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  const observation: ProjectFileChangeObservation = { id, ...identity }
  getProjectDb().prepare('INSERT OR IGNORE INTO project_file_change_observations (id, project_id, workspace_id, policy_revision, observed_at, payload) VALUES (?, ?, ?, ?, ?, ?)').run(id, projectId, workspaceId, policy.revision, observedAt, JSON.stringify(observation))
  return observation
}

/** 关闭、解绑或重新授权后旧观察不再允许用于新模型请求。 */
export function getAuthorizedProjectFileChangeObservation(projectId: string, id: string): ProjectFileChangeObservation | null {
  const row = getProjectDb().prepare('SELECT payload FROM project_file_change_observations WHERE project_id = ? AND id = ?').get(projectId, id) as { payload: string } | undefined
  if (!row) return null
  const value = JSON.parse(row.payload) as ProjectFileChangeObservation
  const policy = getProjectFileChangePolicy(projectId, value.workspaceId)
  const { id: actualId, ...identity } = value
  if (!policy || policy.revision !== value.policyRevision || value.projectId !== projectId || actualId !== id || createHash('sha256').update(JSON.stringify(identity)).digest('hex') !== id) return null
  return value
}
