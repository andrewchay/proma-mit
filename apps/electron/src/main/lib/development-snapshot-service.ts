/**
 * 研发交付快照服务（W02）。
 *
 * 职责：把 worktree 中相对基线的全部变更（已提交 + 暂存 + 未暂存 + 允许的未跟踪
 * 新增/删除）冻结为不可变内容版本，供 Review 与确认应用使用。
 * 边界：
 * - 只读仓库，不触碰真实 index / stash / 工作目录；
 * - 范围外或受保护文件出现在 diff 中即整轮阻塞（T07），不静默过滤；
 * - 二进制、符号链接、重命名、超限文件明确不支持（T09），不以截断内容供验收；
 * - 快照内容保存在会话私有目录：先写内容文件，最后原子写清单。
 */

import { createHash, randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { DevelopmentSnapshot, DevelopmentSnapshotFile, DevelopmentTaskScope } from '@gravitas/shared'
import { writeJsonFileAtomic } from './safe-file'
import { isProtectedDevelopmentPath, normalizeRepoRelativePath, pathWithinAllowed } from './development-task-service'

/** 快照体量上限：集中配置并测试边界（T09） */
export const SNAPSHOT_LIMITS = {
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024,
  maxFiles: 100,
} as const

/** git 输出按 UTF-8 读取；中文与空格路径经 -z / core.quotepath=false 保持原样 */
function git(repository: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Git 执行仍使用 UUID（历史夹具带 exec- 前缀）；Owner 调度使用带命名空间的确定性 ID。
 * 三者都只含安全字符，可直接用于快照文件名。
 */
function isValidDevelopmentExecutionId(value: string): boolean {
  return /^(?:exec-)?[a-f0-9-]{36}$/.test(value) || /^owner-auto-execution-[a-f0-9]{48}$/.test(value)
}

interface SnapshotLimitsParam { maxFileBytes?: number; maxTotalBytes?: number; maxFiles?: number }

export interface CreateSnapshotInput {
  /** worktree 路径（只读访问） */
  worktreePath: string
  sessionDirectory: string
  executionId: string
  workspaceId: string
  scope: DevelopmentTaskScope
  limits?: SnapshotLimitsParam
}

/**
 * 冻结 worktree 相对 baseCommit 的全部变更。
 * baseCommit 从研发 worktree 绑定文件读取；绑定缺失时拒绝（不回退 HEAD）。
 */
export function createDevelopmentSnapshot(input: CreateSnapshotInput): DevelopmentSnapshot {
  const { worktreePath, sessionDirectory, executionId, workspaceId, scope } = input
  if (!isValidDevelopmentExecutionId(executionId)) throw new Error('研发执行ID无效')
  if (workspaceId !== scope.workspaceId) throw new Error('快照工作区与任务范围不匹配')
  const bindingPath = join(sessionDirectory, 'development-worktree.json')
  if (!existsSync(bindingPath)) throw new Error('研发 worktree 绑定缺失，无法确定快照基线')
  const binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as { baseCommit?: string }
  if (!binding.baseCommit || !/^[a-f0-9]{40,64}$/.test(binding.baseCommit)) throw new Error('研发基线损坏')

  const state = captureDevelopmentState(worktreePath, binding.baseCommit!, scope, input.limits)
  const { files, contentHash, contentDirEntries } = state
  if (!files.length) throw new Error('worktree 相对基线没有变更，无可冻结交付')
  const contentsDir = join(sessionDirectory, `development-snapshot-${executionId}.d`)

  const id = `snap-${randomUUID()}`
  // 先写内容，最后原子写清单；中途失败留下孤立目录，不形成“已提交”假记录
  rmSync(contentsDir, { recursive: true, force: true })
  mkdirSync(contentsDir, { recursive: true })
  for (const item of contentDirEntries) {
    if (item.oldContent !== undefined) writeFileSyncRaw(join(contentsDir, `${item.index}.old`), item.oldContent)
    if (item.newContent !== undefined) writeFileSyncRaw(join(contentsDir, `${item.index}.new`), item.newContent)
  }

  const snapshot: DevelopmentSnapshot = {
    id, executionId, workspaceId,
    baseCommit: binding.baseCommit!,
    contentHash, files, createdAt: Date.now(),
  }
  writeJsonFileAtomic(join(sessionDirectory, `development-snapshot-${executionId}.json`), snapshot)
  return snapshot
}

/** Owner终态回调使用的异步快照冻结，避免同步Git进程阻塞Electron主线程。 */
export async function createDevelopmentSnapshotAsync(input: CreateSnapshotInput): Promise<DevelopmentSnapshot> {
  const { worktreePath, sessionDirectory, executionId, workspaceId, scope } = input
  if (!isValidDevelopmentExecutionId(executionId)) throw new Error('研发执行ID无效')
  if (workspaceId !== scope.workspaceId) throw new Error('快照工作区与任务范围不匹配')
  const bindingPath = join(sessionDirectory, 'development-worktree.json')
  const binding = JSON.parse((await readSnapshotFileAsync(bindingPath, 64 * 1024)).toString('utf8')) as { baseCommit?: string }
  if (!binding.baseCommit || !/^[a-f0-9]{40,64}$/.test(binding.baseCommit)) throw new Error('研发基线损坏')

  const state = await captureDevelopmentStateAsync(worktreePath, binding.baseCommit, scope, input.limits)
  if (!state.files.length) throw new Error('worktree 相对基线没有变更，无可冻结交付')
  const contentsDir = join(sessionDirectory, `development-snapshot-${executionId}.d`)
  await mkdir(contentsDir, { recursive: true, mode: 0o700 })
  const contentsDirStat = await lstat(contentsDir)
  if (!contentsDirStat.isDirectory() || contentsDirStat.isSymbolicLink()) throw new Error('研发快照内容目录不是私有普通目录')
  for (const item of state.contentDirEntries) {
    if (item.oldContent !== undefined) await writeSnapshotFileAsync(join(contentsDir, `${item.index}.old`), item.oldContent)
    if (item.newContent !== undefined) await writeSnapshotFileAsync(join(contentsDir, `${item.index}.new`), item.newContent)
  }

  const snapshot: DevelopmentSnapshot = {
    id: `snap-${randomUUID()}`, executionId, workspaceId,
    baseCommit: binding.baseCommit, contentHash: state.contentHash, files: state.files, createdAt: Date.now(),
  }
  const manifestPath = join(sessionDirectory, `development-snapshot-${executionId}.json`)
  const tempPath = `${manifestPath}.${randomUUID()}.tmp`
  await writeSnapshotFileAsync(tempPath, Buffer.from(JSON.stringify(snapshot, null, 2), 'utf8'))
  try {
    await link(tempPath, manifestPath)
  } finally {
    await unlink(tempPath).catch(() => undefined)
  }
  if (process.platform !== 'win32' && constants.O_DIRECTORY !== undefined) {
    const directory = await open(sessionDirectory, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0))
    try { await directory.sync() } finally { await directory.close() }
  }
  return snapshot
}

/**
 * 只读重采完整Git变化集，不写快照、不改index/stash。
 * Git忽略文件不在现有快照契约内；此检查不是整个文件系统的原子快照。
 */
export function developmentWorktreeMatchesSnapshot(
  worktreePath: string,
  snapshot: DevelopmentSnapshot,
  scope: DevelopmentTaskScope,
): boolean {
  try {
    if (snapshot.workspaceId !== scope.workspaceId) return false
    return captureDevelopmentState(worktreePath, snapshot.baseCommit, scope).contentHash === snapshot.contentHash
  } catch {
    // 范围外、符号链接、超限、Git读取失败等都不能被当作验证成功。
    return false
  }
}

/** Owner恢复路径使用的异步状态比对。 */
export async function developmentWorktreeMatchesSnapshotAsync(
  worktreePath: string,
  snapshot: DevelopmentSnapshot,
  scope: DevelopmentTaskScope,
): Promise<boolean> {
  try {
    if (snapshot.workspaceId !== scope.workspaceId) return false
    return (await captureDevelopmentStateAsync(worktreePath, snapshot.baseCommit, scope)).contentHash === snapshot.contentHash
  } catch {
    return false
  }
}

/** 异步读取并校验Owner研发快照及其内容文件。 */
export async function loadDevelopmentSnapshotAsync(sessionDirectory: string, executionId: string): Promise<DevelopmentSnapshot> {
  if (!isValidDevelopmentExecutionId(executionId)) throw new Error('研发执行ID无效')
  const manifestPath = join(sessionDirectory, `development-snapshot-${executionId}.json`)
  const manifestStat = await lstat(manifestPath)
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 256 * 1024) throw new Error('研发快照清单不是合法私有文件')
  const snapshot = JSON.parse((await readSnapshotFileAsync(manifestPath, 256 * 1024)).toString('utf8')) as DevelopmentSnapshot
  const contentsDir = join(sessionDirectory, `development-snapshot-${executionId}.d`)
  const directoryStat = await lstat(contentsDir)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('研发快照内容目录不是私有普通目录')
  if (snapshot.executionId !== executionId || typeof snapshot.id !== 'string' || !/^snap-[a-f0-9-]+$/.test(snapshot.id)
    || typeof snapshot.workspaceId !== 'string' || !/^[a-f0-9]{40,64}$/.test(snapshot.baseCommit)
    || !/^[a-f0-9]{64}$/.test(snapshot.contentHash) || !Number.isSafeInteger(snapshot.createdAt) || snapshot.createdAt < 1 || snapshot.createdAt > Date.now()
    || !Array.isArray(snapshot.files) || snapshot.files.length === 0 || snapshot.files.length > SNAPSHOT_LIMITS.maxFiles) throw new Error('研发快照清单结构或执行身份无效')
  const seenPaths = new Set<string>()
  let totalBytes = 0
  for (const [index, file] of snapshot.files.entries()) {
    if (!file || typeof file.path !== 'string' || normalizeRepoRelativePath(file.path) !== file.path || seenPaths.has(file.path)
      || isProtectedDevelopmentPath(file.path) || !['add', 'modify', 'delete'].includes(file.changeType)
      || file.oldSha256 !== null && !/^[a-f0-9]{64}$/.test(file.oldSha256)
      || file.newSha256 !== null && !/^[a-f0-9]{64}$/.test(file.newSha256)
      || !Number.isSafeInteger(file.newBytes) || file.newBytes < 0 || file.newBytes > SNAPSHOT_LIMITS.maxFileBytes) throw new Error('研发快照文件清单无效')
    if (file.changeType === 'add' && file.oldSha256 !== null || file.changeType === 'delete' && file.newSha256 !== null
      || file.changeType !== 'delete' && file.newSha256 === null || file.changeType !== 'add' && file.oldSha256 === null
      || file.changeType === 'delete' && file.newBytes !== 0) throw new Error('研发快照变更类型与内容指纹不一致')
    totalBytes += file.newBytes
    if (totalBytes > SNAPSHOT_LIMITS.maxTotalBytes) throw new Error('研发快照变更总量超限')
    seenPaths.add(file.path)
    if (file.changeType !== 'add' && sha256(await readSnapshotFileAsync(join(contentsDir, `${index}.old`), SNAPSHOT_LIMITS.maxFileBytes)) !== file.oldSha256) throw new Error(`快照基线内容校验失败：${file.path}`)
    if (file.changeType !== 'delete' && sha256(await readSnapshotFileAsync(join(contentsDir, `${index}.new`), SNAPSHOT_LIMITS.maxFileBytes)) !== file.newSha256) throw new Error(`快照内容校验失败：${file.path}`)
  }
  if (hashFiles(snapshot.files) !== snapshot.contentHash) throw new Error('快照整体指纹不一致')
  return snapshot
}

