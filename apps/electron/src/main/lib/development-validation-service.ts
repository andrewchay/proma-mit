/**
 * 研发验证证据服务（M3 / W07）。
 *
 * 职责：对已冻结交付运行真实验证命令，采集进程退出码与内容 hash 绑定。
 * 边界：
 * - 命令必须精确命中任务范围 verificationCommands 白名单（用户在派发时确认）；
 * - 模型自述的"测试通过"只算 reported，本服务产出命令退出证据，不证明测试收集或业务质量；
 * - 运行前后校验工作目录与快照一致，不一致结果作废为 stale；
 * - 进程未确认退出（timeout）不算成功；输出只存尾部，不作为成功依据。
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DevelopmentSnapshot, DevelopmentTaskScope, DevelopmentValidationBinding, DevelopmentValidationEvidence, DevelopmentValidationResult } from '@gravitas/shared'
import { writeJsonFileAtomic } from './safe-file'
import { getAgentExecution, getTask } from './project-sqlite-store'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getAgentSessionMeta } from './agent-session-manager'
import { getAgentSessionWorkspacePath } from './config-paths'
import { resolveDevelopmentWorktree } from './agent-development-worktree'
import { developmentWorktreeMatchesSnapshot, loadDevelopmentSnapshot } from './development-snapshot-service'
import { normalizeRepoRelativePath } from './development-task-service'
import { DEVELOPMENT_VALIDATION_OUTPUT_TAIL_CHARS, parseDevelopmentValidationRecord } from './development-validation-record'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

export class DevelopmentValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DevelopmentValidationError'
  }
}

interface ValidationWorld {
  taskId: string
  executionId: string
  worktreePath: string
  sessionDirectory: string
  snapshot: DevelopmentSnapshot
  scope: DevelopmentTaskScope
  binding: DevelopmentValidationBinding
}

/** 解析执行上下文：任务范围 + 最近完成执行 + worktree + 快照 */
function resolveValidationWorld(taskId: string, executionId?: string): ValidationWorld {
  const task = getTask(taskId)
  if (!task?.developmentScope) throw new DevelopmentValidationError('任务缺少研发执行范围')
  const execution = executionId ? getAgentExecution(executionId) : listTaskExecutions(taskId).find((item) => item.status === 'completed' && !item.sessionId.startsWith('workflow:'))
  if (!execution || execution.status !== 'completed' || execution.sessionId.startsWith('workflow:')) throw new DevelopmentValidationError('没有已完成的研发执行，无法验证')
  if (execution.projectId !== task.projectId || execution.entityType !== 'task' || execution.entityId !== taskId) throw new DevelopmentValidationError('验证执行不属于当前任务')

  const meta = execution.sessionId ? getAgentSessionMeta(execution.sessionId) : undefined
  const workspace = meta?.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
  if (!workspace?.rootPath || workspace.id !== task.developmentScope.workspaceId) throw new DevelopmentValidationError('研发工作区已失效或不匹配任务范围')
  const sessionDirectory = getAgentSessionWorkspacePath(workspace.slug, execution.sessionId)
  const worktreePath = resolveDevelopmentWorktree(workspace.rootPath, sessionDirectory)
  if (!worktreePath) throw new DevelopmentValidationError('研发 worktree 绑定缺失')
  const snapshot = loadDevelopmentSnapshot(sessionDirectory, execution.id)
  if (snapshot.executionId !== execution.id || snapshot.workspaceId !== workspace.id) throw new DevelopmentValidationError('研发快照身份不匹配')
  if (!Number.isSafeInteger(snapshot.createdAt) || snapshot.createdAt < 0 || snapshot.createdAt > Date.now()) throw new DevelopmentValidationError('研发快照时间无效')
  const scope = task.developmentScope
  const normalized = (paths: string[]): string[] => [...new Set(paths.map(normalizeRepoRelativePath))].sort()
  const scopeHash = hashJson({ workspaceId: scope.workspaceId, targetPaths: normalized(scope.targetPaths), allowedPaths: normalized(scope.allowedPaths) })
  const binding: DevelopmentValidationBinding = {
    version: 1, projectId: task.projectId, workspaceId: workspace.id, sessionId: execution.sessionId,
    snapshotId: snapshot.id, baseCommit: snapshot.baseCommit, scopeHash,
    verificationConfigHash: hashJson({
      scopeHash, commands: [...new Set(scope.verificationCommands ?? [])].sort(),
      reviewerId: scope.reviewerId ?? null, decisionIds: [...new Set(scope.decisionIds ?? [])].sort(),
    }),
  }
  return { taskId, executionId: execution.id, worktreePath, sessionDirectory, snapshot, scope, binding }
}

function listTaskExecutions(taskId: string) {
  const { listAgentExecutionsByEntity } = require('./project-sqlite-store') as typeof import('./project-sqlite-store')
  return listAgentExecutionsByEntity('task', taskId)
}

/**
 * 运行一次验证：命令必须命中范围白名单；采集真实退出码；
 * 运行前后内容 hash 绑定，漂移即 stale。
 */
