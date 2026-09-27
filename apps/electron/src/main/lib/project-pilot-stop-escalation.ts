/**
 * Project Pilot 停止请求未核验升级对账
 *
 * 在向 Runtime 发送停止请求前先记录持久意图：请求可能失败、回调可能抢先到达，
 * 终止与费用均不能仅凭 abort 或普通终态推断。本模块：
 * 1. 意图（每执行唯一）与同项目授权暂停同事务落盘，保留预算待人工对账；
 * 2. 未核验停止后的普通终态并不等于已核验终止，升级保持 open；
 * 3. 没有可信终止回执前不自动消解；重启恢复亦保持 open。
 */

import { randomUUID } from 'node:crypto'
import { getAgentExecution, getProjectDb } from './project-sqlite-store'

function assertValidClock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Pilot 升级时钟无效')
}

export interface PilotStopEscalation {
  escalationId: string
  executionId: string
  commandId: string
  projectId: string
  sessionId: string
  expectedGeneration: number | null
  requestedAt: number
  reason: string
  resolvedAt: number | null
  resolution: string | null
  resolutionEvidence: string | null
}

interface EscalationRow {
  escalation_id: string
  execution_id: string
  command_id: string
  project_id: string
  session_id: string
  expected_generation: number | null
  requested_at: number
  reason: string
  resolved_at: number | null
  resolution: string | null
  resolution_evidence: string | null
}

function fromRow(row: EscalationRow): PilotStopEscalation {
  return {
    escalationId: row.escalation_id,
    executionId: row.execution_id,
    commandId: row.command_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    expectedGeneration: row.expected_generation,
    requestedAt: row.requested_at,
    reason: row.reason,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
    resolutionEvidence: row.resolution_evidence,
  }
}

/**
 * 发送停止请求前调用：校验执行仍为运行中的 Pilot 执行后，暂停授权保留预算并
 * 写入意图。同一执行重复意图拒绝，已有 open 记录始终待人工对账。
 */
export function recordPilotStopEscalation(
  executionId: string,
  reason: string,
  now = Date.now(),
  expectedGeneration?: number,
): PilotStopEscalation {
  assertValidClock(now)
  if (!reason?.trim()) throw new Error('Pilot 停止升级原因无效')
  const database = getProjectDb()
  if (database.isTransactionActive()) throw new Error('Pilot 停止升级不得嵌套未提交事务')
  const execution = getAgentExecution(executionId)
  if (!execution || !execution.pilotCommandId) throw new Error('Pilot 停止升级执行归属无法核验')
  if (execution.status !== 'running') throw new Error('Pilot 停止升级仅适用于运行中的执行')
  const escalationId = randomUUID()
  let result: PilotStopEscalation | undefined
  database.transaction(() => {
    const current = getAgentExecution(executionId)
    if (!current || current.status !== 'running' || current.pilotCommandId !== execution.pilotCommandId
      || current.sessionId !== execution.sessionId) throw new Error('Pilot 停止升级执行已变化')
    const existing = database.prepare('SELECT * FROM pilot_stop_escalations WHERE execution_id = ?')
      .get(executionId) as EscalationRow | undefined
    if (existing && existing.resolved_at === null) throw new Error('Pilot 停止升级已存在')
    if (existing) throw new Error('Pilot 停止升级已消解，不能重复升级')
    const commandId = current.pilotCommandId
    if (!commandId) throw new Error('Pilot 停止升级执行归属无法核验')
    const command = database.prepare('SELECT grant_id, project_id, execution_id FROM pilot_commands WHERE id = ?')
      .get(commandId) as { grant_id: string; project_id: string; execution_id: string } | undefined
    if (!command || command.project_id !== current.projectId || command.execution_id !== executionId) {
      throw new Error('Pilot 停止升级命令归属无法核验')
    }
    // 暂停同项目所有活动授权，并验证本命令授权也已停等；两者与升级记录同事务。
    database.prepare("UPDATE pilot_runtime_grants SET state = 'paused' WHERE project_id = ? AND state = 'active'")
      .run(current.projectId)
    const grant = database.prepare('SELECT state FROM pilot_runtime_grants WHERE id = ? AND project_id = ?')
      .get(command.grant_id, current.projectId) as { state: string } | undefined
    if (grant?.state !== 'paused') throw new Error('Pilot 停止升级授权暂停无法核验')
    database.prepare(`INSERT INTO pilot_stop_escalations
      (escalation_id, execution_id, command_id, project_id, session_id, expected_generation, requested_at, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(escalationId, executionId, commandId, current.projectId,
        current.sessionId, expectedGeneration ?? null, now, reason.trim())
    const row = database.prepare('SELECT * FROM pilot_stop_escalations WHERE execution_id = ?')
      .get(executionId) as EscalationRow | undefined
    if (!row) throw new Error('Pilot 停止升级写入无法核验')
    result = fromRow(row)
  })()
  if (!result) throw new Error('Pilot 停止升级未完成')
  return result
}

/** 只负责「先持久停等、再请求停止」的顺序；停止器结果不得当作退出回执。 */
export function requestPilotStopWithIntent<T>(executionId: string, generation: number, requestStop: () => T): T {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('Pilot 运行代际无效')
  recordPilotStopEscalation(executionId,
    '停止意图已持久化；Runtime 是否接受停止请求及终止状态待人工对账', Date.now(), generation)
  return requestStop()
}

// 自动消解暂不开放：停止确认对象不含可持久核验的 session/generation 凭据。
// 任何普通终态或 cancelled 状态都不能自行清理 open 升级。

/** 读取执行的开升级记录；无则 undefined。 */
export function getPilotStopEscalation(executionId: string): PilotStopEscalation | undefined {
  const row = getProjectDb().prepare('SELECT * FROM pilot_stop_escalations WHERE execution_id = ?')
    .get(executionId) as EscalationRow | undefined
  return row ? fromRow(row) : undefined
}

/** 项目维度列出开升级，供人工对账界面/审计使用。 */
export function listOpenPilotStopEscalations(projectId: string): PilotStopEscalation[] {
  const rows = getProjectDb().prepare(`SELECT * FROM pilot_stop_escalations
    WHERE project_id = ? AND resolved_at IS NULL ORDER BY requested_at ASC`).all(projectId) as EscalationRow[]
  return rows.map(fromRow)
}
