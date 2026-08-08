/**
 * Git Diff 服务
 *
 * 提供工作区文件变更检测、diff 获取、文件还原等 Git 操作。
 * 复用 git-detector.ts 中 runGitCommand 的 spawnSync 模式。
 */

import { spawnSync } from 'child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'path'
import type { ChangedFileEntry, UnstagedChangesResult, UntrackedFileEntry } from '@gravitas/shared'
import type { ChangeSource, ChangedFileStatus } from '@gravitas/shared'

/** 大文件读取上限：超过则跳过，避免 IPC 序列化撑爆内存 */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024

/**
 * 校验并规范化 filePath，确保其位于 root 目录内。
 * 支持相对路径和绝对路径。绝对路径会被自动转为相对路径。
 * 拒绝 `..` 穿越和 root 外的路径。
 * 返回安全的相对路径，或 null 表示不安全。
 */
function normalizeSafePath(root: string, filePath: string): string | null {
  if (!filePath || typeof filePath !== 'string') return null
  const resolvedRoot = resolve(root)
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep

  if (isAbsolute(filePath)) {
    let resolvedFile: string
    try {
      resolvedFile = realpathSync(resolve(filePath))
    } catch {
      return null
    }
    if (!resolvedFile.startsWith(rootWithSep)) return null
    return resolvedFile.slice(rootWithSep.length)
  }

  if (filePath.includes('..')) return null
  const resolvedTarget = resolve(resolvedRoot, filePath)
  let realTarget: string
  try {
    realTarget = realpathSync(resolvedTarget)
  } catch {
    realTarget = resolvedTarget
  }
  if (!realTarget.startsWith(rootWithSep) && realTarget !== resolvedRoot) return null
  return filePath
}

/**
 * 执行 Git 命令
 *
 * @param args - Git 命令参数
 * @param cwd - 工作目录
 * @returns 命令输出，如果失败返回 null
 */
function runGitCommand(args: string[], cwd: string): string | null {
  try {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    })

    if (result.error) {
      console.error('[git-diff-service] git 命令错误:', result.error)
      return null
    }
    if (result.status === 0) {
      return result.stdout.trim()
    }
  } catch {
    // 命令执行失败
  }

  return null
}

/**
 * 计算文件的来源标识
 *
 * filePath 是相对于 gitRoot 的路径，需要拼成绝对路径后再和 session/workspace 路径比较
 */
function computeSource(
  filePath: string,
  gitRoot: string,
  sessionPath?: string,
  workspaceFilesPath?: string,
): ChangeSource {
  const absolutePath = join(gitRoot, filePath)
  let inSession = false
  let inWorkspace = false

  if (sessionPath) {
    const normalized = sessionPath.endsWith(sep) ? sessionPath : sessionPath + sep
    if (absolutePath.startsWith(normalized)) {
      inSession = true
    }
  }

  if (workspaceFilesPath) {
    const normalized = workspaceFilesPath.endsWith(sep) ? workspaceFilesPath : workspaceFilesPath + sep
    if (absolutePath.startsWith(normalized)) {
      inWorkspace = true
    }
  }

  if (inSession && inWorkspace) return 'both'
  if (inSession) return 'session'
  if (inWorkspace) return 'workspace'
  return 'none'
}

/**
 * 解析 numstat 输出为 path -> { additions, deletions } 映射。
 * 对 rename/copy 行（格式 `add\tdel\told => new` 或带 `{...}` 的），以新路径为 key。
 */
function parseNumstat(numStat: string | null): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>()
  if (!numStat) return map
  for (const line of numStat.split('\n')) {
    if (!line) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const additions = parseInt(parts[0]!, 10)
    const deletions = parseInt(parts[1]!, 10)
    let path = parts.slice(2).join('\t')
    // 处理 rename 格式 `old => new`
    const arrowIdx = path.indexOf(' => ')
    if (arrowIdx >= 0) {
      path = path.slice(arrowIdx + 4)
    }
    map.set(path, {
      additions: isNaN(additions) ? 0 : additions,
      deletions: isNaN(deletions) ? 0 : deletions,
    })
  }
  return map
}

/**
 * 获取未暂存的文件变更列表（支持多 Git 仓库）
 */
