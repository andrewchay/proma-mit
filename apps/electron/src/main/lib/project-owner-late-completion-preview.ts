/** 恢复前只读核对迟到终态；调用本函数不会修改执行、费用、授权或文件。 */
import { getAgentSessionMeta, getAgentSessionSDKMessages } from './agent-session-manager'
import { getAgentWorkspace } from './agent-workspace-manager'
import { resolveDevelopmentWorktree } from './agent-development-worktree'
import { getConfigDir } from './config-paths'
import { join } from 'node:path'
import { lstatSync } from 'node:fs'
import { developmentWorktreeMatchesSnapshot, developmentWorktreeMatchesSnapshotAsync, loadDevelopmentSnapshot, loadDevelopmentSnapshotAsync } from './development-snapshot-service'
import { validateDevelopmentScope } from './development-task-service'
import { readOwnerCommandFrozenSource, readOwnerCommandRuntime } from './project-owner-employee-runtime'
import { assertOwnerDispatchManagementCurrent, readOwnerDispatchControl } from './project-owner-dispatch-control'
import { getOwnerExecutionRevalidation } from './project-owner-execution-revalidation'
import { ownerExecutionHash } from './project-owner-execution-hash'
import { buildOwnerLateCompletionEvidence, type OwnerLateCompletionEvidence, type OwnerLateRequestSettlement } from './project-owner-late-completion-evidence'
import * as store from './project-sqlite-store'

interface CandidateRow {
  commandId: string; projectId: string; grantId: string; taskId: string; stepLinkId: string
  executionId: string; sessionId: string; role: string; commandState: string; executionStatus: string
  usageEvidence: string | null; usageRecordKey: string | null; actualCostMicros: number | null
  reservedCostMicros: number; grantState: string; grantTaskId: string | null; grantExpiresAt: number
  revalidationId: string; revalidationRevision: number; revalidationHash: string
}
export interface OwnerLateCompletionPreview {
  commandId: string
  projectId: string
  grantId: string
  taskId: string
  snapshotHash: string
  evidence: OwnerLateCompletionEvidence
  fingerprint: string
}

