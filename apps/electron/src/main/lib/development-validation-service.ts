/**
 * 研发验证证据服务（M3 / W07）。
 *
 * 职责：对已冻结交付运行真实验证命令，采集进程退出码与内容 hash 绑定。
 * 边界：
 * - 命令必须精确命中任务范围 verificationCommands 白名单（用户在派发时确认）；
 * - 模型自述的"测试通过"只算 reported，本服务只产出 verified 证据；
 * - 运行前后校验工作目录与快照一致，不一致结果作废为 stale；
 * - 进程未确认退出（timeout）不算成功；输出只存尾部，不作为成功依据。
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DevelopmentSnapshot, DevelopmentValidationResult } from '@gravitas/shared'
import { writeJsonFileAtomic } from './safe-file'
import { getAgentExecution, getTask } from './project-sqlite-store'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getAgentSessionMeta } from './agent-session-manager'
import { getAgentSessionWorkspacePath } from './config-paths'
import { resolveDevelopmentWorktree } from './agent-development-worktree'
import { loadDevelopmentSnapshot } from './development-snapshot-service'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const OUTPUT_TAIL_CHARS = 8000
/** 单文件验证读取上限与快照一致（1MiB） */
const MAX_FILE_BYTES = 1024 * 1024

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
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/** 解析执行上下文：任务范围 + 最近完成执行 + worktree + 快照 */
function resolveValidationWorld(taskId: string): ValidationWorld {
  const task = getTask(taskId)
  if (!task?.developmentScope) throw new DevelopmentValidationError('任务缺少研发执行范围')
  const execution = listTaskExecutions(taskId).find((item) => item.status === 'completed' && !item.sessionId.startsWith('workflow:'))
  if (!execution) throw new DevelopmentValidationError('没有已完成的研发执行，无法验证')

  const meta = execution.sessionId ? getAgentSessionMeta(execution.sessionId) : undefined
  const workspace = meta?.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
  if (!workspace?.rootPath) throw new DevelopmentValidationError('研发工作区已失效')
  const sessionDirectory = getAgentSessionWorkspacePath(workspace.slug, execution.sessionId)
  const worktreePath = resolveDevelopmentWorktree(workspace.rootPath, sessionDirectory)
  if (!worktreePath) throw new DevelopmentValidationError('研发 worktree 绑定缺失')
  const snapshot = loadDevelopmentSnapshot(sessionDirectory, execution.id)
  return { taskId, executionId: execution.id, worktreePath, sessionDirectory, snapshot }
}

function listTaskExecutions(taskId: string) {
  const { listAgentExecutionsByEntity } = require('./project-sqlite-store') as typeof import('./project-sqlite-store')
  return listAgentExecutionsByEntity('task', taskId)
}

/** 工作目录与快照一致性：逐文件核对新内容 hash；文件缺失/被改即返回 false */
function worktreeMatchesSnapshot(worktreePath: string, snapshot: DevelopmentSnapshot): boolean {
  for (const file of snapshot.files) {
    if (file.changeType === 'delete') continue
    const absolute = join(worktreePath, ...file.path.split('/'))
    if (!existsSync(absolute)) return false
    const stat = require('node:fs').statSync(absolute) as { size: number }
    if (stat.size > MAX_FILE_BYTES) return false
    if (sha256(readFileSync(absolute)) !== file.newSha256) return false
  }
  return true
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
  if (!worktreeMatchesSnapshot(world.worktreePath, world.snapshot)) {
    throw new DevelopmentValidationError('工作目录与冻结快照不一致，请先返工或重新交付')
  }

  const startedAt = Date.now()
  const { exitCode, timedOut, output } = await runCommand(trimmed, world.worktreePath, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const finishedAt = Date.now()

  const staleAfter = !worktreeMatchesSnapshot(world.worktreePath, world.snapshot)
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
    outputTail: output.slice(-OUTPUT_TAIL_CHARS),
    outputTruncated: output.length > OUTPUT_TAIL_CHARS,
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
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    for (const name of readdirSync(sessionDirectory)) {
      if (!name.startsWith('development-validation-') || !name.endsWith('.json')) continue
      try {
        const record = JSON.parse(readFileSync(join(sessionDirectory, name), 'utf8')) as DevelopmentValidationResult
        if (record.taskId === taskId) results.push(record)
      } catch {
        // 单条记录损坏不阻塞列表
      }
    }
  }
  return results.sort((a, b) => b.finishedAt - a.finishedAt)
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
