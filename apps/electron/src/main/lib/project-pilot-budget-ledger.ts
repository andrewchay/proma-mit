import { createHash } from 'node:crypto'
import type { PilotGrantBudgetUsage } from '@gravitas/shared'
import { createAgentExecution, getAgentExecution, getProjectDb, getTask, listTaskBlockers, listTaskStatuses } from './project-sqlite-store'
import { assertPilotExecutionLinked, registerPilotCommandLink } from './project-pilot-command-links'
import { resolveStateGroup } from './task-status-logic'
import type { AgentExecution, Task } from './project-types'
import type { PilotPolicy } from './project-pilot-policy'
import { withPilotPolicySnapshot } from './project-pilot-policy'
import { hashPilotGrantApproval } from './project-pilot-grant-issue'

/** 仅供受控派发层使用的账本原语；调用方仍须先重验候选、readiness 与活动 grant。 */
export interface PilotCommandReservationInput {
  commandId: string
  projectId: string
  grantId: string
  idempotencyKey: string
  taskId: string
  sourceVersion: number
  sourceHash: string
  employeeId: string
  role: 'executor' | 'reviewer'
  reworkOrdinal: number
}

export interface PilotCommandReservation extends PilotCommandReservationInput {
  reservedCostMicros: number
  state: 'reserved' | 'queued' | 'running' | 'settled' | 'released' | 'needs_reconcile'
  actualCostMicros: number | null
  executionId: string | null
  createdAt: number
  updatedAt: number
}

interface GrantRow {
  id: string
  project_id: string
  policy_revision: number
  state: 'paused' | 'active'
  workspace_id: string
  channel_id: string
  model_id: string
  executor_employee_id: string
  reviewer_employee_id: string
  max_cost_micros: number
  max_runs: number
  max_rework: number
  expires_at: number
  approval_fingerprint: string | null
}

function assertGrantMatchesPolicy(grant: GrantRow, policy: PilotPolicy): void {
  if (policy.revision !== grant.policy_revision
    || grant.approval_fingerprint !== hashPilotGrantApproval(policy)
    || policy.workspaceId !== grant.workspace_id || policy.channelId !== grant.channel_id
    || policy.modelId !== grant.model_id || policy.executorEmployeeId !== grant.executor_employee_id
    || policy.reviewerEmployeeId !== grant.reviewer_employee_id
    || policy.maxCostMicros !== grant.max_cost_micros || policy.maxRuns !== grant.max_runs
    || policy.maxRework !== grant.max_rework || policy.expiresAt !== grant.expires_at) {
    throw new Error('Pilot 活动授权与当前策略不一致')
  }
}

function withGrantPolicySnapshot<T>(projectId: string, grantId: string, operation: (policy: PilotPolicy) => T): T {
  const grant = getProjectDb().prepare('SELECT policy_revision FROM pilot_runtime_grants WHERE id = ? AND project_id = ?')
    .get(grantId, projectId) as { policy_revision: number } | undefined
  if (!grant) throw new Error('Pilot 活动授权不存在或已失效')
  return withPilotPolicySnapshot(projectId, grant.policy_revision, operation)
}

interface CommandRow {
  id: string
  project_id: string
  grant_id: string
  idempotency_key: string
  source_task_id: string
  source_version: number
  source_hash: string
  employee_id: string
  role: 'executor' | 'reviewer'
  rework_ordinal: number
  reserved_cost_micros: number
  actual_cost_micros: number | null
  usage_evidence: string | null
  usage_record_key: string | null
  state: PilotCommandReservation['state']
  execution_id: string | null
  created_at: number
  updated_at: number
}

function fromRow(row: CommandRow): PilotCommandReservation {
  return { commandId: row.id, projectId: row.project_id, grantId: row.grant_id,
    idempotencyKey: row.idempotency_key, taskId: row.source_task_id,
    sourceVersion: row.source_version, sourceHash: row.source_hash, employeeId: row.employee_id,
    role: row.role, reworkOrdinal: row.rework_ordinal, reservedCostMicros: row.reserved_cost_micros,
    actualCostMicros: row.actual_cost_micros, state: row.state, executionId: row.execution_id,
    createdAt: row.created_at, updatedAt: row.updated_at }
}

/** 冻结任务的派发相关字段；时间戳相同但内容变化仍会失效。 */
export function hashPilotTaskSource(task: Task): string {
  return createHash('sha256').update(JSON.stringify({
    id: task.id, projectId: task.projectId, updatedAt: task.updatedAt,
    title: task.title, description: task.description, status: task.status,
    assigneeUserId: task.assignee?.userId, workspaceId: task.workspaceId,
    developmentScope: task.developmentScope,
  })).digest('hex')
}

function validateInput(input: PilotCommandReservationInput): void {
  const ids = [input.commandId, input.projectId, input.grantId, input.idempotencyKey, input.taskId, input.employeeId]
  if (ids.some((value) => typeof value !== 'string' || !value.trim())
    || !Number.isSafeInteger(input.sourceVersion) || input.sourceVersion < 0
    || !/^[a-f0-9]{64}$/.test(input.sourceHash)
    || (input.role !== 'executor' && input.role !== 'reviewer')
    || !Number.isSafeInteger(input.reworkOrdinal) || input.reworkOrdinal < 0) {
    throw new Error('Pilot 预算预留参数无效')
  }
}

function assertValidClock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Pilot 时钟无效')
}

