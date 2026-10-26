import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DevelopmentSnapshot } from '@gravitas/shared'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getAgentSessionMeta } from './agent-session-manager'
import { getAgentSessionWorkspacePath } from './config-paths'
import { resolveDevelopmentWorktree } from './agent-development-worktree'
import { createDevelopmentSnapshotAsync, developmentWorktreeMatchesSnapshotAsync, loadDevelopmentSnapshotAsync, readDevelopmentSnapshotContentsAsync } from './development-snapshot-service'
import { validateDevelopmentScope } from './development-task-service'
import { readOwnerCommandFrozenSource } from './project-owner-employee-runtime'
import { ownerExecutionHash } from './project-owner-execution-hash'
import { ownerDevelopmentValidationId, readOwnerDevelopmentValidationAttempt } from './development-validation-attempt'
import { DEVELOPMENT_VALIDATION_EVIDENCE_VALIDITY_MS } from './development-validation-acceptance'
import { DEVELOPMENT_VALIDATION_OUTPUT_TAIL_CHARS } from './development-validation-record'
import { readDevelopmentValidationEvidence } from './development-validation-service'
import * as store from './project-sqlite-store'

export interface OwnerDevelopmentReviewArtifact {
  executorCommandId: string
  executorExecutionId: string
  contentHash: string
  content: string
  validationEvidence?: OwnerDevelopmentValidationArtifact[]
}

export interface OwnerDevelopmentValidationArtifact {
  command: string
  validationId: string
  attemptState: 'missing' | 'running' | 'completed'
  freshness?: 'fresh' | 'stale' | 'legacy' | 'unknown'
  status?: 'passed' | 'failed' | 'stale' | 'timeout'
  exitCode?: number | null
  timedOut?: boolean
  outputTail?: string
  outputTruncated?: boolean
  rawOutputSha256?: string
  rawOutputByteLength?: number
  /** 验证完成时间；用于按有效期判定是否仍可采信。 */
  finishedAt?: number
  /** 超过有效期即置真；评审与验收都不得据此通过。 */
  expired?: boolean
}

export function ownerDevelopmentArtifactReference(executorCommandId: string, executorExecutionId: string): string {
  return `<owner-development-artifact-ref>${JSON.stringify({ executorCommandId, executorExecutionId })}</owner-development-artifact-ref>`
}

