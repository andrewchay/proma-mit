import { ownerEmployeeConfigurationHash } from './project-owner-execution-source'
/** Owner命令启动链：claim单事务+handoff intent+启动回执；独立链不经tryStartExecution。 */
import type { AgentExecution } from './project-types'
import * as store from './project-sqlite-store'
import { admitOwnerExecutionGateSession, resolveOwnerExecutionGateSession } from './project-owner-execution-gates'
import { getOwnerExecutionRevalidation } from './project-owner-execution-revalidation'
import { getPilotPolicy } from './project-pilot-policy'
import { ownerExecutionHash, parseOwnerExecutionSubject } from './project-owner-execution-source'
import { ownerTaskSpecificationHash } from './project-owner-task-materialization'
import { assertOwnerCommandUpstreamHandoffsCurrent, hashOwnerCommandSource } from './project-owner-execution-command'

function assertOwnerCommandStartRecordLocked(executionId: string, commandId: string, expectedRevalidationRevision: number, sessionId: string, now: number): void {
  const database = store.getProjectDb()
  const execution = store.getAgentExecution(executionId)
  const command = database.prepare('SELECT * FROM project_owner_execution_commands WHERE id=? AND project_id=?').get(commandId, execution?.projectId ?? '') as { grant_id: string; execution_id: string | null; state: string; source_task_id: string; employee_id: string; source_hash: string; source_version: number; source_step_link_id: string; role: string } | undefined
  if (!execution || !execution.ownerCommandId || execution.ownerCommandId !== commandId || !command
    || command.execution_id !== executionId || !['queued', 'running'].includes(command.state)) {
    throw new Error('Owner启动归属或命令状态无法核验')
  }
  const grant = database.prepare('SELECT * FROM project_owner_execution_grants WHERE id=? AND project_id=?').get(command.grant_id, execution.projectId) as { state: string; revalidation_id: string; revalidation_revision: number; revalidation_integrity_hash: string; materialization_id: string; materialization_integrity_hash: string; policy_revision: number; expires_at: number } | undefined
  const policy = getPilotPolicy(execution.projectId)
  if (!grant || grant.state !== 'active' || grant.expires_at <= now || !policy || policy.revision !== grant.policy_revision) throw new Error('Owner启动授权不存在、过期或策略已变化')
  // 用grant冻结的上游三元组精确比对v2记录；expectedRevalidationRevision<=0时跳过revision数值校验（handoff intent场景）。
  const viewAny = getOwnerExecutionRevalidation(parseOwnerExecutionSubject({ projectId: execution.projectId }))
  if (viewAny.status !== 'current' || !viewAny.revalidation) throw new Error('Owner启动来源非current')
  const record = viewAny.revalidation
  if ((expectedRevalidationRevision > 0 && record.revision !== expectedRevalidationRevision) || record.id !== grant.revalidation_id
    || record.integrityHash !== grant.revalidation_integrity_hash
    || record.source.materialization.id !== grant.materialization_id
    || record.source.materialization.integrityHash !== grant.materialization_integrity_hash) {
    throw new Error('Owner启动冻结引用与当前v2不一致，请重新确认')
  }
  const task = store.getTask(command.source_task_id)
  const link = task?.ownerStepLinkId ? database.prepare('SELECT id, integrity_hash, payload FROM project_owner_task_step_links WHERE id=? AND task_id=? AND project_id=?').get(task.ownerStepLinkId, task.id, execution.projectId) as { id: string; integrity_hash: string; payload: string } | undefined : undefined
  const frozenTask = record.source.tasks.find(item => item.taskId === command.source_task_id)
  const dependencies = task ? store.listTaskDependencies(execution.projectId).filter(edge => edge.taskId === task.id || edge.dependsOnTaskId === task.id).map(({ id, taskId, dependsOnTaskId, type }) => ({ id, taskId, dependsOnTaskId, type })) : []
  let frozenLink: { taskSpecificationHash?: string } | null = null
  try { frozenLink = link ? JSON.parse(link.payload) as { taskSpecificationHash?: string } : null } catch { frozenLink = null }
  const rebuiltSourceHash = task && link && frozenLink?.taskSpecificationHash
    ? hashOwnerCommandSource({ taskId: task.id, taskSpecificationHash: frozenLink.taskSpecificationHash, linkIntegrityHash: link.integrity_hash, dependencies: dependencies.map(({ id, dependsOnTaskId, type }) => ({ id, dependsOnTaskId, type })) })
    : ''
  if (!task || task.projectId !== execution.projectId || task.ownerStepLinkId !== command.source_step_link_id || task.status !== 'paused'
    || store.listTaskBlockers(execution.projectId).some(blocker => blocker.taskId === task.id)
    || !link || link.id !== command.source_step_link_id || !frozenTask || !frozenLink?.taskSpecificationHash
    || ownerTaskSpecificationHash(task) !== frozenLink.taskSpecificationHash
    || frozenTask.linkId !== link.id || frozenTask.taskSpecificationHash !== frozenLink.taskSpecificationHash
    || rebuiltSourceHash !== command.source_hash || command.source_version !== record.source.materialization.revision
    || ownerExecutionHash(dependencies.slice().sort((a, b) => a.id.localeCompare(b.id))) !== ownerExecutionHash(frozenTask.dependencies.slice().sort((a, b) => a.id.localeCompare(b.id)))) {
    throw new Error('Owner启动Task/依赖/步骤来源与命令冻结摘要不一致')
  }
  if (execution.agentId !== command.employee_id || execution.entityId !== command.source_task_id) throw new Error('Owner启动执行与命令不匹配')
  const frozenExecutor = frozenTask.executor ?? record.source.executor
  const roleEmployeeId = command.role === 'executor' ? frozenExecutor.id
    : command.role === 'reviewer' ? record.source.reviewer.id : null
  const frozenEmployee = roleEmployeeId === command.employee_id
    ? (command.role === 'executor' ? frozenExecutor : record.source.reviewer)
    : null
  const employee = store.getAgentEmployee(command.employee_id)
  if (!frozenEmployee || !employee?.enabled
    || ownerEmployeeConfigurationHash(employee, record.source.workspaceId) !== frozenEmployee.configurationHash) {
    throw new Error('Owner启动员工配置与已确认版本不一致，请重新验证')
  }
  assertOwnerCommandUpstreamHandoffsCurrent(commandId)
}
export function assertOwnerCommandRuntimeContext(executionId: string, commandId: string, sessionId: string, requireHandoffIntent = false, now = Date.now()): void {
  const execution = store.getAgentExecution(executionId)
  const database = store.getProjectDb()
  const link = database.prepare('SELECT revalidation_revision FROM project_owner_execution_command_links WHERE execution_id=? AND command_id=?').get(executionId, commandId) as { revalidation_revision: number } | undefined
  if (!execution || !link || execution.sessionId !== sessionId || execution.status !== 'running' || execution.ownerCommandId !== commandId) {
    throw new Error('Owner Runtime handoff execution/session身份不匹配')
  }
  assertOwnerCommandStartRecordLocked(executionId, commandId, link.revalidation_revision, sessionId, now)
  const attempt = database.prepare('SELECT session_id, handoff_intent_at FROM project_owner_execution_start_attempts WHERE execution_id=? AND command_id=?').get(executionId, commandId) as { session_id: string; handoff_intent_at: number | null } | undefined
  if (!attempt || attempt.session_id !== sessionId || (requireHandoffIntent && (attempt.handoff_intent_at === null || attempt.handoff_intent_at > now))) {
    throw new Error('Owner Runtime handoff intent缺失或身份不匹配')
  }
  const gate = resolveOwnerExecutionGateSession(sessionId)
  if (gate.kind !== 'owner_business' || gate.executionId !== executionId || gate.gate?.sessionId !== sessionId) {
    throw new Error('Owner Runtime handoff未通过资料与会话门禁准入')
  }
}