function sameCommand(row: CommandRow, input: PilotCommandReservationInput): boolean {
  return row.id === input.commandId && row.project_id === input.projectId && row.grant_id === input.grantId
    && row.idempotency_key === input.idempotencyKey && row.source_task_id === input.taskId
    && row.source_version === input.sourceVersion && row.source_hash === input.sourceHash
    && row.employee_id === input.employeeId && row.role === input.role
    && row.rework_ordinal === input.reworkOrdinal
}

function readBudgetUsage(grantId: string): { runReservations: number; committedCostMicros: number } {
  const row = getProjectDb().prepare(`SELECT COALESCE(SUM(CASE WHEN state = 'released' THEN 0 ELSE 1 END), 0) AS runs,
    COALESCE(SUM(CASE WHEN state = 'released' THEN 0 WHEN state = 'settled' AND actual_cost_micros IS NOT NULL THEN actual_cost_micros WHEN actual_cost_micros > reserved_cost_micros THEN actual_cost_micros ELSE reserved_cost_micros END), 0) AS committed
    FROM pilot_commands WHERE grant_id = ?`).get(grantId) as { runs: number; committed: number }
  if (!Number.isSafeInteger(row.runs) || !Number.isSafeInteger(row.committed) || row.committed < 0) {
    throw new Error('Pilot 预算账本无法核验')
  }
  return { runReservations: row.runs, committedCostMicros: row.committed }
}

/** 是否存在已结算的执行命令：评审命令只允许在执行链闭环后派发，先评审后执行视为编排异常。 */
export function hasSettledPilotExecutorRun(projectId: string, grantId: string): boolean {
  if (typeof projectId !== 'string' || !projectId.trim() || typeof grantId !== 'string' || !grantId.trim()) {
    throw new Error('Pilot 结算查询参数无效')
  }
  const row = getProjectDb().prepare(`SELECT 1 FROM pilot_commands
    WHERE project_id = ? AND grant_id = ? AND role = 'executor' AND state = 'settled' LIMIT 1`).get(projectId, grantId)
  return row !== undefined
}

/** 在已锁定的策略快照内预留费用和次数；不创建 Agent execution，也不调用模型。 */
function reservePilotCommandBudgetLocked(
  input: PilotCommandReservationInput,
  now: number,
  policy: PilotPolicy,
): PilotCommandReservation {
  const database = getProjectDb()
  const unresolvedStop = database.prepare(`SELECT 1 FROM pilot_stop_escalations
    WHERE project_id = ? AND resolved_at IS NULL LIMIT 1`).get(input.projectId)
  if (unresolvedStop) throw new Error('Pilot 停止升级待人工对账，拒绝预留新命令')
  const previous = database.prepare('SELECT * FROM pilot_commands WHERE grant_id = ? AND idempotency_key = ?')
    .get(input.grantId, input.idempotencyKey) as CommandRow | undefined
  if (previous) {
    if (!sameCommand(previous, input)) throw new Error('Pilot 命令幂等键已对应其他内容')
    return fromRow(previous)
  }
  const grant = database.prepare('SELECT * FROM pilot_runtime_grants WHERE id = ? AND project_id = ?')
    .get(input.grantId, input.projectId) as GrantRow | undefined
  if (!grant || grant.state !== 'active' || grant.expires_at <= now) throw new Error('Pilot 活动授权不存在或已失效')
  assertGrantMatchesPolicy(grant, policy)
  if (input.reworkOrdinal > grant.max_rework) throw new Error('Pilot 返工次数超出授权')
  const expectedEmployee = input.role === 'executor' ? grant.executor_employee_id : grant.reviewer_employee_id
  if (input.employeeId !== expectedEmployee) throw new Error('Pilot 命令员工不在授权角色内')

  const task = getTask(input.taskId)
  if (!task || task.projectId !== input.projectId || task.workspaceId !== grant.workspace_id
    || task.assignee?.userId !== `agent-${input.employeeId}`) throw new Error('Pilot 任务、项目、工作区或负责人不匹配')
  const group = resolveStateGroup(task.status, listTaskStatuses(input.projectId))
  if (task.status === 'draft' || task.status === 'paused' || (group !== 'unstarted' && group !== 'started')) {
    throw new Error('Pilot 任务状态不可派发')
  }
  if (task.updatedAt !== input.sourceVersion || hashPilotTaskSource(task) !== input.sourceHash) {
    throw new Error('Pilot 命令来源版本已变化')
  }
  if (listTaskBlockers(input.projectId).some((blocker) => blocker.taskId === task.id)) {
    throw new Error('Pilot 任务依赖尚未解除')
  }
  const activeTaskCommand = database.prepare(`SELECT id FROM pilot_commands
    WHERE project_id = ? AND source_task_id = ? AND role = ? AND state IN ('reserved', 'queued', 'running', 'needs_reconcile') LIMIT 1`)
    .get(input.projectId, input.taskId, input.role) as { id: string } | undefined
  if (activeTaskCommand) throw new Error('Pilot 任务已有未结命令')

  const usage = readBudgetUsage(input.grantId)
  if (usage.runReservations >= grant.max_runs) throw new Error('Pilot 执行次数额度已耗尽')
  const remainingCostMicros = grant.max_cost_micros - usage.committedCostMicros
  const remainingRuns = grant.max_runs - usage.runReservations
  const reservedCostMicros = Math.ceil(remainingCostMicros / remainingRuns)
  if (!Number.isSafeInteger(grant.max_cost_micros) || grant.max_cost_micros <= 0
    || !Number.isSafeInteger(remainingCostMicros) || remainingCostMicros <= 0
    || !Number.isSafeInteger(reservedCostMicros) || reservedCostMicros <= 0) {
    throw new Error('Pilot 费用额度不足或无法核验')
  }

  database.prepare(`INSERT INTO pilot_commands
      (id, project_id, grant_id, idempotency_key, source_task_id, source_version, source_hash,
       employee_id, role, rework_ordinal, reserved_cost_micros, actual_cost_micros, state, execution_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'reserved', NULL, ?, ?)`).run(
      input.commandId, input.projectId, input.grantId, input.idempotencyKey, input.taskId,
      input.sourceVersion, input.sourceHash, input.employeeId, input.role, input.reworkOrdinal,
      reservedCostMicros, now, now,
    )
  return { ...input, reservedCostMicros, state: 'reserved', actualCostMicros: null, executionId: null, createdAt: now, updatedAt: now }
}

