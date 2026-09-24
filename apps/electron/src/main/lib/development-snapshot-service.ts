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
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
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
  const limits = { ...SNAPSHOT_LIMITS, ...input.limits }

  const bindingPath = join(sessionDirectory, 'development-worktree.json')
  if (!existsSync(bindingPath)) throw new Error('研发 worktree 绑定缺失，无法确定快照基线')
  const binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as { baseCommit?: string }
  if (!binding.baseCommit || !/^[a-f0-9]{40,64}$/.test(binding.baseCommit)) throw new Error('研发基线损坏')

  // 枚举基线以来的全部变更：
  // - 已提交/暂存/未暂存：git diff --name-only -z --no-renames <baseCommit>（对基线而非 HEAD，避免员工 commit 后漏采）
  // - 未跟踪新增：git status 的 ?? 条目
  const diffRaw = git(worktreePath, 'diff', '--name-only', '-z', '--no-renames', binding.baseCommit!)
  const trackedPaths = diffRaw.split('\0').filter(Boolean)
  const untrackedPaths = parseUntrackedZ(git(worktreePath, 'status', '--porcelain=v1', '-z', '--untracked-files=all'))
  const entries = [...new Set([...trackedPaths, ...untrackedPaths])]
  if (!entries.length) throw new Error('worktree 相对基线没有变更，无可冻结交付')

  const files: DevelopmentSnapshotFile[] = []
  const contentsDir = join(sessionDirectory, `development-snapshot-${executionId}.d`)
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
    const existedAtBase = gitObjectExists(worktreePath, binding.baseCommit!, path)
    const existsNow = existsSync(absolute)

    if (existsNow && lstatSync(absolute).isSymbolicLink()) {
      throw new Error(`暂不支持符号链接变更：${path}`)
    }

    const changeType = existedAtBase && existsNow ? 'modify' : existedAtBase && !existsNow ? 'delete' : 'add'

    let oldSha256: string | null = null
    let newSha256: string | null = null
    let newBytes = 0

    if (changeType !== 'add') {
      const oldContent = gitShowBinary(worktreePath, binding.baseCommit!, path)
      assertRegularText(path, oldContent)
      oldSha256 = sha256(oldContent)
    }
    if (changeType !== 'delete') {
      const stat = statSync(absolute)
      if (!stat.isFile()) throw new Error(`暂不支持的变更对象：${path}`)
      if (stat.size > limits.maxFileBytes) {
        throw new Error(`文件超出单文件上限（${limits.maxFileBytes} 字节）：${path}`)
      }
      const newContent = readFileSync(absolute)
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
      ...(changeType !== 'add' ? { oldContent: gitShowBinary(worktreePath, binding.baseCommit!, path) } : {}),
      ...(changeType !== 'delete' ? { newContent: readFileSync(absolute) } : {}),
    })
  }

  if (files.length > limits.maxFiles) throw new Error(`变更文件数超出上限（${limits.maxFiles}）`)

  const id = `snap-${randomUUID()}`
  const contentHash = hashFiles(files)

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

/** 读取并校验快照：清单存在、内容文件齐全、逐文件 hash 与指纹链一致（T30）。 */
export function loadDevelopmentSnapshot(sessionDirectory: string, executionId: string): DevelopmentSnapshot {
  const manifestPath = join(sessionDirectory, `development-snapshot-${executionId}.json`)
  if (!existsSync(manifestPath)) throw new Error('研发快照不存在或已被清理')
  const snapshot = JSON.parse(readFileSync(manifestPath, 'utf8')) as DevelopmentSnapshot
  const contentsDir = join(sessionDirectory, `development-snapshot-${executionId}.d`)
  if (!existsSync(contentsDir)) throw new Error('研发快照内容缺失')

  snapshot.files.forEach((file, index) => {
    if (file.changeType !== 'add') {
      const oldPath = join(contentsDir, `${index}.old`)
      if (!existsSync(oldPath) || sha256(readFileSync(oldPath)) !== file.oldSha256) {
        throw new Error(`快照基线内容校验失败：${file.path}`)
      }
    }
    if (file.changeType !== 'delete') {
      const newPath = join(contentsDir, `${index}.new`)
      if (!existsSync(newPath) || sha256(readFileSync(newPath)) !== file.newSha256) {
        throw new Error(`快照内容校验失败：${file.path}`)
      }
    }
  })
  if (hashFiles(snapshot.files) !== snapshot.contentHash) throw new Error('快照整体指纹不一致')
  return snapshot
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
