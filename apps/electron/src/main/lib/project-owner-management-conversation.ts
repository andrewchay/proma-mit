import { readOwnerManagementDelivery } from './project-owner-management-delivery'
/** 持续对话只产生管理资料与受控规划请求；不把自然语言当作授权或权威目标修改。 */
import { createHash } from 'node:crypto'
import type { OwnerManagementMessage, ProjectOwnerPlanningContext, SendOwnerManagementMessageRequest } from '@gravitas/shared'
import { appendOwnerManagementMessage, getOwnerManagementMessage, getOwnerManager, recordOwnerConversationMessage, recordStaleOwnerManagementTrace } from './project-owner-management-store'
import { getProjectOwnerGoalDraft } from './project-owner-goal-service'
import { assertLocalActorEnabled, getProjectOwnerPlanDraft, getProjectOwnerPlanningContext } from './project-owner-plan-service'
import { getOwnerRuntimeBinding, prepareOwnerPlanning } from './project-owner-runtime-binding'
import * as store from './project-sqlite-store'
import { readOwnerExecutionObservation } from './project-owner-management-execution'
import { getOwnerManagementDelegation } from './project-owner-management-delegation'

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function parse(raw: unknown): SendOwnerManagementMessageRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error('Owner消息必须是JSON对象')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some(key => !['projectId', 'taskId', 'conversationId', 'requestId', 'expectedGoalRevision', 'content', 'deliveryReference'].includes(key))
    || ['projectId', 'conversationId', 'requestId', ...(value.taskId === undefined ? [] : ['taskId'])].some(key => typeof value[key] !== 'string' || !value[key].trim() || value[key] !== value[key].trim() || value[key].length > 128)
    || !Number.isSafeInteger(value.expectedGoalRevision) || Number(value.expectedGoalRevision) < 1
    || typeof value.content !== 'string' || !value.content.trim() || value.content.length > 4000) throw new Error('Owner消息身份、目标版本或内容无效')
  if (value.deliveryReference !== undefined) {
    const reference = value.deliveryReference as Record<string, unknown>
    if (!reference || typeof reference !== 'object' || Array.isArray(reference) || Object.getPrototypeOf(reference) !== Object.prototype
      || Object.keys(reference).some(key => !['messageId', 'artifactHash', 'stepKey'].includes(key))
      || typeof reference.messageId !== 'string' || !/^[a-f0-9]{64}$/.test(reference.messageId)
      || typeof reference.artifactHash !== 'string' || !/^[a-f0-9]{64}$/.test(reference.artifactHash)
      || (reference.stepKey !== undefined && (typeof reference.stepKey !== 'string' || !reference.stepKey.trim() || reference.stepKey.length > 100))) throw new Error('Owner交付引用无效')
  }
  return { ...value, content: value.content.trim() } as unknown as SendOwnerManagementMessageRequest
}
export function sendOwnerManagementMessage(raw: unknown): OwnerManagementMessage {
  const input = parse(raw), eventId = `conversation:${input.projectId}:${input.requestId}`
  let saved: OwnerManagementMessage | undefined
  store.getProjectDb().transaction(() => {
    assertLocalActorEnabled()
    const manager = getOwnerManager(input.projectId)
    if (!manager || manager.conversationId !== input.conversationId) throw new Error('Owner会话已变化，请读取当前项目对话')
    const old = getOwnerManagementMessage(input.projectId, hash({ eventId, role: 'user', kind: 'conversation' }))
    if (old) {
      if (old.content !== input.content || old.taskId !== input.taskId || old.goalRevision !== input.expectedGoalRevision || JSON.stringify(old.deliveryReference) !== JSON.stringify(input.deliveryReference)) throw new Error('消息请求ID已用于不同内容、交付或目标')
      saved = old; return
    }
    const goal = getProjectOwnerGoalDraft(input.projectId, input.taskId)
    if (!goal || goal.revision !== input.expectedGoalRevision) throw new Error('目标已更新，请读取当前对话后再发送；输入已保留')
    if (input.deliveryReference) readOwnerManagementDeliveryFeedback(input.projectId, manager.conversationId, input.taskId, input.deliveryReference)
    saved = recordOwnerConversationMessage({ projectId: input.projectId, eventId, role: 'user', kind: 'conversation', ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.deliveryReference ? { deliveryReference: input.deliveryReference } : {}), goalRevision: goal.revision, content: input.content })
  })()
  if (!saved) throw new Error('Owner消息未确认保存')
  return saved
}