export function reservePilotCommandBudget(input: PilotCommandReservationInput, now = Date.now()): PilotCommandReservation {
  validateInput(input)
  assertValidClock(now)
  return withGrantPolicySnapshot(input.projectId, input.grantId, (policy) => {
    let result: PilotCommandReservation | undefined
    getProjectDb().transaction(() => { result = reservePilotCommandBudgetLocked(input, now, policy) })()
    if (!result) throw new Error('Pilot 命令预留未完成')
    return result
  })
}

/** 仅内部持久化切片：预留、排队执行和来源关联同事务提交；不会启动 Runtime。 */
export function reserveAndQueuePilotCommand(
  input: PilotCommandReservationInput,
  queue: { executionId: string; prompt: string },
  now = Date.now(),
): { command: PilotCommandReservation; execution: AgentExecution } {
  validateInput(input)
  assertValidClock(now)
  if (!queue.executionId?.trim() || !queue.prompt?.trim()) throw new Error('Pilot 排队执行参数无效')
  return withGrantPolicySnapshot(input.projectId, input.grantId, (policy) => {
    const database = getProjectDb()
    let result: { command: PilotCommandReservation; execution: AgentExecution } | undefined
    database.transaction(() => {
      const reservation = reservePilotCommandBudgetLocked(input, now, policy)
      const grant = database.prepare('SELECT * FROM pilot_runtime_grants WHERE id = ? AND project_id = ?')
        .get(input.grantId, input.projectId) as GrantRow | undefined
      if (!grant || grant.state !== 'active' || grant.expires_at <= now) throw new Error('Pilot 活动授权不存在或已失效')
      assertGrantMatchesPolicy(grant, policy)
      if (reservation.state === 'queued') {
        const existing = getAgentExecution(queue.executionId)
        if (reservation.executionId !== queue.executionId || !existing || existing.prompt !== queue.prompt) {
          throw new Error('Pilot 命令幂等键已对应其他排队执行')
        }
        assertPilotCommandStartRecordLocked(queue.executionId, input.commandId, grant.policy_revision, now, policy)
        assertPilotExecutionLinked(queue.executionId, grant.policy_revision)
        result = { command: reservation, execution: existing }
        return
      }
      if (reservation.state !== 'reserved' || reservation.executionId) throw new Error('Pilot 命令状态不可排队')
      const execution = createAgentExecution({ id: queue.executionId, projectId: input.projectId,
        entityType: 'task', entityId: input.taskId, agentId: input.employeeId, sessionId: '',
        pilotCommandId: input.commandId, prompt: queue.prompt, startedAt: now })
      const updated = database.prepare(`UPDATE pilot_commands SET state = 'queued', execution_id = ?, updated_at = ?
        WHERE id = ? AND grant_id = ? AND state = 'reserved' AND execution_id IS NULL`)
        .run(queue.executionId, now, input.commandId, input.grantId)
      if (updated.changes !== 1) throw new Error('Pilot 命令排队状态已变化')
      registerPilotCommandLink({ commandId: input.commandId, projectId: input.projectId,
        executionId: queue.executionId, policyRevision: grant.policy_revision })
      const command = assertPilotCommandStartRecordLocked(queue.executionId, input.commandId, grant.policy_revision, now, policy)
      result = { command, execution }
    })()
    if (!result) throw new Error('Pilot 命令排队未完成')
    return result
  })
}