export function ownerDevelopmentArtifactReferenceFromPrompt(prompt: string): { reference: string; executorCommandId: string; executorExecutionId: string } | null {
  const match = prompt.match(/<owner-development-artifact-ref>([\s\S]*?)<\/owner-development-artifact-ref>/)
  if (!match) return null
  let value: unknown
  try { value = JSON.parse(match[1]!) } catch { throw new Error('Owner代码Reviewer执行来源不是有效JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof (value as { executorCommandId?: unknown }).executorCommandId !== 'string'
    || typeof (value as { executorExecutionId?: unknown }).executorExecutionId !== 'string') throw new Error('Owner代码Reviewer执行来源字段无效')
  return { reference: match[0], executorCommandId: (value as { executorCommandId: string }).executorCommandId, executorExecutionId: (value as { executorExecutionId: string }).executorExecutionId }
}

export function hydrateOwnerDevelopmentReviewerPrompt(prompt: string, reference: string, artifact: OwnerDevelopmentReviewArtifact): string {
  const parsedReference = ownerDevelopmentArtifactReferenceFromPrompt(prompt)
  const serializedArtifact = JSON.stringify(artifact)
  if (!/^[a-f0-9]{64}$/.test(artifact.contentHash) || !artifact.content.trim()
    || Buffer.byteLength(artifact.content, 'utf8') > 512 * 1024 || prompt.split(reference).length !== 2
    || parsedReference?.reference !== reference || parsedReference.executorCommandId !== artifact.executorCommandId
    || parsedReference.executorExecutionId !== artifact.executorExecutionId
    || Buffer.byteLength(serializedArtifact, 'utf8') > 512 * 1024
    || !Array.isArray(artifact.validationEvidence) || artifact.validationEvidence.length > 12
    || artifact.validationEvidence.some(item => !isOwnerDevelopmentValidationArtifact(item))) {
    throw new Error('Owner代码Reviewer提示与冻结快照绑定无效')
  }
  const untrusted = `<untrusted-owner-development-snapshot>${serializedArtifact.replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}</untrusted-owner-development-snapshot>`
  return prompt.replace(reference, untrusted).replaceAll('OWNER_DEVELOPMENT_SNAPSHOT_HASH', artifact.contentHash)
}

export function ownerDevelopmentArtifactFromPrompt(prompt: string): OwnerDevelopmentReviewArtifact | null {
  const match = prompt.match(/<untrusted-owner-development-snapshot>([\s\S]*?)<\/untrusted-owner-development-snapshot>/)
  if (!match) return null
  let value: unknown
  try { value = JSON.parse(match[1]!) } catch { throw new Error('Owner代码Reviewer提示中的冻结快照不是有效JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Owner代码Reviewer快照结构无效')
  const artifact = value as Partial<OwnerDevelopmentReviewArtifact>
  if (typeof artifact.executorCommandId !== 'string' || typeof artifact.executorExecutionId !== 'string'
    || typeof artifact.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.contentHash)
    || typeof artifact.content !== 'string' || !artifact.content.trim() || Buffer.byteLength(artifact.content, 'utf8') > 512 * 1024) {
    throw new Error('Owner代码Reviewer快照绑定或大小无效')
  }
  if (artifact.validationEvidence !== undefined && (!Array.isArray(artifact.validationEvidence)
    || artifact.validationEvidence.length > 12 || artifact.validationEvidence.some(item => !isOwnerDevelopmentValidationArtifact(item)))) {
    throw new Error('Owner代码Reviewer验证证据结构无效')
  }
  return artifact as OwnerDevelopmentReviewArtifact
}

export function isOwnerDevelopmentValidationArtifact(value: unknown): value is OwnerDevelopmentValidationArtifact {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const allowed = ['command', 'validationId', 'attemptState', 'freshness', 'status', 'exitCode', 'timedOut', 'outputTail', 'outputTruncated', 'rawOutputSha256', 'rawOutputByteLength', 'finishedAt', 'expired']
  if (Object.keys(row).some(key => !allowed.includes(key)) || typeof row.command !== 'string' || !row.command.trim()
    || typeof row.validationId !== 'string' || !/^val-[a-f0-9]{64}$/.test(row.validationId)
    || !['missing', 'running', 'completed'].includes(String(row.attemptState))) return false
  if (row.freshness !== undefined && !['fresh', 'stale', 'legacy', 'unknown'].includes(String(row.freshness))) return false
  if (row.status !== undefined && !['passed', 'failed', 'stale', 'timeout'].includes(String(row.status))) return false
  if (row.exitCode !== undefined && row.exitCode !== null && (!Number.isSafeInteger(row.exitCode) || (row.exitCode as number) < 0)) return false
  if (row.timedOut !== undefined && typeof row.timedOut !== 'boolean') return false
  if (row.outputTail !== undefined && (typeof row.outputTail !== 'string' || row.outputTail.length > DEVELOPMENT_VALIDATION_OUTPUT_TAIL_CHARS)) return false
  if (row.outputTruncated !== undefined && typeof row.outputTruncated !== 'boolean') return false
  if ((row.rawOutputSha256 === undefined) !== (row.rawOutputByteLength === undefined)
    || row.rawOutputSha256 !== undefined && (typeof row.rawOutputSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.rawOutputSha256)
      || !Number.isSafeInteger(row.rawOutputByteLength) || (row.rawOutputByteLength as number) < 0)) return false
  if (row.finishedAt !== undefined && (!Number.isSafeInteger(row.finishedAt) || (row.finishedAt as number) < 0)) return false
  if (row.expired !== undefined && typeof row.expired !== 'boolean') return false
  if (row.attemptState === 'completed' && (!row.status || row.exitCode === undefined || row.timedOut === undefined
    || row.outputTail === undefined || row.outputTruncated === undefined || !row.freshness)) return false
  return true
}

/**
 * Owner研发Executor完成时冻结同一执行产生的代码变更。
 * 不创建人类ProjectChain交付，也不把快照声明为已评审或已验收。
 */
