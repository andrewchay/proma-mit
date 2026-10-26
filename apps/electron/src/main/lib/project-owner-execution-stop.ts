/** Owner命令停止/恢复：escalation镜像+queued释放+对称恢复扫描；无自动消解。 */
import { randomUUID } from 'node:crypto'
import * as store from './project-sqlite-store'
import { settleOwnerCommandUsage } from './project-owner-execution-settlement'

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
export interface OwnerRecoveryResult { executionId: string; commandId: string; state: 'unknown_recorded' | 'stale_only'; startBoundary: 'claim_only' | 'handoff_intent' | 'started_proven' | 'invalid_attempt'; reason: string }
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
        const stale = database.prepare(`UPDATE agent_executions SET status = 'stale', error = ?, last_heartbeat_at = ?, completed_at = ? WHERE id = ? AND project_id = ? AND status = 'running' AND owner_command_id = ?`).run('应用重启后Runtime状态与用量未知，已暂停Owner授权等待对账', now, now, execution.id, execution.projectId, candidate.owner_command_id)
        if (stale.changes !== 1) throw new Error('Owner中断执行状态已变化')
        database.prepare(`UPDATE project_owner_action_approvals SET status='invalidated', decided_at=?, decision_reason='runtime_recovered'
          WHERE project_id=? AND command_id=? AND execution_id=? AND session_id=? AND status='pending'`)
          .run(now, execution.projectId, candidate.owner_command_id, execution.id, execution.sessionId)
        try {
          if (!execution.sessionId.trim()) throw new Error('中断执行缺少会话')
          const command = database.prepare(`SELECT c.state, c.actual_cost_micros, c.usage_evidence, c.usage_record_key, g.channel_id, g.model_id
            FROM project_owner_execution_commands c JOIN project_owner_execution_grants g ON g.id = c.grant_id AND g.project_id = c.project_id
            WHERE c.id = ? AND c.project_id = ? AND c.execution_id = ?`).get(candidate.owner_command_id, execution.projectId, execution.id) as { state: string; actual_cost_micros: number | null; usage_evidence: string | null; usage_record_key: string | null; channel_id: string; model_id: string } | undefined
          if (!command || command.state !== 'running' || command.actual_cost_micros !== null || command.usage_evidence !== null || command.usage_record_key !== null) throw new Error('中断执行命令缺失或已有费用证据')
          settleOwnerCommandUsage(candidate.owner_command_id, { source: 'unknown', executionId: execution.id, sessionId: execution.sessionId, channelId: command.channel_id, modelId: command.model_id, capturedAt: now, reason: '应用重启中断Runtime，无法核验Provider用量' }, now)
          result = { executionId: execution.id, commandId: candidate.owner_command_id, state: 'unknown_recorded', startBoundary, reason: startBoundary === 'started_proven' ? '启动已证实但终态与用量未知，已按未知用量撤权停等' : '中断Runtime已按未知用量撤权停等' }
        } catch {
          result = { executionId: execution.id, commandId: candidate.owner_command_id, state: 'stale_only', startBoundary, reason: '中断执行已置stale，结算失败留待人工对账' }
        }
      })()
    } catch { /* 单条失败不阻塞其余候选 */ }
    if (result) results.push(result)
  }
  return results
}
