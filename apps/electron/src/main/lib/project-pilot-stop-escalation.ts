/**
 * Project Pilot 停止请求未核验升级对账
 *
 * Pilot 执行的停止请求被 Runtime 接受但进程终止未核验时（stopRequested=true,
 * processTermination=NOT_VERIFIED），执行仍在运行、费用仍在累积风险中。本模块：
 * 1. 记录升级（每执行唯一）：暂停授权保留预算，留下待人工对账记录；
 * 2. 终态到达（已核验停止/完成/卡点/恢复 stale）时消解，附终态证据；
 * 3. 恢复路径不自动消解——stale 执行的升级保持 open，等待人工对账。
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
 * 停止请求未核验时调用：校验执行仍为运行中的 Pilot 执行后，暂停授权保留预算并
 * 写入升级记录。同一执行重复升级幂等拒绝（升级保持 open 直到消解）。
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
  const existing = database.prepare('SELECT * FROM pilot_stop_escalations WHERE execution_id = ?')
    .get(executionId) as EscalationRow | undefined
  if (existing && existing.resolved_at === null) throw new Error('Pilot 停止升级已存在')
  if (existing) throw new Error('Pilot 停止升级已消解，不能重复升级')
  // 保留预算：停止未核验期间不允许同一项目继续消耗授权。
  database.prepare("UPDATE pilot_runtime_grants SET state = 'paused' WHERE project_id = ? AND state = 'active'")
    .run(execution.projectId)
  const escalationId = randomUUID()
  database.prepare(`INSERT INTO pilot_stop_escalations
    (escalation_id, execution_id, command_id, project_id, session_id, expected_generation, requested_at, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(escalationId, executionId, execution.pilotCommandId, execution.projectId,
      execution.sessionId, expectedGeneration ?? null, now, reason.trim())
  const row = database.prepare('SELECT * FROM pilot_stop_escalations WHERE execution_id = ?')
    .get(executionId) as EscalationRow | undefined
  if (!row) throw new Error('Pilot 停止升级写入无法核验')
  return fromRow(row)
}

/** 终态到达时消解升级，附终态证据（停止核验结果/终态结果回执摘要）。 */
export function resolvePilotStopEscalation(
  executionId: string,
  resolution: string,
  resolutionEvidence: string,
  now = Date.now(),
): PilotStopEscalation {
  assertValidClock(now)
  if (!resolution?.trim()) throw new Error('Pilot 停止升级消解结论无效')
  if (!resolutionEvidence?.trim()) throw new Error('Pilot 停止升级消解证据无效')
  const database = getProjectDb()
  const row = database.prepare('SELECT * FROM pilot_stop_escalations WHERE execution_id = ?')
    .get(executionId) as EscalationRow | undefined
  if (!row) throw new Error('Pilot 停止升级不存在')
  if (row.resolved_at !== null) throw new Error('Pilot 停止升级已消解')
  if (now < row.requested_at) throw new Error('Pilot 停止升级消解时钟无效')
  database.prepare(`UPDATE pilot_stop_escalations
    SET resolved_at = ?, resolution = ?, resolution_evidence = ? WHERE execution_id = ? AND resolved_at IS NULL`)
    .run(now, resolution.trim(), resolutionEvidence.slice(0, 4000), executionId)
  const updated = database.prepare('SELECT * FROM pilot_stop_escalations WHERE execution_id = ?')
    .get(executionId) as EscalationRow | undefined
  if (!updated || updated.resolved_at === null) throw new Error('Pilot 停止升级消解无法核验')
  return fromRow(updated)
}

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
