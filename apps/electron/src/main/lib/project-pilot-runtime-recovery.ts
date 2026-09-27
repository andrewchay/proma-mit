import { settlePilotCommandUsage } from './project-pilot-budget-ledger'
import { isPilotStartProven } from './project-pilot-start-receipt'
import { getAgentExecution, getProjectDb } from './project-sqlite-store'

export type PilotStartBoundary = 'claim_only' | 'handoff_intent' | 'started_proven' | 'missing_attempt' | 'invalid_attempt'

interface StartAttemptRow {
  command_id: string
  project_id: string
  session_id: string
  claimed_at: number
  handoff_intent_at: number | null
}

/** 该证据仅反映本地持久证据；claim_only/handoff_intent 不能反推 Runtime/Provider 是否执行。 */
function readPilotStartBoundary(execution: NonNullable<ReturnType<typeof getAgentExecution>>, now: number): PilotStartBoundary {
  const attempt = getProjectDb().prepare('SELECT * FROM pilot_runtime_start_attempts WHERE execution_id = ?')
    .get(execution.id) as StartAttemptRow | undefined
  if (!attempt) return 'missing_attempt'
  if (attempt.command_id !== execution.pilotCommandId || attempt.project_id !== execution.projectId
    || attempt.session_id !== execution.sessionId || !Number.isSafeInteger(attempt.claimed_at)
    || attempt.claimed_at < 0 || attempt.claimed_at > now
    || (attempt.handoff_intent_at !== null && (!Number.isSafeInteger(attempt.handoff_intent_at)
      || attempt.handoff_intent_at < attempt.claimed_at || attempt.handoff_intent_at > now))) return 'invalid_attempt'
  if (attempt.handoff_intent_at === null) return 'claim_only'
  // 有不可变开始回执且交接链完整时，启动事实已证；终态与费用仍按 unknown 处理。
  if (isPilotStartProven({
    id: execution.id,
    projectId: execution.projectId,
    sessionId: execution.sessionId,
    pilotCommandId: execution.pilotCommandId,
  }, now)) return 'started_proven'
  return 'handoff_intent'
}

export interface InterruptedPilotRuntimeRecovery {
  executionId: string
  commandId: string
  state: 'unknown_recorded' | 'needs_attention'
  /** 仅描述本地持久证据；missing_attempt 可来自旧库或记录损坏，不代表未启动。 */
  startBoundary: PilotStartBoundary
  reason: string
}

/** 重启后 Runtime 已不可追踪：终结遗留执行，未知费用占额，并撤销同项目活动授权。 */
export function recoverInterruptedPilotRuntimeExecutions(now = Date.now()): InterruptedPilotRuntimeRecovery[] {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Pilot 恢复时钟无效')
  const database = getProjectDb()
  const candidates = database.prepare(`SELECT id, project_id, pilot_command_id FROM agent_executions
    WHERE status = 'running' AND pilot_command_id IS NOT NULL ORDER BY started_at, id`)
    .all() as Array<{ id: string; project_id: string; pilot_command_id: string }>
  const results: InterruptedPilotRuntimeRecovery[] = []
  for (const candidate of candidates) {
    let result: InterruptedPilotRuntimeRecovery | undefined
    let startBoundary: PilotStartBoundary = 'invalid_attempt'
    try {
      database.transaction(() => {
        const execution = getAgentExecution(candidate.id)
        if (!execution || execution.status !== 'running' || execution.pilotCommandId !== candidate.pilot_command_id) return
        startBoundary = readPilotStartBoundary(execution, now)
        // 命令或授权损坏时也先撤权，避免继续派发；结算失败只留待人工对账。
        database.prepare("UPDATE pilot_runtime_grants SET state = 'paused' WHERE project_id = ? AND state = 'active'")
          .run(execution.projectId)
        const stale = database.prepare(`UPDATE agent_executions
          SET status = 'stale', error = ?, last_heartbeat_at = ?, completed_at = ?
          WHERE id = ? AND project_id = ? AND status = 'running' AND pilot_command_id = ?`)
          .run('应用重启后 Runtime 状态与用量未知，已暂停 Pilot 等待对账', now, now,
            execution.id, execution.projectId, candidate.pilot_command_id)
        if (stale.changes !== 1) throw new Error('Pilot 中断执行状态已变化')
        try {
          if (!execution.sessionId.trim()) throw new Error('中断执行缺少会话')
          const command = database.prepare(`SELECT c.state, c.actual_cost_micros AS actualCostMicros,
            c.usage_evidence AS usageEvidence, c.usage_record_key AS usageRecordKey,
            g.channel_id AS channelId, g.model_id AS modelId
            FROM pilot_commands c
            JOIN pilot_runtime_grants g ON g.id = c.grant_id AND g.project_id = c.project_id
            WHERE c.id = ? AND c.project_id = ? AND c.execution_id = ?`)
            .get(candidate.pilot_command_id, execution.projectId, execution.id) as
              { state: string; actualCostMicros: number | null; usageEvidence: string | null;
                usageRecordKey: string | null; channelId: string; modelId: string } | undefined
          if (!command || command.state !== 'running' || command.actualCostMicros !== null
            || command.usageEvidence !== null || command.usageRecordKey !== null) {
            throw new Error('中断执行命令缺失或已有费用证据')
          }
          settlePilotCommandUsage(candidate.pilot_command_id, {
            source: 'unknown', executionId: execution.id, sessionId: execution.sessionId,
            channelId: command.channelId, modelId: command.modelId, capturedAt: now,
            reason: '应用重启中断 Runtime，无法核验 Provider 用量',
          }, now)
          result = { executionId: execution.id, commandId: candidate.pilot_command_id,
            state: 'unknown_recorded', startBoundary,
            reason: startBoundary === 'started_proven'
              ? '启动已证实但终态与用量未知，已按未知用量撤权停等'
              : '中断 Runtime 已按未知用量撤权停等' }
          // 停止升级保持 open 供人工对账，恢复路径不自动消解。
          const escalation = database.prepare(`SELECT reason FROM pilot_stop_escalations
            WHERE execution_id = ? AND resolved_at IS NULL`).get(execution.id) as { reason: string } | undefined
          if (escalation) result = { ...result, reason: `${result.reason}；停止升级待人工对账：${escalation.reason}` }
        } catch {
          result = { executionId: execution.id, commandId: candidate.pilot_command_id,
            state: 'needs_attention', startBoundary, reason: '中断执行用量或账本无法核验，授权已暂停' }
        }
      })()
    } catch {
      // 事务回滚时单独撤权；即使某一执行写入失败，也继续检查其余项目。
      let paused = false
      try {
        database.prepare("UPDATE pilot_runtime_grants SET state = 'paused' WHERE project_id = ? AND state = 'active'")
          .run(candidate.project_id)
        paused = true
      } catch { /* 数据库不可写时只能在结果中如实报告 */ }
      result = { executionId: candidate.id, commandId: candidate.pilot_command_id,
        state: 'needs_attention', startBoundary, reason: paused ? '中断执行恢复失败，授权已暂停' : '中断执行恢复失败，授权暂停未能核验' }
    }
    if (result) results.push(result)
  }
  return results
}
