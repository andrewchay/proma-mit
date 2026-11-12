/** 完成受限验证后才恢复原授权；失败或任何来源变化都保留暂停状态。 */
import { join } from 'node:path'
import { lstatSync } from 'node:fs'
import { getAgentSessionMeta, getAgentSessionSDKMessages } from './agent-session-manager'
import { getAgentWorkspace } from './agent-workspace-manager'
import { resolveDevelopmentWorktree } from './agent-development-worktree'
import { getConfigDir } from './config-paths'
import { developmentWorktreeMatchesSnapshot, loadDevelopmentSnapshot } from './development-snapshot-service'
import { validateDevelopmentScope } from './development-task-service'
import { ownerDevelopmentValidationId } from './development-validation-attempt'
import { readDevelopmentValidationEvidence, runOwnerDevelopmentValidations } from './development-validation-service'
import { assertOwnerDispatchManagementCurrent, readOwnerDispatchControl } from './project-owner-dispatch-control'
import { readOwnerCommandFrozenSource, readOwnerCommandRuntime } from './project-owner-employee-runtime'
import { getOwnerExecutionRevalidation } from './project-owner-execution-revalidation'
import { ownerExecutionHash } from './project-owner-execution-hash'
import { buildOwnerLateCompletionEvidence, type OwnerLateRequestSettlement } from './project-owner-late-completion-evidence'
import { readOwnerLateCompletionReconciliation, type OwnerLateCompletionReconciliation } from './project-owner-late-completion-reconcile'
import { requestOwnerAutonomousScheduleWake } from './project-owner-autonomous-scheduler-events'
import * as store from './project-sqlite-store'