/** 取消尚未启动的 Pilot 执行，并在同一事务释放费用与次数预留。 */
export function cancelQueuedPilotCommand(
  executionId: string,
  reason: string,
  now = Date.now(),
): { command: PilotCommandReservation; execution: AgentExecution } {
  assertValidClock(now)
  if (!executionId?.trim() || !reason?.trim()) throw new Error('Pilot 排队取消参数无效')
  const database = getProjectDb()
  let result: { command: PilotCommandReservation; execution: AgentExecution } | undefined
  database.transaction(() => {
    const execution = getAgentExecution(executionId)
    if (!execution?.pilotCommandId || execution.status !== 'queued' || execution.sessionId !== '') {
      throw new Error('Pilot 排队执行已变化或归属无法核验')
    }
    assertPilotExecutionLinked(executionId)
    const command = database.prepare('SELECT * FROM pilot_commands WHERE id = ? AND project_id = ?')
      .get(execution.pilotCommandId, execution.projectId) as CommandRow | undefined
    if (!command || command.execution_id !== executionId || command.state !== 'queued'
      || command.source_task_id !== execution.entityId || command.employee_id !== execution.agentId) {
      throw new Error('Pilot 排队命令已变化或归属无法核验')
    }
    const cancelled = database.prepare(`UPDATE agent_executions
      SET status = 'cancelled', error = ?, last_heartbeat_at = ?, completed_at = ?
      WHERE id = ? AND project_id = ? AND pilot_command_id = ? AND status = 'queued' AND session_id = ''`)
      .run(reason, now, now, executionId, execution.projectId, execution.pilotCommandId)
    const released = database.prepare(`UPDATE pilot_commands
      SET state = 'released', actual_cost_micros = 0, updated_at = ?
      WHERE id = ? AND project_id = ? AND execution_id = ? AND state = 'queued'`)
      .run(now, execution.pilotCommandId, execution.projectId, executionId)
    if (cancelled.changes !== 1 || released.changes !== 1) throw new Error('Pilot 排队取消状态已变化')
    const currentExecution = getAgentExecution(executionId)
    const currentCommand = database.prepare('SELECT * FROM pilot_commands WHERE id = ?')
      .get(execution.pilotCommandId) as CommandRow | undefined
    if (!currentExecution || !currentCommand) throw new Error('Pilot 排队取消无法核验')
    result = { execution: currentExecution, command: fromRow(currentCommand) }
  })()
  if (!result) throw new Error('Pilot 排队取消未完成')
  return result
}

/** 启动前只核验已入账且绑定本次执行的命令；本函数不启动 Runtime。 */
function assertPilotCommandStartRecordLocked(
  executionId: string,
  commandId: string,
  expectedPolicyRevision: number,
  now: number,
  policy: PilotPolicy,
  runningSessionId?: string,
): PilotCommandReservation {
  const execution = getAgentExecution(executionId)
  if (!execution || execution.pilotCommandId !== commandId
    || execution.status !== (runningSessionId ? 'running' : 'queued')
    || execution.sessionId !== (runningSessionId ?? '')) {
    throw new Error('Pilot 执行归属或排队状态无法核验')
  }
  const row = getProjectDb().prepare('SELECT * FROM pilot_commands WHERE id = ? AND project_id = ?')
    .get(commandId, execution.projectId) as CommandRow | undefined
  if (!row || row.state !== (runningSessionId ? 'running' : 'queued') || row.execution_id !== executionId || row.employee_id !== execution.agentId
    || row.source_task_id !== execution.entityId || row.reserved_cost_micros <= 0) {
    throw new Error('Pilot 已预留命令与执行不匹配')
  }
  const grant = getProjectDb().prepare('SELECT * FROM pilot_runtime_grants WHERE id = ? AND project_id = ?')
    .get(row.grant_id, execution.projectId) as GrantRow | undefined
  if (!grant || grant.state !== 'active' || grant.policy_revision !== expectedPolicyRevision || grant.expires_at <= now
    || row.employee_id !== (row.role === 'executor' ? grant.executor_employee_id : grant.reviewer_employee_id)) {
    throw new Error('Pilot 命令活动授权已失效')
  }
  assertGrantMatchesPolicy(grant, policy)
  const task = getTask(row.source_task_id)
  if (!task || task.projectId !== execution.projectId || task.workspaceId !== grant.workspace_id
    || task.assignee?.userId !== `agent-${row.employee_id}`
    || task.updatedAt !== row.source_version || hashPilotTaskSource(task) !== row.source_hash) {
    throw new Error('Pilot 命令来源已变化')
  }
  if (listTaskBlockers(execution.projectId).some((blocker) => blocker.taskId === task.id)) {
    throw new Error('Pilot 任务依赖尚未解除')
  }
  return fromRow(row)
}

export function assertPilotCommandStartRecord(executionId: string, commandId: string, expectedPolicyRevision: number, now = Date.now()): PilotCommandReservation {
  assertValidClock(now)
  const execution = getAgentExecution(executionId)
  if (!execution?.pilotCommandId) throw new Error('Pilot 执行归属或排队状态无法核验')
  const command = getProjectDb().prepare('SELECT grant_id FROM pilot_commands WHERE id = ? AND project_id = ?')
    .get(commandId, execution.projectId) as { grant_id: string } | undefined
  if (!command) throw new Error('Pilot 已预留命令与执行不匹配')
  return withGrantPolicySnapshot(execution.projectId, command.grant_id, (policy) => (
    assertPilotCommandStartRecordLocked(executionId, commandId, expectedPolicyRevision, now, policy)
  ))
}

