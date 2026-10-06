/**
 * 研发确认应用服务（M3 / W08）。
 *
 * 两段式应用：prepare 预检下发精确操作清单（不含写入），confirm 二次校验后
 * 把已验收冻结内容字节级写入原仓库，保留为未提交改动。
 * 边界：
 * - 只有 local-user 人工验收通过的交付可应用；不做自动合并/提交/推送/hook；
 * - 前置事实（HEAD==基线、目录与 index 干净、逐文件旧内容匹配）在 prepare 与
 *   confirm 双重校验；任一漂移即拒绝，不用过期确认单写文件；
 * - 应用状态 prepared→applying→applied 持久化；中断后按逐文件 hash 分类恢复，
 *   混合态标记 recovery_required，不自动 reset/覆盖；
 * - 文件写入与 SQLite 回写无法同事务：以操作记录+幂等键收敛，绝不重复应用。
 */

import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  DevelopmentApplyManifest,
  DevelopmentApplyOperation,
  DevelopmentApplyStatus,
  DevelopmentApplyStatusInfo,
  DevelopmentSnapshot,
} from '@gravitas/shared'
import { getAgentExecution, getProjectDb, getTask } from './project-sqlite-store'
import { getProjectChain } from './project-chain-service'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getAgentSessionMeta } from './agent-session-manager'
import { getAgentSessionWorkspacePath } from './config-paths'
import { resolveDevelopmentWorktree } from './agent-development-worktree'
import { loadDevelopmentSnapshot } from './development-snapshot-service'
import { updateTask } from './project-service'

const CONFIRM_TTL_MS = 10 * 60 * 1000

export class DevelopmentApplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DevelopmentApplyError'
  }
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** 进程内按仓库根的互斥锁：串行化 confirm，防止并发双写 */
const repoLocks = new Map<string, Promise<unknown>>()
async function withRepoLock<T>(repoRoot: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = repoLocks.get(repoRoot) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(fn)
  repoLocks.set(repoRoot, next)
  try {
    return await next
  } finally {
    if (repoLocks.get(repoRoot) === next) repoLocks.delete(repoRoot)
  }
}

interface ApplyWorld {
  task: NonNullable<ReturnType<typeof getTask>>
  deliveryId: string
  version: number
  snapshot: DevelopmentSnapshot
  repoRoot: string
  branch: string
  executionId: string
}

/** 解析可应用上下文：已验收交付 + 冻结快照 + 原仓库定位 */
function resolveApplyWorld(taskId: string): ApplyWorld {
  const task = getTask(taskId)
  if (!task?.developmentScope) throw new DevelopmentApplyError('任务缺少研发执行范围')
  const chain = getProjectChain(task.projectId)
  const delivery = chain.drafts
    .filter((draft) => draft.taskId === taskId && draft.status === 'accepted' && draft.executionId)
    .sort((a, b) => b.version - a.version)[0]
  if (!delivery) throw new DevelopmentApplyError('没有已人工验收通过的交付版本，不能应用')

  const execution = getAgentExecution(delivery.executionId!)
  if (!execution || execution.projectId !== task.projectId) throw new DevelopmentApplyError('交付关联的执行记录无效')
  const meta = execution.sessionId ? getAgentSessionMeta(execution.sessionId) : undefined
  const workspace = meta?.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
  if (!workspace?.rootPath) throw new DevelopmentApplyError('研发工作区已失效')
  const sessionDirectory = getAgentSessionWorkspacePath(workspace.slug, execution.sessionId)
  const snapshot = loadDevelopmentSnapshot(sessionDirectory, execution.id)
  return {
    task,
    deliveryId: delivery.id,
    version: delivery.version,
    snapshot,
    repoRoot: workspace.rootPath,
    branch: git(workspace.rootPath, 'branch', '--show-current'),
    executionId: execution.id,
  }
}

