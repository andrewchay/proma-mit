/** 失败研发工作树的只读盘点与可信交接；不提交、不丢弃、不覆盖用户文件。 */
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DevelopmentSnapshot, DevelopmentTaskScope } from '@gravitas/shared'
import { applyOwnerDevelopmentSnapshot } from './project-owner-development-handoff'
import {
  createDevelopmentSnapshotAsync,
  developmentWorktreeMatchesSnapshotAsync,
  readDevelopmentSnapshotContentsAsync,
} from './development-snapshot-service'
import * as store from './project-sqlite-store'

/** 失败工作树的只读盘点结果；路径均为仓库相对 POSIX 路径。 */
export interface FailedDevelopmentInventory {
  worktreePath: string
  /** 旧工作树已被清理（用户删除、换机、临时目录回收）时为 null。 */
  baseCommit: string | null
  changedFiles: string[]
  untrackedFiles: string[]
  hasChanges: boolean
  /** 现场已不存在：没有半成品可交接，应从干净基线重试而不是永久阻塞。 */
  worktreeMissing?: true
}

/** 交接入参：失败侧只读，目标侧必须是尚未运行的同基线干净工作树。 */
export interface SeedFailedDevelopmentWorktreeInput {
  /** 主仓库根；只用于校验 worktree 归属，不参与写入 */
  repository: string
  failedWorktreePath: string
  failedSessionDirectory: string
  failedExecutionId: string
  workspaceId: string
  targetWorktreePath: string
  targetSessionDirectory: string
  scope: DevelopmentTaskScope
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** 状态行首字符可能是有意义的空格（如 ` M path`），此时不能 trim。 */
function gitRaw(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** 判断错误是否为「路径不存在」；权限、I/O 等其他错误不在此列。 */
function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/**
 * `repository` 必须是主仓库根；它只用于校验 worktree 归属，不参与写入。
 *
 * 旧工作树不存在时返回 `worktreeMissing`，而不是抛错：用户清理临时目录、
 * 换机同步数据库都会留下这种状态，若按故障处理，恢复流程会每次都撞同一堵墙。
 * 权限错误与仓库归属错误仍原样抛出——那是真实故障，不能当作「没有现场」。
 */
export function inspectFailedDevelopmentWorktree(worktreePath: string, repository: string): FailedDevelopmentInventory {
  let worktree: string
  try { worktree = realpathSync(worktreePath) } catch (error) {
    if (isMissingPath(error)) return { worktreePath, baseCommit: null, changedFiles: [], untrackedFiles: [], hasChanges: false, worktreeMissing: true }
    throw error
  }
  const repo = realpathSync(repository)
  const top = realpathSync(git(worktree, 'rev-parse', '--show-toplevel'))
  if (top !== worktree) throw new Error('失败研发工作树路径不是仓库根目录')
  const worktreeCommon = realpathSync(resolve(worktree, git(worktree, 'rev-parse', '--git-common-dir')))
  const repoCommon = realpathSync(resolve(repo, git(repo, 'rev-parse', '--git-common-dir')))
  if (worktreeCommon !== repoCommon) throw new Error('失败研发工作树不属于当前仓库')
  const baseCommit = git(worktree, 'rev-parse', 'HEAD')
  // 用 -z 保持中文/空格路径原样，并让状态行首空格不被 trim 吃掉；重命名拆成删除+新增。
  const status = gitRaw(worktree, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames')
    .split('\0').filter(Boolean)
  const changedFiles = status.filter(line => !line.startsWith('?? ')).map(line => line.slice(3))
  const untrackedFiles = status.filter(line => line.startsWith('?? ')).map(line => line.slice(3))
  return { worktreePath: worktree, baseCommit, changedFiles, untrackedFiles, hasChanges: status.length > 0 }
}

/**
 * 交接结果。
 *
 * `snapshot === null` 有两种含义，调用方必须能区分：
 * - `worktreeMissing: true`：旧现场已不存在，本次从干净基线重试（应告知用户）；
 * - 其余：旧工作树干净，没有半成品需要接续（正常情况，无需提示）。
 */
export interface SeedFailedDevelopmentWorktreeResult {
  snapshot: DevelopmentSnapshot | null
  worktreeMissing: boolean
}

/**
 * 把失败工作树的改动冻结成快照并应用到新工作树。
 *
 * 无改动时返回 null 快照（新工作树保持干净）；快照不可核验时抛错，
 * 绝不静默丢弃半成品。
 */
export async function seedFailedDevelopmentWorktree(
  input: SeedFailedDevelopmentWorktreeInput,
): Promise<SeedFailedDevelopmentWorktreeResult> {
  const inventory = inspectFailedDevelopmentWorktree(input.failedWorktreePath, input.repository)
  // 现场已不存在：没有半成品可接续，新工作树保持干净。
  // 注意这里只核实「路径不存在」，不断言旧现场从没有过改动——那需要额外证据。
  if (inventory.worktreeMissing === true) return { snapshot: null, worktreeMissing: true }
  if (!inventory.hasChanges || inventory.baseCommit === null) return { snapshot: null, worktreeMissing: false }
  const snapshot = await createDevelopmentSnapshotAsync({
    worktreePath: input.failedWorktreePath, sessionDirectory: input.failedSessionDirectory,
    executionId: input.failedExecutionId, workspaceId: input.workspaceId, scope: input.scope,
  })
  if (snapshot.baseCommit !== inventory.baseCommit) throw new Error('失败工作树基线与快照不一致，已停止交接')
  if (!await developmentWorktreeMatchesSnapshotAsync(input.failedWorktreePath, snapshot, input.scope)) {
    throw new Error('失败工作树在冻结后发生变化，已停止交接')
  }
  const files = await readDevelopmentSnapshotContentsAsync(input.failedSessionDirectory, input.failedExecutionId)
  applyOwnerDevelopmentSnapshot(
    input.targetWorktreePath, input.targetSessionDirectory, snapshot, files, input.scope.allowedPaths,
  )
  return { snapshot, worktreeMissing: false }
}

/**
 * 找到同一项目里最近一次接替中、与当前 step 对应的失败执行。
 * 新批次的 taskId 会变，只能靠 `step_key` 建立新旧映射；找不到或跨界时返回 null。
 */
export function findFailedExecutionForStep(projectId: string, stepKey: string, nextMaterializationId: string): { executionId: string; sessionId: string } | null {
  if (!projectId.trim() || !stepKey.trim() || !nextMaterializationId.trim()) return null
  const row = store.getProjectDb().prepare(`
    SELECT e.id AS execution_id, e.session_id
    FROM project_owner_execution_batch_supersessions s
    JOIN project_owner_execution_grants g ON g.project_id = s.project_id AND g.materialization_id = s.previous_materialization_id
    JOIN project_owner_execution_commands c ON c.grant_id = g.id AND c.role = 'executor'
    JOIN agent_executions e ON e.id = c.execution_id AND e.owner_command_id = c.id
    JOIN project_owner_task_step_links l ON l.id = c.source_step_link_id AND l.task_id = c.source_task_id
    WHERE s.project_id = ? AND l.step_key = ? AND s.next_materialization_id = ? AND e.status = 'failed' AND e.session_id <> ''
    ORDER BY s.created_at DESC, c.created_at DESC
    LIMIT 1`).get(projectId, stepKey, nextMaterializationId) as { execution_id: string; session_id: string } | undefined
  return row ? { executionId: row.execution_id, sessionId: row.session_id } : null
}

export interface MixedBatchHandoffTarget {
  /** 当前批次里与失败步骤对应的 taskId。 */
  taskId: string
  failedExecutionId: string
  failedSessionDirectory: string
  failedWorktreePath: string
}

/**
 * 解析「同一 step 上一次失败现场的 worktree 路径」，供启动链接线使用。
 * 只读：不创建目录、不写库。任一前提不成立都返回 null（静默跳过），
 * 只有「任务缺少冻结研发范围」这种来源损坏才抛错。
 *
 * 工作区必须与当前执行相同——不同仓库基线的快照不能互相应用。
 */
export function resolveMixedBatchHandoffTarget(input: {
  projectId: string
  taskId: string
  currentWorkspace: { id: string; slug: string; rootPath?: string }
  lookupSessionWorkspaceId: (sessionId: string) => string | undefined
  lookupWorkspace: (workspaceId: string) => { id: string; slug: string; rootPath?: string } | undefined
  /** 由调用方注入 `getAgentSessionWorkspacePath`，避免本模块硬编码 Dev/Stable 路径。 */
  resolveSessionDirectory: (slug: string, sessionId: string) => string
}): MixedBatchHandoffTarget | null {
  if (!input.currentWorkspace.rootPath) return null
  const step = store.getProjectDb()
    .prepare('SELECT step_key, materialization_id FROM project_owner_task_step_links WHERE task_id=? AND project_id=?')
    .get(input.taskId, input.projectId) as { step_key: string; materialization_id: string } | undefined
  if (!step) return null
  const failed = findFailedExecutionForStep(input.projectId, step.step_key, step.materialization_id)
  if (!failed) return null
  const failedWorkspaceId = input.lookupSessionWorkspaceId(failed.sessionId)
  const failedWorkspace = failedWorkspaceId ? input.lookupWorkspace(failedWorkspaceId) : undefined
  // 跨工作区的失败现场不可信：不同仓库基线的快照不能应用。
  if (!failedWorkspace?.rootPath || failedWorkspace.id !== input.currentWorkspace.id) return null
  const failedSessionDirectory = input.resolveSessionDirectory(failedWorkspace.slug, failed.sessionId)
  return {
    taskId: input.taskId,
    failedExecutionId: failed.executionId,
    failedSessionDirectory,
    failedWorktreePath: resolve(failedSessionDirectory, 'source'),
  }
}
