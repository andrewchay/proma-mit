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
import { chmod, copyFile, lstat, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
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

const BLOCKED_GIT_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_TEMPLATE_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_INDEX_FILE',
  'GIT_SHALLOW_FILE',
  'GIT_EXEC_PATH',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_PAGER',
  'GIT_PROXY_COMMAND',
  'SSH_ASKPASS',
  'PAGER',
  'EDITOR',
  'VISUAL',
] as const

/**
 * 清除继承的 Git 路径、config 与命令执行覆盖，避免它们绕过当前工作目录布局。
 * 命令内自行设置的变量仍由 seatbelt 与命令后收口约束，不把环境清洗视为完整隔离。
 */
export function sanitizeBashGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source }
  for (const key of BLOCKED_GIT_ENV_KEYS) delete env[key]
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key]
  }
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_SYSTEM = '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  return env
}

/** 只复制 Git 身份键；保留 -c 和显式 author/committer 环境变量的优先级。 */
export function resolveGitIdentityEnvironment(cwd: string, source: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const readEnv = sanitizeBashGitEnvironment(source)
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'] as const) {
    if (source[key] === undefined) delete readEnv[key]
    else readEnv[key] = source[key]
  }
  return new Promise(resolve => {
    execFile('git', ['-C', cwd, 'config', '--includes', '--null', '--get-regexp', '^(user\\.(name|email|useconfigonly)|author\\.(name|email)|committer\\.(name|email))$'], {
      encoding: 'utf8', env: readEnv, timeout: 5000, maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      const values = new Map<string, string>()
      for (const entry of (error ? '' : stdout).split('\0')) {
        const separator = entry.indexOf('\n')
        if (separator < 0) continue
        const key = entry.slice(0, separator).toLowerCase()
        if (!/^(user\.(name|email|useconfigonly)|author\.(name|email)|committer\.(name|email))$/.test(key)) continue
        values.set(key, entry.slice(separator + 1))
      }
      const hasIdentity = (kind: 'author' | 'committer', field: 'name' | 'email'): boolean =>
        Boolean(source[`GIT_${kind.toUpperCase()}_${field.toUpperCase()}`] || values.get(`${kind}.${field}`) || values.get(`user.${field}`))
      if (!hasIdentity('author', 'name') || !hasIdentity('author', 'email') || !hasIdentity('committer', 'name') || !hasIdentity('committer', 'email')) {
        values.set('user.useconfigonly', 'true')
      }
      const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(values.size) }
      let index = 0
      for (const [key, value] of values) {
        env[`GIT_CONFIG_KEY_${index}`] = key
        env[`GIT_CONFIG_VALUE_${index}`] = value
        index++
      }
      resolve(env)
    })
  })
}

