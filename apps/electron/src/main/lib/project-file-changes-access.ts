import type { ProjectWorkspaceFileChangesView } from '@gravitas/shared'
import { getAgentWorkspace } from './agent-workspace-manager'
import { hasProjectWorkspaceBinding } from './project-workspace-bindings'
import { readProjectFileChanges } from './project-file-changes'
import { isProjectRootWatched } from './workspace-watcher'

/** 用户主动查看时校验当前绑定；解绑后不再暴露工作区记录。 */
export async function getProjectWorkspaceFileChanges(projectId: string, workspaceId: string): Promise<ProjectWorkspaceFileChangesView> {
  if (!hasProjectWorkspaceBinding(projectId, workspaceId)) throw new Error('工作区未绑定到项目')
  const workspace = getAgentWorkspace(workspaceId)
  if (!workspace?.rootPath) throw new Error('工作区没有本地项目目录')
  const result = await readProjectFileChanges(workspaceId, workspace.rootPath)
  if (!hasProjectWorkspaceBinding(projectId, workspaceId) || getAgentWorkspace(workspaceId)?.rootPath !== workspace.rootPath) throw new Error('工作区绑定已变化，请重新查看')
  return { ...result, watching: isProjectRootWatched(workspace.rootPath) }
}
