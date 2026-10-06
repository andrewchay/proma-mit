import { createHash, randomUUID } from 'node:crypto'
import type {
  PilotGrantPauseImpact,
  PilotGrantPauseResult,
  PilotGrantPauseTarget,
  PilotRunningChoice,
} from '@gravitas/shared'
import { getAgentExecution, getProjectDb } from './project-sqlite-store'

interface GrantRow {
  id: string
  project_id: string
  policy_revision: number
  state: 'active' | 'paused'
}

interface CommandRow {
  id: string
  project_id: string
  grant_id: string
  execution_id: string | null
  state: string
  source_task_id: string
  employee_id: string
}

interface LinkRow {
  command_id: string
  project_id: string
  policy_revision: number
  execution_id: string
}

function readImpact(grantId: string): PilotGrantPauseImpact {
  const database = getProjectDb()
  const grant = database.prepare('SELECT * FROM pilot_runtime_grants WHERE id = ?').get(grantId) as GrantRow | undefined
  if (!grant || grant.state !== 'active') throw new Error('Pilot 活动授权不存在或已暂停')
  const commands = database.prepare('SELECT * FROM pilot_commands WHERE grant_id = ? ORDER BY id')
    .all(grantId) as CommandRow[]
  if (commands.some((command) => command.state === 'needs_reconcile')) {
    throw new Error('Pilot 命令待对账，不能确认影响面')
  }
  const reservedCommandIds: string[] = []
  for (const command of commands.filter((item) => item.state === 'reserved')) {
    const link = database.prepare('SELECT command_id FROM pilot_command_links WHERE command_id = ?')
      .get(command.id) as { command_id: string } | undefined
    const markedExecution = database.prepare('SELECT id FROM agent_executions WHERE pilot_command_id = ? LIMIT 1')
      .get(command.id) as { id: string } | undefined
    if (command.project_id !== grant.project_id || command.execution_id !== null || link || markedExecution) {
      throw new Error('Pilot 未排队命令已有执行或来源关联，需先对账')
    }
    reservedCommandIds.push(command.id)
  }
  const queued: PilotGrantPauseTarget[] = []
  const running: PilotGrantPauseTarget[] = []
  for (const command of commands) {
    if (command.state !== 'queued' && command.state !== 'running') {
      if (command.execution_id) {
        const terminalExecution = getAgentExecution(command.execution_id)
        if (terminalExecution?.status === 'queued' || terminalExecution?.status === 'running') {
          throw new Error('Pilot 命令与执行状态不一致')
        }
      }
      continue
    }
    const execution = command.execution_id ? getAgentExecution(command.execution_id) : null
    const link = database.prepare('SELECT * FROM pilot_command_links WHERE command_id = ?')
      .get(command.id) as LinkRow | undefined
    if (!execution || !link || command.project_id !== grant.project_id
      || execution.projectId !== grant.project_id || execution.pilotCommandId !== command.id
      || execution.entityType !== 'task' || execution.entityId !== command.source_task_id
      || execution.agentId !== command.employee_id || link.project_id !== grant.project_id
      || link.policy_revision !== grant.policy_revision || link.execution_id !== execution.id) {
      throw new Error('Pilot 命令、执行或来源关联无法核验')
    }
    if (command.state !== execution.status || (command.state === 'queued' && execution.sessionId !== '')) {
      throw new Error('Pilot 命令与执行状态不一致')
    }
    const target = { commandId: command.id, executionId: execution.id,
      taskId: execution.entityId, agentId: execution.agentId, sessionId: execution.sessionId }
    if (command.state === 'queued') queued.push(target)
    else running.push(target)
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ grantId, projectId: grant.project_id,
    policyRevision: grant.policy_revision, reservedCommandIds, queued, running })).digest('hex')
  return { grantId, projectId: grant.project_id, policyRevision: grant.policy_revision, fingerprint, reservedCommandIds, queued, running }
}

/** 只读展示活动 grant 的全部可核验排队和运行中命令；不含普通员工执行。 */
export function previewPilotGrantPauseImpact(grantId: string): PilotGrantPauseImpact {
  if (typeof grantId !== 'string' || !grantId.trim()) throw new Error('缺少 Pilot 授权 ID')
  let result: PilotGrantPauseImpact | undefined
  getProjectDb().transaction(() => { result = readImpact(grantId) })()
  if (!result) throw new Error('Pilot 暂停影响面无法核验')
  return result
}