/** 在同一 SQLite 事务内认领命令和执行；事务提交后才允许调用 Runtime。 */
export function claimPilotCommandStart(
  executionId: string,
  commandId: string,
  expectedPolicyRevision: number,
  sessionId: string,
  now = Date.now(),
): { command: PilotCommandReservation; execution: AgentExecution } {
  assertValidClock(now)
  if (!sessionId?.trim()) throw new Error('Pilot 启动会话无效')
  if (getProjectDb().isTransactionActive()) throw new Error('Pilot 启动认领不得嵌套未提交事务')
  const execution = getAgentExecution(executionId)
  if (!execution?.pilotCommandId) throw new Error('Pilot 执行归属或排队状态无法核验')
  const command = getProjectDb().prepare('SELECT grant_id FROM pilot_commands WHERE id = ? AND project_id = ?')
    .get(commandId, execution.projectId) as { grant_id: string } | undefined
  if (!command) throw new Error('Pilot 已预留命令与执行不匹配')
  return withGrantPolicySnapshot(execution.projectId, command.grant_id, (policy) => {
    const database = getProjectDb()
    let result: { command: PilotCommandReservation; execution: AgentExecution } | undefined
    database.transaction(() => {
      assertPilotCommandStartRecordLocked(executionId, commandId, expectedPolicyRevision, now, policy)
      const claimedExecution = database.prepare(`UPDATE agent_executions
        SET status = 'running', session_id = ?, last_heartbeat_at = ?
        WHERE id = ? AND pilot_command_id = ? AND status = 'queued' AND session_id = ''`)
        .run(sessionId, now, executionId, commandId)
      const claimedCommand = database.prepare(`UPDATE pilot_commands SET state = 'running', updated_at = ?
        WHERE id = ? AND execution_id = ? AND state = 'queued'`)
        .run(now, commandId, executionId)
      if (claimedExecution.changes !== 1 || claimedCommand.changes !== 1) {
        throw new Error('Pilot 启动认领状态已变化')
      }
      database.prepare(`INSERT INTO pilot_runtime_start_attempts
        (execution_id, command_id, project_id, session_id, claimed_at)
        VALUES (?, ?, ?, ?, ?)`).run(executionId, commandId, execution.projectId, sessionId, now)
      const currentExecution = getAgentExecution(executionId)
      const currentCommand = database.prepare('SELECT * FROM pilot_commands WHERE id = ?').get(commandId) as CommandRow | undefined
      if (!currentExecution || !currentCommand) throw new Error('Pilot 启动认领无法核验')
      result = { execution: currentExecution, command: fromRow(currentCommand) }
    })()
    if (!result) throw new Error('Pilot 启动认领未完成')
    return result
  })
}

/** runner 调用前持久化交接意图；崩溃时是否实际调用仍未知，不能当成 Runtime/Provider 启动证据。 */
export function recordPilotRunnerHandoffIntent(executionId: string, commandId: string, sessionId: string, now = Date.now()): void {
  assertValidClock(now)
  if (getProjectDb().isTransactionActive()) throw new Error('Pilot 启动交接不得嵌套未提交事务')
  const execution = getAgentExecution(executionId)
  if (!execution || execution.pilotCommandId !== commandId) throw new Error('Pilot 交接执行归属无法核验')
  const command = getProjectDb().prepare('SELECT grant_id FROM pilot_commands WHERE id = ? AND project_id = ?')
    .get(commandId, execution.projectId) as { grant_id: string } | undefined
  if (!command) throw new Error('Pilot 交接命令无法核验')
  withGrantPolicySnapshot(execution.projectId, command.grant_id, (policy) => {
    const database = getProjectDb()
    database.transaction(() => {
      const grant = database.prepare('SELECT policy_revision FROM pilot_runtime_grants WHERE id = ? AND project_id = ?')
        .get(command.grant_id, execution.projectId) as { policy_revision: number } | undefined
      if (!grant) throw new Error('Pilot 交接授权无法核验')
      assertPilotCommandStartRecordLocked(executionId, commandId, grant.policy_revision, now, policy, sessionId)
      const changed = database.prepare(`UPDATE pilot_runtime_start_attempts SET handoff_intent_at = ?
        WHERE execution_id = ? AND command_id = ? AND project_id = ? AND session_id = ?
          AND handoff_intent_at IS NULL AND claimed_at <= ?`)
        .run(now, executionId, commandId, execution.projectId, sessionId, now)
      if (changed.changes !== 1) throw new Error('Pilot Runtime 启动交接状态无法核验或已记录')
    })()
  })
}

export interface PilotCommandSettlement {
  commandId: string
  state: 'settled' | 'needs_reconcile'
  actualCostMicros: number | null
  grantPaused: boolean
}

interface PilotUsageEvidenceBase {
  executionId: string
  sessionId: string
  channelId: string
  modelId: string
  capturedAt: number
}

export type PilotUsageEvidence = PilotUsageEvidenceBase & (
  | { source: 'provider_reported'; providerRecordId: string; inputTokens: number; outputTokens: number; costMicros: number }
  | { source: 'runtime_reported'; runtimeReceiptId: string; payloadHash: string; inputTokens: number; outputTokens: number; costMicros: number }
  | { source: 'traceable_estimate'; priceSource: string; inputTokens: number; outputTokens: number; costMicros: number }
  | { source: 'request_settled'; requestSettlementIds: string[]; costMicros: number }
  | { source: 'unknown'; reason: string; runtimeReceiptId?: string; payloadHash?: string }
)

