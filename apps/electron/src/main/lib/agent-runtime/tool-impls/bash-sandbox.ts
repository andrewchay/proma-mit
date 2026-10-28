/**
 * Agent Bash 工具的 seatbelt 沙箱策略（折中方案）。
 *
 * 可写：工作目录、会话私有 scratch 目录（同时作为 TMPDIR 与包管理器缓存目录），以及 git 元数据中
 *      对象库、引用、日志与本 worktree 自身的 gitdir。
 * 禁写：git hooks（会在之后的正常 git 操作中执行）、主仓库 config、工作目录下的 .git 指针文件、
 *      其他 worktree 的 gitdir。
 * 配置目录禁止写入；签名目录拒绝读取。只对当前会话目录开放写入。
 * 边界：仅 macOS；其他平台拒绝执行（默认拒绝）。Claude SDK 自带的 Bash 不经过本模块。
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { chmod, copyFile, lstat, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
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
  const finalDenyWriteRoots: string[] = []
  // 新目录允许 git init 创建 .git；已有指针/仓库仍禁止改写其入口。
  const finalDenyWriteLiterals: string[] = input.git || existsSync(join(cwd, '.git')) ? [join(cwd, '.git')] : []
  if (input.git) {
    const { commonDir, ownDir } = input.git
    const mainWorktree = ownDir === commonDir
    if (mainWorktree) {
      // 主工作区：整个 .git 可写，但 hooks、config 与其他 worktree 的目录需要单独禁止。
      writableRoots.push(commonDir)
      finalDenyWriteRoots.push(join(commonDir, 'hooks'), join(commonDir, 'worktrees'))
    } else {
      // 链接 worktree：只开放对象库、引用、日志与自身 gitdir；其他 worktree 目录保持不可写。
      writableRoots.push(join(commonDir, 'objects'), join(commonDir, 'refs'), join(commonDir, 'logs'), ownDir)
      writableLiterals.push(join(commonDir, 'packed-refs'), join(commonDir, 'packed-refs.lock'), join(commonDir, 'FETCH_HEAD'), join(commonDir, 'ORIG_HEAD'))
      finalDenyWriteRoots.push(join(commonDir, 'hooks'))
    }
    finalDenyWriteLiterals.push(join(commonDir, 'config'))
  }
  // 配置目录只为当前工作目录开例外；兄弟会话与工作区配置仍保持只读。
  const configDirs = input.configDirs.map(realOrSelf)
  const insideWorkspace = configDirs.some((dir) => {
    const workspaceRoot = realOrSelf(join(dir, 'agent-workspaces'))
    const path = relative(workspaceRoot, cwd)
    return path.split(sep).length >= 2 && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
  })
  return {
    writableRoots,
    writableLiterals,
    denyRoots: configDirs.map((dir) => realOrSelf(join(dir, 'verifiers'))),
    denyWriteRoots: configDirs,
    allowAfterDenyRoots: insideWorkspace ? [cwd] : [],
    finalDenyWriteRoots,
    finalDenyWriteLiterals,
  }
}

/**
 * 将可写范围内 nlink > 1 的普通文件替换为私有副本，使预先存在的跨边界硬链接失效。
 *
 * seatbelt 只能按路径授权写入，无法识别"路径在范围内、inode 与范围外共享"的预存硬链接；
 * 在每次生成策略前把这类文件原子替换为独立副本（保留权限位），写入就不会再影响其他会话。
 * 边界：扫描与子进程启动之间仍存在理论窗口（外部进程可在此期间创建硬链接），
 * 且会溶解可写范围内合法的硬链接（如包管理器、本地克隆），这些代价已在证据文档中说明。
 */
