import { createHash } from 'node:crypto'
import { createAgentExecution, getAgentExecution, getProjectDb, getTask, listTaskBlockers, listTaskStatuses } from './project-sqlite-store'
import { assertPilotExecutionLinked, registerPilotCommandLink } from './project-pilot-command-links'
import { resolveStateGroup } from './task-status-logic'
import type { AgentExecution, Task } from './project-types'
import type { PilotPolicy } from './project-pilot-policy'
import { withPilotPolicySnapshot } from './project-pilot-policy'
import { hashPilotGrantApproval } from './project-pilot-grant-issue'

/** 仅供受控派发层使用的账本原语；活动 grant 尚未接入执行派发入口。 */
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
  reservedCostMicros: number
}

export interface PilotCommandReservation extends PilotCommandReservationInput {
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
    || !Number.isSafeInteger(input.reworkOrdinal) || input.reworkOrdinal < 0
    || !Number.isSafeInteger(input.reservedCostMicros) || input.reservedCostMicros <= 0) {
    throw new Error('Pilot 预算预留参数无效或费用未知')
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
    && row.rework_ordinal === input.reworkOrdinal && row.reserved_cost_micros === input.reservedCostMicros
}

function readBudgetUsage(grantId: string): { runReservations: number; committedCostMicros: number } {
  const row = getProjectDb().prepare(`SELECT COUNT(*) AS runs,
    COALESCE(SUM(CASE WHEN state = 'released' THEN 0 WHEN state = 'settled' AND actual_cost_micros IS NOT NULL THEN actual_cost_micros WHEN actual_cost_micros > reserved_cost_micros THEN actual_cost_micros ELSE reserved_cost_micros END), 0) AS committed
    FROM pilot_commands WHERE grant_id = ?`).get(grantId) as { runs: number; committed: number }
  if (!Number.isSafeInteger(row.runs) || !Number.isSafeInteger(row.committed) || row.committed < 0) {
    throw new Error('Pilot 预算账本无法核验')
  }
  return { runReservations: row.runs, committedCostMicros: row.committed }
}

/** 在已锁定的策略快照内预留费用和次数；不创建 Agent execution，也不调用模型。 */
function reservePilotCommandBudgetLocked(
  input: PilotCommandReservationInput,
  now: number,
  policy: PilotPolicy,
): PilotCommandReservation {
  const database = getProjectDb()
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
  if (!Number.isSafeInteger(grant.max_cost_micros) || grant.max_cost_micros <= 0
    || input.reservedCostMicros > grant.max_cost_micros - usage.committedCostMicros) throw new Error('Pilot 费用额度不足或无法核验')

  database.prepare(`INSERT INTO pilot_commands
      (id, project_id, grant_id, idempotency_key, source_task_id, source_version, source_hash,
       employee_id, role, rework_ordinal, reserved_cost_micros, actual_cost_micros, state, execution_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'reserved', NULL, ?, ?)`).run(
      input.commandId, input.projectId, input.grantId, input.idempotencyKey, input.taskId,
      input.sourceVersion, input.sourceHash, input.employeeId, input.role, input.reworkOrdinal,
      input.reservedCostMicros, now, now,
    )
  return { ...input, state: 'reserved', actualCostMicros: null, executionId: null, createdAt: now, updatedAt: now }
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

/** 启动前只核验已入账且绑定本次执行的命令；本函数不启动 Runtime。 */
function assertPilotCommandStartRecordLocked(
  executionId: string,
  commandId: string,
  expectedPolicyRevision: number,
  now: number,
  policy: PilotPolicy,
): PilotCommandReservation {
  const execution = getAgentExecution(executionId)
  if (!execution || execution.pilotCommandId !== commandId || execution.status !== 'queued' || execution.sessionId !== '') {
    throw new Error('Pilot 执行归属或排队状态无法核验')
  }
  const row = getProjectDb().prepare('SELECT * FROM pilot_commands WHERE id = ? AND project_id = ?')
    .get(commandId, execution.projectId) as CommandRow | undefined
  if (!row || row.state !== 'queued' || row.execution_id !== executionId || row.employee_id !== execution.agentId
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
  | { source: 'traceable_estimate'; priceSource: string; inputTokens: number; outputTokens: number; costMicros: number }
  | { source: 'unknown'; reason: string }
)

export function validatePilotUsageEvidence(evidence: PilotUsageEvidence): void {
  const ids = [evidence?.executionId, evidence?.sessionId, evidence?.channelId, evidence?.modelId]
  if (ids.some((value) => typeof value !== 'string' || !value.trim())
    || !Number.isSafeInteger(evidence?.capturedAt) || evidence.capturedAt < 0) {
    throw new Error('Pilot 用量证据身份无效')
  }
  if (!['provider_reported', 'traceable_estimate', 'unknown'].includes(evidence.source)) {
    throw new Error('Pilot 用量证据来源无效')
  }
  if (evidence.source === 'unknown') {
    if (!evidence.reason?.trim()) throw new Error('Pilot 未知用量必须说明原因')
    return
  }
  if (!Number.isSafeInteger(evidence.inputTokens) || evidence.inputTokens < 0
    || !Number.isSafeInteger(evidence.outputTokens) || evidence.outputTokens < 0
    || !Number.isSafeInteger(evidence.costMicros) || evidence.costMicros < 0
    || (evidence.source === 'provider_reported' && !evidence.providerRecordId?.trim())
    || (evidence.source === 'traceable_estimate' && !evidence.priceSource?.trim())) {
    throw new Error('Pilot 用量或计价证据无效')
  }
}

/** 只接受与执行归属完全绑定的 Provider 回执、可追溯估算或显式未知证据。 */
export function settlePilotCommandUsage(commandId: string, evidence: PilotUsageEvidence, now = Date.now()): PilotCommandSettlement {
  if (typeof commandId !== 'string' || !commandId.trim()) throw new Error('Pilot 结算命令无效')
  validatePilotUsageEvidence(evidence)
  assertValidClock(now)
  if (evidence.capturedAt > now) throw new Error('Pilot 用量证据时间无效')
  const actualCostMicros = evidence.source === 'unknown' ? null : evidence.costMicros
  const serializedEvidence = JSON.stringify(evidence)
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
    if ((command.state === 'settled' || command.state === 'needs_reconcile')
      && command.actual_cost_micros === actualCostMicros && command.usage_evidence === serializedEvidence) {
      result = { commandId, state: command.state, actualCostMicros, grantPaused: grant.state === 'paused' }
      return
    }
    if (command.state !== 'running') throw new Error('Pilot 命令状态不可结算')
    const exceeded = actualCostMicros === null || actualCostMicros > command.reserved_cost_micros
    const state = exceeded ? 'needs_reconcile' : 'settled'
    const updated = database.prepare(`UPDATE pilot_commands SET state = ?, actual_cost_micros = ?, usage_evidence = ?, updated_at = ?
      WHERE id = ? AND state = 'running'`).run(state, actualCostMicros, serializedEvidence, now, commandId)
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