export function validatePilotUsageEvidence(evidence: PilotUsageEvidence): void {
  const ids = [evidence?.executionId, evidence?.sessionId, evidence?.channelId, evidence?.modelId]
  if (ids.some((value) => typeof value !== 'string' || !value.trim())
    || !Number.isSafeInteger(evidence?.capturedAt) || evidence.capturedAt < 0) {
    throw new Error('Pilot 用量证据身份无效')
  }
  if (!['provider_reported', 'runtime_reported', 'traceable_estimate', 'request_settled', 'unknown'].includes(evidence.source)) {
    throw new Error('Pilot 用量证据来源无效')
  }
  if (evidence.source === 'unknown') {
    if (!evidence.reason?.trim()
      || Boolean(evidence.runtimeReceiptId) !== Boolean(evidence.payloadHash)
      || (evidence.runtimeReceiptId !== undefined && !evidence.runtimeReceiptId.trim())
      || (evidence.payloadHash !== undefined && !/^[a-f0-9]{64}$/.test(evidence.payloadHash))) {
      throw new Error('Pilot 未知用量必须说明原因并携带完整回执引用')
    }
    return
  }
  if (evidence.source === 'request_settled') {
    const ids = evidence.requestSettlementIds
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string' || !id.trim())
      || new Set(ids).size !== ids.length
      || !Number.isSafeInteger(evidence.costMicros) || evidence.costMicros < 0) {
      throw new Error('Pilot 逐请求结算证据无效')
    }
    return
  }
  if (!Number.isSafeInteger(evidence.inputTokens) || evidence.inputTokens < 0
    || !Number.isSafeInteger(evidence.outputTokens) || evidence.outputTokens < 0
    || !Number.isSafeInteger(evidence.costMicros) || evidence.costMicros < 0
    || (evidence.source === 'provider_reported' && !evidence.providerRecordId?.trim())
    || (evidence.source === 'runtime_reported'
      && (!evidence.runtimeReceiptId?.trim() || !/^[a-f0-9]{64}$/.test(evidence.payloadHash)))
    || (evidence.source === 'traceable_estimate' && !evidence.priceSource?.trim())) {
    throw new Error('Pilot 用量或计价证据无效')
  }
}

export function hashPilotProviderUsageRecord(channelId: string, providerRecordId: string): string {
  return createHash('sha256').update(JSON.stringify({
    source: 'provider_reported',
    channelId,
    providerRecordId,
  })).digest('hex')
}

export function hashPilotRuntimeUsageRecord(runtimeReceiptId: string): string {
  return createHash('sha256').update(JSON.stringify({
    source: 'runtime_reported',
    runtimeReceiptId,
  })).digest('hex')
}

export function hashPilotRequestSettlementRecord(requestSettlementIds: string[]): string {
  return createHash('sha256').update(JSON.stringify({
    source: 'request_settled',
    requestSettlementIds: [...requestSettlementIds].sort(),
  })).digest('hex')
}

function usageRecordKey(evidence: PilotUsageEvidence): string | null {
  if (evidence.source === 'provider_reported') {
    return hashPilotProviderUsageRecord(evidence.channelId, evidence.providerRecordId)
  }
  if (evidence.source === 'runtime_reported') return hashPilotRuntimeUsageRecord(evidence.runtimeReceiptId)
  if (evidence.source === 'request_settled') return hashPilotRequestSettlementRecord(evidence.requestSettlementIds)
  if (evidence.source === 'unknown' && evidence.runtimeReceiptId) {
    return hashPilotRuntimeUsageRecord(evidence.runtimeReceiptId)
  }
  return null
}

interface RuntimeUsageReceiptRow {
  id: string
  execution_id: string
  project_id: string
  session_id: string
  channel_id: string
  model_id: string
  runtime_source: string
  raw_payload: string
  payload_hash: string
  input_tokens: number
  output_tokens: number
  cost_micros: number | null
}

function validateRuntimeReceiptPayload(receipt: RuntimeUsageReceiptRow): void {
  if (!receipt.runtime_source.trim()
    || !Number.isSafeInteger(receipt.input_tokens) || receipt.input_tokens < 0
    || !Number.isSafeInteger(receipt.output_tokens) || receipt.output_tokens < 0
    || (receipt.cost_micros !== null
      && (!Number.isSafeInteger(receipt.cost_micros) || receipt.cost_micros < 0))
    || createHash('sha256').update(receipt.raw_payload).digest('hex') !== receipt.payload_hash) {
    throw new Error('Pilot Runtime 用量回执原文哈希无效')
  }
  const expectedId = createHash('sha256').update(JSON.stringify({
    executionId: receipt.execution_id,
    sessionId: receipt.session_id,
    channelId: receipt.channel_id,
    modelId: receipt.model_id,
    runtimeSource: receipt.runtime_source,
    payloadHash: receipt.payload_hash,
  })).digest('hex')
  if (receipt.id !== expectedId) throw new Error('Pilot Runtime 用量回执标识无效')
  let payload: {
    type?: string
    session_id?: string
    usage?: { input_tokens?: number; output_tokens?: number }
    total_cost_usd?: number
  }
  try {
    payload = JSON.parse(receipt.raw_payload) as typeof payload
  } catch {
    throw new Error('Pilot Runtime 用量回执原文不是有效 JSON')
  }
  const costMicros = payload.total_cost_usd === undefined
    ? null
    : Math.round(payload.total_cost_usd * 1_000_000)
  if (payload.type !== 'result' || (payload.session_id && payload.session_id !== receipt.session_id)
    || payload.usage?.input_tokens !== receipt.input_tokens
    || payload.usage?.output_tokens !== receipt.output_tokens
    || (costMicros !== null && !Number.isSafeInteger(costMicros))
    || costMicros !== receipt.cost_micros) {
    throw new Error('Pilot Runtime 用量回执原文与索引字段不一致')
  }
}