/** 读取已验证快照的完整文件内容；不返回被截断或哈希不匹配的正文。 */
export async function readDevelopmentSnapshotContentsAsync(sessionDirectory: string, executionId: string): Promise<Array<{
  file: DevelopmentSnapshotFile
  oldContent: string | null
  newContent: string | null
}>> {
  const snapshot = await loadDevelopmentSnapshotAsync(sessionDirectory, executionId)
  const contentsDir = join(sessionDirectory, `development-snapshot-${executionId}.d`)
  const contents = []
  for (const [index, file] of snapshot.files.entries()) {
    const oldBytes = file.changeType === 'add' ? null : await readSnapshotFileAsync(join(contentsDir, `${index}.old`), SNAPSHOT_LIMITS.maxFileBytes)
    const newBytes = file.changeType === 'delete' ? null : await readSnapshotFileAsync(join(contentsDir, `${index}.new`), SNAPSHOT_LIMITS.maxFileBytes)
    if ((oldBytes && sha256(oldBytes) !== file.oldSha256) || (newBytes && sha256(newBytes) !== file.newSha256)) {
      throw new Error('研发快照文件内容与清单哈希不匹配')
    }
    const oldContent = oldBytes?.toString('utf8') ?? null
    const newContent = newBytes?.toString('utf8') ?? null
    contents.push({ file, oldContent, newContent })
  }
  return contents
}

