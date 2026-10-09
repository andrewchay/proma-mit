/**
 * Agent Bash 工具的 seatbelt 沙箱策略（折中方案）。
 *
 * 可写：工作目录、会话私有 scratch 目录（同时作为 TMPDIR 与包管理器缓存目录），以及 git 元数据中
 *      对象库、引用、日志与本 worktree 自身的 gitdir。
 * 禁写：git hooks（会在之后的正常 git 操作中执行）、主仓库 config、工作目录下的 .git 指针文件、
 *      其他 worktree 的 gitdir。
 * 拒读写：应用配置目录（含签名密钥与已签名记录）。
 * 边界：仅 macOS；其他平台拒绝执行（默认拒绝）。Claude SDK 自带的 Bash 不经过本模块。
 */

import { execFile } from 'node:child_process'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getConfigDir } from '../../config-paths'
import { buildSeatbeltProfile, SANDBOX_EXEC_PATH, type SeatbeltPolicy } from '../../pinned-verifier-sandbox'

export interface GitLayout {
  /** 主仓库的 .git 目录（对象库、引用、hooks、config 所在）。 */
  readonly commonDir: string
  /** 当前 worktree 的 gitdir；主工作区中与 commonDir 相同。 */
  readonly ownDir: string
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** 解析 git 布局；cwd 不在 git 仓库中时返回 undefined。 */
export function resolveGitLayout(cwd: string): Promise<GitLayout | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir'], { encoding: 'utf8' }, (error, stdout) => {
      if (error) return resolve(undefined)
      const [common, own] = stdout.trim().split('\n')
      if (!common || !own) return resolve(undefined)
      resolve({ commonDir: realOrSelf(common), ownDir: realOrSelf(own) })
    })
  })
}

/** 会话 scratch 目录：只属于当前会话，命名中的非法字符替换为下划线。 */
export function scratchDirFor(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_') || 'default'
  const dir = join(realOrSelf(tmpdir()), 'gravitas-bash-scratch', safe)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return realOrSelf(dir)
}

export function buildBashSandboxPolicy(input: {
  cwd: string
  scratchDir: string
  git?: GitLayout
  configDirs: readonly string[]
}): SeatbeltPolicy {
  const cwd = realOrSelf(input.cwd)
  const writableRoots = [cwd, input.scratchDir]
  const writableLiterals: string[] = []
  const denyWriteRoots: string[] = []
  const denyWriteLiterals: string[] = [join(cwd, '.git')]
  if (input.git) {
    const { commonDir, ownDir } = input.git
    const mainWorktree = ownDir === commonDir
    if (mainWorktree) {
      // 主工作区：整个 .git 可写，但 hooks、config 与其他 worktree 的目录需要单独禁止。
      writableRoots.push(commonDir)
      denyWriteRoots.push(join(commonDir, 'hooks'), join(commonDir, 'worktrees'))
    } else {
      // 链接 worktree：只开放对象库、引用、日志与自身 gitdir；其他 worktree 目录保持不可写。
      writableRoots.push(join(commonDir, 'objects'), join(commonDir, 'refs'), join(commonDir, 'logs'), ownDir)
      writableLiterals.push(join(commonDir, 'packed-refs'), join(commonDir, 'packed-refs.lock'), join(commonDir, 'FETCH_HEAD'), join(commonDir, 'ORIG_HEAD'))
      denyWriteRoots.push(join(commonDir, 'hooks'))
    }
    denyWriteLiterals.push(join(commonDir, 'config'))
  }
  // 配置目录禁止写入（Agent 会话目录 agent-workspaces 例外放行，否则 git 连父目录都无法 stat）；
  // 读取只禁止签名目录（密钥密文与记录），其余配置为密文或本就经 Read 工具可读。
  const configDirs = input.configDirs.map(realOrSelf)
  return {
    writableRoots,
    writableLiterals,
    denyRoots: configDirs.map((dir) => realOrSelf(join(dir, 'verifiers'))),
    denyWriteRoots: [...denyWriteRoots, ...configDirs],
    denyWriteLiterals,
    allowAfterDenyRoots: configDirs.map((dir) => realOrSelf(join(dir, 'agent-workspaces'))),
  }
}

/** 为一次 Bash 调用生成沙箱命令与受控环境。 */
export async function prepareBashSandbox(cwd: string, sessionId: string): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
  const scratchDir = scratchDirFor(sessionId)
  const git = await resolveGitLayout(cwd)
  const profile = buildSeatbeltProfile(buildBashSandboxPolicy({ cwd, scratchDir, git, configDirs: [getConfigDir()] }))
  return {
    argv: [SANDBOX_EXEC_PATH, '-p', profile, '/bin/sh', '-c'],
    env: {
      ...process.env,
      TMPDIR: scratchDir,
      BUN_INSTALL_CACHE_DIR: join(scratchDir, 'bun-cache'),
      npm_config_cache: join(scratchDir, 'npm-cache'),
    },
  }
}