export async function freezeOwnerDevelopmentArtifact(commandId: string, executionId: string): Promise<DevelopmentSnapshot | null> {
  const database = store.getProjectDb()
  const command = database.prepare('SELECT project_id, source_task_id, source_step_link_id, role, state, execution_id FROM project_owner_execution_commands WHERE id=?').get(commandId) as {
    project_id: string; source_task_id: string; source_step_link_id: string; role: string; state: string; execution_id: string | null
  } | undefined
  const execution = store.getAgentExecution(executionId)
  if (!command || command.role !== 'executor' || command.state !== 'running' || command.execution_id !== executionId
    || !execution || execution.ownerCommandId !== commandId || execution.status !== 'running'
    || execution.projectId !== command.project_id || execution.entityType !== 'task' || execution.entityId !== command.source_task_id
    || !execution.sessionId || execution.sessionId.startsWith('workflow:')) throw new Error('Owner代码快照的命令与执行归属无法核验')

  const { source } = readOwnerCommandFrozenSource(commandId)
  const frozenTask = source.tasks.find(item => item.taskId === command.source_task_id)
  if (source.executionKind !== 'development') return null
  if (!frozenTask?.developmentScope) throw new Error('Owner研发执行缺少冻结任务范围')
  if (frozenTask.linkId !== command.source_step_link_id || !source.workspaceId) throw new Error('Owner研发快照缺少冻结步骤或工作区来源')
  const task = store.getTask(command.source_task_id)
  if (!task || task.projectId !== command.project_id || task.ownerStepLinkId !== frozenTask.linkId
    || !task.developmentScope || ownerExecutionHash(task.developmentScope) !== ownerExecutionHash(frozenTask.developmentScope)) {
    throw new Error('Owner研发任务范围与冻结执行来源不一致')
  }

  const meta = getAgentSessionMeta(execution.sessionId)
  const workspace = meta?.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
  if (!workspace?.rootPath || workspace.id !== source.workspaceId || workspace.id !== frozenTask.developmentScope.workspaceId
    || task.workspaceId !== workspace.id) throw new Error('Owner研发快照工作区与冻结任务不匹配')
  const scope = validateDevelopmentScope(frozenTask.developmentScope, { getWorkspace: getAgentWorkspace })
  const sessionDirectory = getAgentSessionWorkspacePath(workspace.slug, execution.sessionId)
  const worktreePath = resolveDevelopmentWorktree(workspace.rootPath, sessionDirectory)
  if (!worktreePath) throw new Error('Owner研发快照缺少会话专属worktree')

  const manifestPath = join(sessionDirectory, `development-snapshot-${executionId}.json`)
  let snapshot: DevelopmentSnapshot
  try {
    const stat = await lstat(manifestPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('Owner研发快照清单不是合法私有文件')
    snapshot = await loadDevelopmentSnapshotAsync(sessionDirectory, executionId)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    snapshot = await createDevelopmentSnapshotAsync({ worktreePath, sessionDirectory, executionId, workspaceId: workspace.id, scope })
  }
  if (snapshot.executionId !== executionId || snapshot.workspaceId !== workspace.id
    || !await developmentWorktreeMatchesSnapshotAsync(worktreePath, snapshot, scope)) {
    throw new Error('Owner研发快照与当前冻结范围或worktree不一致；保留原快照并停止交接')
  }
  return snapshot
}

/** 独立Reviewer读取精确Executor快照；正文是非可信数据，超限整份阻断而不截断。 */
export async function readOwnerDevelopmentArtifactForReview(reviewerCommandId: string): Promise<OwnerDevelopmentReviewArtifact | null> {
  const database = store.getProjectDb()
  const reviewer = database.prepare(`SELECT id, project_id, grant_id, source_task_id, source_step_link_id, source_hash,
      rework_ordinal, role, state, execution_id FROM project_owner_execution_commands WHERE id=?`).get(reviewerCommandId) as {
    id: string; project_id: string; grant_id: string; source_task_id: string; source_step_link_id: string; source_hash: string
    rework_ordinal: number; role: string; state: string; execution_id: string | null
  } | undefined
  if (!reviewer || reviewer.role !== 'reviewer' || reviewer.state !== 'running' || !reviewer.execution_id) throw new Error('Owner代码Reviewer命令来源无效')
  const { source } = readOwnerCommandFrozenSource(reviewerCommandId)
  if (source.executionKind !== 'development') return null
  const executors = database.prepare(`SELECT c.id, c.execution_id, c.source_hash, c.state, c.actual_cost_micros, c.usage_evidence,
      c.usage_record_key, e.status AS execution_status, e.owner_command_id, e.session_id
    FROM project_owner_execution_commands c JOIN agent_executions e ON e.id=c.execution_id
    WHERE c.project_id=? AND c.grant_id=? AND c.source_task_id=? AND c.source_step_link_id=?
      AND c.role='executor' AND c.rework_ordinal=?`).all(
    reviewer.project_id, reviewer.grant_id, reviewer.source_task_id, reviewer.source_step_link_id, reviewer.rework_ordinal,
  ) as Array<{ id: string; execution_id: string | null; source_hash: string; state: string; actual_cost_micros: number | null
    usage_evidence: string | null; usage_record_key: string | null; execution_status: string; owner_command_id: string | null; session_id: string | null }>
  const executor = executors[0]
  if (executors.length !== 1 || !executor?.execution_id || executor.source_hash !== reviewer.source_hash
    || executor.state !== 'settled' || executor.actual_cost_micros === null || !executor.usage_record_key
    || executor.execution_status !== 'completed' || executor.owner_command_id !== executor.id || !executor.session_id) {
    throw new Error('Owner代码Reviewer对应Executor执行或费用无法核验')
  }
  try {
    const usage = JSON.parse(executor.usage_evidence ?? 'null') as { source?: unknown }
    if (!usage || usage.source === 'unknown') throw new Error('Owner代码Executor用量仍未知')
  } catch { throw new Error('Owner代码Executor用量证据无效') }

  const frozenTask = source.tasks.find(item => item.taskId === reviewer.source_task_id)
  const task = store.getTask(reviewer.source_task_id)
  const execution = store.getAgentExecution(executor.execution_id)
  if (!frozenTask?.developmentScope || frozenTask.linkId !== reviewer.source_step_link_id || !source.workspaceId
    || !task || task.projectId !== reviewer.project_id || task.ownerStepLinkId !== frozenTask.linkId || !task.developmentScope
    || ownerExecutionHash(task.developmentScope) !== ownerExecutionHash(frozenTask.developmentScope)
    || !execution || execution.sessionId !== executor.session_id || execution.ownerCommandId !== executor.id) {
    throw new Error('Owner代码Reviewer的冻结任务或Executor身份已变化')
  }
  const meta = getAgentSessionMeta(execution.sessionId)
  const workspace = meta?.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
  if (!workspace?.rootPath || workspace.id !== source.workspaceId || workspace.id !== frozenTask.developmentScope.workspaceId
    || task.workspaceId !== workspace.id) throw new Error('Owner代码Reviewer工作区与冻结来源不匹配')
  const scope = validateDevelopmentScope(frozenTask.developmentScope, { getWorkspace: getAgentWorkspace })
  const sessionDirectory = getAgentSessionWorkspacePath(workspace.slug, execution.sessionId)
  const worktreePath = resolveDevelopmentWorktree(workspace.rootPath, sessionDirectory)
  if (!worktreePath) throw new Error('Owner代码Reviewer缺少Executor会话worktree')
  const snapshot = await loadDevelopmentSnapshotAsync(sessionDirectory, execution.id)
  if (snapshot.workspaceId !== workspace.id || !await developmentWorktreeMatchesSnapshotAsync(worktreePath, snapshot, scope)) {
    throw new Error('Owner代码Reviewer快照与当前冻结范围/worktree不一致')
  }
  const files = await readDevelopmentSnapshotContentsAsync(sessionDirectory, execution.id)
  const content = JSON.stringify({ executionId: execution.id, workspaceId: workspace.id, baseCommit: snapshot.baseCommit, contentHash: snapshot.contentHash, files })
  if (Buffer.byteLength(content, 'utf8') > 512 * 1024) throw new Error('Owner代码快照超过Reviewer完整输入上限；未截断或启动评审')
  const validationEvidence = (frozenTask.developmentScope.verificationCommands ?? []).map(command => {
    const validationId = ownerDevelopmentValidationId(executor.id, command, snapshot.contentHash)
    const attempt = readOwnerDevelopmentValidationAttempt(sessionDirectory, validationId)
    if (!attempt) return { command, validationId, attemptState: 'missing' as const }
    if (attempt.ownerCommandId !== executor.id || attempt.taskId !== task.id || attempt.executionId !== execution.id
      || attempt.projectId !== reviewer.project_id || attempt.grantId !== reviewer.grant_id
      || attempt.stepLinkId !== reviewer.source_step_link_id || attempt.sourceHash !== reviewer.source_hash
      || attempt.workspaceId !== workspace.id || attempt.snapshotContentHash !== snapshot.contentHash
      || attempt.verificationConfigHash.length !== 64 || attempt.command !== command) {
      throw new Error('Owner研发验证尝试与Reviewer冻结来源不匹配')
    }
    if (attempt.state !== 'completed') return { command, validationId, attemptState: 'running' as const, freshness: 'unknown' as const }
    try {
      const evidence = readDevelopmentValidationEvidence(task.id, execution.id, validationId)
      const result = evidence.result
      return {
        command, validationId, attemptState: 'completed' as const, freshness: evidence.freshness,
        status: result.status, exitCode: result.exitCode, timedOut: result.timedOut,
        outputTail: result.outputTail, outputTruncated: result.outputTruncated,
        ...(result.rawOutputSha256 === undefined ? {} : { rawOutputSha256: result.rawOutputSha256 }),
        ...(result.rawOutputByteLength === undefined ? {} : { rawOutputByteLength: result.rawOutputByteLength }),
        finishedAt: result.finishedAt,
        expired: Date.now() - result.finishedAt > DEVELOPMENT_VALIDATION_EVIDENCE_VALIDITY_MS,
      }
    } catch {
      return { command, validationId, attemptState: 'completed' as const, freshness: 'unknown' as const,
        status: 'stale' as const, exitCode: null, timedOut: false, outputTail: '', outputTruncated: true }
    }
  })
  const artifact = { executorCommandId: executor.id, executorExecutionId: execution.id, contentHash: snapshot.contentHash, content, validationEvidence }
  if (Buffer.byteLength(JSON.stringify(artifact), 'utf8') > 512 * 1024) throw new Error('Owner代码快照及验证回执超过Reviewer完整输入上限；未截断或启动评审')
  return artifact
}