/** 在写入事务内再次核对预览；仅调用者已有可信预览时使用。 */
export function assertOwnerLateCompletionPreviewCurrent(preview: OwnerLateCompletionPreview, isSessionActive: (sessionId: string) => boolean): void {
  const db = store.getProjectDb(), row = candidate(preview.commandId)
  if (!row || row.projectId !== preview.projectId || row.grantId !== preview.grantId || row.taskId !== preview.taskId
    || row.commandState !== 'needs_reconcile' || row.executionStatus !== 'stale' || row.role !== 'executor'
    || row.actualCostMicros !== null || row.grantState !== 'paused' || row.grantExpiresAt <= Date.now()
    || !row.sessionId || isSessionActive(row.sessionId) || isFinalizing(row.commandId) || readOwnerDispatchControl(row.projectId, row.grantId).paused) throw new Error('迟到终态预览的状态或授权已变化')
  const latest = db.prepare('SELECT id FROM project_owner_execution_grants WHERE project_id=? AND task_id IS ? ORDER BY issued_at DESC,rowid DESC LIMIT 1').get(row.projectId, row.grantTaskId) as { id: string } | undefined
  if (latest?.id !== row.grantId
    || db.prepare('SELECT 1 FROM project_owner_execution_stop_escalations WHERE command_id=? AND resolved_at IS NULL').get(row.commandId)
    || db.prepare("SELECT 1 FROM project_owner_action_approvals WHERE command_id=? AND status IN ('pending','invalidated') LIMIT 1").get(row.commandId)
    || db.prepare('SELECT 1 FROM project_owner_execution_grant_decisions WHERE grant_id=? AND action=\'revoke\'').get(row.grantId)
    || db.prepare("SELECT 1 FROM project_owner_execution_commands WHERE grant_id=? AND id<>? AND state IN ('reserved','queued','running','needs_reconcile') LIMIT 1").get(row.grantId, row.commandId)) throw new Error('迟到终态预览出现新的命令或授权决定')
  assertOwnerDispatchManagementCurrent(row.projectId, row.grantId)
  const validation = getOwnerExecutionRevalidation({ projectId: row.projectId, ...(row.grantTaskId ? { taskId: row.grantTaskId } : {}) })
  if (validation.status !== 'current' || validation.revalidation?.id !== row.revalidationId || validation.revalidation.revision !== row.revalidationRevision || validation.revalidation.integrityHash !== row.revalidationHash) throw new Error('迟到终态的冻结来源已变化')
  const frozen = readOwnerCommandFrozenSource(row.commandId).source
  const task = frozen.tasks.find(item => item.taskId === row.taskId && item.linkId === row.stepLinkId), currentTask = store.getTask(row.taskId)
  if (!task?.developmentScope || !currentTask?.developmentScope || currentTask.ownerStepLinkId !== row.stepLinkId || ownerExecutionHash(task.developmentScope) !== ownerExecutionHash(currentTask.developmentScope)) throw new Error('迟到终态的任务范围已变化')
  const meta = getAgentSessionMeta(row.sessionId), workspace = meta?.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
  if (!workspace?.rootPath || workspace.id !== task.developmentScope.workspaceId || workspace.id !== currentTask.workspaceId
    || !/^[a-zA-Z0-9_-]+$/.test(workspace.slug) || !/^[a-zA-Z0-9_-]+$/.test(row.sessionId)) throw new Error('迟到终态的会话工作区无效')
  const sessionDirectory = join(getConfigDir(), 'agent-workspaces', workspace.slug, row.sessionId)
  const stat = lstatSync(sessionDirectory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('迟到终态会话目录无效')
  const worktree = resolveDevelopmentWorktree(workspace.rootPath, sessionDirectory)
  if (!worktree) throw new Error('迟到终态工作树缺失')
  const snapshot = loadDevelopmentSnapshot(sessionDirectory, row.executionId)
  const scope = validateDevelopmentScope(task.developmentScope, { getWorkspace: getAgentWorkspace })
  const settlements = requests(row.commandId)
  const evidence = buildOwnerLateCompletionEvidence(row.executionId, row.sessionId, getAgentSessionSDKMessages(row.sessionId), settlements)
  const proof = startProof(row)
  if (!evidence || evidence.costMicros > row.reservedCostMicros || snapshot.workspaceId !== workspace.id
    || !developmentWorktreeMatchesSnapshot(worktree, snapshot, scope)
    || !proof
    || ownerExecutionHash({ row, settlements, evidence, startProof: proof, snapshotHash: snapshot.contentHash }) !== preview.fingerprint) throw new Error('迟到终态、启动回执、费用或代码快照已变化')
}

function candidate(commandId: string): CandidateRow | undefined {
  return store.getProjectDb().prepare(`SELECT c.id AS commandId,c.project_id AS projectId,c.grant_id AS grantId,
    c.source_task_id AS taskId,c.source_step_link_id AS stepLinkId,c.execution_id AS executionId,c.role,
    c.state AS commandState,c.usage_evidence AS usageEvidence,c.usage_record_key AS usageRecordKey,
    c.actual_cost_micros AS actualCostMicros,c.reserved_cost_micros AS reservedCostMicros,
    e.session_id AS sessionId,e.status AS executionStatus,g.state AS grantState,g.task_id AS grantTaskId,
    g.expires_at AS grantExpiresAt,g.revalidation_id AS revalidationId,g.revalidation_revision AS revalidationRevision,
    g.revalidation_integrity_hash AS revalidationHash
    FROM project_owner_execution_commands c
    JOIN agent_executions e ON e.id=c.execution_id AND e.owner_command_id=c.id AND e.project_id=c.project_id AND e.entity_id=c.source_task_id AND e.entity_type='task' AND e.agent_id=c.employee_id
    JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id AND g.dispatch_mode='autonomous'
    WHERE c.id=?`).get(commandId) as CandidateRow | undefined
}

function requests(commandId: string): OwnerLateRequestSettlement[] {
  return store.getProjectDb().prepare(`SELECT request_id AS requestId,execution_id AS executionId,session_id AS sessionId,
    state,settled_cost_micros AS settledCostMicros,request_evidence_id AS requestEvidenceId,price_evidence_id AS priceEvidenceId
    FROM project_owner_execution_request_reservations WHERE command_id=? ORDER BY request_id`).all(commandId) as OwnerLateRequestSettlement[]
}

function startProof(row: CandidateRow): unknown {
  return store.getProjectDb().prepare(`SELECT a.claimed_at AS claimedAt,a.handoff_intent_at AS handoffIntentAt,
    r.runner_name AS runnerName,r.process_id AS processId,r.started_at AS startedAt,r.received_at AS receivedAt
    FROM project_owner_execution_start_attempts a JOIN project_owner_execution_start_receipts r
    ON r.execution_id=a.execution_id AND r.command_id=a.command_id AND r.project_id=a.project_id AND r.session_id=a.session_id
    WHERE a.execution_id=? AND a.command_id=? AND a.project_id=? AND a.session_id=? AND a.handoff_intent_at IS NOT NULL`)
    .get(row.executionId, row.commandId, row.projectId, row.sessionId)
}

function isFinalizing(commandId: string): boolean {
  return (require('./agent-employee-service') as typeof import('./agent-employee-service')).isOwnerCommandFinalizing(commandId)
}

/** 不接受模型传入状态；会话活跃性必须由本机运行时提供。 */
export async function previewOwnerLateCompletion(commandId: string, isSessionActive: (sessionId: string) => boolean): Promise<OwnerLateCompletionPreview | null> {
  if (!commandId.trim() || isFinalizing(commandId)) return null
  const db = store.getProjectDb(), row = candidate(commandId)
  if (!row || row.role !== 'executor' || row.commandState !== 'needs_reconcile' || row.executionStatus !== 'stale'
    || row.actualCostMicros !== null || row.grantState !== 'paused' || row.grantExpiresAt <= Date.now()
    || !row.sessionId || isSessionActive(row.sessionId) || !row.usageEvidence || !row.usageRecordKey) return null
  let previousUsage: unknown
  try { previousUsage = JSON.parse(row.usageEvidence) } catch { return null }
  if (!previousUsage || typeof previousUsage !== 'object' || Array.isArray(previousUsage)) return null
  const usage = previousUsage as Record<string, unknown>, runtime = readOwnerCommandRuntime(commandId)
  if (usage.source !== 'unknown' || usage.executionId !== row.executionId || usage.sessionId !== row.sessionId
    || usage.channelId !== runtime.channelId || usage.modelId !== runtime.modelId
    || usage.reason !== '应用重启中断Runtime，无法核验Provider用量'
    || row.usageRecordKey !== `unknown:${row.executionId}:${row.sessionId}::`) return null
  const proof = startProof(row)
  if (!proof) return null
  if (db.prepare('SELECT 1 FROM project_owner_execution_stop_escalations WHERE command_id=? AND resolved_at IS NULL').get(commandId)
    || db.prepare("SELECT 1 FROM project_owner_action_approvals WHERE command_id=? AND status IN ('pending','invalidated') LIMIT 1").get(commandId)
    || db.prepare('SELECT 1 FROM project_owner_execution_grant_decisions WHERE grant_id=? AND action=\'revoke\'').get(row.grantId)
    || db.prepare("SELECT 1 FROM project_owner_execution_commands WHERE grant_id=? AND id<>? AND state IN ('reserved','queued','running','needs_reconcile') LIMIT 1").get(row.grantId, commandId)
    || readOwnerDispatchControl(row.projectId, row.grantId).paused) return null
  const latest = db.prepare('SELECT id FROM project_owner_execution_grants WHERE project_id=? AND task_id IS ? ORDER BY issued_at DESC,rowid DESC LIMIT 1').get(row.projectId, row.grantTaskId) as { id: string } | undefined
  if (latest?.id !== row.grantId) return null
  try { assertOwnerDispatchManagementCurrent(row.projectId, row.grantId) } catch { return null }
  const revalidation = getOwnerExecutionRevalidation({ projectId: row.projectId, ...(row.grantTaskId ? { taskId: row.grantTaskId } : {}) })
  if (revalidation.status !== 'current' || revalidation.revalidation?.id !== row.revalidationId
    || revalidation.revalidation.revision !== row.revalidationRevision || revalidation.revalidation.integrityHash !== row.revalidationHash) return null
  const frozen = readOwnerCommandFrozenSource(commandId).source
  const task = frozen.tasks.find(item => item.taskId === row.taskId && item.linkId === row.stepLinkId)
  const currentTask = store.getTask(row.taskId)
  if (!task?.developmentScope || !currentTask?.developmentScope || currentTask.projectId !== row.projectId
    || currentTask.ownerStepLinkId !== row.stepLinkId || ownerExecutionHash(task.developmentScope) !== ownerExecutionHash(currentTask.developmentScope)) return null
  const meta = getAgentSessionMeta(row.sessionId), workspace = meta?.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
  if (!workspace?.rootPath || workspace.id !== task.developmentScope.workspaceId || workspace.id !== currentTask.workspaceId) return null
  if (!/^[a-zA-Z0-9_-]+$/.test(workspace.slug) || !/^[a-zA-Z0-9_-]+$/.test(row.sessionId)) return null
  const sessionDirectory = join(getConfigDir(), 'agent-workspaces', workspace.slug, row.sessionId)
  try { const stat = lstatSync(sessionDirectory); if (!stat.isDirectory() || stat.isSymbolicLink()) return null } catch { return null }
  const worktree = resolveDevelopmentWorktree(workspace.rootPath, sessionDirectory)
  if (!worktree) return null
  const settlements = requests(commandId)
  const evidence = buildOwnerLateCompletionEvidence(row.executionId, row.sessionId, getAgentSessionSDKMessages(row.sessionId), settlements)
  if (!evidence || evidence.costMicros > row.reservedCostMicros) return null
  const snapshot = await loadDevelopmentSnapshotAsync(sessionDirectory, row.executionId)
  const scope = validateDevelopmentScope(task.developmentScope, { getWorkspace: getAgentWorkspace })
  if (snapshot.workspaceId !== workspace.id || !await developmentWorktreeMatchesSnapshotAsync(worktree, snapshot, scope)) return null
  // 等待文件读取期间若账本、会话、授权或费用发生变化，则不返回过时预览。
  if (isSessionActive(row.sessionId) || isFinalizing(commandId)) return null
  const current = candidate(commandId)
  const currentTaskAfter = store.getTask(row.taskId)
  const revalidationAfter = getOwnerExecutionRevalidation({ projectId: row.projectId, ...(row.grantTaskId ? { taskId: row.grantTaskId } : {}) })
  const latestAfter = db.prepare('SELECT id FROM project_owner_execution_grants WHERE project_id=? AND task_id IS ? ORDER BY issued_at DESC,rowid DESC LIMIT 1').get(row.projectId, row.grantTaskId) as { id: string } | undefined
  if (!current || ownerExecutionHash(current) !== ownerExecutionHash(row)
    || ownerExecutionHash(requests(commandId)) !== ownerExecutionHash(settlements)
    || !startProof(row) || ownerExecutionHash(startProof(row)) !== ownerExecutionHash(proof)
    || !currentTaskAfter?.developmentScope || currentTaskAfter.ownerStepLinkId !== row.stepLinkId
    || ownerExecutionHash(currentTaskAfter.developmentScope) !== ownerExecutionHash(task.developmentScope)
    || revalidationAfter.status !== 'current' || revalidationAfter.revalidation?.integrityHash !== row.revalidationHash
    || latestAfter?.id !== row.grantId
    || db.prepare('SELECT 1 FROM project_owner_execution_stop_escalations WHERE command_id=? AND resolved_at IS NULL').get(commandId)
    || db.prepare("SELECT 1 FROM project_owner_action_approvals WHERE command_id=? AND status IN ('pending','invalidated') LIMIT 1").get(commandId)
    || db.prepare('SELECT 1 FROM project_owner_execution_grant_decisions WHERE grant_id=? AND action=\'revoke\'').get(row.grantId)
    || db.prepare("SELECT 1 FROM project_owner_execution_commands WHERE grant_id=? AND id<>? AND state IN ('reserved','queued','running','needs_reconcile') LIMIT 1").get(row.grantId, commandId)
    || ownerExecutionHash(buildOwnerLateCompletionEvidence(row.executionId, row.sessionId, getAgentSessionSDKMessages(row.sessionId), settlements)) !== ownerExecutionHash(evidence)
    || readOwnerDispatchControl(row.projectId, row.grantId).paused || row.grantExpiresAt <= Date.now()) return null
  try { assertOwnerDispatchManagementCurrent(row.projectId, row.grantId) } catch { return null }
  const fingerprint = ownerExecutionHash({ row, settlements, evidence, startProof: proof, snapshotHash: snapshot.contentHash })
  return { commandId, projectId: row.projectId, grantId: row.grantId, taskId: row.taskId, snapshotHash: snapshot.contentHash, evidence, fingerprint }
}