interface ResumeRow {
  commandId: string; executionId: string; sessionId: string; projectId: string; taskId: string; stepLinkId: string
  grantId: string; grantTaskId: string | null; commandState: string; grantState: string; grantExpiresAt: number
  executionStatus: string; resultSummary: string | null; actualCostMicros: number | null; reservedCostMicros: number
  usageEvidence: string | null; revalidationId: string; revalidationRevision: number; revalidationHash: string
}
function assertCurrent(audit: OwnerLateCompletionReconciliation, isSessionActive: (sessionId: string) => boolean) {
  const db = store.getProjectDb()
  const row = db.prepare(`SELECT c.id AS commandId,c.execution_id AS executionId,e.session_id AS sessionId,c.project_id AS projectId,
      c.source_task_id AS taskId,c.source_step_link_id AS stepLinkId,c.grant_id AS grantId,c.state AS commandState,
      c.actual_cost_micros AS actualCostMicros,c.reserved_cost_micros AS reservedCostMicros,c.usage_evidence AS usageEvidence,
      e.status AS executionStatus,e.result_summary AS resultSummary,g.state AS grantState,g.task_id AS grantTaskId,g.expires_at AS grantExpiresAt,
      g.revalidation_id AS revalidationId,g.revalidation_revision AS revalidationRevision,g.revalidation_integrity_hash AS revalidationHash
    FROM project_owner_execution_commands c JOIN agent_executions e ON e.id=c.execution_id AND e.owner_command_id=c.id AND e.project_id=c.project_id AND e.entity_id=c.source_task_id AND e.entity_type='task' AND e.agent_id=c.employee_id
    JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id AND g.dispatch_mode='autonomous' WHERE c.id=? AND c.role='executor'`).get(audit.commandId) as ResumeRow | undefined
  if (!row || row.executionId !== audit.executionId || row.projectId !== audit.projectId || row.taskId !== audit.taskId || row.grantId !== audit.grantId
    || row.commandState !== 'settled' || row.executionStatus !== 'completed' || row.grantState !== 'paused'
    || row.actualCostMicros !== audit.costMicros || row.reservedCostMicros !== audit.originalCommand.reservedCostMicros
    || row.grantExpiresAt <= Date.now() || isSessionActive(row.sessionId)
    || (require('./agent-employee-service') as typeof import('./agent-employee-service')).isOwnerCommandFinalizing(row.commandId)
    || readOwnerDispatchControl(row.projectId, row.grantId).paused) throw new Error('已对账执行、授权或费用状态已变化')
  const latest = db.prepare('SELECT id FROM project_owner_execution_grants WHERE project_id=? AND task_id IS ? ORDER BY issued_at DESC,rowid DESC LIMIT 1').get(row.projectId, row.grantTaskId) as { id: string } | undefined
  if (latest?.id !== row.grantId || db.prepare('SELECT 1 FROM project_owner_execution_stop_escalations WHERE command_id=? AND resolved_at IS NULL').get(row.commandId)
    || db.prepare("SELECT 1 FROM project_owner_action_approvals WHERE command_id=? AND status IN ('pending','invalidated') LIMIT 1").get(row.commandId)
    || db.prepare("SELECT 1 FROM project_owner_execution_grant_decisions WHERE grant_id=? AND action='revoke'").get(row.grantId)
    || db.prepare("SELECT 1 FROM project_owner_execution_commands WHERE grant_id=? AND id<>? AND state IN ('reserved','queued','running','needs_reconcile') LIMIT 1").get(row.grantId, row.commandId)) throw new Error('原授权已有新决定、未知费用或其他运行')
  assertOwnerDispatchManagementCurrent(row.projectId, row.grantId)
  const revalidation = getOwnerExecutionRevalidation({ projectId: row.projectId, ...(row.grantTaskId ? { taskId: row.grantTaskId } : {}) })
  if (revalidation.status !== 'current' || revalidation.revalidation?.id !== row.revalidationId
    || revalidation.revalidation.revision !== row.revalidationRevision || revalidation.revalidation.integrityHash !== row.revalidationHash) throw new Error('原执行来源已变化')
  const frozen = readOwnerCommandFrozenSource(row.commandId).source
  const task = frozen.tasks.find(item => item.taskId === row.taskId && item.linkId === row.stepLinkId), currentTask = store.getTask(row.taskId)
  if (!task?.developmentScope || !currentTask?.developmentScope || currentTask.status !== 'paused' || currentTask.ownerStepLinkId !== row.stepLinkId
    || ownerExecutionHash(task.developmentScope) !== ownerExecutionHash(currentTask.developmentScope)) throw new Error('原研发任务或范围已变化')
  const meta = getAgentSessionMeta(row.sessionId), workspace = meta?.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
  if (!workspace?.rootPath || workspace.id !== task.developmentScope.workspaceId || workspace.id !== currentTask.workspaceId
    || !/^[a-zA-Z0-9_-]+$/.test(workspace.slug) || !/^[a-zA-Z0-9_-]+$/.test(row.sessionId)) throw new Error('研发会话或工作区已变化')
  const directory = join(getConfigDir(), 'agent-workspaces', workspace.slug, row.sessionId), stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('研发会话目录无效')
  const worktree = resolveDevelopmentWorktree(workspace.rootPath, directory), snapshot = loadDevelopmentSnapshot(directory, row.executionId)
  const scope = validateDevelopmentScope(task.developmentScope, { getWorkspace: getAgentWorkspace })
  if (!worktree || snapshot.contentHash !== audit.snapshotHash || !developmentWorktreeMatchesSnapshot(worktree, snapshot, scope)) throw new Error('冻结代码成果已变化')
  const requests = db.prepare(`SELECT request_id AS requestId,execution_id AS executionId,session_id AS sessionId,state,
    settled_cost_micros AS settledCostMicros,request_evidence_id AS requestEvidenceId,price_evidence_id AS priceEvidenceId
    FROM project_owner_execution_request_reservations WHERE command_id=? ORDER BY request_id`).all(row.commandId) as OwnerLateRequestSettlement[]
  const evidence = buildOwnerLateCompletionEvidence(row.executionId, row.sessionId, getAgentSessionSDKMessages(row.sessionId), requests)
  const runtime = readOwnerCommandRuntime(row.commandId)
  let usage: Record<string, unknown>
  try { usage = JSON.parse(row.usageEvidence ?? '') as Record<string, unknown> } catch { throw new Error('已结算用量记录损坏') }
  if (!evidence || evidence.terminalHash !== audit.terminalHash || evidence.assistantSummaryHash !== audit.assistantSummaryHash
    || evidence.assistantSummary !== row.resultSummary || evidence.costMicros !== audit.costMicros
    || JSON.stringify(evidence.requestSettlementIds) !== JSON.stringify(audit.requestSettlementIds)
    || usage.source !== 'request_settled' || usage.executionId !== row.executionId || usage.sessionId !== row.sessionId
    || usage.channelId !== runtime.channelId || usage.modelId !== runtime.modelId || usage.costMicros !== audit.costMicros
    || JSON.stringify(usage.requestSettlementIds) !== JSON.stringify(audit.requestSettlementIds)) throw new Error('迟到终态或逐请求费用来源已变化')
  return { row, scope, directory }
}

