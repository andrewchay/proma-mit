/** 主进程创建研发任务 worktree；绑定落在会话私有目录，不修改工作区配置。 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { writeJsonFileAtomic } from './safe-file'

interface DevelopmentWorktree {
  repository: string
  path: string
  branch: string
  baseCommit: string
}
const BINDING_FILE = 'development-worktree.json'
function git(repository: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
function commonDirectory(repository: string): string {
  return realpathSync(resolve(repository, git(repository, 'rev-parse', '--git-common-dir')))
}

export function createDevelopmentWorktree(repository: string, sessionDirectory: string, executionId: string): DevelopmentWorktree {
  if (!/^[a-zA-Z0-9-]+$/.test(executionId)) throw new Error('无效的研发执行 ID')
  const root = realpathSync(repository)
  if (realpathSync(git(root, 'rev-parse', '--show-toplevel')) !== root) throw new Error('工作区必须指向 Git 仓库根目录')
  if (git(root, 'status', '--porcelain', '--untracked-files=all')) throw new Error('仓库存在未提交改动，请先保存当前迭代，再派发研发任务；不会自动提交或丢弃变更')
  mkdirSync(sessionDirectory, { recursive: true })
  if (existsSync(join(sessionDirectory, BINDING_FILE))) throw new Error('此会话已绑定研发 worktree，不能覆盖')
  const worktree: DevelopmentWorktree = {
    repository: root,
    path: join(realpathSync(sessionDirectory), 'source'),
    branch: `employee/${executionId}`,
    baseCommit: git(root, 'rev-parse', 'HEAD'),
  }
  git(root, 'worktree', 'add', '-b', worktree.branch, worktree.path, worktree.baseCommit)
  writeJsonFileAtomic(join(sessionDirectory, BINDING_FILE), worktree)
  return worktree
}

/** 主进程采集可核对的 Git 元数据；模型自述的测试结果不在此冒充已验证。 */
export function captureDevelopmentEvidence(repository: string, sessionDirectory: string, executionId: string): { path: string; summary: string } {
  if (!/^[a-zA-Z0-9-]+$/.test(executionId)) throw new Error('无效的研发执行 ID')
  const cwd = resolveDevelopmentWorktree(repository, sessionDirectory)
  if (!cwd) throw new Error('研发交付缺少 worktree 绑定')
  const binding: unknown = JSON.parse(readFileSync(join(sessionDirectory, BINDING_FILE), 'utf8'))
  if (!binding || typeof binding !== 'object' || !('baseCommit' in binding) || typeof binding.baseCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(binding.baseCommit)) throw new Error('研发基线损坏')
  const evidence = {
    executionId, capturedAt: Date.now(), cwd, baseCommit: binding.baseCommit,
    head: git(cwd, 'rev-parse', 'HEAD'),
    branch: git(cwd, 'branch', '--show-current'),
    status: git(cwd, 'status', '--short', '--untracked-files=all'),
    diffStat: git(cwd, 'diff', '--stat', binding.baseCommit, '--'),
    testVerification: 'not-verified',
  }
  const path = join(sessionDirectory, `development-evidence-${executionId}.json`)
  writeJsonFileAtomic(path, evidence)
  return { path, summary: `【主进程 Git 快照；测试结果仍待核验】\n分支：${evidence.branch}\n基线：${evidence.baseCommit}\n工作目录：${cwd}\n${evidence.status || '工作目录干净'}\n${evidence.diffStat || '无已跟踪文件差异；未跟踪文件见状态列表'}\n证据：${path}` }
}

/** 已有绑定失效时必须报错，绝不回退到主仓库执行。 */
export function resolveDevelopmentWorktree(repository: string, sessionDirectory: string): string | undefined {
  const binding = join(sessionDirectory, BINDING_FILE)
  if (!existsSync(binding)) return undefined
  const value: unknown = JSON.parse(readFileSync(binding, 'utf8'))
  if (!value || typeof value !== 'object' || !('repository' in value) || !('path' in value) ||
    typeof value.repository !== 'string' || typeof value.path !== 'string') throw new Error('研发 worktree 绑定损坏')
  if (realpathSync(repository) !== value.repository) throw new Error('研发会话绑定的仓库已变化，请重新派发')
  const path = realpathSync(value.path)
  if (path !== join(realpathSync(sessionDirectory), 'source') ||
    realpathSync(git(path, 'rev-parse', '--show-toplevel')) !== path ||
    commonDirectory(path) !== commonDirectory(repository)) throw new Error('研发 worktree 不属于当前仓库或会话')
  return path
}