export async function runDevelopmentValidation(taskId: string, command: string, options: { timeoutMs?: number } = {}): Promise<DevelopmentValidationResult> {
  const trimmed = command?.trim()
  if (!trimmed) throw new DevelopmentValidationError('验证命令不能为空')
  const task = getTask(taskId)
  if (!task?.developmentScope) throw new DevelopmentValidationError('任务缺少研发执行范围')
  const authorized = task.developmentScope.verificationCommands ?? []
  if (!authorized.includes(trimmed)) {
    throw new DevelopmentValidationError(`命令不在任务验证白名单内（派发时确认的命令：${authorized.join('；') || '无'}）`)
  }

  const world = resolveValidationWorld(taskId)
  if (!world.scope.verificationCommands?.includes(trimmed)) throw new DevelopmentValidationError('验证命令授权已变化')
  if (!developmentWorktreeMatchesSnapshot(world.worktreePath, world.snapshot, world.scope)) {
    throw new DevelopmentValidationError('工作目录与冻结快照不一致，请先返工或重新交付')
  }

  const startedAt = Date.now()
  const { exitCode, timedOut, output } = await runCommand(trimmed, world.worktreePath, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const finishedAt = Date.now()

  const staleAfter = !validationWorldStillMatches(world)
  const status: DevelopmentValidationResult['status'] = timedOut ? 'timeout' : staleAfter ? 'stale' : exitCode === 0 ? 'passed' : 'failed'

  const result: DevelopmentValidationResult = {
    id: `val-${randomUUID()}`,
    taskId,
    executionId: world.executionId,
    command: trimmed,
    startedAt,
    finishedAt,
    exitCode,
    timedOut,
    status,
    snapshotContentHash: world.snapshot.contentHash,
    outputTail: output.slice(-DEVELOPMENT_VALIDATION_OUTPUT_TAIL_CHARS),
    outputTruncated: output.length > DEVELOPMENT_VALIDATION_OUTPUT_TAIL_CHARS,
    binding: world.binding,
  }
  writeJsonFileAtomic(join(world.sessionDirectory, `development-validation-${result.id}.json`), result)
  return result
}

/** 列出任务全部验证记录（按结束时间倒序）。 */
export function listDevelopmentValidations(taskId: string): DevelopmentValidationResult[] {
  const results: DevelopmentValidationResult[] = []
  for (const execution of listTaskExecutions(taskId)) {
    if (!execution.sessionId || execution.sessionId.startsWith('workflow:')) continue
    const meta = getAgentSessionMeta(execution.sessionId)
    const workspace = meta?.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
    if (!workspace) continue
    const sessionDirectory = getAgentSessionWorkspacePath(workspace.slug, execution.sessionId)
    if (!existsSync(sessionDirectory)) continue
    for (const name of readdirSync(sessionDirectory)) {
      if (!name.startsWith('development-validation-') || !name.endsWith('.json')) continue
      try {
        const id = name.slice('development-validation-'.length, -'.json'.length)
        const record = readValidationRecord(sessionDirectory, id, taskId, execution.id)
        results.push(record)
      } catch {
        // 单条记录损坏不阻塞列表
      }
    }
  }
  return results.sort((a, b) => b.finishedAt - a.finishedAt)
}

/**
 * 从主进程按权威任务/执行派生的私有路径回读，拒绝接收模型DTO或任意文件路径。
 * fresh只是绑定/当前Git变化集一致，不能冒充测试收集、Goal调用身份或业务验收。
 */
export function readDevelopmentValidationEvidence(taskId: string, executionId: string, validationId: string): DevelopmentValidationEvidence {
  const world = resolveValidationWorld(taskId, executionId)
  const result = readValidationRecord(world.sessionDirectory, validationId, taskId, executionId)
  if (!result.binding) return { result, freshness: 'legacy', reason: '旧记录没有配置绑定，不补造可信新鲜度' }
  if (hashJson(result.binding) !== hashJson(world.binding) || result.snapshotContentHash !== world.snapshot.contentHash
    || !world.scope.verificationCommands?.includes(result.command) || result.startedAt < world.snapshot.createdAt) {
    return { result, freshness: 'stale', reason: '身份、快照或验证配置已变化' }
  }
  if (!developmentWorktreeMatchesSnapshot(world.worktreePath, world.snapshot, world.scope)) {
    return { result, freshness: 'stale', reason: '当前工作目录的完整Git变化集与快照不一致' }
  }
  return { result, freshness: 'fresh' }
}

function readValidationRecord(sessionDirectory: string, id: string, taskId: string, executionId: string): DevelopmentValidationResult {
  if (!/^val-[a-f0-9-]+$/.test(id)) throw new DevelopmentValidationError('验证记录ID无效')
  const path = join(sessionDirectory, `development-validation-${id}.json`)
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new DevelopmentValidationError('验证记录不是合法的私有文件')
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const record = parseDevelopmentValidationRecord(raw, { id, taskId, executionId }, Date.now())
  if (!record) throw new DevelopmentValidationError('验证记录结构或身份不合法')
  return record
}

function validationWorldStillMatches(original: ValidationWorld): boolean {
  try {
    const current = resolveValidationWorld(original.taskId, original.executionId)
    return hashJson(current.binding) === hashJson(original.binding)
      && current.snapshot.contentHash === original.snapshot.contentHash
      && developmentWorktreeMatchesSnapshot(current.worktreePath, current.snapshot, current.scope)
  } catch {
    return false
  }
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** 受控运行：无 shell，参数按空格切分（首版不支持引号）；输出全量采集后截尾。 */
async function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; timedOut: boolean; output: string }> {
  const parts = command.split(/\s+/).filter(Boolean)
  if (!parts.length) throw new DevelopmentValidationError('验证命令不能为空')
  return new Promise((resolve) => {
    const child = spawn(parts[0]!, parts.slice(1), {
      cwd,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      // 宽限后强制结束，确保进程终止被确认
      setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      }, 2000).unref()
    }, timeoutMs)
    const collect = (chunk: Buffer | string): void => { output += chunk.toString('utf8') }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ exitCode: null, timedOut, output: `${output}\n[spawn error] ${error.message}` })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        exitCode: timedOut ? null : code,
        timedOut,
        output: signal && !timedOut ? `${output}\n[signal] ${signal}` : output,
      })
    })
  })
}