/** 原仓库预检：仓库身份、HEAD==基线、目录与 index 全干净、逐文件旧内容匹配 */
function verifyRepoPreconditions(world: ApplyWorld): void {
  const toplevel = git(world.repoRoot, 'rev-parse', '--show-toplevel')
  if (toplevel !== world.repoRoot) throw new DevelopmentApplyError('应用目标不是仓库根目录')
  const head = git(world.repoRoot, 'rev-parse', 'HEAD')
  if (head !== world.snapshot.baseCommit) {
    throw new DevelopmentApplyError(`原仓库 HEAD（${head.slice(0, 7)}）已偏离交付基线（${world.snapshot.baseCommit.slice(0, 7)}）；不自动 rebase/merge，请重新评估后处理`)
  }
  const status = git(world.repoRoot, 'status', '--porcelain', '--untracked-files=all')
  if (status) throw new DevelopmentApplyError('原仓库存在未提交改动或未跟踪文件，请先保存当前迭代再应用')
  // 逐文件：当前内容必须等于快照旧内容（HEAD==基线下的双保险，防 worktree 边界遗漏）
  for (const file of world.snapshot.files) {
    const absolute = join(world.repoRoot, ...file.path.split('/'))
    if (file.changeType === 'add') {
      if (existsSync(absolute)) throw new DevelopmentApplyError(`目标文件已存在（快照判定为新增）：${file.path}`)
      continue
    }
    if (!existsSync(absolute)) throw new DevelopmentApplyError(`目标文件缺失（快照判定存在）：${file.path}`)
    if (sha256(readFileSync(absolute)) !== file.oldSha256) {
      throw new DevelopmentApplyError(`文件当前内容与快照基线不一致：${file.path}`)
    }
  }
}

/** 预检并创建 prepared 操作记录；不下发任何写入。 */
export function prepareApply(taskId: string): DevelopmentApplyManifest {
  const world = resolveApplyWorld(taskId)
  verifyRepoPreconditions(world)
  const id = `apply-${randomUUID()}`
  const now = Date.now()
  const operation: DevelopmentApplyOperation = {
    id,
    taskId,
    deliveryId: world.deliveryId,
    version: world.version,
    executionId: world.executionId,
    snapshotId: world.snapshot.id,
    contentHash: world.snapshot.contentHash,
    repoRoot: world.repoRoot,
    branch: world.branch,
    baseCommit: world.snapshot.baseCommit,
    files: world.snapshot.files,
    status: 'prepared',
    createdAt: now,
    expiresAt: now + CONFIRM_TTL_MS,
  }
  saveOperation(operation)
  return {
    operationId: id,
    taskId,
    deliveryId: world.deliveryId,
    version: world.version,
    snapshotId: world.snapshot.id,
    contentHash: world.snapshot.contentHash,
    repoRoot: world.repoRoot,
    branch: world.branch,
    baseCommit: world.snapshot.baseCommit,
    files: world.snapshot.files,
    createdAt: now,
    expiresAt: operation.expiresAt,
  }
}

/** 确认应用：二次校验后字节级写入；无 commit/无 push/无 hook；随后尝试任务完成（不绕过 DoD）。 */
export async function confirmApply(operationId: string): Promise<DevelopmentApplyOperation & { taskCompleted: boolean; taskError?: string }> {
  const operation = loadOperation(operationId)
  if (!operation) throw new DevelopmentApplyError('应用操作不存在')
  return withRepoLock(operation.repoRoot, async () => {
    const fresh = loadOperation(operationId)!
    if (fresh.status === 'applied') return { ...fresh, taskCompleted: false } // 幂等：已完成不重复写
    if (fresh.status === 'recovery_required') throw new DevelopmentApplyError('存在混合态应用记录，需先人工恢复')
    if (fresh.status !== 'prepared' && fresh.status !== 'blocked') throw new DevelopmentApplyError(`当前状态不可确认：${fresh.status}`)
    if (Date.now() > fresh.expiresAt) {
      saveOperation({ ...fresh, status: 'blocked', error: '确认单已过期，请重新预检' })
      throw new DevelopmentApplyError('确认单已过期，请重新预检')
    }

    // 与 prepare 完全一致的二次校验（不能只依赖旧预检）；任何漂移标记 blocked
    let world: ApplyWorld
    let snapshot: DevelopmentSnapshot
    let sessionDirectory: string
    try {
      const loaded = loadSnapshotByOperation(fresh)
      snapshot = loaded.snapshot
      sessionDirectory = loaded.sessionDirectory
      const branch = git(fresh.repoRoot, 'branch', '--show-current')
      if (branch !== fresh.branch) throw new DevelopmentApplyError('原仓库分支已变化，请重新预检')
      world = {
        task: getTask(fresh.taskId)!,
        deliveryId: fresh.deliveryId,
        version: fresh.version,
        snapshot,
        repoRoot: fresh.repoRoot,
        branch,
        executionId: fresh.executionId,
      }
      verifyRepoPreconditions(world)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      saveOperation({ ...fresh, status: 'blocked', error: `确认前校验失败：${message}` })
      throw error
    }

    saveOperation({ ...fresh, status: 'applying' })
    try {
      for (let index = 0; index < fresh.files.length; index++) {
        const file = fresh.files[index]!
        const absolute = join(fresh.repoRoot, ...file.path.split('/'))
        if (file.changeType === 'delete') {
          rmSync(absolute)
        } else {
          writeFileSync(absolute, readSnapshotNewContent(sessionDirectory, snapshot, index))
        }
      }
      // 逐文件后验：内容与 index 状态
      verifyApplied(fresh)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      saveOperation({ ...fresh, status: 'recovery_required', error: message })
      throw new DevelopmentApplyError(`应用中断已标记恢复态：${message}`)
    }

    const applied: DevelopmentApplyOperation = { ...fresh, status: 'applied', appliedAt: Date.now() }
    saveOperation(applied)

    // 应用成功 ≠ 任务完成：走现有 DoD 闸门，失败不回滚文件
    let taskCompleted = false
    let taskError: string | undefined
    try {
      const updated = await updateTask(fresh.taskId, { status: 'completed' }, { source: 'system' })
      taskCompleted = Boolean(updated)
    } catch (error) {
      taskError = error instanceof Error ? error.message : String(error)
    }
    return { ...applied, taskCompleted, ...(taskError ? { taskError } : {}) }
  })
}