function readOwnerManagementDeliveryFeedback(projectId: string, conversationId: string, taskId: string | undefined, reference: NonNullable<OwnerManagementMessage['deliveryReference']>): NonNullable<NonNullable<ProjectOwnerPlanningContext['conversation']>['deliveryFeedback']> {
  const source = getOwnerManagementMessage(projectId, reference.messageId)
  if (!source || source.conversationId !== conversationId || source.role !== 'assistant' || source.kind !== 'delivery'
    || source.taskId !== taskId || !source.delivery) throw new Error('反馈所指向的项目成果不存在或已变化')
  const matches = source.delivery.items.filter(item => item.artifactHash === reference.artifactHash && (!reference.stepKey || item.stepKey === reference.stepKey))
  if (matches.length !== 1) throw new Error('反馈所指向的成果版本不存在或不唯一')
  const item = matches[0]!
  if (createHash('sha256').update(item.content, 'utf8').digest('hex') !== reference.artifactHash) throw new Error('反馈所指向的成果正文完整性校验失败')
  return { version: 1, messageId: source.id, artifactHash: item.artifactHash, ...(reference.stepKey ? { stepKey: item.stepKey } : {}), title: item.title,
    acceptanceCriteria: [...item.acceptanceCriteria], content: item.content, ownerDecision: item.ownerDecision, reviewerSummary: item.reviewerSummary }
}
/** 每次仅取本主体、截至准确用户消息的有界历史；随后消息不会改变在途请求。 */
export function withOwnerConversationContext(context: ProjectOwnerPlanningContext, messageId: string, historyThroughMessageId?: string, interactionVersion: 1 | 2 = 2, deliveryVersion: 0 | 1 = 0, messageBindingVersion: 0 | 1 = 1, employeeInteractionVersion: 0 | 1 = 0, frozenEmployeeInteractions?: import('@gravitas/shared').OwnerEmployeeInteraction[]): ProjectOwnerPlanningContext {
  const projectId = context.goal.goal.projectId, taskId = context.goal.goal.taskId
  const manager = getOwnerManager(projectId), message = getOwnerManagementMessage(projectId, messageId)
  const employee = message?.kind === 'employee_interaction' && message.role === 'assistant' ? message.employeeInteraction : undefined
  const observation = message?.kind === 'execution_observation' && message.role === 'assistant' ? message.executionObservation : undefined
  if (!manager || !message || (!employee && !observation && (message.role !== 'user' || message.kind !== 'conversation')) || message.taskId !== taskId || message.goalRevision !== context.goal.revision) throw new Error('Owner对话来源与当前目标不一致')
  if (employee) {
    const current = (require('./project-owner-employee-interactions') as typeof import('./project-owner-employee-interactions')).getOwnerEmployeeInteraction(projectId, employee.id)
    if (!current || current.requestHash !== employee.requestHash) throw new Error('员工待决事项已更新')
  }
  if (observation) {
    const current = readOwnerExecutionObservation(projectId, observation.executionId, observation.trigger)
    if (current.taskId !== taskId || JSON.stringify(current.observation) !== JSON.stringify(observation)) throw new Error('Owner业务观察来源已变化')
  }
  const historyEnd = historyThroughMessageId ? getOwnerManagementMessage(projectId, historyThroughMessageId) : null
  if (historyThroughMessageId && (!historyEnd || historyEnd.taskId !== taskId)) throw new Error('Owner对话历史边界无效')
  const latest = historyEnd ?? (observation || employee ? message : (() => {
    const row = store.getProjectDb().prepare("SELECT id FROM project_owner_management_messages WHERE project_id = ? AND json_extract(payload, '$.taskId') IS ? ORDER BY rowid DESC LIMIT 1").get(projectId, taskId ?? null) as { id: string } | undefined
    return row ? getOwnerManagementMessage(projectId, row.id) : null
  })())
  if (!latest) throw new Error('Owner对话历史为空')
  const deliveryFeedback = message.deliveryReference
    ? readOwnerManagementDeliveryFeedback(projectId, manager.conversationId, taskId, message.deliveryReference)
    : undefined
  const rows = store.getProjectDb().prepare("SELECT id FROM project_owner_management_messages WHERE project_id = ? AND json_extract(payload, '$.taskId') IS ? AND rowid <= (SELECT rowid FROM project_owner_management_messages WHERE id = ?) ORDER BY rowid DESC LIMIT 25").all(projectId, taskId ?? null, latest.id) as { id: string }[]
  const messages: NonNullable<ProjectOwnerPlanningContext['conversation']>['messages'] = []
  let characters = 0
  for (const row of rows.slice(0, 24)) {
    const item = getOwnerManagementMessage(projectId, row.id)!
    if (characters + item.content.length > 24000) break
    messages.push({ id: item.id, role: item.role, content: item.content }); characters += item.content.length
  }
  const plan = getProjectOwnerPlanDraft(projectId, taskId)
  const tasks = store.listTasks(projectId).filter(task => (!taskId || task.id === taskId) && !store.hasOwnerPlanningTaskEvidence(task.id))
  const questionSources = require('./project-owner-management-questions') as typeof import('./project-owner-management-questions')
  const employeeInteractions = employeeInteractionVersion === 1
    ? frozenEmployeeInteractions ?? (require('./project-owner-employee-interactions') as typeof import('./project-owner-employee-interactions')).listOwnerEmployeeInteractions(projectId).filter(item => ['pending_owner', 'discussing_user'].includes(item.state))
    : undefined
  const result = { ...context, conversation: { ...(employeeInteractions ? { employeeInteractionVersion: 1 as const, employeeInteractions } : {}), ...(deliveryFeedback ? { deliveryFeedback } : {}), ...(observation ? { executionObservation: observation, ...(messageBindingVersion === 1 ? { observationMessageBindingVersion: 1 as const } : {}), ...(deliveryVersion === 1 ? { deliveryReview: readOwnerManagementDelivery(projectId, observation) } : {}) } : interactionVersion === 2 ? { interactionVersion: 2 as const, openQuestions: questionSources.getOwnerConversationQuestionSources(context, latest.id) } : {}), conversationId: manager.conversationId, throughMessageId: messageId, historyThroughMessageId: latest.id, messages: messages.reverse(), truncated: messages.length < rows.length, currentPlan: plan ? { revision: plan.revision, state: plan.state, proposal: plan.proposal } : null, tasks: tasks.slice(0, 30).map(({ id, title, status }) => ({ id, title, status })), tasksTruncated: tasks.length > 30 } }
  if (JSON.stringify(result).length > 280000) throw new Error('Owner对话与资料合计过长，请精简当前资料后继续')
  return result
}
/**
 * 选择下一轮要准备的来源。用户消息默认优先，但上一轮已经是用户对话时，
 * 先处理员工待决事项，避免连续对话把员工问题永久饿死。
 */