/** 解析 git 布局；cwd 不在 git 仓库中时返回 undefined。 */
export function resolveGitLayout(cwd: string): Promise<GitLayout | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir'], {
      encoding: 'utf8',
      env: sanitizeBashGitEnvironment(process.env),
    }, (error, stdout) => {
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
 * 启动前复核模式则只拒绝、不替换，避免把竞态发现静默推迟到下一次调用。
 *
 * seatbelt 只能按路径授权写入，无法识别"路径在范围内、inode 与范围外共享"的预存硬链接。
 * 两次扫描之间及复核之后的系统外并发进程仍不受本模块控制，不能视为操作系统级原子隔离。
 */
async function scanWritableHardlinks(policy: SeatbeltPolicy, mode: 'quarantine' | 'reject'): Promise<void> {
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
    if (mode === 'reject') throw new Error(`Bash 启动前复核：可写范围出现硬链接，已拒绝执行：${path}`)
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

export async function quarantineWritableHardlinks(policy: SeatbeltPolicy): Promise<void> {
  await scanWritableHardlinks(policy, 'quarantine')
}

/** 启动前再次核对可写范围；发现扫描间隙新增的硬链接时失败关闭。 */
export async function assertNoWritableHardlinks(policy: SeatbeltPolicy): Promise<void> {
  await scanWritableHardlinks(policy, 'reject')
}

/** 为一次 Bash 调用生成沙箱命令与受控环境。 */
export async function prepareBashSandbox(cwd: string, sessionId: string): Promise<{
  argv: string[]
  env: NodeJS.ProcessEnv
  gitWasPresent: boolean
  assertLaunchSafe: () => Promise<void>
}> {
  const scratchDir = scratchDirFor(sessionId)
  const git = await resolveGitLayout(cwd)
  const gitIdentity = await resolveGitIdentityEnvironment(cwd, process.env)
  // 与策略口径一致：已有仓库或已有 .git 入口都算"命令前已存在"，其后 hooks/config 由策略拒写。
  const gitWasPresent = Boolean(git) || existsSync(join(realOrSelf(cwd), '.git'))
  const policy = buildBashSandboxPolicy({ cwd, scratchDir, git, configDirs: [getConfigDir()] })
  // 先溶解预存硬链接，再生成策略；隔离失败时不执行命令（失败关闭）。
  await quarantineWritableHardlinks(policy)
  const profile = buildSeatbeltProfile(policy)
  return {
    argv: [SANDBOX_EXEC_PATH, '-p', profile, '/bin/sh', '-c'],
    env: {
      ...sanitizeBashGitEnvironment(process.env),
      ...gitIdentity,
      TMPDIR: scratchDir,
      BUN_INSTALL_CACHE_DIR: join(scratchDir, 'bun-cache'),
      npm_config_cache: join(scratchDir, 'npm-cache'),
    },
    gitWasPresent,
    assertLaunchSafe: () => assertNoWritableHardlinks(policy),
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
 * 可在普通 git 操作中被自动执行的 config 键（小写全名）。
 *
 * hooks 目录之外，config 本身就是一条命令执行通道：core.fsmonitor 在 status 时运行、
 * core.pager 在任何输出时运行、filter.*.clean 在 add 时运行、diff.external 在 diff 时运行、
 * include.path 可把外部文件里的上述键间接引入。新建仓库的 config 由命令自己写出，
 * 策略无法在命令期间拒写，只能在命令结束后清洗。
 */
const COMMAND_CARRYING_CONFIG_KEYS = new Set([
  'core.fsmonitor',
  'core.pager',
  'core.editor',
  'core.sshcommand',
  'core.askpass',
  'core.hookspath',
  'credential.helper',
  'diff.external',
  'gpg.program',
])

/** 判断一条 config 条目是否携带命令执行能力（值语义相关的键只在值以 ! 开头时算）。 */
export function isCommandCarryingConfigKey(fullKey: string, value: string): boolean {
  if (COMMAND_CARRYING_CONFIG_KEYS.has(fullKey)) return true
  if (/^filter\..+\.(clean|smudge|process)$/.test(fullKey)) return true
  if (/^include(if\..+)?\.path$/.test(fullKey)) return true
  if (/^alias\..+$/.test(fullKey) && value.trimStart().startsWith('!')) return true
  if (/^submodule\..+\.update$/.test(fullKey) && value.trimStart().startsWith('!')) return true
  return false
}

/**
 * 从 git config 文本中移除可执行载体条目，返回清洗后的文本与被移除的键。
 *
 * 按行处理并跟踪 section/subsection，因此 `[filter "x"] clean = ...` 这类小节形式
 * 与 `filter.x.clean` 的点分形式都能命中；`\` 续行整体移除，避免留下半条值。
 * 只删条目本身，其余内容与顺序原样保留。
 */
export function sanitizeGitConfigText(text: string): { text: string; removed: string[] } {
  const lines = text.split('\n')
  const kept: string[] = []
  const removed: string[] = []
  let section = ''
  let subsection: string | undefined
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    const header = raw.match(/^\s*\[([^\]\s"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\]\s*$/)
    const sectionName = header?.[1]
    if (header && sectionName) {
      // 兼容老式 [section.subsection] 写法；新式带引号小节走 header[2]。
      const [head, ...dots] = sectionName.toLowerCase().split('.')
      section = head ?? ''
      subsection = header[2] !== undefined ? header[2].toLowerCase() : dots.length ? dots.join('.') : undefined
      kept.push(raw)
      continue
    }
    const entry = raw.match(/^\s*([A-Za-z][A-Za-z0-9.-]*)\s*(?:=(.*))?$/)
    const name = entry?.[1]
    if (!entry || !name) {
      kept.push(raw)
      continue
    }
    const span = [raw]
    let value = entry[2] ?? ''
    while (value.endsWith('\\') && i + 1 < lines.length) {
      i += 1
      const next = lines[i] ?? ''
      value = `${value.slice(0, -1)}${next}`
      span.push(next)
    }
    const fullKey = [section, subsection, name.toLowerCase()].filter(Boolean).join('.')
    if (isCommandCarryingConfigKey(fullKey, value)) {
      removed.push(fullKey)
      continue
    }
    kept.push(...span)
  }
  return { text: kept.join('\n'), removed: [...new Set(removed)] }
}

/**
 * 命令结束后清洗新建仓库 config 中的可执行载体，原文件保留为 .gravitas-quarantine。
 *
 * 只处理本命令新建（命令前无 .git）、且 gitdir 位于工作目录内的仓库；
 * 范围外或预存仓库一律不触碰。返回被移除的键名，无改动时返回 undefined。
 */
export async function sanitizeNewGitConfig(cwd: string, gitWasPresent: boolean): Promise<string[] | undefined> {
  if (gitWasPresent) return undefined
  const real = realOrSelf(cwd)
  const git = await resolveGitLayout(real)
  if (!git) return undefined
  const configPath = join(git.commonDir, 'config')
  if (!configPath.startsWith(`${real}${sep}`)) return undefined
  let text: string
  try {
    const st = await lstat(configPath)
    // 符号链接不跟随：改写链接目标等于越界写入。
    if (!st.isFile()) return undefined
    text = await readFile(configPath, 'utf8')
  } catch {
    return undefined
  }
  const { text: cleaned, removed } = sanitizeGitConfigText(text)
  if (!removed.length) return undefined
  const temp = `${configPath}.gravitas-tmp`
  try {
    await writeFile(temp, cleaned, { mode: 0o600 })
    await rename(configPath, `${configPath}.gravitas-quarantine`)
    await rename(temp, configPath)
  } catch {
    await unlink(temp).catch(() => {})
    // 清洗失败时保持原 config 不变；残留风险在证据文档中说明。
    return undefined
  }
  return removed
}

/**
 * 新建仓库的命令后收口：停用 hooks 并清洗 config 可执行载体。
 *
 * Bash 工具必须调用本函数而非单独的 quarantineNewGitHooks，两者缺一都会留下
 * 可在后续 git 操作中自动执行的通道。
 */
export async function quarantineNewGitArtifacts(cwd: string, gitWasPresent: boolean): Promise<string | undefined> {
  const notices: string[] = []
  const hooks = await quarantineNewGitHooks(cwd, gitWasPresent)
  if (hooks) notices.push(hooks)
  const configKeys = await sanitizeNewGitConfig(cwd, gitWasPresent)
  if (configKeys?.length) {
    notices.push(`已从新建仓库 config 移除 ${configKeys.length} 个可执行载体（原文件另存为 config.gravitas-quarantine）：${configKeys.join('、')}`)
  }
  return notices.length ? notices.join('；') : undefined
}

/**
 * 命令结束后收口新建仓库的 hooks：非 .sample 的 hook 文件重命名停用。
 *
 * 实测（见 git-init-experiment-f.log）：预 deny .git/hooks 会让 git init 致命失败，
 * 因此 init 命令期间的 hooks/config 写入无法用策略拦截；这里在命令结束后把
 * 本命令新建仓库（命令前无 .git）中可自动执行的 hook 停用，防止注入钩子在
 * 后续 git 操作中持久生效。文件保留（仅加后缀），用户可恢复。
 * 残留边界：命令内已触发的执行、GIT_DIR 环境变量间接布局不在本函数覆盖范围；
 * config 载体由 sanitizeNewGitConfig 处理，Bash 工具应调用 quarantineNewGitArtifacts。
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