/** 查询任务应用操作状态；对 applying 中断记录做恢复分类。 */
export function getApplyStatus(taskId: string): DevelopmentApplyStatusInfo {
  const operations = listOperations(taskId)
  const latest = operations[0]
  if (!latest) return { confirmable: false, taskCompleted: getTask(taskId)?.status === 'completed' }
  if (latest.status === 'applying') {
    const classification = classifyInterrupted(latest)
    if (classification.status === 'applied') {
      saveOperation({ ...latest, status: 'applied', appliedAt: Date.now(), error: classification.error })
      const updated = loadOperation(latest.id)!
      return { latest: updated, confirmable: false, taskCompleted: getTask(taskId)?.status === 'completed' }
    }
    if (classification.status === 'prepared') {
      saveOperation({ ...latest, status: 'prepared', error: classification.error })
      return { latest: loadOperation(latest.id)!, confirmable: true, taskCompleted: false }
    }
    saveOperation({ ...latest, status: 'recovery_required', error: classification.error })
    return { latest: loadOperation(latest.id)!, confirmable: false, recoveryFiles: classification.recoveryFiles, taskCompleted: false }
  }
  return {
    latest,
    confirmable: latest.status === 'prepared' && Date.now() <= latest.expiresAt,
    taskCompleted: getTask(taskId)?.status === 'completed',
  }
}

/** 中断分类：全新→补记 applied；全旧→可重试 prepared；混合→recovery_required */
function classifyInterrupted(operation: DevelopmentApplyOperation): { status: DevelopmentApplyStatus; error?: string; recoveryFiles?: Array<{ path: string; issue: string }> } {
  const issues: Array<{ path: string; issue: string }> = []
  for (let index = 0; index < operation.files.length; index++) {
    const file = operation.files[index]!
    const absolute = join(operation.repoRoot, ...file.path.split('/'))
    if (file.changeType === 'delete') {
      if (existsSync(absolute)) issues.push({ path: file.path, issue: '应删除的文件仍存在' })
      continue
    }
    if (!existsSync(absolute)) {
      issues.push({ path: file.path, issue: '应写入的文件缺失' })
      continue
    }
    const current = sha256(readFileSync(absolute))
    if (current === file.newSha256) continue
    if (current === file.oldSha256) continue // 尚未写入，属未开始
    issues.push({ path: file.path, issue: '内容既非基线也非验收版本' })
  }
  if (!issues.length) {
    // 全部文件处于目标态或基线态：全部目标态才算 applied
    const allNew = operation.files.every((file) => {
      if (file.changeType === 'delete') return !existsSync(join(operation.repoRoot, ...file.path.split('/')))
      const absolute = join(operation.repoRoot, ...file.path.split('/'))
      return existsSync(absolute) && sha256(readFileSync(absolute)) === file.newSha256
    })
    if (allNew) return { status: 'applied', error: '应用中断后确认全部文件已是验收内容' }
    return { status: 'prepared', error: '应用中断后确认全部文件仍是基线内容，可重试' }
  }
  return { status: 'recovery_required', error: '应用中断且文件状态混合，需人工恢复', recoveryFiles: issues }
}