export async function getUnstagedChanges(
  dirPath: string,
  sessionPath?: string,
  workspaceFilesPath?: string,
  extraPaths?: string[],
): Promise<UnstagedChangesResult> {
  // 收集所有候选目录中的不重复 Git 仓库根
  const candidates = [dirPath, sessionPath, workspaceFilesPath, ...(extraPaths || [])].filter(
    (p): p is string => typeof p === 'string' && p.length > 0
  )
  const gitRoots: string[] = []
  for (const cand of candidates) {
    for (const root of findAllGitRoots(cand)) {
      if (!gitRoots.includes(root)) gitRoots.push(root)
    }
  }

  if (gitRoots.length === 0) {
    // 非 Git 项目：无基线可对比，改为枚举主工作目录下的用户文件，
    // 让 Agent 会话产物（新建/编辑的文件）在改动面板可见。
    const fallback = collectNonGitFiles(dirPath)
    if (fallback) return fallback
    return { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
  }

  const allFiles: ChangedFileEntry[] = []
  const allUntracked: UntrackedFileEntry[] = []

  // 候选目录绝对路径（用于过滤：只显示落在某个候选目录内的文件）
  const candidateRoots = candidates.map((c) => {
    const r = c.replace(/[/\\]+$/, '')
    return r + sep
  })
  const isUnderAnyCandidate = (absPath: string): boolean => {
    return candidateRoots.some((root) => absPath === root.slice(0, -1) || absPath.startsWith(root))
  }

  for (const gitRoot of gitRoots) {
    // 获取变更文件列表 (M=modified, D=deleted, A=added, R=renamed, C=copied, T=type)
    const nameStatus = runGitCommand(['diff', '--name-status'], gitRoot)
    const numStat = runGitCommand(['diff', '--numstat'], gitRoot)
    const numStatMap = parseNumstat(numStat)

    if (nameStatus) {
      const statusLines = nameStatus.split('\n').filter(Boolean)

      for (const statusLine of statusLines) {
        const simpleMatch = statusLine.match(/^([MDAT])\t(.+)$/)
        const renameMatch = statusLine.match(/^([RC])\d*\t([^\t]+)\t(.+)$/)

        let status: ChangedFileStatus
        let filePath: string

        if (simpleMatch) {
          const code = simpleMatch[1]!
          status = code === 'D' ? 'deleted' : 'modified'
          filePath = simpleMatch[2]!
        } else if (renameMatch) {
          status = 'modified'
          filePath = renameMatch[3]!
        } else {
          continue
        }

        // 过滤：只保留落在某个 candidate 内的文件
        const absPath = join(gitRoot, filePath)
        if (!isUnderAnyCandidate(absPath)) continue

        const stats = numStatMap.get(filePath) ?? { additions: 0, deletions: 0 }

        allFiles.push({
          filePath,
          status,
          additions: stats.additions,
          deletions: stats.deletions,
          source: computeSource(filePath, gitRoot, sessionPath, workspaceFilesPath),
          gitRoot,
        })
      }
    }

    // 获取未追踪文件
    const untrackedOutput = runGitCommand(['ls-files', '--others', '--exclude-standard'], gitRoot)
    if (untrackedOutput) {
      for (const rel of untrackedOutput.split('\n').filter(Boolean)) {
        const absPath = join(gitRoot, rel)
        if (isUnderAnyCandidate(absPath)) {
          allUntracked.push({ filePath: rel, gitRoot })
        }
      }
    }
  }

  return {
    isGitRepo: true,
    files: allFiles,
    untrackedFiles: allUntracked,
    gitRootNames: gitRoots.map((r) => basename(r)),
  }
}

/** 向下递归搜索所有 .git 目录，返回所有找到的仓库根（不提前停止） */
function findAllGitRootsDown(dirPath: string, maxDepth: number): string[] {
  if (maxDepth <= 0) return []

  let entries: string[]
  try {
    entries = readdirSync(dirPath)
  } catch {
    return []
  }

  const found: string[] = []
  for (const name of entries) {
    if (name === '.git') {
      found.push(dirPath)
      continue
    }
    if (name.startsWith('.') || name === 'node_modules') continue

    const fullPath = join(dirPath, name)
    let st
    try { st = statSync(fullPath) } catch { continue }
    if (!st.isDirectory()) continue

    if (existsSync(join(fullPath, '.git'))) {
      found.push(fullPath)
      // 已确认是 git root，不再深入避免重复
      continue
    }
    found.push(...findAllGitRootsDown(fullPath, maxDepth - 1))
  }

  return found
}

/** 查找 Git 仓库根目录（支持向上搜索子目录内的 repos），返回所有找到的根 */
function findAllGitRoots(baseDir: string): string[] {
  if (!existsSync(baseDir)) return []

  // 1. 向上搜索：git rev-parse --show-toplevel
  const toplevel = runGitCommand(['rev-parse', '--show-toplevel'], baseDir)
  const roots: string[] = []
  if (toplevel && existsSync(toplevel) && !roots.includes(toplevel)) {
    roots.push(toplevel)
  }

  // 2. 向下搜索所有子 .git
  for (const r of findAllGitRootsDown(baseDir, 3)) {
    if (!roots.includes(r)) roots.push(r)
  }

  return roots
}

/** 查找 Git 仓库根目录，先向上后向下搜索，失败返回 null */
function findGitRoot(baseDir: string): string | null {
  return findAllGitRoots(baseDir)[0] ?? null
}

// ===== 非 Git 项目会话产物兜底 =====
//
// 当会话工作目录不是 Git 仓库时，没有 git 基线可做 diff，但 Agent 在本目录新建/编辑的
// 文件仍然值得让用户看到。这里做一次有界的递归枚举，把主工作目录下的用户文件当作
// 「未追踪/新增」列出，让改动面板不至于空无一物。

/** 递归扫描时跳过的目录段（避免 node_modules / 构建产物 / 版本库内部文件风暴） */
const NON_GIT_SKIP_SEGMENTS = new Set([
  'node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out',
  '.cache', '__pycache__', '.turbo', '.parcel-cache', '.svelte-kit',
  '.proma', '.context', 'coverage', '.venv', 'venv',
])

/** 递归扫描时跳过的具体文件名 */
const NON_GIT_SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'])

/** 扫描上限：超过则放弃，避免在大目录上反复扫描拖慢面板 */
const NON_GIT_MAX_FILES = 500
const NON_GIT_MAX_DEPTH = 12

function isNonGitSkipped(name: string): boolean {
  return NON_GIT_SKIP_NAMES.has(name) || NON_GIT_SKIP_SEGMENTS.has(name)
}

/**
 * 有界地枚举 dir 下的用户文件，返回「未追踪新增」形式的条目。
 * 只在目录规模可控时返回；目录过大或不可读则返回 null（让上层走常规空结果）。
 */
function collectNonGitFiles(dir: string): UnstagedChangesResult | null {
  if (!dir || !existsSync(dir)) return null

  const result: UntrackedFileEntry[] = []
  let scannedCount = 0

  const walk = (current: string, depth: number): boolean => {
    if (depth > NON_GIT_MAX_DEPTH || scannedCount >= NON_GIT_MAX_FILES) return false
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return true
    }
    for (const entry of entries) {
      if (scannedCount >= NON_GIT_MAX_FILES) return false
      if (isNonGitSkipped(entry.name)) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (!walk(full, depth + 1)) return false
        continue
      }
      // 只关心常规文件；符号链接/特殊文件跳过，避免误读系统文件。
      if (!entry.isFile()) continue
      const rel = relative(dir, full)
      if (rel.startsWith('..') || rel.includes(`${sep}..`)) continue
      result.push({ filePath: rel, gitRoot: dir })
      scannedCount += 1
    }
    return true
  }

  walk(dir, 0)
  if (result.length === 0) return null
  // 按路径排序，保证展示稳定。
  result.sort((a, b) => a.filePath.localeCompare(b.filePath))
  return { isGitRepo: false, files: [], untrackedFiles: result, gitRootNames: [] }
}