interface CapturedDevelopmentState {
  files: DevelopmentSnapshotFile[]
  contentHash: string
  contentDirEntries: Array<{ index: number; newContent?: Buffer; oldContent?: Buffer }>
}

async function captureDevelopmentStateAsync(
  worktreePath: string,
  baseCommit: string,
  scope: DevelopmentTaskScope,
  overrides?: SnapshotLimitsParam,
): Promise<CapturedDevelopmentState> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit)) throw new Error('研发基线损坏')
  const limits = { ...SNAPSHOT_LIMITS, ...overrides }
  const diffRaw = await gitAsync(worktreePath, 'diff', '--name-only', '-z', '--no-renames', baseCommit)
  const trackedPaths = diffRaw.split('\0').filter(Boolean)
  const untrackedPaths = parseUntrackedZ(await gitAsync(worktreePath, 'status', '--porcelain=v1', '-z', '--untracked-files=all'))
  const entries = [...new Set([...trackedPaths, ...untrackedPaths])]
  const files: DevelopmentSnapshotFile[] = []
  const contentDirEntries: CapturedDevelopmentState['contentDirEntries'] = []
  let totalBytes = 0

  for (const rawPath of entries) {
    const path = normalizeRepoRelativePath(rawPath)
    if (!pathWithinAllowed(path, scope.allowedPaths)) throw new Error(`存在范围外变更，整轮交付被阻塞：${path}`)
    if (isProtectedDevelopmentPath(path)) throw new Error(`变更涉及受保护路径，整轮交付被阻塞：${path}`)
    const absolute = join(worktreePath, ...path.split('/'))
    const existedAtBase = await gitObjectExistsAsync(worktreePath, baseCommit, path)
    const existsNow = await snapshotPathExistsWithoutSymlinksAsync(worktreePath, path)
    const changeType = existedAtBase && existsNow ? 'modify' : existedAtBase && !existsNow ? 'delete' : 'add'
    let oldSha256: string | null = null
    let newSha256: string | null = null
    let newBytes = 0
    let oldContent: Buffer | undefined
    let newContent: Buffer | undefined
    if (changeType !== 'add') {
      oldContent = await gitShowBinaryAsync(worktreePath, baseCommit, path)
      assertRegularText(path, oldContent)
      oldSha256 = sha256(oldContent)
    }
    if (changeType !== 'delete') {
      const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > limits.maxFileBytes) throw new Error(`文件超出单文件上限或不是普通文件：${path}`)
        newContent = await handle.readFile()
      } finally { await handle.close() }
      if (newContent.byteLength > limits.maxFileBytes) throw new Error(`文件超出单文件上限（${limits.maxFileBytes} 字节）：${path}`)
      assertRegularText(path, newContent)
      newSha256 = sha256(newContent)
      newBytes = newContent.byteLength
      totalBytes += newBytes
      if (totalBytes > limits.maxTotalBytes) throw new Error(`变更总量超出上限（${limits.maxTotalBytes} 字节）`)
    }
    const index = files.length
    files.push({ path, changeType, oldSha256, newSha256, newBytes })
    contentDirEntries.push({ index, oldContent, newContent })
    if (files.length > limits.maxFiles) throw new Error(`变更文件数超出上限（${limits.maxFiles}）`)
  }
  return { files, contentHash: hashFiles(files), contentDirEntries }
}