export function claimOwnerCommandStart(executionId: string, commandId: string, expectedRevalidationRevision: number, sessionId: string, now = Date.now()): { execution: AgentExecution } {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Owner启动时钟无效')
  if (!sessionId?.trim()) throw new Error('Owner启动会话无效')
  if (store.getProjectDb().isTransactionActive()) throw new Error('Owner启动认领不得嵌套未提交事务')
  const execution = store.getAgentExecution(executionId)
  if (!execution?.ownerCommandId || execution.ownerCommandId !== commandId) throw new Error('Owner执行归属或排队状态无法核验')
  const database = store.getProjectDb()
  let result: { execution: AgentExecution } | undefined
  database.transaction(() => {
    assertOwnerCommandStartRecordLocked(executionId, commandId, expectedRevalidationRevision, sessionId, now)
    const claimedExecution = database.prepare("UPDATE agent_executions SET status='running', session_id=?, last_heartbeat_at=? WHERE id=? AND owner_command_id=? AND status='queued' AND session_id=''").run(sessionId, now, executionId, commandId)
    const claimedCommand = database.prepare("UPDATE project_owner_execution_commands SET state='running', updated_at=? WHERE id=? AND execution_id=? AND state='queued'").run(now, commandId, executionId)
    if (claimedExecution.changes !== 1 || claimedCommand.changes !== 1) throw new Error('Owner启动认领状态已变化')
    database.prepare('INSERT INTO project_owner_execution_start_attempts(execution_id,command_id,project_id,session_id,claimed_at) VALUES(?,?,?,?,?)').run(executionId, commandId, execution.projectId, sessionId, now)
    const current = store.getAgentExecution(executionId)
    if (!current || current.status !== 'running' || current.sessionId !== sessionId) throw new Error('Owner启动认领回读失败')
    result = { execution: current }
  })()
  if (!result!) throw new Error('Owner启动认领未完成')
  return result!
}
export function recordOwnerCommandHandoffIntent(executionId: string, commandId: string, sessionId: string, now = Date.now()): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Owner交接时钟无效')
  const database = store.getProjectDb()
  database.transaction(() => {
    const execution = store.getAgentExecution(executionId)
    const attempt = database.prepare('SELECT session_id FROM project_owner_execution_start_attempts WHERE execution_id=? AND command_id=?').get(executionId, commandId) as { session_id: string } | undefined
    if (!execution || execution.status !== 'running' || execution.ownerCommandId !== commandId || execution.sessionId !== sessionId || attempt?.session_id !== sessionId) {
      throw new Error('Owner交接意向会话与已认领执行不匹配')
    }
    assertOwnerCommandStartRecordLocked(executionId, commandId, 0, sessionId, now)
    const updated = database.prepare('UPDATE project_owner_execution_start_attempts SET handoff_intent_at=? WHERE execution_id=? AND command_id=? AND session_id=? AND handoff_intent_at IS NULL AND claimed_at<=?').run(now, executionId, commandId, sessionId, now)
    if (updated.changes !== 1) throw new Error('Owner交接意向状态已变化')
  })()
}
/** Runtime首条消息=启动事实成立；回执失败仅告警不中断（镜像pilot语义）。 */
export function recordOwnerRuntimeStarted(executionId: string, commandId: string, projectId: string, sessionId: string, runnerName: string, startedAt: number, processId: number | null, now = Date.now()): void {
  if (!Number.isSafeInteger(startedAt) || startedAt < 0 || !Number.isSafeInteger(now) || now < startedAt
    || !runnerName?.trim() || (processId !== null && (!Number.isSafeInteger(processId) || processId <= 0))) {
    throw new Error('Owner启动回执字段无效')
  }
  const database = store.getProjectDb()
  database.transaction(() => {
    const execution = store.getAgentExecution(executionId)
    const command = database.prepare('SELECT project_id, execution_id, state FROM project_owner_execution_commands WHERE id=?').get(commandId) as { project_id: string; execution_id: string; state: string } | undefined
    const attempt = database.prepare('SELECT project_id, session_id, claimed_at, handoff_intent_at FROM project_owner_execution_start_attempts WHERE execution_id=? AND command_id=?').get(executionId, commandId) as { project_id: string; session_id: string; claimed_at: number; handoff_intent_at: number | null } | undefined
    if (!execution || execution.ownerCommandId !== commandId || execution.projectId !== projectId || execution.sessionId !== sessionId || execution.status !== 'running'
      || !command || command.project_id !== projectId || command.execution_id !== executionId || command.state !== 'running'
      || !attempt || attempt.project_id !== projectId || attempt.session_id !== sessionId || attempt.handoff_intent_at === null
      || attempt.claimed_at > attempt.handoff_intent_at || attempt.handoff_intent_at > startedAt || startedAt > now) {
      throw new Error('Owner启动回执与已认领交接记录不匹配')
    }
    database.prepare('INSERT INTO project_owner_execution_start_receipts(execution_id,command_id,project_id,session_id,runner_name,process_id,started_at,received_at) VALUES(?,?,?,?,?,?,?,?)').run(executionId, commandId, projectId, sessionId, runnerName.trim(), processId, startedAt, now)
  })()
}
export function isOwnerStartProven(executionId: string, commandId: string): boolean {
  return Boolean(store.getProjectDb().prepare('SELECT 1 FROM project_owner_execution_start_receipts WHERE execution_id=? AND command_id=?').get(executionId, commandId))
}
/** claim后调Runtime前：准入gate session（兑现"仅供未来claim链调用"注释）。 */
export function admitOwnerGateForClaim(executionId: string, sessionId: string): void {
  admitOwnerExecutionGateSession(executionId, sessionId)
}
