/**
 * Project Pilot 实际开始回执
 *
 * 交接意图（pilot_runtime_start_attempts.handoff_intent_at）只证明"我们打算调用
 * runner"；崩溃窗口内 Runtime/Provider 是否真正开始仍然未知。本模块在 runner
 * 确认 Runtime 已产出首个活动（adapter 首条消息到达）后写入不可变开始回执，
 * 使"启动事实"在重启恢复时可被区分：有有效回执 = 启动已证、终态与费用仍 unknown；
 * 无回执 = 启动仍 unknown，保持保守停等。
 */

import { getAgentExecution, getProjectDb } from './project-sqlite-store'

function assertValidClock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Pilot 回执时钟无效')
}

export interface PilotRuntimeStartReceipt {
  executionId: string
  commandId: string
  projectId: string
  sessionId: string
  runnerName: string
  processId: number | null
  startedAt: number
  receivedAt: number
}

interface StartAttemptRow {
  command_id: string
  project_id: string
  session_id: string
  claimed_at: number
  handoff_intent_at: number | null
}

interface ReceiptRow {
  execution_id: string
  command_id: string
  project_id: string
  session_id: string
  runner_name: string
  process_id: number | null
  started_at: number
  received_at: number
}

function fromRow(row: ReceiptRow): PilotRuntimeStartReceipt {
  return {
    executionId: row.execution_id,
    commandId: row.command_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    runnerName: row.runner_name,
    processId: row.process_id,
    startedAt: row.started_at,
    receivedAt: row.received_at,
  }
}

/**
 * runner 确认 Runtime 已产出首个活动后调用。校验执行归属、交接链完整性与时钟
 * 单调性后写入不可变回执；重复调用幂等拒绝。回执不证明终态与费用，只证明启动。
 */
export function recordPilotRuntimeStarted(
  executionId: string,
  commandId: string,
  sessionId: string,
  receipt: { runnerName: string; processId?: number | null; startedAt?: number },
  now = Date.now(),
): PilotRuntimeStartReceipt {
  assertValidClock(now)
  if (!sessionId?.trim()) throw new Error('Pilot 开始回执会话无效')
  if (!receipt?.runnerName?.trim()) throw new Error('Pilot 开始回执 runner 身份无效')
  const startedAt = receipt.startedAt ?? now
  assertValidClock(startedAt)
  if (startedAt > now) throw new Error('Pilot 开始回执时间不能晚于接收时间')
  if (receipt.processId !== undefined && receipt.processId !== null
    && (!Number.isSafeInteger(receipt.processId) || receipt.processId <= 0)) {
    throw new Error('Pilot 开始回执进程号无效')
  }
  const database = getProjectDb()
  if (database.isTransactionActive()) throw new Error('Pilot 开始回执不得嵌套未提交事务')
  const execution = getAgentExecution(executionId)
  if (!execution || execution.pilotCommandId !== commandId) throw new Error('Pilot 开始回执执行归属无法核验')
  if (!execution.projectId?.trim()) throw new Error('Pilot 开始回执项目无效')
  const attempt = database.prepare('SELECT * FROM pilot_runtime_start_attempts WHERE execution_id = ?')
    .get(executionId) as StartAttemptRow | undefined
  if (!attempt) throw new Error('Pilot 开始回执缺少启动认领记录')
  if (attempt.command_id !== commandId || attempt.project_id !== execution.projectId
    || attempt.session_id !== sessionId) throw new Error('Pilot 开始回执与启动认领不一致')
  if (attempt.handoff_intent_at === null) throw new Error('Pilot 开始回执缺少交接意图')
  if (attempt.claimed_at > now || attempt.handoff_intent_at > now
    || attempt.handoff_intent_at < attempt.claimed_at) throw new Error('Pilot 开始回执交接链时钟无效')
  // 启动活动不得早于交接意图：回执来自交接之后的 runner 运行。
  if (startedAt < attempt.handoff_intent_at) throw new Error('Pilot 开始回执早于交接意图')
  const existing = database.prepare('SELECT * FROM pilot_runtime_start_receipts WHERE execution_id = ?')
    .get(executionId) as ReceiptRow | undefined
  if (existing) throw new Error('Pilot 开始回执已存在')
  database.prepare(`INSERT INTO pilot_runtime_start_receipts
    (execution_id, command_id, project_id, session_id, runner_name, process_id, started_at, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(executionId, commandId, execution.projectId, sessionId, receipt.runnerName,
      receipt.processId ?? null, startedAt, now)
  const row = database.prepare('SELECT * FROM pilot_runtime_start_receipts WHERE execution_id = ?')
    .get(executionId) as ReceiptRow | undefined
  if (!row) throw new Error('Pilot 开始回执写入无法核验')
  return fromRow(row)
}

/** 读取开始回执；不存在返回 undefined。仅供恢复对账与审计读取。 */
export function readPilotRuntimeStartReceipt(executionId: string): PilotRuntimeStartReceipt | undefined {
  const row = getProjectDb().prepare('SELECT * FROM pilot_runtime_start_receipts WHERE execution_id = ?')
    .get(executionId) as ReceiptRow | undefined
  return row ? fromRow(row) : undefined
}

/**
 * 校验回执与执行/交接链的一致性。返回 true 表示"启动事实已证"；
 * 回执缺失或链断裂都返回 false，调用方必须保持"启动未知"的保守结论。
 */
export function isPilotStartProven(execution: {
  id: string
  projectId: string
  sessionId: string
  pilotCommandId?: string | null
}, now = Date.now()): boolean {
  assertValidClock(now)
  if (!execution.pilotCommandId) return false
  const database = getProjectDb()
  const attempt = database.prepare('SELECT * FROM pilot_runtime_start_attempts WHERE execution_id = ?')
    .get(execution.id) as StartAttemptRow | undefined
  if (!attempt || attempt.handoff_intent_at === null) return false
  if (attempt.command_id !== execution.pilotCommandId || attempt.project_id !== execution.projectId
    || attempt.session_id !== execution.sessionId) return false
  if (attempt.claimed_at > now || attempt.handoff_intent_at > now
    || attempt.handoff_intent_at < attempt.claimed_at) return false
  const receipt = database.prepare('SELECT * FROM pilot_runtime_start_receipts WHERE execution_id = ?')
    .get(execution.id) as ReceiptRow | undefined
  if (!receipt) return false
  if (receipt.command_id !== execution.pilotCommandId || receipt.project_id !== execution.projectId
    || receipt.session_id !== execution.sessionId) return false
  if (receipt.started_at > now || receipt.received_at > now || receipt.received_at < receipt.started_at
    || receipt.started_at < attempt.handoff_intent_at) return false
  return true
}
