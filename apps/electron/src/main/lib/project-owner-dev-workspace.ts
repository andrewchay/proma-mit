/**
 * Owner 专用工作区的本地 Git 基线。
 *
 * 背景：绿地研发交付以 Git worktree 快照为边界，要求工作区 rootPath 是
 * HEAD 可解析的仓库。此前 Owner 专用工作区没有 rootPath，安排上下文只能
 * 提供纯文本交付，浏览器运行核验无法落地。
 *
 * 边界：
 * - 仓库建在应用受管目录下（owner-dev-repos/{slug}），不触碰用户既有目录；
 * - Git 不可用或基线建立失败时回退为无 rootPath 的托管工作区（旧行为）；
 * - 只做空初始提交，不预置任何业务文件，也不自动提交后续改动。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { devNull } from 'node:os'
import { join } from 'node:path'
import type { AgentWorkspace } from '@gravitas/shared'
import { createAgentWorkspace } from './agent-workspace-manager'
import { getConfigDir } from './config-paths'

/**
 * 研发交付依赖 worktree 快照，其基线来自仓库 HEAD。
 * 只有 `git init` 而没有首个提交的空仓会在执行准备阶段失败，因此这里就要求 HEAD 可解析，
 * 避免把一条必然失败的路径提供成候选。
 */
export function isGitRepositoryWithHead(rootPath: string): boolean {
  if (!existsSync(join(rootPath, '.git'))) return false
  try {
    execFileSync('git', ['-C', rootPath, 'rev-parse', '--verify', 'HEAD'], { stdio: 'ignore', timeout: 5_000, env: isolatedGitEnvironment() })
    return true
  } catch {
    return false
  }
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0' }
}

function git(rootPath: string, args: string[]): void {
  execFileSync('git', ['-C', rootPath, '-c', `core.hooksPath=${devNull}`, '-c', 'init.templateDir=', ...args], {
    stdio: 'ignore',
    timeout: 15_000,
    env: isolatedGitEnvironment(),
  })
}

/** 为 Owner 专用工作区建立带 Git 基线的本地仓库目录；基线不可用时回退为托管工作区。 */
export function createOwnerDedicatedWorkspace(name: string): AgentWorkspace {
  const trimmed = name.trim()
  const slug = trimmed.toLowerCase()
  if (trimmed.length > 100 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Owner工作区名称无效')
  const reposDir = join(getConfigDir(), 'owner-dev-repos')
  const repoRoot = join(reposDir, slug)
  // 不让预先放置的符号链接将建仓操作导向受管目录之外。
  for (const path of [reposDir, repoRoot]) {
    try {
      if (!lstatSync(path).isDirectory()) throw new Error('Owner工作区目录不安全')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
  }
  try {
    if (!lstatSync(join(repoRoot, '.git')).isDirectory()) throw new Error('Owner工作区目录不安全')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
  try {
    ensureGitBaseline(repoRoot)
  } catch (cause) {
    // Git 缺失或基线建立失败不应阻断 Owner 配置；退化为无 rootPath 的托管工作区（只能文本交付）。
    console.warn('[Owner工作区] 无法建立 Git 基线，回退为托管工作区', cause)
    return createAgentWorkspace(trimmed)
  }
  // 工作区登记自身的错误（重名、rootPath 已被占用等）不属于基线问题，原样抛出。
  return createAgentWorkspace(trimmed, repoRoot, slug)
}

/** 目录可能来自上次中断的半成品；缺失哪一步补哪一步，最终 HEAD 必须可解析。 */
function ensureGitBaseline(repoRoot: string): void {
  mkdirSync(repoRoot, { recursive: true })
  if (!existsSync(join(repoRoot, '.git'))) git(repoRoot, ['init', '-q'])
  // 绿地基线只需要可解析的 HEAD；空提交即可，不预置业务文件。
  if (!isGitRepositoryWithHead(repoRoot)) {
    git(repoRoot, ['-c', 'user.email=owner-dev@gravitas.local', '-c', 'user.name=gravitas-owner', 'commit', '--allow-empty', '-q', '-m', 'init'])
  }
  if (!isGitRepositoryWithHead(repoRoot)) throw new Error('Owner工作区 Git 基线不可用')
}
