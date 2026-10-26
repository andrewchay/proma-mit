/** Owner用途只由同库权威关联解析。配置/资料快照不是费用许可；最终发送仍须controlled准入。 */
import { createHash } from 'node:crypto'
import type { ProjectOwnerPlanningContext } from '@gravitas/shared'
import { getOwnerCarrierFacts, getOwnerRuntimeBinding, type OwnerPlanningLink, type OwnerRuntimeBinding } from './project-owner-runtime-binding'
import { assertLocalActorEnabled, getProjectOwnerPlanningContext, getProjectOwnerPlanDraft } from './project-owner-plan-service'
import { buildProjectOwnerPlanningRequest, type ProjectOwnerPlanningRequest } from './project-owner-planning-protocol'
import * as store from './project-sqlite-store'
export interface OwnerPlanningTaskSource {
  link: OwnerPlanningLink
  binding: OwnerRuntimeBinding
  context: ProjectOwnerPlanningContext
  request: ProjectOwnerPlanningRequest
}
export interface OwnerPlanningSessionSource extends OwnerPlanningTaskSource {
  executionId: string
  sessionId: string
}
interface LinkRow {
  id: string
  project_id: string
  request_id: string
  planning_task_id: string
  input_hash: string
  payload: string
  source_snapshot: string | null
}
interface PurposeRow { id: string; owner_planning_link_id: string | null; execution_id: string | null }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function id(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 128) throw new Error('Owner规划记录身份无效'); return value }
function number(value: unknown, minimum: number): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error('Owner规划记录版本无效'); return value }
function digest(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Owner规划记录指纹无效'); return value }
/** 严格读取不可覆盖的来源记录。完成回执可读取冻结资料；不据此授权新发送。 */
export function readOwnerPlanningSnapshot(taskId: string): { link: OwnerPlanningLink; context: ProjectOwnerPlanningContext; request: ProjectOwnerPlanningRequest } | null {
  const row = store.getProjectDb().prepare('SELECT * FROM project_owner_planning_links WHERE planning_task_id = ?').get(taskId) as LinkRow | undefined
  const purpose = store.getProjectDb().prepare('SELECT id, owner_planning_link_id, execution_id FROM controlled_task_preparations WHERE task_id = ?').get(taskId) as PurposeRow | undefined
  if (!row && !purpose?.owner_planning_link_id) {
    if (store.hasOwnerPlanningTaskEvidence(taskId)) throw new Error('Owner规划关联或目的证据缺失，不允许降级普通Agent')
    return null
  }
  if (!row || !purpose || purpose.owner_planning_link_id !== row.id) throw new Error('Owner规划关联或目的证据缺失，不允许降级普通Agent')
  try {
    const value = JSON.parse(row.payload) as Record<string, unknown>
    const targetTaskId = value.targetTaskId === undefined ? undefined : id(value.targetTaskId)
    const link: OwnerPlanningLink = { schemaVersion: 1, id: id(row.id), projectId: id(row.project_id), requestId: id(row.request_id), planningTaskId: id(row.planning_task_id), ...(targetTaskId === undefined ? {} : { targetTaskId }), bindingRevision: number(value.bindingRevision, 1), goalRevision: number(value.goalRevision, 1), goalVersion: number(value.goalVersion, 1), planRevision: number(value.planRevision, 0), contextFingerprint: digest(value.contextFingerprint), carrierFingerprint: digest(value.carrierFingerprint), protocolVersion: '1', promptHash: digest(value.promptHash), purpose: 'owner_planning', maxRequests: 1, maxOutputTokens: 4096, createdAt: number(value.createdAt, 1) }
    if (Object.keys(value).length !== Object.keys(link).length || Object.entries(link).some(([key, item]) => value[key] !== item) || taskId !== link.planningTaskId || link.planningTaskId === link.targetTaskId) throw new Error('关联内容不一致')
    if (row.input_hash !== hash({ projectId: link.projectId, requestId: link.requestId, taskId: link.targetTaskId, bindingRevision: link.bindingRevision, goalRevision: link.goalRevision, planRevision: link.planRevision, contextFingerprint: link.contextFingerprint })) throw new Error('关联请求指纹不一致')
    if (!row.source_snapshot || row.source_snapshot.length > 300000) throw new Error('发送快照缺失或超限')
    const context = JSON.parse(row.source_snapshot) as ProjectOwnerPlanningContext
    const request = buildProjectOwnerPlanningRequest(context)
    if (context.goal.goal.projectId !== link.projectId || context.goal.goal.taskId !== link.targetTaskId || context.goal.goal.goalVersion !== link.goalVersion || context.goal.revision !== link.goalRevision || context.fingerprint !== link.contextFingerprint || hash(request) !== link.promptHash) throw new Error('冻结资料与关联不一致')
    return { link, context, request }
  } catch { throw new Error('Owner规划来源记录无效，请保留数据核查或重新准备') }
}
/** 仅当前来源可送模型。解析无Caller/Runner/费用授权副作用。 */
export function resolveOwnerPlanningTask(taskId: string): OwnerPlanningTaskSource | null {
  const frozen = readOwnerPlanningSnapshot(taskId)
  if (!frozen) return null
  assertLocalActorEnabled()
  const { link } = frozen
  const task = store.getTask(taskId)
  const binding = getOwnerRuntimeBinding(link.projectId)
  if (!binding || binding.revision !== link.bindingRevision || binding.carrierFingerprint !== link.carrierFingerprint || !task || task.projectId !== link.projectId || task.parentId || task.assignee?.userId !== `agent-${binding.carrierId}` || task.workspaceId !== binding.workspaceId || !['paused', 'pending', 'in_progress'].includes(task.status)) throw new Error('Owner规划目标身份或载体绑定已变化')
  const facts = getOwnerCarrierFacts(link.projectId, binding.carrierId, binding.workspaceId)
  const current = getProjectOwnerPlanningContext(link.projectId, link.targetTaskId)
  const plan = getProjectOwnerPlanDraft(link.projectId, link.targetTaskId)
  if (facts.carrierFingerprint !== binding.carrierFingerprint || facts.channelId !== binding.channelId || facts.modelId !== binding.modelId || current.goal.revision !== link.goalRevision || current.fingerprint !== link.contextFingerprint || JSON.stringify(current) !== JSON.stringify(frozen.context) || (plan?.revision ?? 0) !== link.planRevision) throw new Error('Owner规划目标、资料、计划或载体配置已更新，请重新准备确认')
  const preparation = store.getProjectDb().prepare('SELECT id FROM controlled_task_preparations WHERE task_id = ?').get(taskId) as { id: string } | undefined
  if (preparation?.id !== task.controlledPreparationId) throw new Error('Owner规划任务准备身份已变化')
  return { ...frozen, binding }
}
export function resolveOwnerPlanningSession(sessionId: string): OwnerPlanningSessionSource | null {
  const execution = store.getAgentExecutionBySessionId(sessionId)
  if (!execution || execution.entityType !== 'task') return null
  const source = resolveOwnerPlanningTask(execution.entityId)
  if (!source) return null
  // 持久停止意图先于abort；即使Runtime未确认取消，也不能再获得新发送许可。
  if (store.getProjectDb().prepare('SELECT execution_id FROM project_owner_planning_stop_requests WHERE execution_id = ?').get(execution.id)) throw new Error('Owner已请求停止，不能启动或继续发送')
  const preparation = store.getProjectDb().prepare('SELECT execution_id FROM controlled_task_preparations WHERE task_id = ?').get(source.link.planningTaskId) as { execution_id: string | null }
  if (execution.status !== 'running' || execution.sessionId !== sessionId || execution.agentId !== source.binding.carrierId || execution.projectId !== source.link.projectId || preparation.execution_id !== execution.id || execution.pilotCommandId) throw new Error('Owner规划会话没有当前同来源受控执行，不能伪造Pilot授权')
  return { ...source, executionId: execution.id, sessionId }
}