function gitAsync(repository: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repository, ...args], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout) => error ? reject(error) : resolve(stdout))
  })
}

function gitShowBinaryAsync(repository: string, commit: string, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repository, 'show', `${commit}:${path}`], {
      encoding: 'buffer', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout) => error ? reject(error) : resolve(stdout as Buffer))
  })
}

async function gitObjectExistsAsync(repository: string, commit: string, path: string): Promise<boolean> {
  try { await gitAsync(repository, 'cat-file', '-e', `${commit}:${path}`); return true }
  catch { return false }
}

async function snapshotPathExistsWithoutSymlinksAsync(worktreePath: string, path: string): Promise<boolean> {
  let current = worktreePath
  const segments = path.split('/')
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error(`暂不支持符号链接变更：${path}`)
      if (index < segments.length - 1 && !info.isDirectory()) throw new Error(`路径父级不是目录：${path}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  return true
}

async function readSnapshotFileAsync(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxBytes) throw new Error('研发快照文件类型或大小无效')
    const content = await handle.readFile()
    if (content.byteLength > maxBytes) throw new Error('研发快照文件类型或大小无效')
    return content
  } finally { await handle.close() }
}

async function writeSnapshotFileAsync(path: string, content: Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally { await handle.close() }
}

function captureDevelopmentState(
  worktreePath: string,
  baseCommit: string,
  scope: DevelopmentTaskScope,
  overrides?: SnapshotLimitsParam,
): CapturedDevelopmentState {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit)) throw new Error('研发基线损坏')
  const limits = { ...SNAPSHOT_LIMITS, ...overrides }
  // 枚举基线以来的全部变更：
  // - 已提交/暂存/未暂存：git diff --name-only -z --no-renames <baseCommit>（对基线而非 HEAD，避免员工 commit 后漏采）
  // - 未跟踪新增：git status 的 ?? 条目
  const diffRaw = git(worktreePath, 'diff', '--name-only', '-z', '--no-renames', baseCommit)
  const trackedPaths = diffRaw.split('\0').filter(Boolean)
  const untrackedPaths = parseUntrackedZ(git(worktreePath, 'status', '--porcelain=v1', '-z', '--untracked-files=all'))
  const entries = [...new Set([...trackedPaths, ...untrackedPaths])]

  const files: DevelopmentSnapshotFile[] = []
  let totalBytes = 0
  const contentDirEntries: Array<{ index: number; newContent?: Buffer; oldContent?: Buffer }> = []

  for (const rawPath of entries) {
    const path = normalizeRepoRelativePath(rawPath)

    if (!pathWithinAllowed(path, scope.allowedPaths)) {
      throw new Error(`存在范围外变更，整轮交付被阻塞：${path}`)
    }
    if (isProtectedDevelopmentPath(path)) {
      throw new Error(`变更换及受保护路径，整轮交付被阻塞：${path}`)
    }

    const absolute = join(worktreePath, ...path.split('/'))
    const existedAtBase = gitObjectExists(worktreePath, baseCommit, path)
    const existsNow = snapshotPathExistsWithoutSymlinks(worktreePath, path)

    const changeType = existedAtBase && existsNow ? 'modify' : existedAtBase && !existsNow ? 'delete' : 'add'

    let oldSha256: string | null = null
    let newSha256: string | null = null
    let newBytes = 0
    let oldContent: Buffer | undefined
    let newContent: Buffer | undefined

    if (changeType !== 'add') {
      oldContent = gitShowBinary(worktreePath, baseCommit, path)
      assertRegularText(path, oldContent)
      oldSha256 = sha256(oldContent)
    }
    if (changeType !== 'delete') {
      const stat = statSync(absolute)
      if (!stat.isFile()) throw new Error(`暂不支持的变更对象：${path}`)
      if (stat.size > limits.maxFileBytes) {
        throw new Error(`文件超出单文件上限（${limits.maxFileBytes} 字节）：${path}`)
      }
      newContent = readFileSync(absolute)
      if (newContent.byteLength > limits.maxFileBytes) throw new Error(`文件超出单文件上限（${limits.maxFileBytes} 字节）：${path}`)
      assertRegularText(path, newContent)
      newSha256 = sha256(newContent)
      newBytes = newContent.byteLength
      totalBytes += newBytes
      if (totalBytes > limits.maxTotalBytes) throw new Error(`变更总量超出上限（${limits.maxTotalBytes} 字节）`)
    }

    const index = files.length
    files.push({ path, changeType, oldSha256, newSha256, newBytes })
    contentDirEntries.push({
      index,
      oldContent,
      newContent,
    })
  }

  if (files.length > limits.maxFiles) throw new Error(`变更文件数超出上限（${limits.maxFiles}）`)

  return { files, contentHash: hashFiles(files), contentDirEntries }
}

/** 不跟随目标或任一父目录的符号链接，包括dangling链接。 */
function snapshotPathExistsWithoutSymlinks(worktreePath: string, path: string): boolean {
  const segments = path.split('/')
  let current = worktreePath
  for (let index = 0; index < segments.length; index++) {
    current = join(current, segments[index]!)
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) throw new Error(`暂不支持符号链接变更：${path}`)
      if (index < segments.length - 1 && !stat.isDirectory()) throw new Error(`路径父级不是目录：${path}`)
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false
      throw error
    }
  }
  return true
}

/** 读取并校验快照：清单存在、内容文件齐全、逐文件 hash 与指纹链一致（T30）。 */
export function loadDevelopmentSnapshot(sessionDirectory: string, executionId: string): DevelopmentSnapshot {
  const manifestPath = join(sessionDirectory, `development-snapshot-${executionId}.json`)
  const snapshot = JSON.parse(readSnapshotFile(manifestPath, 256 * 1024).toString('utf8')) as DevelopmentSnapshot
  const contentsDir = join(sessionDirectory, `development-snapshot-${executionId}.d`)
  const directoryStat = lstatSync(contentsDir)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('研发快照内容目录不是私有普通目录')
  if (snapshot.executionId !== executionId || typeof snapshot.id !== 'string' || !/^snap-[a-f0-9-]+$/.test(snapshot.id)
    || typeof snapshot.workspaceId !== 'string' || !/^[a-f0-9]{40,64}$/.test(snapshot.baseCommit)
    || !/^[a-f0-9]{64}$/.test(snapshot.contentHash) || !Number.isSafeInteger(snapshot.createdAt) || snapshot.createdAt < 1 || snapshot.createdAt > Date.now()
    || !Array.isArray(snapshot.files) || snapshot.files.length === 0 || snapshot.files.length > SNAPSHOT_LIMITS.maxFiles) {
    throw new Error('研发快照清单结构或执行身份无效')
  }
  const seenPaths = new Set<string>()
  let totalBytes = 0

  snapshot.files.forEach((file, index) => {
    if (!file || typeof file.path !== 'string' || normalizeRepoRelativePath(file.path) !== file.path || seenPaths.has(file.path)
      || isProtectedDevelopmentPath(file.path)
      || !['add', 'modify', 'delete'].includes(file.changeType)
      || file.oldSha256 !== null && !/^[a-f0-9]{64}$/.test(file.oldSha256)
      || file.newSha256 !== null && !/^[a-f0-9]{64}$/.test(file.newSha256)
      || !Number.isSafeInteger(file.newBytes) || file.newBytes < 0 || file.newBytes > SNAPSHOT_LIMITS.maxFileBytes) {
      throw new Error('研发快照文件清单无效')
    }
    if (file.changeType === 'add' && file.oldSha256 !== null || file.changeType === 'delete' && file.newSha256 !== null
      || file.changeType !== 'delete' && file.newSha256 === null || file.changeType !== 'add' && file.oldSha256 === null
      || file.changeType === 'delete' && file.newBytes !== 0) throw new Error('研发快照变更类型与内容指纹不一致')
    totalBytes += file.newBytes
    if (totalBytes > SNAPSHOT_LIMITS.maxTotalBytes) throw new Error('研发快照变更总量超限')
    seenPaths.add(file.path)
    if (file.changeType !== 'add') {
      const oldPath = join(contentsDir, `${index}.old`)
      if (sha256(readSnapshotFile(oldPath, SNAPSHOT_LIMITS.maxFileBytes)) !== file.oldSha256) {
        throw new Error(`快照基线内容校验失败：${file.path}`)
      }
    }
    if (file.changeType !== 'delete') {
      const newPath = join(contentsDir, `${index}.new`)
      if (sha256(readSnapshotFile(newPath, SNAPSHOT_LIMITS.maxFileBytes)) !== file.newSha256) {
        throw new Error(`快照内容校验失败：${file.path}`)
      }
    }
  })
  if (hashFiles(snapshot.files) !== snapshot.contentHash) throw new Error('快照整体指纹不一致')
  return snapshot
}

/** 读取本机会话内的快照文件，拒绝符号链接、特殊文件和超限内容。 */
function readSnapshotFile(path: string, maxBytes: number): Buffer {
  let pathStat: ReturnType<typeof lstatSync>
  try { pathStat = lstatSync(path) }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') throw new Error('研发快照文件不存在')
    throw error
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size > maxBytes) throw new Error('研发快照文件类型或大小无效')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('研发快照文件类型或大小无效')
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

function hashFiles(files: DevelopmentSnapshotFile[]): string {
  const hasher = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hasher.update(`${file.path}\0${file.changeType}\0${file.oldSha256 ?? ''}\0${file.newSha256 ?? ''}\n`)
  }
  return hasher.digest('hex')
}

/** 文本契约：出现 NUL 字节即视为二进制，明确拒绝（T09） */
function assertRegularText(path: string, content: Buffer): void {
  if (content.subarray(0, 8192).includes(0)) throw new Error(`暂不支持二进制文件变更：${path}`)
}

function writeFileSyncRaw(path: string, content: Buffer): void {
  const { writeFileSync } = require('node:fs') as typeof import('node:fs')
  writeFileSync(path, content)
}

/** 从 `git status --porcelain=v1 -z` 提取未跟踪路径（XY 为 ??） */
function parseUntrackedZ(raw: string): string[] {
  return raw.split('\0').filter((token) => token.length >= 4 && token.slice(0, 2) === '??').map((token) => token.slice(3))
}

function gitObjectExists(repository: string, commit: string, path: string): boolean {
  try {
    git(repository, 'cat-file', '-e', `${commit}:${path}`)
    return true
  } catch {
    return false
  }
}

function gitShowBinary(repository: string, commit: string, path: string): Buffer {
  return execFileSync('git', ['-C', repository, 'show', `${commit}:${path}`], {
    timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as Buffer
}
