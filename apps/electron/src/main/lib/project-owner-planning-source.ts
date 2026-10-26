/** Owner用途只由同库权威关联解析。配置/资料快照不是费用许可；最终发送仍须controlled准入。 */
import { withOwnerConversationContext } from './project-owner-management-conversation'
import { createHash } from 'node:crypto'
import { getAgentProviderProtocol, type OwnerExecutionAssignmentContext, type OwnerExecutionAssignmentInput, type ProjectOwnerPlanningContext } from '@gravitas/shared'
import { getChannelById } from './channel-manager'
import { getOwnerCarrierFacts, getOwnerRuntimeBinding, ownerCarrierBindingMatches, type OwnerPlanningLink, type OwnerRuntimeBinding } from './project-owner-runtime-binding'
import { assertLocalActorEnabled, getProjectOwnerPlanningContext, getProjectOwnerPlanDraft } from './project-owner-plan-service'
import { resolveProjectOwnerPlanningRequest, type ProjectOwnerPlanningRequest } from './project-owner-planning-protocol'
import { resolveOwnerExecutionAssignmentRequest } from './project-owner-execution-assignment-protocol'
import { ownerAssignmentContextMatchesApprovalTransition, parseOwnerExecutionAssignmentContext } from './project-owner-execution-assignment-context'
import { getCurrentOwnerExecutionAssignmentContext } from './project-owner-execution-assignment-context-service'
import * as store from './project-sqlite-store'
export interface OwnerPlanningTaskSource {
  link: OwnerPlanningLink
  binding: OwnerRuntimeBinding
  context: ProjectOwnerPlanningContext
  request: ProjectOwnerPlanningRequest
  assignmentContext?: OwnerExecutionAssignmentContext
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
  assignment_snapshot: string | null
}
interface PurposeRow { id: string; owner_planning_link_id: string | null; execution_id: string | null }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function id(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 128) throw new Error('Owner规划记录身份无效'); return value }
function number(value: unknown, minimum: number): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error('Owner规划记录版本无效'); return value }
function digest(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Owner规划记录指纹无效'); return value }
/** 严格读取不可覆盖的来源记录。完成回执可读取冻结资料；不据此授权新发送。 */
export function readOwnerPlanningSnapshot(taskId: string): { link: OwnerPlanningLink; context: ProjectOwnerPlanningContext; request: ProjectOwnerPlanningRequest; assignmentContext?: OwnerExecutionAssignmentContext } | null {
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
    const conversationMessageId = value.conversationMessageId === undefined ? undefined : id(value.conversationMessageId)
    const protocolVersion = value.protocolVersion === '1' ? '1' : value.protocolVersion === '2' ? '2' : value.protocolVersion === '3' ? '3' : value.protocolVersion === '4' ? '4' : value.protocolVersion === '5' ? '5' : undefined
    const requestPurpose = value.purpose === 'owner_planning' || value.purpose === 'owner_execution_assignment' ? value.purpose : undefined
    if (!protocolVersion || !requestPurpose) throw new Error('Owner请求协议版本/用途无效')
    const assignmentProtocolVersion = value.assignmentProtocolVersion === undefined ? undefined : value.assignmentProtocolVersion === '2' && requestPurpose === 'owner_execution_assignment' ? '2' : undefined
    if (value.assignmentProtocolVersion !== undefined && assignmentProtocolVersion === undefined) throw new Error('Owner安排协议版本无效')
    const assignmentContextFingerprint = requestPurpose === 'owner_execution_assignment' ? digest(value.assignmentContextFingerprint) : undefined
    const usesExtendedOutput = assignmentProtocolVersion === '2' || requestPurpose === 'owner_planning' && protocolVersion !== '1'
    const expectedMaxOutputTokens = usesExtendedOutput ? 8192 : 4096
    const maxOutputTokens: 4096 | 8192 = expectedMaxOutputTokens
    if (value.maxOutputTokens !== maxOutputTokens) throw new Error('Owner请求协议输出限制无效')
    if (((protocolVersion === '3' || protocolVersion === '5') && value.reasoningEffort !== 'low') || ((protocolVersion !== '3' && protocolVersion !== '5') && value.reasoningEffort !== undefined)) throw new Error('Owner请求推理强度与协议版本不匹配')
    const link: OwnerPlanningLink = { schemaVersion: 1, id: id(row.id), projectId: id(row.project_id), requestId: id(row.request_id), planningTaskId: id(row.planning_task_id), ...(targetTaskId === undefined ? {} : { targetTaskId }), ...(conversationMessageId ? { conversationMessageId } : {}), bindingRevision: number(value.bindingRevision, 1), goalRevision: number(value.goalRevision, 1), goalVersion: number(value.goalVersion, 1), planRevision: number(value.planRevision, 0), contextFingerprint: digest(value.contextFingerprint), carrierFingerprint: digest(value.carrierFingerprint), protocolVersion, ...(assignmentProtocolVersion ? { assignmentProtocolVersion } : {}), ...((protocolVersion === '3' || protocolVersion === '5') ? { reasoningEffort: 'low' as const } : {}), promptHash: digest(value.promptHash), purpose: requestPurpose, ...(assignmentContextFingerprint ? { assignmentContextFingerprint } : {}), maxRequests: 1, maxOutputTokens, createdAt: number(value.createdAt, 1) }
    if (Object.keys(value).length !== Object.keys(link).length || Object.entries(link).some(([key, item]) => value[key] !== item) || taskId !== link.planningTaskId || link.planningTaskId === link.targetTaskId) throw new Error('Owner请求关联内容不一致')
    if (!row.source_snapshot || row.source_snapshot.length > 300000) throw new Error('Owner请求发送快照缺失或超限')
    const context = JSON.parse(row.source_snapshot) as ProjectOwnerPlanningContext
    if (context.goal.goal.projectId !== link.projectId || context.goal.goal.taskId !== link.targetTaskId || context.goal.goal.goalVersion !== link.goalVersion || context.goal.revision !== link.goalRevision || context.fingerprint !== link.contextFingerprint) throw new Error('Owner冻结规划资料与关联不一致')
    let assignmentContext: OwnerExecutionAssignmentContext | undefined
    let request: ProjectOwnerPlanningRequest
    if (link.purpose === 'owner_execution_assignment') {
      if (!row.assignment_snapshot || row.assignment_snapshot.length > 300000) throw new Error('Owner安排冻结资料缺失或超限')
      assignmentContext = parseOwnerExecutionAssignmentContext(JSON.parse(row.assignment_snapshot))
      if (assignmentContext.contextFingerprint !== link.assignmentContextFingerprint || assignmentContext.sourceContextFingerprint !== context.fingerprint || assignmentContext.projectId !== link.projectId || assignmentContext.taskId !== link.targetTaskId || assignmentContext.planRevision !== link.planRevision || assignmentContext.bindingRevision !== link.bindingRevision) throw new Error('Owner安排冻结资料与关联不一致')
      request = resolveOwnerExecutionAssignmentRequest(assignmentContext, link.promptHash)
    } else {
      if (row.assignment_snapshot !== null || value.assignmentContextFingerprint !== undefined) throw new Error('Owner规划关联夹带安排资料')
      request = resolveProjectOwnerPlanningRequest(context, link.promptHash)
    }
    if ((context.conversation?.throughMessageId ?? undefined) !== link.conversationMessageId) throw new Error('Owner对话快照与关联不一致')
    if (hash(request) !== link.promptHash) throw new Error('Owner冻结请求指纹不一致')
    const baseHash = { projectId: link.projectId, requestId: link.requestId, taskId: link.targetTaskId, bindingRevision: link.bindingRevision, goalRevision: link.goalRevision, planRevision: link.planRevision, contextFingerprint: link.contextFingerprint, ...(link.conversationMessageId ? { conversationMessageId: link.conversationMessageId } : {}) }
    const expectedInputHash = link.purpose === 'owner_execution_assignment'
      ? hash({ ...baseHash, planFingerprint: assignmentContext!.planFingerprint, assignmentContextFingerprint: link.assignmentContextFingerprint })
      : hash(baseHash)
    if (row.input_hash !== expectedInputHash) throw new Error('Owner请求关联输入指纹不一致')
    return { link, context, request, ...(assignmentContext ? { assignmentContext } : {}) }
  } catch { throw new Error('Owner规划来源记录无效，请保留数据核查或重新准备') }
}
/** 仅当前来源可送模型。解析无Caller/Runner/费用授权副作用。 */
export function resolveOwnerPlanningTask(taskId: string, allowTerminalTask = false): OwnerPlanningTaskSource | null {
  const frozen = readOwnerPlanningSnapshot(taskId)
  if (!frozen) return null
  assertLocalActorEnabled()
  const { link } = frozen
  const task = store.getTask(taskId)
  const binding = getOwnerRuntimeBinding(link.projectId)
  const allowedTaskStatuses = allowTerminalTask ? ['paused', 'pending', 'in_progress', 'completed', 'failed', 'cancelled', 'stale'] : ['paused', 'pending', 'in_progress']
  if (!binding || binding.revision !== link.bindingRevision || binding.carrierFingerprint !== link.carrierFingerprint || !task || task.projectId !== link.projectId || task.parentId || task.assignee?.userId !== `agent-${binding.carrierId}` || task.workspaceId !== binding.workspaceId || !allowedTaskStatuses.includes(task.status)) throw new Error('Owner规划目标身份或载体绑定已变化')
  if ((link.protocolVersion === '3' || link.protocolVersion === '5') && (getChannelById(binding.channelId)?.provider !== 'zhipu' || !/^glm-5\.3(?:-flash)?$/i.test(binding.modelId))) throw new Error('Owner规划推理协议与冻结模型不匹配')
  if (link.protocolVersion === '4' && (binding.modelId !== 'deepseek-flash' || getAgentProviderProtocol(getChannelById(binding.channelId)!.provider, 'ai-sdk') !== 'openai-chat')) throw new Error('Owner规划JSON协议与冻结模型不匹配')
  const facts = getOwnerCarrierFacts(link.projectId, binding.carrierId, binding.workspaceId)
  const baseContext = getProjectOwnerPlanningContext(link.projectId, link.targetTaskId)
  const current = link.conversationMessageId ? withOwnerConversationContext(baseContext, link.conversationMessageId, frozen.context.conversation?.historyThroughMessageId, frozen.context.conversation?.interactionVersion ?? 1, frozen.context.conversation?.deliveryReview?.version ?? 0, frozen.context.conversation?.observationMessageBindingVersion ?? 0) : baseContext
  const plan = getProjectOwnerPlanDraft(link.projectId, link.targetTaskId)
  const assignmentApprovalTransition = link.purpose === 'owner_execution_assignment' && plan?.state === 'confirmed'
    && plan.planFingerprint === frozen.assignmentContext?.planFingerprint && plan.revision === link.planRevision + 1
  if (!ownerCarrierBindingMatches(binding, facts) || current.goal.revision !== link.goalRevision || current.fingerprint !== link.contextFingerprint || JSON.stringify(current) !== JSON.stringify(frozen.context)
    || !((plan?.revision ?? 0) === link.planRevision || assignmentApprovalTransition)) throw new Error('Owner规划目标、资料、计划或载体配置已更新，请重新准备确认')
  if (link.purpose === 'owner_execution_assignment') {
    const previous = frozen.assignmentContext
    if (!previous) throw new Error('Owner安排冻结资料缺失')
    const input: OwnerExecutionAssignmentInput = { requestId: link.requestId, expectedBindingRevision: link.bindingRevision, expectedGoalRevision: link.goalRevision, expectedPlanRevision: plan?.revision ?? link.planRevision, expectedPlanFingerprint: previous.planFingerprint, expectedContextFingerprint: link.contextFingerprint, ...(previous.feedback ? { feedback: previous.feedback } : {}) }
    const latest = getCurrentOwnerExecutionAssignmentContext({ projectId: link.projectId, ...(link.targetTaskId === undefined ? {} : { taskId: link.targetTaskId }) }, input, previous.teamContractVersion ?? 1)
    const sameContext = assignmentApprovalTransition
      ? ownerAssignmentContextMatchesApprovalTransition(previous, latest.context)
      : latest.context.contextFingerprint === previous.contextFingerprint && JSON.stringify(latest.context) === JSON.stringify(previous)
    if (!sameContext) throw new Error('Owner安排的计划、工作区或团队候选已变化，请重新提案')
  }
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
