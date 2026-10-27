/** 从可信Run派生待确认理解；用户裁决仍写入既有消息、目标及答复账本，无第二套目标真相。 */
import { createHash } from 'node:crypto'
import type { DecideOwnerConversationChangeRequest, OwnerConversationChangeDecision, OwnerConversationChangeResult, OwnerConversationChangeView, ProjectOwnerGoalDraft } from '@gravitas/shared'
import { getOwnerPlanningRunOutcome, getOwnerPlanningRunReceipt } from './project-owner-planning-run-service'
import { readOwnerPlanningSnapshot, resolveOwnerPlanningTask } from './project-owner-planning-source'
import { appendOwnerManagementMessage, getOwnerManagementMessage, getOwnerManager } from './project-owner-management-store'
import { answerOwnerManagementQuestion, listOwnerManagementQuestions } from './project-owner-management-questions'
import { getProjectOwnerGoalDraft, listProjectOwnerGoalHistory, saveProjectOwnerGoalDraft } from './project-owner-goal-service'
import { getOwnerManagementDelegation, revokeOwnerManagementDelegation } from './project-owner-management-delegation'
import { assertLocalActorEnabled } from './project-owner-plan-service'
import * as store from './project-sqlite-store'

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const eventId = (id: string) => `conversation-change-decision:${id}`
function source(projectId: string, id: string) {
  const receipt = getOwnerPlanningRunReceipt(id), outcome = receipt ? getOwnerPlanningRunOutcome(receipt.executionId) : null
  const frozen = receipt ? readOwnerPlanningSnapshot(receipt.planningTaskId) : null
  if (!receipt || receipt.projectId !== projectId || receipt.purpose !== 'owner_planning' || outcome?.receiptId !== receipt.id || outcome.state !== 'replied' || !outcome.changeProposal || !outcome.reply || frozen?.context.conversation?.interactionVersion !== 2 || !frozen.link.conversationMessageId) throw new Error('Owner内容理解没有可信来源或不属于当前项目')
  const message = getOwnerManagementMessage(projectId, frozen.link.conversationMessageId)
  if (!message || message.role !== 'user' || message.kind !== 'conversation' || message.taskId !== frozen.link.targetTaskId || message.goalRevision !== frozen.link.goalRevision) throw new Error('Owner内容理解与原用户消息不一致')
  return { receipt, outcome, frozen, message, change: outcome.changeProposal }
}
function readDecision(view: OwnerConversationChangeView): { decision: OwnerConversationChangeDecision; goal?: ProjectOwnerGoalDraft } | null {
  const message = getOwnerManagementMessage(view.projectId, hash({ eventId: eventId(view.id), role: 'user', kind: 'change_decision' }))
  if (!message) return null
  const value = message.changeDecision
  if (message.kind !== 'change_decision' || message.changeId !== view.id || message.taskId !== view.taskId || !value || value.changeId !== view.id || value.previewHash !== view.previewHash || !['apply', 'dismiss'].includes(value.action) || typeof value.requestId !== 'string' || !value.requestId.trim()) throw new Error('Owner理解裁决与原提案不一致')
  if (value.action === 'dismiss') {
    if (value.goalRevision !== undefined || value.goalHash !== undefined) throw new Error('未采用的理解不能夹带目标更新')
    return { decision: value }
  }
  const goal = listProjectOwnerGoalHistory(view.projectId, view.taskId).find(item => item.revision === value.goalRevision)
  if (!goal || (goal.revision !== view.goalRevision + 1 && !(view.change.kind === 'clarification_answers' && goal.revision === view.goalRevision)) || hash(goal) !== value.goalHash) throw new Error('Owner理解裁决缺少准确目标回执')
  return { decision: value, goal }
}
function isCurrent(view: OwnerConversationChangeView): boolean {
  if (getOwnerManager(view.projectId)?.conversationId !== view.conversationId || getProjectOwnerGoalDraft(view.projectId, view.taskId)?.revision !== view.goalRevision) return false
  try {
    const original = source(view.projectId, view.id)
    resolveOwnerPlanningTask(original.frozen.link.planningTaskId, true)
    const latest = store.getProjectDb().prepare("SELECT id FROM project_owner_management_messages WHERE project_id=? AND json_extract(payload, '$.kind')='conversation' AND json_extract(payload, '$.role')='user' AND json_extract(payload, '$.taskId') IS ? ORDER BY rowid DESC LIMIT 1").get(view.projectId, view.taskId ?? null) as { id: string } | undefined
    if (latest?.id !== view.messageId) return false
    if (view.change.kind === 'clarification_answers') {
      const questionId = view.change.questionId
      const question = listOwnerManagementQuestions(view.projectId).find(item => item.id === questionId && item.state === 'open')
      if (!question || question.taskId !== view.taskId || question.goalRevision !== view.goalRevision || question.contextFingerprint !== original.frozen.link.contextFingerprint) return false
    }
    return true
  } catch { return false }
}
export function getOwnerConversationChange(projectId: string, id: string): OwnerConversationChangeView {
  const original = source(projectId, id), { frozen, change } = original, goal = frozen.context.goal.goal
  const question = change.kind === 'clarification_answers' ? frozen.context.conversation!.openQuestions?.find(item => item.id === change.questionId) : null
  const body = { id, projectId, ...(frozen.link.targetTaskId ? { taskId: frozen.link.targetTaskId } : {}), conversationId: frozen.context.conversation!.conversationId, messageId: frozen.link.conversationMessageId!, goalRevision: frozen.link.goalRevision, summary: original.outcome.reply!, change, currentGoal: { objective: goal.objective, constraints: goal.constraints, acceptanceCriteria: goal.acceptanceCriteria }, questions: question?.questions.map(({ key, question }) => ({ key, question })) ?? [] }
  const view: OwnerConversationChangeView = { ...body, previewHash: hash({ ...body, promptHash: frozen.link.promptHash }), state: 'pending' }
  const prior = readDecision(view)
  return { ...view, state: prior ? prior.decision.action === 'apply' ? 'applied' : 'dismissed' : isCurrent(view) ? 'pending' : 'stale' }
}
export function listOwnerConversationChanges(projectId: string): OwnerConversationChangeView[] {
  const rows = store.getProjectDb().prepare("SELECT o.receipt_id FROM project_owner_planning_run_outcomes o JOIN agent_executions e ON e.id=o.execution_id WHERE e.project_id=? AND json_extract(o.payload, '$.changeProposal') IS NOT NULL ORDER BY o.rowid DESC LIMIT 50").all(projectId) as { receipt_id: string }[]
  return rows.reverse().map(row => getOwnerConversationChange(projectId, row.receipt_id))
}
function parse(raw: unknown): DecideOwnerConversationChangeRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error('Owner理解裁决必须是JSON对象')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some(key => !['projectId', 'changeId', 'requestId', 'action', 'previewHash'].includes(key)) || ['projectId', 'requestId'].some(key => typeof value[key] !== 'string' || !value[key].trim() || value[key] !== value[key].trim() || value[key].length > 128) || [value.changeId, value.previewHash].some(item => typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item)) || !['apply', 'dismiss'].includes(String(value.action))) throw new Error('Owner理解裁决身份、指纹或动作无效')
  return value as unknown as DecideOwnerConversationChangeRequest
}
export function decideOwnerConversationChange(raw: unknown): OwnerConversationChangeResult {
  const input = parse(raw)
  let result: OwnerConversationChangeResult | undefined
  store.getProjectDb().transaction(() => {
    assertLocalActorEnabled()
    const view = getOwnerConversationChange(input.projectId, input.changeId)
    if (view.previewHash !== input.previewHash) throw new Error('Owner理解摘要已变化，请重新审阅')
    const collision = store.getProjectDb().prepare("SELECT payload FROM project_owner_management_messages WHERE project_id=? AND json_extract(payload, '$.kind')='change_decision' AND json_extract(payload, '$.changeDecision.requestId')=? LIMIT 1").get(input.projectId, input.requestId) as { payload: string } | undefined
    if (collision && (JSON.parse(collision.payload) as { changeId?: string }).changeId !== input.changeId) throw new Error('裁决请求ID已用于其他理解')
    const prior = readDecision(view)
    if (prior) {
      if (prior.decision.action !== input.action) throw new Error('这份理解已有不同裁决，请继续在对话说明你的想法')
      result = { changeId: view.id, action: input.action, ...(prior.goal ? { goal: prior.goal } : {}) }; return
    }
    if (view.state !== 'pending') throw new Error('目标、问题、配置或较新消息已变化，旧理解不能应用；请继续当前对话')
    let goal: ProjectOwnerGoalDraft | undefined
    if (input.action === 'apply') {
      if (view.change.kind === 'clarification_answers') {
        const original = source(view.projectId, view.id)
        const change = view.change
        const question = original.frozen.context.conversation!.openQuestions!.find(item => item.id === change.questionId)!
        goal = answerOwnerManagementQuestion({ projectId: view.projectId, questionId: question.id, requestId: `conversation:${view.id}`, expectedGoalRevision: view.goalRevision, expectedContextFingerprint: question.contextFingerprint, answers: view.change.answers })
      } else {
        const current = getProjectOwnerGoalDraft(view.projectId, view.taskId)!
        const delegation = getOwnerManagementDelegation(view.projectId, view.taskId).delegation
        goal = saveProjectOwnerGoalDraft(view.projectId, view.goalRevision, { ...view.change.goal, codeSourceAccess: current.goal.codeSourceAccess ?? 'none' }, view.taskId)
        // 用户已明确确认新目标；旧管理委托仅收紧为撤销，不发行或扩展任何新许可。
        if (delegation) revokeOwnerManagementDelegation(view.projectId, delegation.id)
      }
    }
    const decision: OwnerConversationChangeDecision = { changeId: view.id, requestId: input.requestId, action: input.action, previewHash: view.previewHash, ...(goal ? { goalRevision: goal.revision, goalHash: hash(goal) } : {}) }
    appendOwnerManagementMessage({ projectId: view.projectId, ...(view.taskId ? { taskId: view.taskId } : {}), eventId: eventId(view.id), role: 'user', kind: 'change_decision', changeId: view.id, changeDecision: decision, content: input.action === 'dismiss' ? '这份理解不准确，暂不采用。我会继续说明。' : view.change.kind === 'clarification_answers' ? '答复理解正确，按此补充并继续规划。' : '目标修订理解正确，按此更新；旧管理委托不再使用，新范围再确认。' })
    result = { changeId: view.id, action: input.action, ...(goal ? { goal } : {}) }
  })()
  if (!result) throw new Error('Owner理解裁决尚未确认保存')
  return result
}
