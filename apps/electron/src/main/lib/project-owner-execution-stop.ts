import { readOwnerCommandRuntime } from './project-owner-employee-runtime'
/** Owner命令停止/恢复：escalation镜像+queued释放+对称恢复扫描；无自动消解。 */
import { randomUUID } from 'node:crypto'
import * as store from './project-sqlite-store'
import { settleOwnerCommandUsage } from './project-owner-execution-settlement'
import { detectOwnerOutwardActions } from './project-owner-outward-actions'
import { getAgentSessionSDKMessages } from './agent-session-manager'

interface EscalationRow { escalation_id: string; execution_id: string; command_id: string; project_id: string; session_id: string; requested_at: number; reason: string; resolved_at: number | null }
export interface OwnerStopEscalation { escalationId: string; executionId: string; commandId: string; projectId: string; sessionId: string; requestedAt: number; reason: string }
function fromRow(row: EscalationRow): OwnerStopEscalation { return { escalationId: row.escalation_id, executionId: row.execution_id, commandId: row.command_id, projectId: row.project_id, sessionId: row.session_id, requestedAt: row.requested_at, reason: row.reason } }
export function recordOwnerCommandStopEscalation(executionId: string, reason: string, now = Date.now(), expectedGeneration?: number): OwnerStopEscalation {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Owner停止升级时钟无效')
  if (!reason?.trim()) throw new Error('Owner停止升级原因无效')
  const database = store.getProjectDb()
  if (database.isTransactionActive()) throw new Error('Owner停止升级不得嵌套未提交事务')
  const execution = store.getAgentExecution(executionId)
  if (!execution || !execution.ownerCommandId) throw new Error('Owner停止升级执行归属无法核验')
  if (execution.status !== 'running') throw new Error('Owner停止升级仅适用于运行中的执行')
  const escalationId = randomUUID()
  let result: OwnerStopEscalation | undefined
  database.transaction(() => {
    const current = store.getAgentExecution(executionId)
    if (!current || current.status !== 'running' || current.ownerCommandId !== execution.ownerCommandId || current.sessionId !== execution.sessionId) throw new Error('Owner停止升级执行已变化')
    const existing = database.prepare('SELECT * FROM project_owner_execution_stop_escalations WHERE execution_id = ?').get(executionId) as EscalationRow | undefined
    if (existing && existing.resolved_at === null) throw new Error('Owner停止升级已存在')
    if (existing) throw new Error('Owner停止升级已消解，不能重复升级')
    const commandId = current.ownerCommandId!
    const command = database.prepare('SELECT grant_id, project_id, execution_id FROM project_owner_execution_commands WHERE id = ?').get(commandId) as { grant_id: string; project_id: string; execution_id: string } | undefined
    if (!command || command.project_id !== current.projectId || command.execution_id !== executionId) throw new Error('Owner停止升级命令归属无法核验')
    // 暂停同项目全部活动owner授权+验证本命令授权已停等，与升级记录同事务。
    database.prepare("UPDATE project_owner_execution_grants SET state = 'paused' WHERE project_id = ? AND state = 'active'").run(current.projectId)
    const grant = database.prepare('SELECT state FROM project_owner_execution_grants WHERE id = ? AND project_id = ?').get(command.grant_id, current.projectId) as { state: string } | undefined
    if (grant?.state !== 'paused') throw new Error('Owner停止升级授权暂停无法核验')
    database.prepare(`INSERT INTO project_owner_execution_stop_escalations
      (escalation_id, execution_id, command_id, project_id, session_id, expected_generation, requested_at, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(escalationId, executionId, commandId, current.projectId, current.sessionId, expectedGeneration ?? null, now, reason.trim())
    const row = database.prepare('SELECT * FROM project_owner_execution_stop_escalations WHERE execution_id = ?').get(executionId) as EscalationRow | undefined
    if (!row) throw new Error('Owner停止升级写入无法核验')
    result = fromRow(row)
  })()
  if (!result) throw new Error('Owner停止升级未完成')
  return result
}
/** 先持久停止意图，再向Runtime发停止请求；中止回执不含可持久核验凭据，升级不自动消解，待人工对账。 */
export async function requestOwnerCommandStopWithIntent(executionId: string, reason: string, requestStop: () => Promise<void>, now = Date.now()): Promise<OwnerStopEscalation> {
  const escalation = recordOwnerCommandStopEscalation(executionId, reason, now)
  await requestStop()
  return escalation
}
/** 取消未启动的owner命令执行，同事务释放费用与次数预留。 */
export function cancelQueuedOwnerCommand(commandId: string, now = Date.now()): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Owner取消时钟无效')
  const database = store.getProjectDb()
  database.transaction(() => {
    const command = database.prepare('SELECT * FROM project_owner_execution_commands WHERE id = ?').get(commandId) as { id: string; project_id: string; state: string; execution_id: string | null; reserved_cost_micros: number } | undefined
    if (!command) throw new Error('Owner命令不存在')
    if (command.state !== 'queued' || !command.execution_id) throw new Error('Owner命令不在可取消状态')
    const released = database.prepare(`UPDATE project_owner_execution_commands SET state = 'released', actual_cost_micros = 0, updated_at = ? WHERE id = ? AND state = 'queued'`).run(now, commandId)
    if (released.changes !== 1) throw new Error('Owner命令释放状态已变化')
    const stale = database.prepare("UPDATE agent_executions SET status = 'stale', error = ?, completed_at = ? WHERE id = ? AND project_id = ? AND status = 'queued'").run('Owner命令已取消，预留已释放', now, command.execution_id, command.project_id)
    if (stale.changes !== 1) throw new Error('Owner执行取消状态已变化')
  })()
}
export interface OwnerRecoveryResult { executionId: string; commandId: string; state: 'unknown_recorded' | 'stale_only'; startBoundary: 'claim_only' | 'handoff_intent' | 'started_proven' | 'invalid_attempt'; outwardActions: string[]; reason: string }
function readOwnerStartBoundary(executionId: string, commandId: string): OwnerRecoveryResult['startBoundary'] {
  const database = store.getProjectDb()
  const attempt = database.prepare('SELECT handoff_intent_at FROM project_owner_execution_start_attempts WHERE execution_id = ? AND command_id = ?').get(executionId, commandId) as { handoff_intent_at: number | null } | undefined
  if (!attempt) return 'invalid_attempt'
  if (!attempt.handoff_intent_at) return 'claim_only'
  if (!database.prepare('SELECT 1 FROM project_owner_execution_start_receipts WHERE execution_id = ? AND command_id = ?').get(executionId, commandId)) return 'handoff_intent'
  return 'started_proven'
}
/** 恢复对称扫描（R5）：重启后对遗留running的owner命令执行撤权+stale+unknown结算；升级保持open待人工对账。 */
export function recoverInterruptedOwnerRuntimeExecutions(now = Date.now(), onlyExecutionId?: string): OwnerRecoveryResult[] {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Owner恢复时钟无效')
  const database = store.getProjectDb()
  recoverUnclaimedOwnerCommandPreparations(now, onlyExecutionId)
  const candidates = database.prepare(`SELECT id, project_id, owner_command_id FROM agent_executions WHERE status = 'running' AND owner_command_id IS NOT NULL AND (? IS NULL OR id = ?) ORDER BY started_at, id`).all(onlyExecutionId ?? null, onlyExecutionId ?? null) as Array<{ id: string; project_id: string; owner_command_id: string }>
  const results: OwnerRecoveryResult[] = []
  for (const candidate of candidates) {
    let result: OwnerRecoveryResult | undefined
    const startBoundary = readOwnerStartBoundary(candidate.id, candidate.owner_command_id)
    try {
      database.transaction(() => {
        const execution = store.getAgentExecution(candidate.id)
        if (!execution || execution.status !== 'running' || execution.ownerCommandId !== candidate.owner_command_id) return
        database.prepare("UPDATE project_owner_execution_grants SET state = 'paused' WHERE project_id = ? AND state = 'active'").run(execution.projectId)
        // 对外动作只作为人工判断线索，不能证明动作成功，也不改变“不自动重跑”的策略。
        const outwardActions = detectOwnerOutwardActions(getAgentSessionSDKMessages(execution.sessionId))
        const recoveryError = outwardActions.length
          ? `应用重启后Runtime状态与用量未知；检测到对外动作（${outwardActions.join('、')}），不自动重跑以免重复执行，已暂停Owner授权等待对账`
          : '应用重启后Runtime状态与用量未知，已暂停Owner授权等待对账'
        const stale = database.prepare(`UPDATE agent_executions SET status = 'stale', error = ?, last_heartbeat_at = ?, completed_at = ? WHERE id = ? AND project_id = ? AND status = 'running' AND owner_command_id = ?`).run(recoveryError, now, now, execution.id, execution.projectId, candidate.owner_command_id)
        if (stale.changes !== 1) throw new Error('Owner中断执行状态已变化')
        database.prepare(`UPDATE project_owner_action_approvals SET status='invalidated', decided_at=?, decision_reason='runtime_recovered'
          WHERE project_id=? AND command_id=? AND execution_id=? AND session_id=? AND status='pending'`)
          .run(now, execution.projectId, candidate.owner_command_id, execution.id, execution.sessionId)
        try {
          if (!execution.sessionId.trim()) throw new Error('中断执行缺少会话')
          const command = database.prepare(`SELECT c.state, c.actual_cost_micros, c.usage_evidence, c.usage_record_key
            FROM project_owner_execution_commands c JOIN project_owner_execution_grants g ON g.id = c.grant_id AND g.project_id = c.project_id
            WHERE c.id = ? AND c.project_id = ? AND c.execution_id = ?`).get(candidate.owner_command_id, execution.projectId, execution.id) as { state: string; actual_cost_micros: number | null; usage_evidence: string | null; usage_record_key: string | null } | undefined
          if (!command || command.state !== 'running' || command.actual_cost_micros !== null || command.usage_evidence !== null || command.usage_record_key !== null) throw new Error('中断执行命令缺失或已有费用证据')
          const runtime = readOwnerCommandRuntime(candidate.owner_command_id)
          settleOwnerCommandUsage(candidate.owner_command_id, { source: 'unknown', executionId: execution.id, sessionId: execution.sessionId, channelId: runtime.channelId, modelId: runtime.modelId, capturedAt: now, reason: '应用重启中断Runtime，无法核验Provider用量' }, now)
          result = { executionId: execution.id, commandId: candidate.owner_command_id, state: 'unknown_recorded', startBoundary, outwardActions, reason: startBoundary === 'started_proven' ? '启动已证实但终态与用量未知，已按未知用量撤权停等' : '中断Runtime已按未知用量撤权停等' }
        } catch {
          database.prepare("UPDATE project_owner_execution_commands SET state='needs_reconcile',updated_at=? WHERE id=? AND state='running' AND actual_cost_micros IS NULL").run(now, candidate.owner_command_id)
          result = { executionId: execution.id, commandId: candidate.owner_command_id, state: 'stale_only', startBoundary, outwardActions, reason: '中断执行已置stale，结算失败留待人工对账' }
        }
      })()
    } catch { /* 单条失败不阻塞其余候选 */ }
    if (result) results.push(result)
  }
  return results
}


const OWNER_UNCLAIMED_PREPARATION = `e.status='queued' AND e.session_id='' AND c.actual_cost_micros IS NULL
  AND c.usage_evidence IS NULL AND c.usage_record_key IS NULL
  AND NOT EXISTS(SELECT 1 FROM project_owner_execution_start_attempts a WHERE a.execution_id=e.id)
  AND NOT EXISTS(SELECT 1 FROM project_owner_execution_request_reservations r WHERE r.command_id=c.id)`

const OWNER_WORKSPACE_BLOCK_EVIDENCE = `(SELECT json_extract(a.payload,'$.workspaceBlocker.kind') FROM project_activities a
  WHERE a.project_id=c.project_id AND a.action='owner_prestart_blocked'
    AND json_extract(a.payload,'$.commandId')=c.id AND json_extract(a.payload,'$.executionId')=e.id
  ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1)='dirty_worktree'`

interface UnclaimedPreparation { id: string; project_id: string; source_task_id: string; execution_id: string; state: 'queued' | 'needs_reconcile' }
interface UnclaimedWorkspaceBlock extends UnclaimedPreparation { grant_id: string; grant_state: string; expires_at: number }

/** 旧版启动扫描可能已恢复排队，但授权仍待对账，也允许核对该阻塞。 */
export function readUnclaimedOwnerDevelopmentWorkspaceBlock(projectId: string, commandId: string): UnclaimedWorkspaceBlock | undefined {
  return store.getProjectDb().prepare(`SELECT c.id,c.project_id,c.source_task_id,c.execution_id,c.state,c.grant_id,g.state AS grant_state,g.expires_at
    FROM project_owner_execution_commands c
    JOIN agent_executions e ON e.id=c.execution_id AND e.owner_command_id=c.id AND e.project_id=c.project_id
    JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
    WHERE c.project_id=? AND c.id=? AND (c.state='needs_reconcile' OR (c.state='queued' AND g.state='needs_reconcile'))
      AND ${OWNER_UNCLAIMED_PREPARATION} AND ${OWNER_WORKSPACE_BLOCK_EVIDENCE}`).get(projectId, commandId) as UnclaimedWorkspaceBlock | undefined
}

function queueRecoveredPreparation(row: UnclaimedPreparation, now: number): void {
  const database = store.getProjectDb()
  const queued = database.prepare("UPDATE project_owner_execution_commands SET state='queued',updated_at=? WHERE id=? AND state=?").run(now,row.id,row.state)
  if (queued.changes !== 1) throw new Error('Owner准备恢复状态已变化')
  store.recordProjectActivity({
    projectId: row.project_id, entityType: 'task', entityId: row.source_task_id, action: 'owner_unclaimed_start_recovered', actor: 'system:owner-runtime',
    summary: '原执行从未认领且没有会话、请求或用量；恢复排队准备，费用预留和原失败记录保留。',
    payload: { commandId: row.id, executionId: row.execution_id, previousState: row.state },
  })
}

/** 只由显式 Git 核对通过后调用；旧版误冻结授权仅在整批无其他未知执行或费用时解除。 */
export function resumeOwnerDevelopmentAfterWorkspaceCheck(projectId: string, commandId: string, now = Date.now()): void {
  const database = store.getProjectDb()
  database.transaction(() => {
    const row = readUnclaimedOwnerDevelopmentWorkspaceBlock(projectId, commandId)
    if (!row || row.expires_at <= now || !['active', 'needs_reconcile'].includes(row.grant_state)) {
      throw new Error('工作区已清理，原授权仍需核对后才能继续。')
    }
    if (row.grant_state === 'needs_reconcile') {
      const restored = database.prepare(`UPDATE project_owner_execution_grants SET state='active'
        WHERE id=? AND project_id=? AND state='needs_reconcile'
          AND id=(SELECT g.id FROM project_owner_execution_grants g
            WHERE g.project_id=? AND g.task_id IS project_owner_execution_grants.task_id ORDER BY g.issued_at DESC,g.rowid DESC LIMIT 1)
          AND NOT EXISTS(SELECT 1 FROM project_owner_execution_grants g WHERE g.project_id=? AND g.state='active')
          AND NOT EXISTS(SELECT 1 FROM project_owner_execution_commands c WHERE c.grant_id=? AND c.id<>? AND c.state IN ('reserved','queued','running','needs_reconcile'))
          AND NOT EXISTS(SELECT 1 FROM project_owner_execution_request_reservations r
            JOIN project_owner_execution_commands c ON c.id=r.command_id WHERE c.grant_id=? AND r.state<>'settled')
          AND NOT EXISTS(SELECT 1 FROM project_owner_execution_stop_escalations s
            JOIN project_owner_execution_commands c ON c.id=s.command_id WHERE c.grant_id=? AND s.resolved_at IS NULL)`)
        .run(row.grant_id,projectId,projectId,projectId,row.grant_id,commandId,row.grant_id,row.grant_id)
      if (restored.changes !== 1) throw new Error('工作区已清理，这次授权还有其他执行或费用需要核对。')
    }
    queueRecoveredPreparation(row, now)
  })()
}

/** 补偿未认领的准备失败。明确的工作区阻塞留给用户清理后重新核对，保留原命令与预留。 */
export function recoverUnclaimedOwnerCommandPreparations(now = Date.now(), onlyExecutionId?: string): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Owner准备恢复时钟无效')
  const database = store.getProjectDb()
  let recovered = 0
  database.transaction(() => {
    const rows = database.prepare(`SELECT c.id,c.project_id,c.source_task_id,c.execution_id,c.state FROM project_owner_execution_commands c
      JOIN agent_executions e ON e.id=c.execution_id AND e.owner_command_id=c.id AND e.project_id=c.project_id
      WHERE c.state='needs_reconcile' AND ${OWNER_UNCLAIMED_PREPARATION}
        AND (? IS NULL OR e.id=?)
        AND NOT COALESCE(${OWNER_WORKSPACE_BLOCK_EVIDENCE},0)
        AND NOT EXISTS(SELECT 1 FROM project_activities a WHERE a.project_id=c.project_id
          AND a.action='owner_unclaimed_start_recovered' AND json_extract(a.payload,'$.commandId')=c.id)`)
      .all(onlyExecutionId ?? null, onlyExecutionId ?? null) as UnclaimedPreparation[]
    for (const row of rows) {
      queueRecoveredPreparation(row, now)
      recovered += 1
    }
  })()
  return recovered
}