/** 内部存储原语：用户逐项确认后同事务撤权、释放未启动预留、取消排队；停止请求仍待编排层执行。 */
export function confirmPilotGrantPause(
  preview: PilotGrantPauseImpact,
  choices: PilotRunningChoice[],
  now = Date.now(),
): PilotGrantPauseResult {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Pilot 时钟无效')
  const database = getProjectDb()
  let result: PilotGrantPauseResult | undefined
  database.transaction(() => {
    const current = readImpact(preview.grantId)
    if (current.projectId !== preview.projectId || current.policyRevision !== preview.policyRevision
      || current.fingerprint !== preview.fingerprint) throw new Error('暂停影响面已变化，请重新预览并确认')
    const choiceIds = new Set<string>()
    for (const choice of choices) {
      if (choiceIds.has(choice.executionId)
        || (choice.disposition !== 'finish_current' && choice.disposition !== 'request_stop')) {
        throw new Error('运行中任务选择重复或无效')
      }
      choiceIds.add(choice.executionId)
    }
    if (choiceIds.size !== current.running.length
      || current.running.some((target) => !choiceIds.has(target.executionId))) {
      throw new Error('请逐项选择所有运行中任务的处理方式')
    }
    const paused = database.prepare(`UPDATE pilot_runtime_grants SET state = 'paused'
      WHERE id = ? AND project_id = ? AND policy_revision = ? AND state = 'active'`)
      .run(current.grantId, current.projectId, current.policyRevision)
    if (paused.changes !== 1) throw new Error('Pilot 活动授权已变化')
    const releasedReservationCommandIds: string[] = []
    for (const commandId of current.reservedCommandIds) {
      const released = database.prepare(`UPDATE pilot_commands SET state = 'released', actual_cost_micros = 0, updated_at = ?
        WHERE id = ? AND grant_id = ? AND state = 'reserved' AND execution_id IS NULL`)
        .run(now, commandId, current.grantId)
      if (released.changes !== 1) throw new Error('Pilot 未排队命令已变化，请重新预览')
      releasedReservationCommandIds.push(commandId)
    }
    const cancelledExecutionIds: string[] = []
    for (const target of current.queued) {
      const cancelled = database.prepare(`UPDATE agent_executions SET status = 'cancelled', error = ?, completed_at = ?
        WHERE id = ? AND project_id = ? AND pilot_command_id = ? AND status = 'queued' AND session_id = ''`)
        .run('用户确认暂停 Pilot，取消尚未启动的排队执行', now,
          target.executionId, current.projectId, target.commandId)
      if (cancelled.changes !== 1) throw new Error('Pilot 排队执行已变化，请重新预览')
      const released = database.prepare(`UPDATE pilot_commands SET state = 'released', actual_cost_micros = 0, updated_at = ?
        WHERE id = ? AND grant_id = ? AND execution_id = ? AND state = 'queued'`)
        .run(now, target.commandId, current.grantId, target.executionId)
      if (released.changes !== 1) throw new Error('Pilot 排队命令已变化，请重新预览')
      cancelledExecutionIds.push(target.executionId)
      database.prepare(`INSERT INTO project_activities
        (id, project_id, entity_type, entity_id, action, summary, payload, actor, created_at)
        VALUES (?, ?, 'task', ?, 'pilot_queued_cancelled', ?, ?, 'local-user', ?)`)
        .run(randomUUID(), current.projectId, target.executionId, '用户确认暂停后取消 Pilot 排队执行',
          JSON.stringify({ grantId: current.grantId, commandId: target.commandId }), now)
    }
    database.prepare(`INSERT INTO pilot_grant_pause_decisions
      (grant_id, project_id, policy_revision, fingerprint, queued_targets, running_choices, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(current.grantId, current.projectId, current.policyRevision,
      current.fingerprint, JSON.stringify({ reservedCommandIds: current.reservedCommandIds, queued: current.queued }), JSON.stringify(choices), now)
    for (const choice of choices) {
      if (choice.disposition !== 'request_stop') continue
      const target = current.running.find((item) => item.executionId === choice.executionId)
      if (!target || !target.sessionId) throw new Error('Pilot 运行中停止目标无法核验')
      database.prepare(`INSERT INTO pilot_grant_stop_requests
        (grant_id, execution_id, project_id, command_id, session_id, state, requested_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(current.grantId, target.executionId,
        current.projectId, target.commandId, target.sessionId, now)
    }
    result = { grantId: current.grantId, cancelledExecutionIds, releasedReservationCommandIds,
      runningChoices: choices, pendingStopExecutionIds: choices.filter((choice) => choice.disposition === 'request_stop')
        .map((choice) => choice.executionId) }
  })()
  if (!result) throw new Error('Pilot 暂停事务未完成')
  return result
}

export interface PilotGrantStopOutcome {
  executionId: string
  requestAccepted: boolean
  stopped: boolean
  processTermination: 'VERIFIED' | 'NOT_VERIFIED'
  auditRecorded?: false
}

export interface PilotGrantPauseWithStopsResult extends PilotGrantPauseResult {
  stopOutcomes: PilotGrantStopOutcome[]
}

/** 供后续真实停止器接线；暂停事务先提交，再逐条请求停止并如实报告未知结果。 */
export function confirmPilotGrantPauseAndRequestStops(
  preview: PilotGrantPauseImpact,
  choices: PilotRunningChoice[],
  stopRunning: (executionId: string) => PilotGrantStopOutcome,
): PilotGrantPauseWithStopsResult {
  const paused = confirmPilotGrantPause(preview, choices)
  const stopOutcomes = paused.pendingStopExecutionIds.map((executionId): PilotGrantStopOutcome => {
    let outcome: PilotGrantStopOutcome
    try {
      outcome = stopRunning(executionId)
      if (!outcome || outcome.executionId !== executionId
        || outcome.stopped !== (outcome.processTermination === 'VERIFIED')
        || (outcome.stopped && !outcome.requestAccepted)) {
        throw new Error('Pilot 停止结果无法核验')
      }
    } catch {
      outcome = { executionId, requestAccepted: false, stopped: false, processTermination: 'NOT_VERIFIED' }
    }
    try {
      getProjectDb().transaction(() => {
        const state = outcome.processTermination === 'VERIFIED' ? 'stopper_reported'
          : outcome.requestAccepted ? 'accepted_unverified' : 'unverified'
        const changed = getProjectDb().prepare(`UPDATE pilot_grant_stop_requests SET state = ?, result_at = ?
          WHERE grant_id = ? AND execution_id = ? AND project_id = ? AND state = 'pending'`)
          .run(state, Date.now(), paused.grantId, executionId, preview.projectId)
        if (changed.changes !== 1) throw new Error('Pilot 停止请求待办已变化')
        getProjectDb().prepare(`INSERT INTO project_activities
          (id, project_id, entity_type, entity_id, action, summary, payload, actor, created_at)
          VALUES (?, ?, 'task', ?, 'pilot_stop_request_result', ?, ?, 'local-user', ?)`).run(
          randomUUID(), preview.projectId, executionId, 'Pilot 暂停后逐项停止请求结果（不代表费用对账完成）',
          JSON.stringify({ grantId: paused.grantId, ...outcome }), Date.now())
      })()
    } catch {
      // 保留实际请求结果；审计失败独立标记，不能把已送达伪装为未送达。
      return { ...outcome, auditRecorded: false }
    }
    return outcome
  })
  return { ...paused, stopOutcomes }
}

export interface GrantStopRequestRow {
  grant_id: string
  execution_id: string
  project_id: string
  command_id: string
  session_id: string
  state: 'pending' | 'accepted_unverified' | 'unverified' | 'stopper_reported' | 'legacy_unknown'
  requested_at: number
  result_at: number | null
}

/** 只读人工对账清单；pending/legacy_unknown 都可能已经发出，绝不自动重放。 */
export function listPilotGrantStopRequests(projectId: string): GrantStopRequestRow[] {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('缺少 Pilot 项目 ID')
  const database = getProjectDb()
  const rows = database.prepare(`SELECT * FROM pilot_grant_stop_requests
    WHERE project_id = ? ORDER BY requested_at, execution_id`).all(projectId) as GrantStopRequestRow[]
  const legacy = database.prepare(`SELECT grant_id, running_choices, created_at FROM pilot_grant_pause_decisions
    WHERE project_id = ? ORDER BY created_at, grant_id`).all(projectId) as Array<{
      grant_id: string; running_choices: string; created_at: number
    }>
  for (const decision of legacy) {
    let choices: PilotRunningChoice[]
    try { choices = JSON.parse(decision.running_choices) as PilotRunningChoice[] } catch { continue }
    if (!Array.isArray(choices)) continue
    for (const choice of choices) {
      if (!choice || choice.disposition !== 'request_stop' || typeof choice.executionId !== 'string') continue
      if (rows.some((row) => row.grant_id === decision.grant_id && row.execution_id === choice.executionId)) continue
      const execution = getAgentExecution(choice.executionId)
      rows.push({ grant_id: decision.grant_id, execution_id: choice.executionId, project_id: projectId,
        command_id: execution?.pilotCommandId ?? '', session_id: execution?.sessionId ?? '',
        state: 'legacy_unknown', requested_at: decision.created_at, result_at: null })
    }
  }
  return rows.sort((a, b) => a.requested_at - b.requested_at || a.execution_id.localeCompare(b.execution_id))
}

interface GrantPauseDecisionRow {
  grant_id: string
  project_id: string
  policy_revision: number
  fingerprint: string
  queued_targets: string
  running_choices: string
  created_at: number
}

export interface PilotGrantPauseRecovery {
  state: 'no_decision' | 'queue_reconciled' | 'needs_attention'
  pendingStopExecutionIds: string[]
  reason?: string
}

/** 重启后只读核验暂停事务；没有进程终止证据时不宣称 request_stop 已完成。 */
export function inspectPilotGrantPauseRecovery(grantId: string): PilotGrantPauseRecovery {
  if (typeof grantId !== 'string' || !grantId.trim()) throw new Error('缺少 Pilot 授权 ID')
  const database = getProjectDb()
  const row = database.prepare('SELECT * FROM pilot_grant_pause_decisions WHERE grant_id = ?')
    .get(grantId) as GrantPauseDecisionRow | undefined
  if (!row) return { state: 'no_decision', pendingStopExecutionIds: [] }
  let targets: { reservedCommandIds: string[]; queued: PilotGrantPauseTarget[] }
  let choices: PilotRunningChoice[]
  try {
    targets = JSON.parse(row.queued_targets) as typeof targets
    choices = JSON.parse(row.running_choices) as PilotRunningChoice[]
  } catch {
    return { state: 'needs_attention', pendingStopExecutionIds: [], reason: '暂停确认记录无法读取' }
  }
  if (!Array.isArray(targets?.reservedCommandIds) || !Array.isArray(targets.queued)
    || targets.reservedCommandIds.some((id) => typeof id !== 'string' || !id.trim())
    || targets.queued.some((target) => !target || typeof target.commandId !== 'string'
      || !target.commandId.trim() || typeof target.executionId !== 'string' || !target.executionId.trim())
    || !Array.isArray(choices) || choices.some((choice) => !choice || typeof choice.executionId !== 'string'
      || (choice.disposition !== 'request_stop' && choice.disposition !== 'finish_current'))) {
    return { state: 'needs_attention', pendingStopExecutionIds: [], reason: '暂停确认记录无效' }
  }
  const pendingStopExecutionIds = choices.filter((choice) => choice.disposition === 'request_stop')
    .map((choice) => choice.executionId)
  const grant = database.prepare('SELECT * FROM pilot_runtime_grants WHERE id = ?')
    .get(grantId) as GrantRow | undefined
  if (!grant || grant.project_id !== row.project_id || grant.policy_revision !== row.policy_revision
    || grant.state !== 'paused') {
    return { state: 'needs_attention', pendingStopExecutionIds, reason: '活动授权未保持暂停' }
  }
  for (const commandId of targets.reservedCommandIds) {
    const command = database.prepare('SELECT state, grant_id FROM pilot_commands WHERE id = ?')
      .get(commandId) as { state: string; grant_id: string } | undefined
    if (!command || command.grant_id !== grantId || command.state !== 'released') {
      return { state: 'needs_attention', pendingStopExecutionIds, reason: '未排队预留尚未释放' }
    }
  }
  for (const target of targets.queued) {
    const execution = getAgentExecution(target.executionId)
    const command = database.prepare('SELECT state, grant_id, execution_id FROM pilot_commands WHERE id = ?')
      .get(target.commandId) as { state: string; grant_id: string; execution_id: string } | undefined
    if (!execution || execution.projectId !== row.project_id || execution.status !== 'cancelled'
      || execution.pilotCommandId !== target.commandId || !command || command.grant_id !== grantId
      || command.execution_id !== target.executionId || command.state !== 'released') {
      return { state: 'needs_attention', pendingStopExecutionIds, reason: '排队取消结果无法核验' }
    }
  }
  if (pendingStopExecutionIds.length) {
    return { state: 'needs_attention', pendingStopExecutionIds, reason: '运行中停止请求缺少进程终止证据' }
  }
  return { state: 'queue_reconciled', pendingStopExecutionIds: [] }
}
