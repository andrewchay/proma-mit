/** 研发工作区门禁的结构化结果：只读、可展示、可重新核对。 */
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

export type DevelopmentWorkspaceBlocker =
  | { kind: 'ready' }
  | { kind: 'not_git_root'; workspaceId: string; workspaceName: string; repository: string; detail: string }
  | { kind: 'dirty_worktree'; workspaceId: string; workspaceName: string; repository: string; trackedFiles: string[]; untrackedFiles: string[]; detail: string; remedy: string }

const MAX_LISTED = 30

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** 解析 `git status --porcelain=v1 -z` 的输出。不能 trim：状态位前导空格有意义。 */
function parseStatus(raw: string): { trackedFiles: string[]; untrackedFiles: string[] } {
  const trackedFiles: string[] = [], untrackedFiles: string[] = []
  for (const entry of raw.split('\0')) {
    if (entry.length < 4) continue
    const path = entry.slice(3)
    if (entry.startsWith('?? ')) untrackedFiles.push(path)
    else trackedFiles.push(path)
  }
  return { trackedFiles, untrackedFiles }
}

export function inspectDevelopmentWorkspaceBlocker(repository: string, workspaceId: string, workspaceName: string): DevelopmentWorkspaceBlocker {
  let root: string
  try { root = realpathSync(repository) } catch {
    return { kind: 'not_git_root', workspaceId, workspaceName, repository, detail: '工作区目录不存在或不可读' }
  }
  let top: string
  try { top = realpathSync(git(root, 'rev-parse', '--show-toplevel').trim()) } catch {
    return { kind: 'not_git_root', workspaceId, workspaceName, repository: root, detail: '工作区不是 Git 仓库' }
  }
  if (top !== root) return { kind: 'not_git_root', workspaceId, workspaceName, repository: root, detail: `工作区不是仓库根目录（仓库根为 ${top}）` }
  // -z 且不 trim：porcelain 的 " M path" 前导空格是状态位，trim 会截断首个路径字符。
  const { trackedFiles, untrackedFiles } = parseStatus(git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'))
  if (!trackedFiles.length && !untrackedFiles.length) return { kind: 'ready' }
  return {
    kind: 'dirty_worktree', workspaceId, workspaceName, repository: root,
    trackedFiles: trackedFiles.slice(0, MAX_LISTED), untrackedFiles: untrackedFiles.slice(0, MAX_LISTED),
    detail: `已跟踪文件有 ${trackedFiles.length} 处修改，未跟踪文件有 ${untrackedFiles.length} 个`,
    remedy: '请先提交、暂存或移走这些文件，然后点击“重新核对工作区”。系统不会自动提交或丢弃你的改动。',
  }
}
