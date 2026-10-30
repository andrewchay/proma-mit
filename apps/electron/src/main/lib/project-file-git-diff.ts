import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import type { ProjectWorkspaceGitDiff } from '@gravitas/shared'
import { getAgentWorkspace } from './agent-workspace-manager'
import { hasProjectWorkspaceBinding } from './project-workspace-bindings'

const run = promisify(execFile)
const MAX_DIFF_BYTES = 128 * 1024

/** 仅在用户主动请求时比较当前 Git HEAD；不读取或保存历史正文。 */
export async function getProjectWorkspaceGitDiff(projectId: string, workspaceId: string, path: string): Promise<ProjectWorkspaceGitDiff> {
  if (!hasProjectWorkspaceBinding(projectId, workspaceId)) throw new Error('工作区未绑定到项目')
  const workspace = getAgentWorkspace(workspaceId)
  if (!workspace?.rootPath) throw new Error('工作区没有本地项目目录')
  if (typeof path !== 'string' || !path || path.length > 4096 || isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('文件路径无效')
  let result: ProjectWorkspaceGitDiff
  try {
    const { stdout } = await run('git', ['-C', workspace.rootPath, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', 'HEAD', '--', `:(literal)${path}`], {
      timeout: 5000, maxBuffer: MAX_DIFF_BYTES, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8',
    })
    result = /^Binary files .* differ$/m.test(stdout) ? { status: 'unavailable', reason: '二进制文件不显示文本差异。' } : stdout ? { status: 'available', text: stdout } : { status: 'unavailable', reason: '当前相对 HEAD 没有可显示的差异；文件可能未跟踪或已恢复。' }
  } catch {
    result = { status: 'unavailable', reason: '无法读取 Git 差异：可能没有 HEAD、不是 Git 项目，或差异超过大小或时间限制。' }
  }
  if (!hasProjectWorkspaceBinding(projectId, workspaceId) || getAgentWorkspace(workspaceId)?.rootPath !== workspace.rootPath) throw new Error('工作区绑定已变化，请重新查看')
  return result
}
