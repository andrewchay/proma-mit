import { createHash } from 'node:crypto'
import type { ProjectWorkspaceFileChange } from '@gravitas/shared'
import { getProjectDb } from './project-sqlite-store'
import { getProjectFileChangePolicy } from './project-file-change-policy'
import { listWorkspaceProjectBindings } from './project-workspace-bindings'
import { readProjectFileChanges } from './project-file-changes'

export interface ProjectFileChangeObservation {
  id: string
  projectId: string
  workspaceId: string
  policyRevision: string
  observedAt: number
  changes: ProjectWorkspaceFileChange[]
  retainedChanges: number
  historyBounded: true
  contentHash: string
}

/** 按一次扫描合并，稳定标识去重；只接收授权开启后观察到的变化。 */
export function recordProjectFileChangeObservation(projectId: string, workspaceId: string, changes: ProjectWorkspaceFileChange[]): ProjectFileChangeObservation | null {
  const policy = getProjectFileChangePolicy(projectId, workspaceId)
  if (!policy || !changes.length) return null
  const observedAt = changes[0]!.observedAt
  if (!Number.isSafeInteger(observedAt) || observedAt <= policy.enabledAt || changes.some(item => item.observedAt !== observedAt)) return null
  if (changes.some(item => typeof item.path !== 'string' || !item.path || item.path.length > 1000 || !['added', 'modified', 'deleted', 'renamed'].includes(item.kind) || (item.previousPath !== undefined && (typeof item.previousPath !== 'string' || item.previousPath.length > 1000)))) return null
  const selected = changes.slice(0, 20)
  const identity = { projectId, workspaceId, policyRevision: policy.revision, observedAt }
  const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  const content = { ...identity, changes: selected, retainedChanges: changes.length, historyBounded: true as const }
  const contentHash = createHash('sha256').update(JSON.stringify(content)).digest('hex')
  const observation: ProjectFileChangeObservation = { id, ...content, contentHash }
  getProjectDb().prepare('INSERT OR IGNORE INTO project_file_change_observations (id, project_id, workspace_id, policy_revision, observed_at, payload) VALUES (?, ?, ?, ?, ?, ?)').run(id, projectId, workspaceId, policy.revision, observedAt, JSON.stringify(observation))
  return observation
}

/** 关闭、解绑或重新授权后旧观察不再允许用于新模型请求。 */
export function getAuthorizedProjectFileChangeObservation(projectId: string, id: string): ProjectFileChangeObservation | null {
  const row = getProjectDb().prepare('SELECT payload FROM project_file_change_observations WHERE project_id = ? AND id = ?').get(projectId, id) as { payload: string } | undefined
  if (!row) return null
  const value = JSON.parse(row.payload) as ProjectFileChangeObservation
  const policy = getProjectFileChangePolicy(projectId, value.workspaceId)
  const { id: actualId, contentHash, ...content } = value
  const identity = { projectId: value.projectId, workspaceId: value.workspaceId, policyRevision: value.policyRevision, observedAt: value.observedAt }
  if (!policy || policy.revision !== value.policyRevision || value.projectId !== projectId || actualId !== id || createHash('sha256').update(JSON.stringify(identity)).digest('hex') !== id || createHash('sha256').update(JSON.stringify(content)).digest('hex') !== contentHash) return null
  return value
}

/** 从本地快照恢复观察，重复扫描或重启时由稳定身份去重。 */
export async function reconcileProjectFileChangeObservations(workspaceId: string, root: string): Promise<void> {
  const bindings = listWorkspaceProjectBindings(workspaceId).filter(binding => getProjectFileChangePolicy(binding.projectId, workspaceId))
  if (!bindings.length) return
  const snapshot = await readProjectFileChanges(workspaceId, root, 1000)
  const batches = new Map<number, ProjectWorkspaceFileChange[]>()
  for (const event of snapshot.changes.slice().reverse()) {
    const batch = batches.get(event.observedAt) ?? []
    batch.push(event)
    batches.set(event.observedAt, batch)
  }
  for (const binding of bindings) {
    for (const batch of batches.values()) recordProjectFileChangeObservation(binding.projectId, workspaceId, batch)
  }
}
