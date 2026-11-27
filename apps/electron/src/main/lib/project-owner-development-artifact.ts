import { OWNER_DEVELOPMENT_EVIDENCE_HINT_MARKER, ownerDevelopmentEvidenceHint } from './project-owner-evidence-reference'
import { lstat, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DevelopmentSnapshot, DevelopmentTaskScope, ProjectOwnerPlanDraft } from '@gravitas/shared'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getAgentSessionMeta } from './agent-session-manager'
import { getAgentSessionWorkspacePath } from './config-paths'
import { resolveDevelopmentWorktree } from './agent-development-worktree'
import { createDevelopmentSnapshotAsync, developmentWorktreeMatchesSnapshotAsync, loadDevelopmentSnapshot, loadDevelopmentSnapshotAsync, readDevelopmentSnapshotContentsAsync, type DevelopmentSnapshotScope } from './development-snapshot-service'
import { isProtectedDevelopmentPath, normalizeRepoRelativePath, pathWithinAllowed, validateDevelopmentScope } from './development-task-service'
import { applyOwnerDevelopmentSnapshot, mergeOwnerDevelopmentSnapshots, type OwnerDevelopmentHandoffInput } from './project-owner-development-handoff'
import { readFailedDevelopmentHandoff, resolveMixedBatchHandoffTarget } from './project-owner-development-recovery'
import type { AcceptedArtifact } from './project-owner-accepted-artifact'
import { ownerTaskDeliveryKind, readOwnerCommandFrozenSource } from './project-owner-employee-runtime'
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
  const hint = prompt.includes(OWNER_DEVELOPMENT_EVIDENCE_HINT_MARKER)
    ? ownerDevelopmentEvidenceHint(artifact.content, artifact.validationEvidence) : ''
  return prompt.replace(reference, () => hint ? `${hint.trimStart()}\n${untrusted}` : untrusted)
    .replaceAll('OWNER_DEVELOPMENT_SNAPSHOT_HASH', artifact.contentHash)
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
  if (ownerTaskDeliveryKind(source, command.source_task_id) !== 'development') return null
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
  const scope = ownerDevelopmentSnapshotScope(validateDevelopmentScope(frozenTask.developmentScope, { getWorkspace: getAgentWorkspace }), commandId)
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
  if (ownerTaskDeliveryKind(source, reviewer.source_task_id) !== 'development') return null
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
  const scope = ownerDevelopmentSnapshotScope(validateDevelopmentScope(frozenTask.developmentScope, { getWorkspace: getAgentWorkspace }), executor.id)
  const sessionDirectory = getAgentSessionWorkspacePath(workspace.slug, execution.sessionId)
  const worktreePath = resolveDevelopmentWorktree(workspace.rootPath, sessionDirectory)
  if (!worktreePath) throw new Error('Owner代码Reviewer缺少Executor会话worktree')
  const snapshot = await loadDevelopmentSnapshotAsync(sessionDirectory, execution.id)
  if (snapshot.workspaceId !== workspace.id || !await developmentWorktreeMatchesSnapshotAsync(worktreePath, snapshot, scope)) {
    throw new Error('Owner代码Reviewer快照与当前冻结范围/worktree不一致')
  }
  const revalidation = (require('./owner-quality-revalidation-smoke') as typeof import('./owner-quality-revalidation-smoke')).readOwnerQualityRevalidationSmokePermit({ projectId: reviewer.project_id, taskId: reviewer.source_task_id, grantId: reviewer.grant_id, reworkOrdinal: reviewer.rework_ordinal })
  if (revalidation && snapshot.contentHash !== revalidation.artifactHash) throw new Error('Owner复验成果哈希已变化，禁止启动独立评审')
  const files = await readDevelopmentSnapshotContentsAsync(sessionDirectory, execution.id)
  const content = JSON.stringify({ executionId: execution.id, workspaceId: workspace.id, baseCommit: snapshot.baseCommit, contentHash: snapshot.contentHash, files })
  if (Buffer.byteLength(content, 'utf8') > 512 * 1024) throw new Error('Owner代码快照超过Reviewer完整输入上限；未截断或启动评审')
  const { readOwnerDocumentReviewValidation } = require('./project-owner-document-review-retry') as typeof import('./project-owner-document-review-retry')
  const documentValidation = readOwnerDocumentReviewValidation(reviewerCommandId, executor.id, snapshot.contentHash)
  const validationEvidence = documentValidation ? [documentValidation] : (frozenTask.developmentScope.verificationCommands ?? []).map(command => {
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


function readOwnerDevelopmentRevisionSource(source: Pick<ReturnType<typeof readOwnerCommandFrozenSource>['source'], 'projectId' | 'taskId' | 'planRevision' | 'planFingerprint'>, workspaceId: string) {
  const { readOwnerPriorDelivery } = require('./project-owner-execution-command') as typeof import('./project-owner-execution-command')
  const prior = readOwnerPriorDelivery(source, true)
  if (!prior?.development) return undefined
  const { item, message } = prior
  // readOwnerPriorDelivery 已核验代码正文及全部文件哈希；再核对原交付在账本中的身份。
  const delivered = JSON.parse(item.content) as { executionId: string; workspaceId: string; baseCommit: string; contentHash: string; files: OwnerDevelopmentHandoffInput['files'] }
  const original = store.getAgentExecution(delivered.executionId)
  const originalCommand = original?.ownerCommandId
    ? store.getProjectDb().prepare(`SELECT c.grant_id,g.owner_management_delegation_id FROM project_owner_execution_commands c
      JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
      WHERE c.id=? AND c.execution_id=? AND c.project_id=? AND c.role='executor' AND c.state='settled'`)
      .get(original.ownerCommandId, original.id, source.projectId) as { grant_id: string; owner_management_delegation_id: string | null } | undefined
    : undefined
  if (!original || !originalCommand || original.status !== 'completed' || !original.sessionId
    || delivered.workspaceId !== workspaceId || !message.delivery
    || message.eventId !== `owner-delivery:${originalCommand.grant_id}:${ownerExecutionHash(message.delivery)}`) throw new Error('Owner研发修订缺少可核验的原交付执行或工作区')
  const { listOwnerTechnicalReviewEvidence } = require('./project-owner-technical-review') as typeof import('./project-owner-technical-review')
  const { readOwnerQualityAction } = require('./project-owner-quality-actions') as typeof import('./project-owner-quality-actions')
  const accepted = listOwnerTechnicalReviewEvidence(source.projectId, original.entityId).some(review =>
    review.grantId === originalCommand.grant_id && review.executorCommandId === original.ownerCommandId
      && review.executorExecutionId === original.id && review.artifactHash === item.artifactHash
      && review.verdict === 'approved' && review.artifactVerified && review.validationEvidenceVerified
      && readOwnerQualityAction(review.reviewerCommandId)?.state === 'accepted')
  if (!accepted) throw new Error('Owner研发修订引用的源码未通过原批次验收')
  return { item, delivered, original, delegationId: originalCommand.owner_management_delegation_id }
}

/** 从用户明确限定路径的反馈和原验收账本读取修订上限。禁止从模型的范围说明提取权限。 */
export function readOwnerDevelopmentRevisionLimit(plan: ProjectOwnerPlanDraft, workspaceId: string, requireLatestFeedback = false): { path: string; commands: string[]; onlyNarrowing: boolean; delegationId: string | null } | null {
  if (!plan.sourceRun || !plan.proposal.deliveryFeedbackAssessment || plan.proposal.steps.length !== 1
    || plan.proposal.steps[0]?.deliveryKind !== 'development') return null
  const { getOwnerPlanningRunReceipt } = require('./project-owner-planning-run-service') as typeof import('./project-owner-planning-run-service')
  const { readOwnerPlanningSnapshot } = require('./project-owner-planning-source') as typeof import('./project-owner-planning-source')
  const receipt = getOwnerPlanningRunReceipt(plan.sourceRun.receiptId)
  const source = receipt && readOwnerPlanningSnapshot(receipt.planningTaskId, { allowUnknownPromptForHistory: true })
  const conversation = source?.context.conversation
  const feedback = conversation?.messages.find(item => item.role === 'user' && item.id === source?.link.conversationMessageId)
  if (!feedback) return null
  const matches = [...feedback.content.matchAll(/(?:^|[。！？；\n])\s*(?:此次|本次|本轮)?目标路径和允许修改路径(?:只能|仅能|均)是\s*([A-Za-z0-9_./-]+)(?=\s*(?:[。！？；\n]|$))/g)]
  if (matches.length > 1) throw new Error('Owner修订反馈包含多个明确路径上限')
  const text = matches[0] ? feedback.content.replace(matches[0][0], '。') : feedback.content
  const parts = text.split(/[。！？；\n]+/).map(value => value.trim()).filter(Boolean)
  const editPattern = /^(?:请)?(?:基于[^，]{1,48}，)?只(?:在\s*([A-Za-z0-9_./-]+)\s+[^，]{1,200}|(?:把|修改)\s*([A-Za-z0-9_./-]+)\s*(?:中|里的?|的)[^，]{1,200})$/
  const edits = parts.flatMap(sentence => {
    const match = editPattern.exec(sentence)
    return match ? [{ sentence, path: match[1] ?? match[2]! }] : []
  })
  const requestedPath = matches[0]?.[1] ?? (edits.length === 1 ? edits[0]?.path : undefined)
  if (!requestedPath) return null
  if (requireLatestFeedback) {
    const latest = store.getProjectDb().prepare("SELECT id FROM project_owner_management_messages WHERE project_id=? AND json_extract(payload, '$.taskId') IS ? AND json_extract(payload, '$.role')='user' ORDER BY rowid DESC LIMIT 1").get(plan.projectId, plan.taskId ?? null) as { id: string } | undefined
    if (latest?.id !== feedback.id) throw new Error('文件修订之后已收到新的用户反馈，先完成核对再启动')
  }
  const path = normalizeRepoRelativePath(requestedPath)
  if (isProtectedDevelopmentPath(path)) throw new Error('Owner修订反馈的目标涉及受保护文件')
  const { projectId, taskId, revision: planRevision, planFingerprint } = plan
  const prior = readOwnerDevelopmentRevisionSource({ projectId, taskId, planRevision, planFingerprint }, workspaceId)
  const commandId = prior?.original.ownerCommandId
  if (!prior || !commandId || !prior.delivered.files.some(entry => entry.file.path === path && entry.file.newSha256 !== null)) throw new Error('Owner修订指定的路径缺少同工作区已验收成果')
  const original = readOwnerCommandFrozenSource(commandId)
  const scope = original.source.tasks.find(item => item.taskId === original.taskId)?.developmentScope
  if (!scope || scope.workspaceId !== workspaceId || !pathWithinAllowed(path, scope.allowedPaths)
    || !scope.verificationCommands?.length) throw new Error('Owner修订指定的路径或验证不在原研发授权范围')
  const edit = edits.length === 1 ? edits[0] : undefined
  const otherFiles = prior.delivered.files.map(entry => entry.file.path).filter(file => file !== path)
  const onlyNarrowing = edit?.path === path && !otherFiles.some(file => edit.sentence.includes(file))
    && !/(?:发布|外发|联网|采购|费用|预算|资料|工作区|授权追加|同步|上传|发送|共享|通知|部署|推送|付款|飞书)/.test(parts.join('。'))
    && parts.filter(value => value !== edit.sentence).every(value =>
      /^(?:请)?在(?:当前|原)(?:已)?交付版本上(?:做一项修订|修改)$/.test(value)
      || /^其余.{1,180}(?:逐字保留|保持不变)(?:，[^。]{1,140}只作为只读资源参加浏览器验收)?$/.test(value)
      || /^保留[^，]{1,100}(?:，[^，]{1,140}(?:逐字节保持|逐字保留|保持不变))?$/.test(value)
      || /^(?:最终)?交付(?:原目录下)?[^，]{1,80}完整文件，并对[^，]{1,50}重新运行原(?:浏览器)?检查(?:，确认[^，]{1,100})?$/.test(value)
      || scope.verificationCommands?.some(command => value === `继续使用 ${command}` || value === `继续使用 ${command}，按原授权提交完整交付`)
      || /^(?:请)?(?:按原授权继续|在现有授权内推进)$/.test(value))
  return { path, commands: scope.verificationCommands, onlyNarrowing, delegationId: prior.delegationId }
}

/** 只读继承来自历史交付账本，不能据此扩大员工的路径权限。 */
export function ownerDevelopmentSnapshotScope(scope: DevelopmentTaskScope, commandId?: string): DevelopmentSnapshotScope {
  if (!commandId) return scope
  const { source, taskId } = readOwnerCommandFrozenSource(commandId)
  if (source.qualityManagementVersion !== 1) return scope
  const retained = readOwnerRetainedFiles(source, taskId)
  const revision = readOwnerDevelopmentRevisionSource(source, scope.workspaceId)
  if (!revision) return retained.size ? { ...scope, inheritedFiles: [...retained.values()] } : scope
  const priorDeliveryFiles = revision.delivered.files.map(entry => entry.file)
  for (const file of priorDeliveryFiles) if (!pathWithinAllowed(file.path, scope.allowedPaths)) retainOwnerFile(retained, file)
  let priorBrowserTargets: readonly string[] | undefined
  if (scope.verificationCommands?.some(command => command.startsWith('browser:'))
    && !scope.targetPaths.some(path => /\.html?$/i.test(path))) {
    const originalCommandId = revision.original.ownerCommandId!
    const original = readOwnerCommandFrozenSource(originalCommandId)
    const originalScope = original.source.tasks.find(item => item.taskId === original.taskId)?.developmentScope
    if (!originalScope || original.source.planRevision >= source.planRevision) throw new Error('Owner原浏览器验证入口无法核对')
    const html = originalScope.targetPaths.filter(path => /\.html?$/i.test(path))
    priorBrowserTargets = html.length ? html : ownerDevelopmentSnapshotScope(originalScope, originalCommandId).priorBrowserTargets
  }
  return { ...scope, priorDeliveryHash: revision.item.artifactHash, priorDeliveryFiles, priorBrowserTargets, ...(retained.size ? { inheritedFiles: [...retained.values()] } : {}) }
}

/** 同范围修订在私有工作树重放指定的已验收源码，仓库 HEAD 保持原样。 */
async function readOwnerDevelopmentRevision(source: ReturnType<typeof readOwnerCommandFrozenSource>['source'], workspace: { id: string; slug: string }): Promise<OwnerDevelopmentHandoffInput | undefined> {
  const revision = readOwnerDevelopmentRevisionSource(source, workspace.id)
  if (!revision) return undefined
  const { item, delivered, original } = revision
  const directory = getAgentSessionWorkspacePath(workspace.slug, original.sessionId)
  const snapshot = await loadDevelopmentSnapshotAsync(directory, original.id)
  const files = await readDevelopmentSnapshotContentsAsync(directory, original.id)
  if (snapshot.workspaceId !== workspace.id || snapshot.baseCommit !== delivered.baseCommit || snapshot.contentHash !== item.artifactHash
    || JSON.stringify(files) !== JSON.stringify(delivered.files)) throw new Error('Owner研发修订原快照与交付正文不一致')
  return { snapshot, files }
}

/** Owner返工创建新会话，只交接同授权上一轮的已冻结源码，不复用旧业务会话。 */
export async function seedOwnerDevelopmentRework(commandId: string, worktreePath: string): Promise<string | undefined> {
  const database = store.getProjectDb()
  const current = database.prepare("SELECT project_id,grant_id,source_task_id,source_step_link_id,source_hash,rework_ordinal,role,state,execution_id FROM project_owner_execution_commands WHERE id=?").get(commandId) as { project_id: string; grant_id: string; source_task_id: string; source_step_link_id: string; source_hash: string; rework_ordinal: number; role: string; state: string; execution_id: string } | undefined
  if (!current || current.state !== 'queued') throw new Error('Owner返工命令尚未处于可准备状态')
  if (current.role !== 'executor' || current.rework_ordinal === 0) return undefined
  const prior = database.prepare(`SELECT c.id,c.execution_id,c.state,c.actual_cost_micros,c.usage_evidence,e.status,e.session_id
    FROM project_owner_execution_commands c JOIN agent_executions e ON e.id=c.execution_id AND e.owner_command_id=c.id
    WHERE c.grant_id=? AND c.source_task_id=? AND c.source_step_link_id=? AND c.source_hash=? AND c.role='executor' AND c.rework_ordinal=?`).all(
    current.grant_id,current.source_task_id,current.source_step_link_id,current.source_hash,current.rework_ordinal-1,
  ) as Array<{ id: string; execution_id: string; state: string; actual_cost_micros: number | null; usage_evidence: string | null; status: string; session_id: string }>
  const previous = prior[0]
  const action = database.prepare("SELECT reviewer_command_id FROM project_owner_quality_actions WHERE grant_id=? AND task_id=? AND json_extract(payload,'$.reworkOrdinal')=? ORDER BY created_at DESC LIMIT 1").get(current.grant_id,current.source_task_id,current.rework_ordinal-1) as { reviewer_command_id: string } | undefined
  const decision = action ? (require('./project-owner-quality-actions') as typeof import('./project-owner-quality-actions')).readOwnerQualityAction(action.reviewer_command_id) : null
  const revalidation = (require('./owner-quality-revalidation-smoke') as typeof import('./owner-quality-revalidation-smoke')).readOwnerQualityRevalidationSmokePermit({ projectId: current.project_id, taskId: current.source_task_id, grantId: current.grant_id, reworkOrdinal: current.rework_ordinal })
  if (prior.length !== 1 || !previous || previous.state !== 'settled' || previous.status !== 'completed' || previous.actual_cost_micros === null
    || !previous.usage_evidence || JSON.parse(previous.usage_evidence).source === 'unknown' || decision?.state !== 'rework_authorized' && !revalidation) throw new Error('Owner返工缺少上一轮准确成果、已知费用或质量授权')
  const { source } = readOwnerCommandFrozenSource(commandId)
  const task = source.tasks.find(item => item.taskId === current.source_task_id)
  const workspace = source.workspaceId ? getAgentWorkspace(source.workspaceId) : undefined
  if (!task?.developmentScope || !workspace?.rootPath) throw new Error('Owner返工缺少冻结研发范围')
  const targetDirectory = dirname(worktreePath), targetBinding = JSON.parse(await readFile(join(targetDirectory,'development-worktree.json'),'utf8')) as { branch?: string }
  const execution = store.getAgentExecution(current.execution_id)
  if (execution?.ownerCommandId !== commandId || execution.status !== 'queued' || execution.sessionId !== '' || targetBinding.branch !== `employee/${current.execution_id}` || resolveDevelopmentWorktree(workspace.rootPath,targetDirectory) !== worktreePath) throw new Error('Owner返工目标不是本次未认领执行的独立worktree')
  const previousDirectory = getAgentSessionWorkspacePath(workspace.slug, previous.session_id)
  const previousPath = resolveDevelopmentWorktree(workspace.rootPath, previousDirectory)
  const snapshot = await loadDevelopmentSnapshotAsync(previousDirectory, previous.execution_id)
  const scope = ownerDevelopmentSnapshotScope(validateDevelopmentScope(task.developmentScope, { getWorkspace: getAgentWorkspace }), commandId)
  if (!previousPath || snapshot.workspaceId !== workspace.id || !await developmentWorktreeMatchesSnapshotAsync(previousPath,snapshot,scope)) throw new Error('Owner返工上一轮worktree与冻结快照不一致')
  if (revalidation && snapshot.contentHash !== revalidation.artifactHash) throw new Error('Owner复验交接前的原成果哈希已变化')
  const files = await readDevelopmentSnapshotContentsAsync(previousDirectory,previous.execution_id)
  applyOwnerDevelopmentSnapshot(worktreePath, targetDirectory, snapshot, files, [...scope.allowedPaths, ...scope.inheritedFiles?.map(file => file.path) ?? []])
  return previous.execution_id
}

type FrozenDevelopmentSource = ReturnType<typeof readOwnerCommandFrozenSource>['source']

function ownerPredecessorIds(source: FrozenDevelopmentSource, taskId: string): Set<string> {
  const tasks = new Map(source.tasks.map(task => [task.taskId, task]))
  const retained = new Map(source.retainedSteps?.map(step => [step.taskId, step]))
  const predecessors = new Set<string>()
  const visit = (id: string): void => {
    const task = tasks.get(id)
    const key = task?.stepKey ?? retained.get(id)?.stepKey
    if (!key) throw new Error('Owner代码交接依赖不在冻结任务中')
    const upstreamIds = task?.dependencies.filter(edge => edge.taskId === id).map(edge => edge.dependsOnTaskId) ?? []
    for (const step of retained.values()) if (step.dependedOnBy.includes(key)) upstreamIds.push(step.taskId)
    for (const upstreamId of upstreamIds) {
      if (upstreamId === taskId) throw new Error('Owner代码交接存在循环依赖')
      if (predecessors.has(upstreamId)) continue
      predecessors.add(upstreamId)
      visit(upstreamId)
    }
  }
  visit(taskId)
  return predecessors
}

function readRetainedDevelopmentPredecessors(source: FrozenDevelopmentSource, ancestors: Set<string>) {
  const { readLatestAcceptedArtifact } = require('./project-owner-accepted-artifact') as typeof import('./project-owner-accepted-artifact')
  const retained = new Map<string, { source: FrozenDevelopmentSource; accepted: AcceptedArtifact }>()
  for (const step of source.retainedSteps ?? []) {
    if (!ancestors.has(step.taskId)) continue
    const accepted = readLatestAcceptedArtifact(source.projectId, step.taskId)
    const task = store.getTask(step.taskId)
    if (!accepted || accepted.artifactHash !== step.artifactHash || task?.ownerStepLinkId !== accepted.stepLinkId) throw new Error('Owner保留步骤的已验收成果已变化或不可核验')
    const original = readOwnerCommandFrozenSource(accepted.executorCommandId)
    if (original.taskId !== step.taskId || original.source.taskId !== source.taskId || original.source.projectId !== source.projectId
      || original.source.workspaceId !== source.workspaceId || original.source.tasks.find(item => item.taskId === step.taskId)?.linkId !== accepted.stepLinkId) throw new Error('Owner保留步骤的原授权或工作区不一致')
    if (ownerTaskDeliveryKind(original.source, step.taskId) === 'development') retained.set(step.taskId, { source: original.source, accepted })
  }
  return retained
}

type RetainedFile = DevelopmentSnapshot['files'][number]

function retainOwnerFile(files: Map<string, RetainedFile>, file: RetainedFile): void {
  const previous = files.get(file.path)
  if (previous && (previous.oldSha256 !== file.oldSha256 || previous.newSha256 !== file.newSha256)) throw new Error(`Owner保留步骤的已验收文件版本冲突：${file.path}`)
  files.set(file.path, file)
}

/** 接替执行可以读取已验收文件；所有交付和验证都必须保留其原版内容。 */
function readOwnerRetainedFiles(source: FrozenDevelopmentSource, taskId: string): Map<string, RetainedFile> {
  const files = new Map<string, RetainedFile>()
  if (!source.retainedSteps?.length) return files
  const retained = readRetainedDevelopmentPredecessors(source, ownerPredecessorIds(source, taskId))
  const included = new Set([...retained].flatMap(([id, previous]) => [...ownerPredecessorIds(previous.source, id)]))
  for (const [id, previous] of retained) {
    if (included.has(id)) continue
    const workspace = getAgentWorkspace(source.workspaceId)
    const command = store.getProjectDb().prepare('SELECT execution_id FROM project_owner_execution_commands WHERE id=?').get(previous.accepted.executorCommandId) as { execution_id: string } | undefined
    const execution = command && store.getAgentExecution(command.execution_id)
    if (!workspace || execution?.ownerCommandId !== previous.accepted.executorCommandId || execution.status !== 'completed' || !execution.sessionId) throw new Error('Owner保留代码缺少已完成的执行或工作区')
    const snapshot = loadDevelopmentSnapshot(getAgentSessionWorkspacePath(workspace.slug, execution.sessionId), execution.id)
    if (snapshot.workspaceId !== workspace.id || snapshot.contentHash !== previous.accepted.artifactHash) throw new Error('Owner保留代码快照与原验收版本不一致')
    for (const file of snapshot.files) retainOwnerFile(files, file)
  }
  return files
}

/** 后继研发步骤继承已验收的上游快照，始终创建独立会话与worktree。 */
export async function seedOwnerDevelopmentBaseline(commandId: string, worktreePath: string): Promise<string | undefined> {
  const database = store.getProjectDb()
  const command = database.prepare('SELECT project_id,grant_id,source_task_id,source_hash,rework_ordinal,role,state,execution_id FROM project_owner_execution_commands WHERE id=?').get(commandId) as { project_id: string; grant_id: string; source_task_id: string; source_hash: string; rework_ordinal: number; role: string; state: string; execution_id: string } | undefined
  if (!command || command.state !== 'queued') throw new Error('Owner代码交接命令尚未处于可准备状态')
  if (command.role !== 'executor' || command.rework_ordinal !== 0) return undefined
  const { source } = readOwnerCommandFrozenSource(commandId)
  if (source.qualityManagementVersion !== 1 || ownerTaskDeliveryKind(source, command.source_task_id) !== 'development') return undefined
  const task = source.tasks.find(item => item.taskId === command.source_task_id)
  const workspace = getAgentWorkspace(source.workspaceId)
  if (!task?.developmentScope || !workspace?.rootPath) throw new Error('Owner代码交接缺少冻结研发任务或工作区')
  const ancestors = ownerPredecessorIds(source, command.source_task_id)
  const retained = readRetainedDevelopmentPredecessors(source, ancestors)
  const codeAncestors = [...ancestors].filter(id => retained.has(id)
    || source.tasks.some(task => task.taskId === id) && ownerTaskDeliveryKind(source, id) === 'development')
  // 是否已包含上游，以该快照当时冻结的依赖为准。新方案的边不能证明旧快照包含文件。
  const included = new Set(codeAncestors.flatMap(id => [...ownerPredecessorIds(retained.get(id)?.source ?? source, id)]))
  const tips = codeAncestors.filter(id => !included.has(id))
  if (codeAncestors.length && !tips.length) throw new Error('Owner代码依赖缺少可核验的上游版本')
  const targetDirectory = dirname(worktreePath)
  const targetBinding = JSON.parse(await readFile(join(targetDirectory, 'development-worktree.json'), 'utf8')) as { branch?: string }
  const targetExecution = store.getAgentExecution(command.execution_id)
  if (targetExecution?.ownerCommandId !== commandId || targetExecution.status !== 'queued' || targetExecution.sessionId !== ''
    || targetBinding.branch !== `employee/${command.execution_id}` || resolveDevelopmentWorktree(workspace.rootPath, targetDirectory) !== worktreePath) throw new Error('Owner代码交接目标工作树来源不一致')
  const targetScope = validateDevelopmentScope(task.developmentScope, { getWorkspace: getAgentWorkspace })
  if (!tips.length) {
    const revision = await readOwnerDevelopmentRevision(source, workspace)
    if (revision) {
      applyOwnerDevelopmentSnapshot(worktreePath, targetDirectory, revision.snapshot, revision.files, [...targetScope.allowedPaths, ...revision.snapshot.files.map(file => file.path)])
      return revision.snapshot.executionId
    }
  }
  const handoffs: OwnerDevelopmentHandoffInput[] = []
  const quality = require('./project-owner-quality-actions') as typeof import('./project-owner-quality-actions')
  const { listOwnerTechnicalReviewEvidence } = require('./project-owner-technical-review') as typeof import('./project-owner-technical-review')
  for (const tip of tips) {
    const previous = retained.get(tip)
    const predecessor = (previous?.source ?? source).tasks.find(item => item.taskId === tip)!
    const current = previous ? undefined : database.prepare('SELECT reviewer_command_id FROM project_owner_quality_actions WHERE project_id=? AND grant_id=? AND task_id=? ORDER BY rowid DESC LIMIT 1').get(command.project_id, command.grant_id, tip) as { reviewer_command_id: string } | undefined
    const reviewerCommandId = previous?.accepted.reviewerCommandId ?? current?.reviewer_command_id
    const decision = reviewerCommandId ? quality.readOwnerQualityAction(reviewerCommandId) : null
    const artifact = reviewerCommandId ? quality.readOwnerQualityArtifact(reviewerCommandId) : null
    const review = reviewerCommandId && listOwnerTechnicalReviewEvidence(command.project_id, tip, [reviewerCommandId]).find(item => item.reviewerCommandId === reviewerCommandId)
    if (!decision || decision.state !== 'accepted' || !artifact || artifact.contentHash !== decision.artifactHash || artifact.stepLinkId !== predecessor.linkId
      || !review || review.verdict !== 'approved' || !review.artifactVerified || !review.validationEvidenceVerified || review.artifactHash !== artifact.contentHash
      || artifact.grantId !== decision.grantId || review.grantId !== decision.grantId
      || (previous ? previous.accepted.executorCommandId !== review.executorCommandId || previous.accepted.artifactHash !== artifact.contentHash : decision.grantId !== command.grant_id)) throw new Error('Owner代码上游缺少准确验收、独立评审或验证证据')
    const upstream = database.prepare("SELECT id,execution_id,state,actual_cost_micros,usage_evidence,source_hash FROM project_owner_execution_commands WHERE id=? AND project_id=? AND grant_id=? AND source_task_id=? AND source_step_link_id=? AND role='executor' AND rework_ordinal=?").get(review.executorCommandId, command.project_id, decision.grantId, tip, predecessor.linkId, decision.reworkOrdinal) as { id: string; execution_id: string; state: string; actual_cost_micros: number | null; usage_evidence: string | null; source_hash: string } | undefined
    const execution = upstream && store.getAgentExecution(upstream.execution_id)
    let knownUsage = false
    try { const usage = JSON.parse(upstream?.usage_evidence ?? 'null') as { source?: string } | null; knownUsage = Boolean(usage?.source && usage.source !== 'unknown') } catch { /* 用量无法核对时保留原记录。 */ }
    if (!upstream || upstream.state !== 'settled' || upstream.actual_cost_micros === null || upstream.source_hash !== artifact.sourceHash || upstream.source_hash !== review.sourceHash || !knownUsage
      || !execution || execution.ownerCommandId !== upstream.id || execution.status !== 'completed' || !execution.sessionId || execution.id !== review.executorExecutionId) throw new Error('Owner代码上游执行或费用无法核验')
    const previousDirectory = getAgentSessionWorkspacePath(workspace.slug, execution.sessionId)
    const previousPath = resolveDevelopmentWorktree(workspace.rootPath, previousDirectory)
    const snapshot = await loadDevelopmentSnapshotAsync(previousDirectory, execution.id)
    const priorScope = predecessor.developmentScope && ownerDevelopmentSnapshotScope(validateDevelopmentScope(predecessor.developmentScope, { getWorkspace: getAgentWorkspace }), upstream?.id)
    if (!priorScope || !previousPath || snapshot.workspaceId !== workspace.id || snapshot.contentHash !== artifact.contentHash
      || !await developmentWorktreeMatchesSnapshotAsync(previousPath, snapshot, priorScope)) throw new Error('Owner代码交接快照来源不一致')
    handoffs.push({ snapshot, files: await readDevelopmentSnapshotContentsAsync(previousDirectory, execution.id) })
  }
  const scope = ownerDevelopmentSnapshotScope(targetScope, commandId)
  const inherited = new Map(scope.inheritedFiles?.map(file => [file.path, file]))
  const allowedPaths = [...scope.allowedPaths, ...inherited.keys()]
  const failed = resolveMixedBatchHandoffTarget({
    projectId: command.project_id, taskId: command.source_task_id, currentWorkspace: workspace,
    lookupSessionWorkspaceId: sessionId => getAgentSessionMeta(sessionId)?.workspaceId,
    lookupWorkspace: getAgentWorkspace, resolveSessionDirectory: getAgentSessionWorkspacePath,
  })
  const partial = failed && await readFailedDevelopmentHandoff({
    ...failed, repository: workspace.rootPath, workspaceId: workspace.id, scope: { ...targetScope, allowedPaths },
  })
  if (partial?.handoff) handoffs.push(partial.handoff)
  if (retained.size) {
    const latest = readRetainedDevelopmentPredecessors(source, ancestors)
    if ([...retained].some(([id, previous]) => latest.get(id)?.accepted.ownerExecutionId !== previous.accepted.ownerExecutionId)) throw new Error('Owner保留代码在工作树准备期间发生变化')
  }
  if (handoffs.length) {
    const merged = mergeOwnerDevelopmentSnapshots(handoffs)
    const byPath = new Map(merged.snapshot.files.map(file => [file.path, file]))
    for (const [path, expected] of inherited) {
      const file = byPath.get(path)
      if (file?.oldSha256 !== expected.oldSha256 || file.newSha256 !== expected.newSha256) throw new Error(`Owner上游变更与只读继承文件冲突：${path}`)
    }
    applyOwnerDevelopmentSnapshot(worktreePath, targetDirectory, merged.snapshot, merged.files, allowedPaths)
  }
  if (failed && (partial?.handoff || partial?.worktreeMissing)) {
    const snapshot = partial.handoff?.snapshot
    store.recordProjectActivity({
      projectId: command.project_id, entityType: 'task', entityId: command.source_task_id, actor: 'system:owner-runtime',
      action: snapshot ? 'owner_development_handoff' : 'owner_development_handoff_missing',
      summary: snapshot ? `已接续上次失败工作树的 ${snapshot.files.length} 个文件改动。` : '上次失败的工作树已不存在，本次未接续失败现场。',
      payload: { commandId, failedExecutionId: failed.failedExecutionId, ...(snapshot
        ? { contentHash: snapshot.contentHash, files: snapshot.files.map(file => file.path) }
        : { failedWorktreePath: failed.failedWorktreePath }) },
    })
  }
  return handoffs.length === 1 ? handoffs[0]!.snapshot.executionId : undefined
}