/**
 * 获取单个文件的 unified diff
 */
export async function getFileDiff(dirPath: string, filePath: string, gitRoot?: string): Promise<string> {
  const root = gitRoot || findGitRoot(dirPath)
  if (!root) return ''
  const safePath = normalizeSafePath(root, filePath)
  if (!safePath) {
    console.warn('[git-diff-service] getFileDiff 拒绝不安全路径:', filePath)
    return ''
  }
  const diff = runGitCommand(['diff', '--', safePath], root)
  return diff || ''
}

/**
 * 获取文件的旧版本（git HEAD）和新版本（磁盘）内容
 */
export async function getDiffContents(dirPath: string, filePath: string, gitRoot?: string): Promise<{ oldContent: string; newContent: string } | null> {
  const root = gitRoot || findGitRoot(dirPath)

  // 无 git root：纯文件预览（无 git HEAD 可比较），仅读磁盘文件，安全检查依赖 dirPath
  if (!root) {
    const safePath = normalizeSafePath(dirPath, filePath)
    if (!safePath) {
      console.warn('[git-diff-service] getDiffContents 拒绝不安全路径（无 git root）:', filePath)
      return null
    }
    const fullPath = join(dirPath, safePath)
    let newContent = ''
    if (existsSync(fullPath)) {
      try {
        const st = statSync(fullPath)
        if (st.size > MAX_FILE_SIZE_BYTES) {
          console.warn('[git-diff-service] 文件超过大小上限，跳过读取:', fullPath, st.size)
        } else {
          newContent = readFileSync(fullPath, 'utf-8')
        }
      } catch {
        // 读取失败保持空字符串
      }
    }
    return { oldContent: '', newContent }
  }

  const safePath = normalizeSafePath(root, filePath)
  if (!safePath) {
    console.warn('[git-diff-service] getDiffContents 拒绝不安全路径:', filePath)
    return null
  }

  // 旧版本从 git HEAD 读取
  let oldContent = ''
  try {
    const result = spawnSync('git', ['show', `HEAD:${safePath}`], {
      cwd: root,
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    if (result.status === 0) {
      oldContent = result.stdout
    }
  } catch {
    // 文件在 HEAD 中不存在（新文件）
  }

  // 新版本从磁盘读取
  let newContent = ''
  const fullPath = join(root, safePath)
  if (existsSync(fullPath)) {
    try {
      const st = statSync(fullPath)
      if (st.size > MAX_FILE_SIZE_BYTES) {
        console.warn('[git-diff-service] 文件超过大小上限，跳过读取:', fullPath, st.size)
      } else {
        newContent = readFileSync(fullPath, 'utf-8')
      }
    } catch {
      // 读取失败保持空字符串
    }
  }

  return { oldContent, newContent }
}

/**
 * 获取未追踪文件的内容（用于显示全绿新增 diff）
 *
 * filePath 应为相对于 gitRoot 或 dirPath 的相对路径。
 * 拒绝绝对路径和 `..` 穿越。
 */
export async function getUntrackedContent(dirPath: string, filePath: string, gitRoot?: string): Promise<string> {
  if (!filePath || typeof filePath !== 'string') return ''
  const root = gitRoot || findGitRoot(dirPath) || dirPath
  const safePath = normalizeSafePath(root, filePath)
  if (!safePath) {
    console.warn('[git-diff-service] getUntrackedContent 拒绝不安全路径:', filePath)
    return ''
  }
  const fullPath = resolve(root, safePath)
  try {
    const st = statSync(fullPath)
    if (st.size > MAX_FILE_SIZE_BYTES) {
      console.warn('[git-diff-service] 未追踪文件超过大小上限:', fullPath, st.size)
      return ''
    }
    return readFileSync(fullPath, 'utf-8')
  } catch {
    return ''
  }
}

/**
 * 还原文件的未暂存变更
 */
export async function revertFile(dirPath: string, filePath: string, gitRoot?: string): Promise<void> {
  const root = gitRoot || findGitRoot(dirPath)
  if (!root) throw new Error('未找到 Git 仓库')
  const safePath = normalizeSafePath(root, filePath)
  if (!safePath) {
    throw new Error(`不安全的路径: ${filePath}`)
  }
  const result = runGitCommand(['checkout', '--', safePath], root)
  if (result === null) {
    throw new Error(`还原失败: git checkout -- ${safePath}`)
  }
}
