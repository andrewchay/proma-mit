import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectFileChangePolicy } from '@gravitas/shared'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getProjectDb } from './project-sqlite-store'
import { hasProjectWorkspaceBinding } from './project-workspace-bindings'

interface PolicyRow { revision: string; enabled_at: number; ignore_digest: string | null }

/** 将原始忽略文件内容绑定到授权；读取失败时不沿用旧授权。 */
function ignoreDigest(root: string): string {
  const rootInfo = lstatSync(root, { bigint: true })
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.ino === 0n) throw new Error('项目目录不可用于授权')
  const rootIdentity = `${rootInfo.dev}:${rootInfo.ino}:`
  let fd: number
  try { fd = openSync(join(root, '.gravitasignore'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createHash('sha256').update(rootIdentity).update('missing').digest('hex')
    throw error
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > 65536) throw new Error('忽略文件不可用于授权')
    const data = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < data.length) { const read = readSync(fd, data, length, data.length - length, length); if (!read) break; length += read }
    const after = fstatSync(fd)
    if (length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error('忽略文件读取期间发生变化')
    return createHash('sha256').update(rootIdentity).update('file:').update(data.subarray(0, length)).digest('hex')
  } finally { closeSync(fd) }
}

/** 绑定撤销后策略立即失效；重新绑定不会恢复旧授权。 */
export function getProjectFileChangePolicy(projectId: string, workspaceId: string): ProjectFileChangePolicy | null {
  const root = getAgentWorkspace(workspaceId)?.rootPath
  if (!hasProjectWorkspaceBinding(projectId, workspaceId) || !root) return null
  const row = getProjectDb().prepare('SELECT p.revision, p.enabled_at, s.ignore_digest FROM project_file_change_policies p LEFT JOIN project_file_change_policy_scopes s ON s.project_id=p.project_id AND s.workspace_id=p.workspace_id AND s.revision=p.revision WHERE p.project_id = ? AND p.workspace_id = ?').get(projectId, workspaceId) as PolicyRow | undefined
  if (!row?.ignore_digest) return null
  let matches = false
  try { matches = row.ignore_digest === ignoreDigest(root) } catch { /* 读不到范围时撤销，不能沿用旧授权。 */ }
  if (matches) return { revision: row.revision, enabledAt: row.enabled_at }
  getProjectDb().prepare('DELETE FROM project_file_change_policy_scopes WHERE project_id = ? AND workspace_id = ? AND revision = ?').run(projectId, workspaceId, row.revision)
  return null
}

/** 仅供用户明确开启或关闭；开启只覆盖此时之后发生的扫描观察。 */
export function setProjectFileChangePolicy(projectId: string, workspaceId: string, enabled: boolean): ProjectFileChangePolicy | null {
  if (typeof enabled !== 'boolean' || !hasProjectWorkspaceBinding(projectId, workspaceId) || !getAgentWorkspace(workspaceId)?.rootPath) throw new Error('项目工作区绑定无效')
  const database = getProjectDb()
  if (!enabled) {
    database.transaction(() => {
      database.prepare('DELETE FROM project_file_change_policy_scopes WHERE project_id = ? AND workspace_id = ?').run(projectId, workspaceId)
      database.prepare('DELETE FROM project_file_change_policies WHERE project_id = ? AND workspace_id = ?').run(projectId, workspaceId)
    })()
    return null
  }
  const current = getProjectFileChangePolicy(projectId, workspaceId)
  if (current) return current
  const root = getAgentWorkspace(workspaceId)!.rootPath!
  const digest = ignoreDigest(root)
  const policy = { revision: randomUUID(), enabledAt: Date.now() }
  database.transaction(() => {
    database.prepare('DELETE FROM project_file_change_policy_scopes WHERE project_id = ? AND workspace_id = ?').run(projectId, workspaceId)
    database.prepare('DELETE FROM project_file_change_policies WHERE project_id = ? AND workspace_id = ?').run(projectId, workspaceId)
    database.prepare('INSERT INTO project_file_change_policies (project_id, workspace_id, revision, enabled_at) VALUES (?, ?, ?, ?)').run(projectId, workspaceId, policy.revision, policy.enabledAt)
    database.prepare('INSERT INTO project_file_change_policy_scopes (project_id, workspace_id, revision, ignore_digest) VALUES (?, ?, ?, ?)').run(projectId, workspaceId, policy.revision, digest)
  })()
  return policy
}

/** 文件监听到忽略配置变化时，禁止配置短暂变更又还原后恢复旧授权。 */
export function invalidateWorkspaceFileChangePolicies(workspaceId: string): void {
  getProjectDb().prepare('DELETE FROM project_file_change_policy_scopes WHERE workspace_id = ?').run(workspaceId)
}