export function chooseOwnerPendingSource(input: { hasUser: boolean; userPrepared: boolean; hasObservation: boolean; previousKind?: string }): 'user' | 'observation' | null {
  if (input.hasObservation && (input.previousKind === 'conversation' || !input.hasUser || input.userPrepared)) return 'observation'
  if (input.hasUser && !input.userPrepared) return 'user'
  return input.hasObservation ? 'observation' : null
}

/** 新消息串行交给同一管理主体；运行期间只落消息，结果回调后再准备后续批次。 */
export function preparePendingOwnerConversation(projectId: string, taskId?: string): boolean {
  const database = store.getProjectDb()
  const user = database.prepare("SELECT id FROM project_owner_management_messages WHERE project_id = ? AND json_extract(payload, '$.kind') = 'conversation' AND json_extract(payload, '$.role') = 'user' AND json_extract(payload, '$.teamWorkspaceApproval') IS NULL AND json_extract(payload, '$.taskId') IS ? AND NOT EXISTS (SELECT 1 FROM project_owner_management_messages ignored WHERE ignored.project_id=project_owner_management_messages.project_id AND ignored.event_id='conversation-stale:' || project_owner_management_messages.id) ORDER BY rowid DESC LIMIT 1").get(projectId, taskId ?? null) as { id: string } | undefined
  const prepared = (id: string) => Boolean(database.prepare("SELECT 1 FROM project_owner_planning_links WHERE project_id=? AND json_extract(payload, '$.conversationMessageId')=? LIMIT 1").get(projectId, id))
  const observation = database.prepare("SELECT m.id FROM project_owner_management_messages m WHERE m.project_id=? AND json_extract(m.payload, '$.kind') IN ('execution_observation','employee_interaction') AND json_extract(m.payload, '$.taskId') IS ? AND NOT EXISTS (SELECT 1 FROM project_owner_management_messages ignored WHERE ignored.project_id=m.project_id AND ignored.event_id='conversation-stale:' || m.id) AND NOT EXISTS (SELECT 1 FROM project_owner_planning_links l WHERE l.project_id=m.project_id AND json_extract(l.payload, '$.conversationMessageId')=m.id) ORDER BY m.rowid LIMIT 1").get(projectId, taskId ?? null) as { id: string } | undefined
  // 公平性：上一轮若处理的是用户对话，下一轮优先员工待决事项，避免连续对话把员工问题永久饿死。
  const previous = database.prepare("SELECT json_extract(payload, '$.conversationMessageId') AS messageId FROM project_owner_planning_links WHERE project_id = ? AND json_extract(payload, '$.targetTaskId') IS ? ORDER BY rowid DESC LIMIT 1").get(projectId, taskId ?? null) as { messageId: string | null } | undefined
  const previousKind = previous?.messageId
    ? (database.prepare("SELECT json_extract(payload, '$.kind') AS kind FROM project_owner_management_messages WHERE project_id = ? AND id = ?").get(projectId, previous.messageId) as { kind: string } | undefined)?.kind
    : undefined
  const source = chooseOwnerPendingSource({ hasUser: Boolean(user), userPrepared: Boolean(user && prepared(user.id)), hasObservation: Boolean(observation), ...(previousKind ? { previousKind } : {}) })
  // 没有明确偏好时保留旧行为：仍回落到用户消息，供既有续接/陈旧提示路径判断。
  const row = source === 'observation' ? observation : user ?? observation
  if (!row) return false
  const message = getOwnerManagementMessage(projectId, row.id)!, goal = getProjectOwnerGoalDraft(projectId, taskId)
  const links = store.getProjectDb().prepare("SELECT planning_task_id, payload FROM project_owner_planning_links WHERE project_id = ? AND json_extract(payload, '$.targetTaskId') IS ? ORDER BY rowid DESC").all(projectId, taskId ?? null) as { planning_task_id: string; payload: string }[]
  if (!goal || goal.revision !== message.goalRevision) {
    const runs = require('./project-owner-planning-run-service') as typeof import('./project-owner-planning-run-service')
    const handled = links.filter(link => (JSON.parse(link.payload) as { conversationMessageId?: string }).conversationMessageId === message.id).some(link => store.listAgentExecutionsByEntity('task', link.planning_task_id).some(execution => {
      const outcome = runs.getOwnerPlanningRunOutcome(execution.id)
      return outcome && ['replied', 'proposed', 'needs_clarification'].includes(outcome.state)
    }))
    if (handled) return false
    appendOwnerManagementMessage({ projectId, eventId: `conversation-stale:${message.id}`, role: 'assistant', kind: 'attention', ...(taskId ? { taskId } : {}), content: '这条消息保存后，项目目标已更新。我保留了原文，但不会把它套用到新目标；请在当前目标下补充你的想法。' })
    return false
  }
  const delegation = getOwnerManagementDelegation(projectId, taskId)
  // 上次请求的"结论不可继续"（例如 Owner 回复未通过协议校验）不该永久冻结项目：
  // 旧请求保持保守预留与未知费用记录，不重试、不补造用量；新消息按新请求处理。
  const attentionDecision = decideAttentionCarryover(delegation)
  const recoverableAttention = attentionDecision === 'proceed'
  if (attentionDecision === 'budget_blocked') {
    appendOwnerManagementMessage({
      projectId, eventId: `conversation-attention-budget:${message.id}`, role: 'assistant', kind: 'attention',
      ...(taskId ? { taskId } : {}),
      content: '上一条请求的结论无法继续且费用未知，已按保守上界占用额度；剩余预算不足以再发一次请求。我没有发送模型请求。请先核对上次请求费用，或提高项目预算与请求次数上限后再继续。',
    })
    return true
  }
  if (recoverableAttention) {
    appendOwnerManagementMessage({
      projectId, eventId: `conversation-attention-carryover:${message.id}`, role: 'assistant', kind: 'management_progress',
      ...(taskId ? { taskId } : {}),
      content: '上一条请求的结论无法继续，我不会重试它；它的费用仍按保守预留占用、记为未知，不会补造用量。你现在这条消息会作为新的请求处理。若预算预留已不足，我会在这里说明而不是继续发送。',
    })
  }
  if ((delegation.state !== 'active' || !delegation.delegation) && !recoverableAttention) {
    if (delegation.state === 'stale' && delegation.delegation) recordStaleOwnerManagementTrace(projectId, delegation.delegation.id, taskId)
    const detail = delegation.state === 'attention'
      ? '上一条请求的运行或费用状态需要核对'
      : delegation.state === 'stale'
        ? `管理授权已失效：${delegation.detail}`
        : delegation.state === 'exhausted'
          ? '管理请求次数或预算预留已用尽'
          : delegation.state === 'expired'
            ? '管理授权已到期'
            : delegation.state === 'revoked'
              ? '管理授权已撤销'
              : '当前没有有效的持续管理授权'
    const recovery = delegation.state === 'attention'
      ? '重新确认授权范围不会解除这次暂停；请先核对上次请求的运行和费用状态。当前应用不能登记外部账单核对结果并恢复授权。'
      : '请在项目对话中的Owner授权卡核对当前范围并重新确认；确认后我会自动继续处理这条消息。'
    appendOwnerManagementMessage({ projectId, eventId: `conversation-blocked:${message.id}:${delegation.state}:${hash(delegation.detail)}`, role: 'assistant', kind: 'attention', ...(taskId ? { taskId } : {}), content: `你的消息已保存，但我暂停了后续处理：${detail}。我没有为这条消息发送模型请求。${recovery}已有预算预留只是保守上界，不是实际账单。` })
    return true
  }
  if (links.some(link => store.listAgentExecutionsByEntity('task', link.planning_task_id).some(execution => ['queued', 'running'].includes(execution.status)))) {
    appendOwnerManagementMessage({ projectId, eventId: `conversation-waiting:${message.id}`, role: 'assistant', kind: 'management_progress', ...(taskId ? { taskId } : {}), content: '已收到这条补充。我正在完成当前回复，随后会继续处理你的新消息；你无需重复发送。' })
    return true
  }
  // 已发送的请求不因回调或重启再次生成；未启动的链接仅在来源过期时重建。
  const previousLink = links.find(link => (JSON.parse(link.payload) as { conversationMessageId?: string }).conversationMessageId === message.id)
  const previousExecutions = previousLink ? store.listAgentExecutionsByEntity('task', previousLink.planning_task_id) : []
  if (previousExecutions.length) return true
  const binding = getOwnerRuntimeBinding(projectId)
  if (!binding) {
    appendOwnerManagementMessage({ projectId, eventId: `conversation-config:${message.id}`, role: 'assistant', kind: 'configuration_required', ...(taskId ? { taskId } : {}), content: '你的消息已保存。确认本项目使用的模型和工作位置后，我会继续；暂未调用模型。' })
    return true
  }
  if (message.executionObservation) {
    try {
      const current = readOwnerExecutionObservation(projectId, message.executionObservation.executionId, message.executionObservation.trigger)
      if (current.taskId !== taskId || JSON.stringify(current.observation) !== JSON.stringify(message.executionObservation)) throw new Error('观察已变化')
    } catch {
      appendOwnerManagementMessage({ projectId, eventId: `conversation-stale:${message.id}`, role: 'assistant', kind: 'attention', ...(taskId ? { taskId } : {}), content: '执行情况已有更新。我保留了之前的观察，不会按过时结果发起分析；将核对最新记录后继续。' })
      return false
    }
  }
  const context = getProjectOwnerPlanningContext(projectId, taskId), plan = getProjectOwnerPlanDraft(projectId, taskId)
  if (previousLink) {
    const source = JSON.parse(previousLink.payload) as { bindingRevision?: number; goalRevision?: number; planRevision?: number; contextFingerprint?: string }
    if (source.bindingRevision === binding.revision && source.goalRevision === goal.revision
      && source.planRevision === (plan?.revision ?? 0) && source.contextFingerprint === context.fingerprint) return true
  }
  const link = prepareOwnerPlanning(projectId, { requestId: `conversation:${message.id}${previousLink ? `:recovered:${binding.revision}:${goal.revision}:${plan?.revision ?? 0}` : ''}`, ...(taskId ? { taskId } : {}), conversationMessageId: message.id, expectedBindingRevision: binding.revision, expectedGoalRevision: goal.revision, expectedPlanRevision: plan?.revision ?? 0, expectedContextFingerprint: context.fingerprint })
  appendOwnerManagementMessage({ projectId, eventId: `conversation-ready:${message.id}:${link.planningTaskId}`, role: 'assistant', kind: message.executionObservation ? 'management_progress' : 'planning_confirmation', ...(taskId ? { taskId } : {}), planningTaskId: link.planningTaskId, content: message.executionObservation ? '员工的最新情况已记录。我会在已确认的管理范围内分析进展与问题；许可不可用时保留结果并停等。' : '消息已保存。我正在结合当前目标、方案和项目状态回应；若授权或费用状态阻止继续，我会在这里说明具体原因。聊天本身不修改目标、方案或执行许可。' })
  return true
}