export async function quarantineWritableHardlinks(policy: SeatbeltPolicy): Promise<void> {
  const roots = [...policy.writableRoots, ...(policy.writableLiterals ?? [])]
  let seq = 0
  const visit = async (path: string): Promise<void> => {
    let st
    try {
      st = await lstat(path)
    } catch (error) {
      // 扫描期间被删除属于正常竞态；其余错误按失败关闭处理。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (st.isSymbolicLink()) return
    if (st.isDirectory()) {
      let names: string[]
      try {
        names = await readdir(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      await Promise.all(names.map((name) => visit(join(path, name))))
      return
    }
    if (!st.isFile() || st.nlink <= 1) return
    // 同目录临时文件 + 原子重命名，保证替换后是独立 inode；权限位按原文件恢复。
    const temp = `${path}.gravitas-quarantine-${process.pid}-${seq++}`
    try {
      await copyFile(path, temp)
      await chmod(temp, st.mode & 0o7777)
      await rename(temp, path)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
  }
  for (const root of roots) await visit(root)
}

/** 为一次 Bash 调用生成沙箱命令与受控环境。 */
export async function prepareBashSandbox(cwd: string, sessionId: string): Promise<{ argv: string[]; env: NodeJS.ProcessEnv; gitWasPresent: boolean }> {
  const scratchDir = scratchDirFor(sessionId)
  const git = await resolveGitLayout(cwd)
  // 与策略口径一致：已有仓库或已有 .git 入口都算"命令前已存在"，其后 hooks/config 由策略拒写。
  const gitWasPresent = Boolean(git) || existsSync(join(realOrSelf(cwd), '.git'))
  const policy = buildBashSandboxPolicy({ cwd, scratchDir, git, configDirs: [getConfigDir()] })
  // 先溶解预存硬链接，再生成策略；隔离失败时不执行命令（失败关闭）。
  await quarantineWritableHardlinks(policy)
  const profile = buildSeatbeltProfile(policy)
  return {
    argv: [SANDBOX_EXEC_PATH, '-p', profile, '/bin/sh', '-c'],
    env: {
      ...process.env,
      TMPDIR: scratchDir,
      BUN_INSTALL_CACHE_DIR: join(scratchDir, 'bun-cache'),
      npm_config_cache: join(scratchDir, 'npm-cache'),
    },
    gitWasPresent,
  }
}

/** 读取仓库 config 中的 core.hooksPath（无则返回 undefined）。 */
async function readCoreHooksPath(commonDir: string): Promise<string | undefined> {
  let text: string
  try {
    text = await readFile(join(commonDir, 'config'), 'utf8')
  } catch {
    return undefined
  }
  const match = text.match(/^\s*hooksPath\s*=\s*(.+)$/m)
  const value = match?.[1]
  if (!value) return undefined
  return value.trim().replace(/^"(.*)"$/, '$1')
}

/**
 * 命令结束后收口新建仓库的 hooks：非 .sample 的 hook 文件重命名停用。
 *
 * 实测（见 git-init-experiment-f.log）：预 deny .git/hooks 会让 git init 致命失败，
 * 因此 init 命令期间的 hooks/config 写入无法用策略拦截；这里在命令结束后把
 * 本命令新建仓库（命令前无 .git）中可自动执行的 hook 停用，防止注入钩子在
 * 后续 git 操作中持久生效。文件保留（仅加后缀），用户可恢复。
 * 残留边界：命令内已触发的执行、GIT_DIR 环境变量间接布局、config 别名与
 * core.fsmonitor 等 config 载体不在本函数覆盖范围。
 */
export async function quarantineNewGitHooks(cwd: string, gitWasPresent: boolean): Promise<string | undefined> {
  if (gitWasPresent) return undefined
  const real = realOrSelf(cwd)
  const git = await resolveGitLayout(real)
  if (!git) return undefined
  const targets: string[] = []
  // 范围外的仓库不可能在本沙箱内创建；只处理当前工作目录内的 hooks 目录。
  const hooksDir = join(git.commonDir, 'hooks')
  if (hooksDir.startsWith(real + sep)) targets.push(hooksDir)
  const hooksPath = await readCoreHooksPath(git.commonDir)
  if (hooksPath) {
    const resolved = realOrSelf(isAbsolute(hooksPath) ? hooksPath : join(real, hooksPath))
    if (resolved.startsWith(real + sep) && !targets.includes(resolved)) targets.push(resolved)
  }
  const disabled: string[] = []
  for (const dir of targets) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (name.endsWith('.sample')) continue
      const full = join(dir, name)
      let st
      try {
        st = await lstat(full)
      } catch {
        continue
      }
      if (!st.isFile() && !st.isSymbolicLink()) continue
      try {
        await rename(full, `${full}.gravitas-quarantine`)
        disabled.push(relative(real, full) || full)
      } catch {
        // 单个文件停用失败不阻断其他文件；失败项保留原名，风险在证据文档中说明。
      }
    }
  }
  if (!disabled.length) return undefined
  return `已停用新建仓库中的 ${disabled.length} 个 hook 文件（加 .gravitas-quarantine 后缀，可手动恢复）：${disabled.join('、')}`
}