const inFlight = new Map<string, Promise<void>>()
/** 可重复进入：已完成的验证读取原回执，未知验证保留暂停，不重发模型。 */
export function resumeOwnerLateCompletion(commandId: string, isSessionActive: (sessionId: string) => boolean): Promise<void> {
  const existing = inFlight.get(commandId)
  if (existing) return existing
  const pending = (async () => {
    const audit = readOwnerLateCompletionReconciliation(commandId)
    if (!audit) throw new Error('缺少迟到终态对账记录')
    const db = store.getProjectDb()
    const prior = db.prepare('SELECT project_id,grant_id,payload,integrity_hash,created_at FROM project_owner_late_completion_resumptions WHERE command_id=?').get(commandId) as {
      project_id: string; grant_id: string; payload: string; integrity_hash: string; created_at: number
    } | undefined
    if (prior) {
      let value: unknown
      try { value = JSON.parse(prior.payload) } catch { throw new Error('迟到终态续接记录无法解析') }
      if (!value || typeof value !== 'object' || Array.isArray(value) || !('commandId' in value) || value.commandId !== commandId
        || !('projectId' in value) || value.projectId !== audit.projectId || prior.project_id !== audit.projectId
        || !('grantId' in value) || value.grantId !== audit.grantId || prior.grant_id !== audit.grantId
        || !('createdAt' in value) || value.createdAt !== prior.created_at || ownerExecutionHash(value) !== prior.integrity_hash) throw new Error('迟到终态续接记录完整性无效')
      return
    }
    assertCurrent(audit, isSessionActive)
    await runOwnerDevelopmentValidations(commandId)
    db.transaction(() => {
      const current = assertCurrent(audit, isSessionActive)
      const commands = current.scope.verificationCommands ?? []
      if (!commands.length) throw new Error('原研发范围没有验证命令')
      const validations = commands.map(command => {
        const id = ownerDevelopmentValidationId(commandId, command, audit.snapshotHash)
        const evidence = readDevelopmentValidationEvidence(audit.taskId, audit.executionId, id)
        if (evidence.freshness !== 'fresh' || evidence.result.command !== command || evidence.result.snapshotContentHash !== audit.snapshotHash
          || !['passed', 'failed'].includes(evidence.result.status) || evidence.result.timedOut || evidence.result.outputTruncated
          || evidence.result.exitCode === null || !evidence.result.rawOutputSha256 || !Number.isSafeInteger(evidence.result.rawOutputByteLength)) throw new Error('验证回执缺失、未知或不完整，保留暂停')
        return { id, command, status: evidence.result.status, exitCode: evidence.result.exitCode, outputHash: evidence.result.rawOutputSha256 }
      })
      const createdAt = Date.now(), payload = { commandId, projectId: audit.projectId, grantId: audit.grantId,
        reconciliationHash: ownerExecutionHash(audit), snapshotHash: audit.snapshotHash, validations, createdAt }
      db.prepare('INSERT INTO project_owner_late_completion_resumptions (command_id,project_id,grant_id,payload,integrity_hash,created_at) VALUES (?,?,?,?,?,?)')
        .run(commandId, audit.projectId, audit.grantId, JSON.stringify(payload), ownerExecutionHash(payload), createdAt)
      const updated = db.prepare("UPDATE project_owner_execution_grants SET state='active' WHERE id=? AND project_id=? AND state='paused'").run(audit.grantId, audit.projectId)
      if (updated.changes !== 1) throw new Error('授权状态已变化，事务回滚')
      store.recordProjectActivity({ projectId: audit.projectId, entityType: 'task', entityId: audit.taskId,
        action: 'owner_late_completion_validation_recorded', actor: 'system:owner-runtime',
        summary: '迟到终态的原成果已完成受限验证；原授权经重新核验后继续，独立评审仍须判断成果。', payload })
    })()
    requestOwnerAutonomousScheduleWake(audit.projectId)
  })()
  inFlight.set(commandId, pending)
  void pending.finally(() => { if (inFlight.get(commandId) === pending) inFlight.delete(commandId) }).catch(() => {})
  return pending
}