/** 重启或旧版本遗留的消息链接尚未创建执行时，允许在恢复授权后重新准备。 */
export function hasUnstartedOwnerConversation(projectId: string, taskId?: string): boolean {
  const row = store.getProjectDb().prepare("SELECT id FROM project_owner_management_messages WHERE project_id = ? AND json_extract(payload, '$.kind') = 'conversation' AND json_extract(payload, '$.role') = 'user' AND json_extract(payload, '$.teamWorkspaceApproval') IS NULL AND json_extract(payload, '$.taskId') IS ? AND NOT EXISTS (SELECT 1 FROM project_owner_management_messages ignored WHERE ignored.project_id=project_owner_management_messages.project_id AND ignored.event_id='conversation-stale:' || project_owner_management_messages.id) ORDER BY rowid DESC LIMIT 1").get(projectId, taskId ?? null) as { id: string } | undefined
  if (!row) return false
  const link = store.getProjectDb().prepare("SELECT planning_task_id, payload FROM project_owner_planning_links WHERE project_id = ? AND json_extract(payload, '$.conversationMessageId') = ? ORDER BY rowid DESC LIMIT 1").get(projectId, row.id) as { planning_task_id: string; payload: string } | undefined
  if (!link) return true
  return store.listAgentExecutionsByEntity('task', link.planning_task_id).length === 0
}

/**
 * 决定"上次请求结论不可继续"时该如何处理新消息。
 *
 * 原则：旧请求保持保守预留、费用记为未知、绝不重试；新消息可以作为新请求继续，
 * 但如果剩余预算不足以覆盖一次保守上界，就必须停下来说明，不能靠放行绕过额度。
 */
export function decideAttentionCarryover(view: {
  state: string
  usedRequests: number
  reservedCostMicros: number
  attentionCheck?: { reason: string }
  delegation: { maxRequests: number; maxCostMicros: number; perRequestCeilingMicros: number; autonomousExecution?: boolean } | null
}): 'blocked' | 'budget_blocked' | 'proceed' {
  if (view.state !== 'attention') return 'blocked'
  if (view.attentionCheck?.reason !== 'non_continueable_outcome') return 'blocked'
  const row = view.delegation
  if (!row) return 'blocked'
  const withinBudget = (row.autonomousExecution === true || view.usedRequests < row.maxRequests)
    && view.reservedCostMicros + row.perRequestCeilingMicros <= row.maxCostMicros
  return withinBudget ? 'proceed' : 'budget_blocked'
}