export function assertPilotRuntimeUsageReceipt(
  evidence: Extract<PilotUsageEvidence, { source: 'runtime_reported' | 'unknown' }>,
  projectId: string,
): void {
  if (!evidence.runtimeReceiptId) return
  const receipt = getProjectDb().prepare('SELECT * FROM pilot_runtime_usage_receipts WHERE id = ?')
    .get(evidence.runtimeReceiptId) as RuntimeUsageReceiptRow | undefined
  if (!receipt) throw new Error('Pilot Runtime 用量回执与原始记录不匹配')
  validateRuntimeReceiptPayload(receipt)
  if (receipt.execution_id !== evidence.executionId || receipt.project_id !== projectId
    || receipt.session_id !== evidence.sessionId || receipt.channel_id !== evidence.channelId
    || receipt.model_id !== evidence.modelId || receipt.payload_hash !== evidence.payloadHash) {
    throw new Error('Pilot Runtime 用量回执与原始记录不匹配')
  }
  if (evidence.source === 'runtime_reported'
    && (receipt.input_tokens !== evidence.inputTokens || receipt.output_tokens !== evidence.outputTokens
      || receipt.cost_micros !== evidence.costMicros)) {
    throw new Error('Pilot Runtime 用量回执金额或 token 与原始记录不匹配')
  }
}

function hasLegacyUsageReplay(recordKey: string, commandId: string): boolean {
  const rows = getProjectDb().prepare(`SELECT id, usage_evidence FROM pilot_commands
    WHERE usage_record_key IS NULL AND usage_evidence IS NOT NULL AND id <> ?`).all(commandId) as Array<{
      id: string
      usage_evidence: string
    }>
  return rows.some((row) => {
    try {
      const legacy = JSON.parse(row.usage_evidence) as PilotUsageEvidence
      return legacy.source === 'provider_reported'
        && hashPilotProviderUsageRecord(legacy.channelId, legacy.providerRecordId) === recordKey
    } catch {
      return false
    }
  })
}

/** 只接受与执行归属完全绑定的 Provider 回执、可追溯估算或显式未知证据。 */
export function settlePilotCommandUsage(commandId: string, evidence: PilotUsageEvidence, now = Date.now()): PilotCommandSettlement {
  if (typeof commandId !== 'string' || !commandId.trim()) throw new Error('Pilot 结算命令无效')
  validatePilotUsageEvidence(evidence)
  assertValidClock(now)
  if (evidence.capturedAt > now) throw new Error('Pilot 用量证据时间无效')
  const actualCostMicros = evidence.source === 'unknown' ? null : evidence.costMicros
  const serializedEvidence = JSON.stringify(evidence)
  const recordKey = usageRecordKey(evidence)
  const database = getProjectDb()
  let result: PilotCommandSettlement | undefined
  database.transaction(() => {
    const command = database.prepare('SELECT * FROM pilot_commands WHERE id = ?').get(commandId) as CommandRow | undefined
    if (!command || !command.execution_id) throw new Error('Pilot 命令或执行不存在')
    const grant = database.prepare('SELECT * FROM pilot_runtime_grants WHERE id = ? AND project_id = ?')
      .get(command.grant_id, command.project_id) as GrantRow | undefined
    const execution = getAgentExecution(command.execution_id)
    if (!grant || !execution || execution.projectId !== command.project_id
      || execution.pilotCommandId !== command.id || execution.entityId !== command.source_task_id
      || execution.entityType !== 'task' || execution.agentId !== command.employee_id
      || !['completed', 'failed', 'cancelled', 'stale'].includes(execution.status)) {
      throw new Error('Pilot 执行未终结或账本归属无法核验')
    }
    assertPilotExecutionLinked(execution.id, grant.policy_revision)
    if (execution.id !== evidence.executionId || execution.sessionId !== evidence.sessionId
      || grant.channel_id !== evidence.channelId || grant.model_id !== evidence.modelId) {
      throw new Error('Pilot 用量证据与执行、会话、渠道或模型不匹配')
    }
    if (evidence.source === 'runtime_reported' || evidence.source === 'unknown') {
      assertPilotRuntimeUsageReceipt(evidence, command.project_id)
    }
    if (evidence.source === 'request_settled') {
      // 终态命令结算不信任调用方数字：逐请求预留必须全部 settled，且清单与总额逐项一致。
      const rows = database.prepare('SELECT request_id, state, settled_cost_micros FROM pilot_request_reservations WHERE command_id = ?')
        .all(commandId) as Array<{ request_id: string; state: string; settled_cost_micros: number | null }>
      if (rows.length < 1) throw new Error('Pilot 命令没有逐请求结算记录')
      const dbIds = rows.map((row) => row.request_id).sort()
      const evidenceIds = [...evidence.requestSettlementIds].sort()
      if (dbIds.length !== evidenceIds.length || dbIds.some((id, index) => id !== evidenceIds[index])) {
        throw new Error('Pilot 逐请求结算清单与命令预留不一致')
      }
      if (rows.some((row) => row.state !== 'settled')) throw new Error('Pilot 命令仍有未结算的请求预留')
      const total = rows.reduce((sum, row) => sum + (row.settled_cost_micros ?? 0), 0)
      if (total !== evidence.costMicros) throw new Error('Pilot 逐请求结算总额不一致')
    }
    if ((command.state === 'settled' || command.state === 'needs_reconcile')
      && command.actual_cost_micros === actualCostMicros && command.usage_evidence === serializedEvidence
      && command.usage_record_key === recordKey) {
      result = { commandId, state: command.state, actualCostMicros, grantPaused: grant.state === 'paused' }
      return
    }
    if (command.state !== 'running') throw new Error('Pilot 命令状态不可结算')
    const unresolvedStop = database.prepare(`SELECT 1 FROM pilot_stop_escalations
      WHERE execution_id = ? AND command_id = ? AND resolved_at IS NULL LIMIT 1`)
      .get(execution.id, commandId)
    // 终态回调可能先于停止核验返回；保留费用额度并保持人工对账，不能将
    // Runtime 转述的有限费用当作可释放的最终账。
    if (unresolvedStop && evidence.source !== 'unknown') throw new Error('Pilot 停止升级未消解，费用须保留待人工对账')
    if (recordKey) {
      const replay = database.prepare('SELECT id FROM pilot_commands WHERE usage_record_key = ? AND id <> ?')
        .get(recordKey, commandId) as { id: string } | undefined
      if (replay || hasLegacyUsageReplay(recordKey, commandId)) {
        throw new Error('Pilot Provider 用量回执已被其他命令使用')
      }
    }
    const exceeded = actualCostMicros === null || actualCostMicros > command.reserved_cost_micros
    const state = exceeded ? 'needs_reconcile' : 'settled'
    const updated = database.prepare(`UPDATE pilot_commands
      SET state = ?, actual_cost_micros = ?, usage_evidence = ?, usage_record_key = ?, updated_at = ?
      WHERE id = ? AND state = 'running'`).run(state, actualCostMicros, serializedEvidence, recordKey, now, commandId)
    if (updated.changes !== 1) throw new Error('Pilot 结算状态已变化')
    if (exceeded) {
      database.prepare("UPDATE pilot_runtime_grants SET state = 'paused' WHERE id = ? AND state = 'active'")
        .run(grant.id)
    }
    result = { commandId, state, actualCostMicros, grantPaused: exceeded || grant.state === 'paused' }
  })()
  if (!result) throw new Error('Pilot 结算未完成')
  return result
}

