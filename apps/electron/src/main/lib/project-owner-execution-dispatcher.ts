/** Owner命令专用、显式dispatch入口；不由heartbeat、普通排队或启动恢复调用。 */
import { isAgentCompatibleProvider } from '@gravitas/shared'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getChannelById } from './channel-manager'
import { hasProjectWorkspaceBinding } from './project-workspace-bindings'
import { assertLocalActorEnabled } from './project-owner-plan-service'
import { getOwnerExecutionRevalidation } from './project-owner-execution-revalidation'
import { ownerExecutionObject } from './project-owner-execution-source'
import * as store from './project-sqlite-store'
import { startOwnerCommandExecution } from './agent-employee-service'

interface OwnerDispatchCommandRow {
  id: string
  project_id: string
  grant_id: string
  source_task_id: string
  employee_id: string
  role: string
  source_version: number
  ack_fingerprint: string
  state: string
  execution_id: string | null
  reserved_cost_micros: number
}
interface OwnerDispatchGrantRow {
  state: string
  dispatch_mode: string
  revalidation_id: string
  revalidation_revision: number
  revalidation_integrity_hash: string
  materialization_id: string
  materialization_integrity_hash: string
  policy_revision: number
  executor_employee_id: string
  reviewer_employee_id: string
  workspace_id: string
  channel_id: string
  model_id: string
  runtime: string
  expires_at: number
}

/** 唯一派发入口只接受 command 身份、确认指纹与独立执行确认；其余运行参数全部从权威库重建。 */
async function dispatchOwnerCommandExecutionForMode(raw: unknown, expectedMode: 'manual' | 'autonomous'): Promise<{ commandId: string; executionId: string; started: boolean }> {
  assertLocalActorEnabled()
  const input = ownerExecutionObject(raw, ['commandId', 'ackFingerprint', 'acknowledgeExecution'])
  if (typeof input.commandId !== 'string' || !input.commandId.trim()
    || typeof input.ackFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.ackFingerprint)
    || input.acknowledgeExecution !== true) {
    throw new Error('Owner执行需提供有效确认指纹并单独确认本次启动')
  }
  const database = store.getProjectDb()
  if (database.isTransactionActive()) throw new Error('Owner dispatcher拒绝未提交外层事务')
  const command = database.prepare('SELECT * FROM project_owner_execution_commands WHERE id=?').get(input.commandId) as OwnerDispatchCommandRow | undefined
  if (!command || command.state !== 'queued' || !command.execution_id || command.ack_fingerprint !== input.ackFingerprint) {
    throw new Error('Owner命令未排队、指纹不匹配或已被消费')
  }
  const execution = store.getAgentExecution(command.execution_id)
  const grant = database.prepare('SELECT * FROM project_owner_execution_grants WHERE id=? AND project_id=?').get(command.grant_id, command.project_id) as OwnerDispatchGrantRow | undefined
  if (!execution || execution.status !== 'queued' || execution.ownerCommandId !== command.id
    || execution.projectId !== command.project_id || execution.entityId !== command.source_task_id
    || execution.agentId !== command.employee_id || !grant || grant.state !== 'active' || grant.expires_at <= Date.now()) {
    throw new Error('Owner命令、执行或活动授权归属无法核验')
  }
  if (grant.dispatch_mode !== expectedMode) throw new Error(expectedMode === 'manual' ? '自主命令只能由主进程Scheduler派发' : '此命令不属于自主授权模式')
  if (grant.runtime !== 'ai-sdk') throw new Error('Owner dispatcher当前只支持AI SDK Runtime')
  const employee = store.getAgentEmployee(command.employee_id)
  const channel = getChannelById(grant.channel_id)
  const workspace = getAgentWorkspace(grant.workspace_id)
  const view = getOwnerExecutionRevalidation({ projectId: command.project_id })
  const record = view.revalidation
  const task = store.getTask(command.source_task_id)
  const frozenTask = record?.source.tasks.find((item) => item.taskId === command.source_task_id)
  const roleEmployeeId = command.role === 'executor'
    ? (frozenTask?.executor?.id ?? record?.source.executor.id ?? '')
    : command.role === 'reviewer' ? record?.source.reviewer.id ?? '' : ''
  if (view.status !== 'current' || !record || record.revision !== grant.revalidation_revision
    || record.id !== grant.revalidation_id || record.integrityHash !== grant.revalidation_integrity_hash
    || record.source.materialization.id !== grant.materialization_id
    || record.source.materialization.integrityHash !== grant.materialization_integrity_hash
    || record.source.runtime !== 'ai-sdk' || record.source.channelId !== grant.channel_id
    || record.source.modelId !== grant.model_id || record.source.workspaceId !== grant.workspace_id
    || !frozenTask || roleEmployeeId !== command.employee_id || (command.role === 'executor' && frozenTask.executor && task?.assignee?.userId !== `agent-${command.employee_id}`) || !employee?.enabled || employee.workflowId
    || employee.runtime !== 'ai-sdk' || employee.channelId !== grant.channel_id || employee.modelId !== grant.model_id
    || employee.executionProfile !== record.source.executionKind || !channel?.enabled || !isAgentCompatibleProvider(channel.provider, 'ai-sdk')
    || !channel.models.some(item => item.id === grant.model_id && item.enabled)
    || !workspace || !hasProjectWorkspaceBinding(command.project_id, grant.workspace_id)
    || !task || task.projectId !== command.project_id || task.status !== 'paused') {
    throw new Error('Owner派发来源、员工、渠道、工作区或任务状态已变化')
  }
  const link = database.prepare('SELECT revalidation_revision FROM project_owner_execution_command_links WHERE command_id=? AND execution_id=?').get(command.id, execution.id) as { revalidation_revision: number } | undefined
  if (!link || link.revalidation_revision !== record.revision) throw new Error('Owner命令与重验证版本链接不一致')
  const started = await startOwnerCommandExecution({
    executionId: execution.id,
    commandId: command.id,
    role: command.role as 'executor' | 'reviewer',
    expectedRevalidationRevision: link.revalidation_revision,
    reservedCostMicros: command.reserved_cost_micros,
  })
  return { commandId: command.id, executionId: execution.id, started }
}
/** IPC 人工派发入口：不能消费 autonomous command。 */
export function dispatchOwnerCommandExecution(raw: unknown): Promise<{ commandId: string; executionId: string; started: boolean }> {
  return dispatchOwnerCommandExecutionForMode(raw, 'manual')
}
/** 仅供 main Scheduler 使用，不注册为 Renderer IPC。 */
export function dispatchAutonomousOwnerCommandExecution(raw: unknown): Promise<{ commandId: string; executionId: string; started: boolean }> {
  return dispatchOwnerCommandExecutionForMode(raw, 'autonomous')
}