function verifyApplied(operation: DevelopmentApplyOperation): void {
  for (let index = 0; index < operation.files.length; index++) {
    const file = operation.files[index]!
    const absolute = join(operation.repoRoot, ...file.path.split('/'))
    if (file.changeType === 'delete') {
      if (existsSync(absolute)) throw new Error(`删除未生效：${file.path}`)
      continue
    }
    if (!existsSync(absolute)) throw new Error(`写入未生效：${file.path}`)
    if (sha256(readFileSync(absolute)) !== file.newSha256) throw new Error(`写入内容与验收版本不一致：${file.path}`)
  }
  // index 未被触碰：无暂存差异
  const staged = git(operation.repoRoot, 'diff', '--cached', '--name-only')
  if (staged) throw new Error('应用后 index 出现暂存内容，超出预期')
}

/** 按操作记录解析快照及其内容目录（校验 snapshotId 与内容指纹）。 */
function loadSnapshotByOperation(operation: DevelopmentApplyOperation): { snapshot: DevelopmentSnapshot; sessionDirectory: string } {
  const execution = getAgentExecution(operation.executionId)
  const meta = execution?.sessionId ? getAgentSessionMeta(execution.sessionId) : undefined
  const workspace = meta?.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
  if (!workspace) throw new DevelopmentApplyError('研发工作区已失效，不能读取快照')
  const sessionDirectory = getAgentSessionWorkspacePath(workspace.slug, execution!.sessionId)
  const snapshot = loadDevelopmentSnapshot(sessionDirectory, operation.executionId)
  if (snapshot.id !== operation.snapshotId || snapshot.contentHash !== operation.contentHash) {
    throw new DevelopmentApplyError('快照与操作记录不匹配')
  }
  return { snapshot, sessionDirectory }
}

function readSnapshotNewContent(sessionDirectory: string, snapshot: DevelopmentSnapshot, index: number): Buffer {
  const path = join(sessionDirectory, `development-snapshot-${snapshot.executionId}.d`, `${index}.new`)
  if (!existsSync(path)) throw new Error(`快照内容缺失：${snapshot.files[index]?.path}`)
  return readFileSync(path)
}

// ===== 持久化 =====

function rowToOperation(row: Record<string, unknown>): DevelopmentApplyOperation {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    deliveryId: row.delivery_id as string,
    version: row.version as number,
    executionId: row.execution_id as string,
    snapshotId: row.snapshot_id as string,
    contentHash: row.content_hash as string,
    repoRoot: row.repo_root as string,
    branch: row.branch as string,
    baseCommit: row.base_commit as string,
    files: JSON.parse(row.files as string),
    status: row.status as DevelopmentApplyStatus,
    createdAt: row.created_at as number,
    expiresAt: row.expires_at as number,
    ...(row.applied_at ? { appliedAt: row.applied_at as number } : {}),
    ...(row.error ? { error: row.error as string } : {}),
  }
}

function saveOperation(operation: DevelopmentApplyOperation): void {
  getProjectDb().prepare(
    `INSERT OR REPLACE INTO development_apply_operations
     (id, task_id, delivery_id, version, execution_id, snapshot_id, content_hash, repo_root, branch, base_commit, files, status, created_at, expires_at, applied_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    operation.id, operation.taskId, operation.deliveryId, operation.version, operation.executionId, operation.snapshotId,
    operation.contentHash, operation.repoRoot, operation.branch, operation.baseCommit,
    JSON.stringify(operation.files), operation.status, operation.createdAt, operation.expiresAt,
    operation.appliedAt ?? null, operation.error ?? null,
  )
}

function loadOperation(id: string): DevelopmentApplyOperation | undefined {
  const row = getProjectDb().prepare('SELECT * FROM development_apply_operations WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToOperation(row) : undefined
}

function listOperations(taskId: string): DevelopmentApplyOperation[] {
  const rows = getProjectDb().prepare('SELECT * FROM development_apply_operations WHERE task_id = ? ORDER BY created_at DESC').all(taskId) as Array<Record<string, unknown>>
  return rows.map(rowToOperation)
}