/** 仅读取账本预留；未知实际费用会继续占用完整预留。 */
export function getPilotGrantBudgetUsage(grantId: string): { runReservations: number; committedCostMicros: number } {
  const grant = getProjectDb().prepare('SELECT id FROM pilot_runtime_grants WHERE id = ?').get(grantId) as { id: string } | undefined
  if (!grant) throw new Error('Pilot 授权不存在，预算余额无法核验')
  return readBudgetUsage(grantId)
}

/** 控制面只读用量视图：与预算核验同口径（settled 按实结计、其余命令按预留占额），附逐命令与逐请求汇总；授权不存在返回 null。 */
export function getPilotGrantBudgetUsageView(projectId: string, grantId: string): PilotGrantBudgetUsage | null {
  if (typeof projectId !== 'string' || !projectId.trim() || typeof grantId !== 'string' || !grantId.trim()) {
    throw new Error('Pilot 用量视图参数无效')
  }
  const grant = getProjectDb().prepare('SELECT id, state, max_cost_micros, max_runs FROM pilot_runtime_grants WHERE id = ? AND project_id = ?')
    .get(grantId, projectId) as { id: string; state: 'active' | 'paused'; max_cost_micros: number; max_runs: number } | undefined
  if (!grant) return null
  const usage = readBudgetUsage(grantId)
  const commandRows = getProjectDb().prepare(`SELECT id, role, rework_ordinal, state, reserved_cost_micros, actual_cost_micros, created_at
    FROM pilot_commands WHERE grant_id = ? ORDER BY created_at ASC, id ASC`).all(grantId) as Array<{
    id: string; role: 'executor' | 'reviewer'; rework_ordinal: number
    state: 'reserved' | 'queued' | 'running' | 'settled' | 'released' | 'needs_reconcile'
    reserved_cost_micros: number; actual_cost_micros: number | null; created_at: number
  }>
  const requestRows = getProjectDb().prepare(`SELECT r.command_id AS commandId, COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN r.state = 'settled' THEN 1 ELSE 0 END), 0) AS settled,
      COALESCE(SUM(CASE WHEN r.state = 'needs_reconcile' THEN 1 ELSE 0 END), 0) AS needsReconcile,
      COALESCE(SUM(r.settled_cost_micros), 0) AS settledCost
    FROM pilot_request_reservations r JOIN pilot_commands c ON c.id = r.command_id
    WHERE c.grant_id = ? GROUP BY r.command_id`).all(grantId) as Array<{
    commandId: string; total: number; settled: number; needsReconcile: number; settledCost: number
  }>
  const byCommand = new Map(requestRows.map((row) => [row.commandId, row]))
  return {
    grantId,
    state: grant.state,
    maxCostMicros: grant.max_cost_micros,
    maxRuns: grant.max_runs,
    usedRuns: usage.runReservations,
    committedCostMicros: usage.committedCostMicros,
    remainingCostMicros: Math.max(0, grant.max_cost_micros - usage.committedCostMicros),
    remainingRuns: Math.max(0, grant.max_runs - usage.runReservations),
    commands: commandRows.map((row) => {
      const aggregate = byCommand.get(row.id)
      return {
        commandId: row.id,
        role: row.role,
        reworkOrdinal: row.rework_ordinal,
        state: row.state,
        reservedCostMicros: row.reserved_cost_micros,
        actualCostMicros: row.actual_cost_micros,
        requestsTotal: aggregate?.total ?? 0,
        requestsSettled: aggregate?.settled ?? 0,
        requestsNeedsReconcile: aggregate?.needsReconcile ?? 0,
        settledCostMicros: aggregate?.settledCost ?? 0,
        createdAt: row.created_at,
      }
    }),
  }
}
