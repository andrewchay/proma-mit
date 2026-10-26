import { applyOwnerQualityDecision } from './project-owner-quality-actions'
import { createHash } from 'node:crypto'
import { applyOwnerClarificationAnswers, type AnswerOwnerManagementQuestionRequest, type OwnerManagementQuestion, type ProjectOwnerGoalDraft, type OwnerManagementView } from '@gravitas/shared'
import { getOwnerPlanningRunOutcome, getOwnerPlanningRunReceipt } from './project-owner-planning-run-service'
import { readOwnerPlanningSnapshot, resolveOwnerPlanningTask } from './project-owner-planning-source'
import { appendOwnerManagementMessage, recordOwnerManagementAnswer, getOwnerManager, getOwnerManagementView } from './project-owner-management-store'
import { getProjectOwnerGoalDraft, saveProjectOwnerGoalDraft } from './project-owner-goal-service'
import { assertLocalActorEnabled, getProjectOwnerPlanDraft } from './project-owner-plan-service'
import { getOwnerManagementDelegation } from './project-owner-management-delegation'
import * as store from './project-sqlite-store'

interface PayloadRow { payload: string; integrity_hash: string }
interface AnswerReceipt { questionId: string; projectId: string; requestId: string; answers: Record<string, string>; goal: ProjectOwnerGoalDraft }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function parse<T>(row: PayloadRow): T {
  const value: unknown = JSON.parse(row.payload)
  if (!value || typeof value !== 'object' || digest(value) !== row.integrity_hash) throw new Error('Owner问题记录完整性无效，请保留数据核查')
  return value as T
}
function readQuestion(projectId: string, id: string): OwnerManagementQuestion {
  const row = store.getProjectDb().prepare('SELECT payload, integrity_hash FROM project_owner_management_questions WHERE project_id = ? AND id = ?').get(projectId, id) as PayloadRow | undefined
  if (!row) throw new Error('Owner问题不存在或不属于当前项目')
  const question = parse<OwnerManagementQuestion>(row)
  const manager = getOwnerManager(projectId)
  const outcome = getOwnerPlanningRunOutcome(question.executionId)
  const receipt = getOwnerPlanningRunReceipt(question.receiptId)
  const snapshot = receipt ? readOwnerPlanningSnapshot(receipt.planningTaskId) : null
  if (!manager || question.id !== id || question.projectId !== projectId || question.conversationId !== manager.conversationId
    || question.state !== 'open' || receipt?.projectId !== projectId || receipt.executionId !== question.executionId || receipt.planningTaskId !== question.planningTaskId
    || snapshot?.link.purpose !== 'owner_planning' || snapshot.link.targetTaskId !== question.taskId || snapshot.link.goalRevision !== question.goalRevision || snapshot.context.fingerprint !== question.contextFingerprint
    || outcome?.state !== 'needs_clarification' || outcome.receiptId !== question.receiptId || outcome.clarification?.reason !== question.reason || JSON.stringify(outcome.clarification.questions) !== JSON.stringify(question.questions)) throw new Error('Owner问题与权威来源不一致')
  return question
}
function existingAnswer(question: OwnerManagementQuestion): AnswerReceipt | null {
  const row = store.getProjectDb().prepare('SELECT payload, integrity_hash FROM project_owner_management_answers WHERE question_id = ?').get(question.id) as PayloadRow | undefined
  if (!row) return null
  const receipt = parse<AnswerReceipt>(row)
  const goalRow = store.getProjectDb().prepare('SELECT payload FROM project_owner_revisions WHERE project_id = ? AND subject_key = ? AND revision = ?').get(question.projectId, question.taskId ? `task:${question.taskId}` : 'project', receipt.goal.revision) as { payload: string } | undefined
  if (receipt.questionId !== question.id || receipt.projectId !== question.projectId || receipt.goal.goal.projectId !== question.projectId || receipt.goal.goal.taskId !== question.taskId || !goalRow || goalRow.payload !== JSON.stringify(receipt.goal)) throw new Error('Owner答复回执与已保存目标不一致')
  return receipt
}
function assertQuestionCurrent(question: OwnerManagementQuestion): void {
  resolveOwnerPlanningTask(question.planningTaskId, true)
  const latest = store.getProjectDb().prepare("SELECT l.planning_task_id FROM project_owner_planning_links l WHERE l.project_id = ? AND json_extract(l.payload, '$.purpose') = 'owner_planning' AND json_extract(l.payload, '$.targetTaskId') IS ? AND (json_extract(l.payload, '$.conversationMessageId') IS NULL OR l.planning_task_id = ? OR EXISTS (SELECT 1 FROM project_owner_management_questions q WHERE q.project_id = l.project_id AND json_extract(q.payload, '$.planningTaskId') = l.planning_task_id)) ORDER BY l.rowid DESC LIMIT 1").get(question.projectId, question.taskId ?? null, question.planningTaskId) as { planning_task_id: string } | undefined
  if (latest?.planning_task_id !== question.planningTaskId) throw new Error('Owner已有更新的问题或规划请求，不能套用旧答复')
}
export function listOwnerManagementQuestions(projectId: string): OwnerManagementQuestion[] {
  const rows = store.getProjectDb().prepare('SELECT id FROM project_owner_management_questions WHERE project_id = ? ORDER BY rowid DESC LIMIT 50').all(projectId) as { id: string }[]
  return rows.reverse().map(({ id }) => {
    const question = readQuestion(projectId, id)
    if (existingAnswer(question)) return { ...question, state: 'answered' as const }
    try { assertQuestionCurrent(question); return question }
    catch { return { ...question, state: 'stale' as const } }
  })
}
export function getOwnerManagementConversation(projectId: string): OwnerManagementView {
  const changes = require('./project-owner-management-changes') as typeof import('./project-owner-management-changes')
  return { ...getOwnerManagementView(projectId), questions: listOwnerManagementQuestions(projectId), changes: changes.listOwnerConversationChanges(projectId) }
}

/** 仅从真实处理结论重建问题，不接受Renderer提供问题文本或模型自述的授权。 */
export function projectOwnerManagementRunResult(projectId: string, executionId: string, eventId: string): void {
  const outcome = getOwnerPlanningRunOutcome(executionId)
  const receipt = outcome ? getOwnerPlanningRunReceipt(outcome.receiptId) : null
  const manager = getOwnerManager(projectId)
  if (!outcome || !receipt || !manager || receipt.projectId !== projectId || receipt.executionId !== executionId || receipt.purpose !== 'owner_planning') throw new Error('Owner管理运行结论身份不一致')
  const snapshot = readOwnerPlanningSnapshot(receipt.planningTaskId)
  if (!snapshot) throw new Error('Owner问题缺少冻结来源')
  if (outcome.qualityDecision) {
    const action = applyOwnerQualityDecision(projectId, executionId)
    appendOwnerManagementMessage({ projectId, eventId, ...(snapshot.link.targetTaskId ? { taskId: snapshot.link.targetTaskId } : {}), role: 'assistant', kind: 'reply', planningTaskId: receipt.planningTaskId, content: `${action.detail}\n判断依据：${action.decision.reason}` })
    return
  }
  if (outcome.state === 'replied' && outcome.reply) {
    if (!snapshot.link.conversationMessageId || getProjectOwnerGoalDraft(projectId, snapshot.link.targetTaskId)?.revision !== snapshot.link.goalRevision) return
    appendOwnerManagementMessage({ projectId, eventId, ...(snapshot.link.targetTaskId ? { taskId: snapshot.link.targetTaskId } : {}), role: 'assistant', kind: outcome.changeProposal ? 'change_proposal' : 'reply', ...(outcome.changeProposal ? { changeId: receipt.id } : {}), planningTaskId: receipt.planningTaskId, content: outcome.reply })
    return
  }
  if (outcome.state === 'needs_clarification' && outcome.clarification) {
    resolveOwnerPlanningTask(receipt.planningTaskId, true)
    const id = digest({ projectId, executionId, receiptId: receipt.id })
    const question: OwnerManagementQuestion = { id, projectId, ...(snapshot.link.targetTaskId ? { taskId: snapshot.link.targetTaskId } : {}), conversationId: manager.conversationId, executionId, receiptId: receipt.id, planningTaskId: receipt.planningTaskId, goalRevision: snapshot.link.goalRevision, contextFingerprint: snapshot.link.contextFingerprint, reason: outcome.clarification.reason, questions: outcome.clarification.questions, state: 'open' }
    assertQuestionCurrent(question)
    const existing = store.getProjectDb().prepare('SELECT payload, integrity_hash FROM project_owner_management_questions WHERE id = ?').get(id) as PayloadRow | undefined
    if (existing) {
      if (JSON.stringify(parse<OwnerManagementQuestion>(existing)) !== JSON.stringify(question)) throw new Error('Owner问题已有不同记录')
    } else store.getProjectDb().prepare('INSERT INTO project_owner_management_questions (id, project_id, execution_id, payload, integrity_hash) VALUES (?, ?, ?, ?, ?)').run(id, projectId, executionId, JSON.stringify(question), digest(question))
    appendOwnerManagementMessage({ projectId, eventId, ...(snapshot.link.targetTaskId ? { taskId: snapshot.link.targetTaskId } : {}), role: 'assistant', kind: 'clarification', questionId: id, content: [question.reason, ...question.questions.map(item => `${item.question}\n${item.why}${item.recommended ? `\n建议：${item.recommended}` : ''}`)].join('\n\n') })
  } else if (outcome.state === 'proposed') {
    const plan = getProjectOwnerPlanDraft(projectId, snapshot.link.targetTaskId)
    if (plan?.state === 'stale' || plan?.sourceRun?.executionId !== executionId) return
    const delegation = getOwnerManagementDelegation(projectId, snapshot.link.targetTaskId)
    const content = delegation.state !== 'active' || !delegation.delegation
      ? `方案已保存。${plan.proposal.summary}\n当前持续管理授权已失效；我没有安排团队或启动员工。重新核对并确认项目授权后，我会继续。`
      : delegation.delegation.autonomousExecution
        ? `方案已准备好。${plan.proposal.summary}\n我会在已确认范围内自动安排团队并推进，不需要你批准普通计划或再次点击开工。`
        : `方案已准备好。${plan.proposal.summary}\n我正在为方案准备内部安排，不会提前启动员工。请审阅结果与完成标准；需要调整时直接告诉我，确认开始后我会负责执行。`
    appendOwnerManagementMessage({ projectId, eventId, ...(snapshot.link.targetTaskId ? { taskId: snapshot.link.targetTaskId } : {}), role: 'assistant', kind: 'plan_proposal', content })
  } else {
    const reason = safeFailureDetail(outcome.detail)
    appendOwnerManagementMessage({ projectId, eventId, ...(snapshot.link.targetTaskId ? { taskId: snapshot.link.targetTaskId } : {}), role: 'assistant', kind: 'attention', content: `这次规划未得到可继续使用的结果。我已保留记录；${reason ? `失败原因：${reason}。` : ''}费用或运行状态未知时不会自动重复调用。` })
  }
}

function safeFailureDetail(detail: string): string {
  return detail.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]')
    .replace(/(api[_-]?key|authorization|access[_-]?token)\s*[:=]\s*[^,\s;]+/gi, '$1=[已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[已隐藏凭据]')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 300)
}

export function answerOwnerManagementQuestion(raw: unknown): ProjectOwnerGoalDraft {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)) throw new Error('Owner答复必须是对象')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some(key => !['projectId', 'questionId', 'requestId', 'expectedGoalRevision', 'expectedContextFingerprint', 'answers'].includes(key))
    || [value.projectId, value.questionId, value.requestId].some(id => typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 128)
    || !Number.isSafeInteger(value.expectedGoalRevision) || Number(value.expectedGoalRevision) < 1 || typeof value.expectedContextFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedContextFingerprint)
    || !value.answers || typeof value.answers !== 'object' || Array.isArray(value.answers)) throw new Error('Owner答复字段或版本无效')
  const input = value as unknown as AnswerOwnerManagementQuestionRequest
  let result: ProjectOwnerGoalDraft | undefined
  store.getProjectDb().transaction(() => {
    assertLocalActorEnabled()
    const question = readQuestion(input.projectId, input.questionId)
    const keys = question.questions.map(item => item.key)
    if (Object.keys(input.answers).length !== keys.length || Object.keys(input.answers).some(key => !keys.includes(key)) || keys.some(key => typeof input.answers[key] !== 'string' || !input.answers[key]!.trim())) throw new Error('请完整答复当前问题，不附加其他问题的答案')
    const answers = Object.fromEntries(keys.map(key => [key, input.answers[key]!.trim().replace(/\s+/g, ' ')]))
    const collision = store.getProjectDb().prepare('SELECT question_id FROM project_owner_management_answers WHERE project_id = ? AND request_id = ?').get(input.projectId, input.requestId) as { question_id: string } | undefined
    if (collision && collision.question_id !== question.id) throw new Error('此答复请求ID已经用于其他问题')
    const old = existingAnswer(question)
    if (old) {
      if (JSON.stringify(old.answers) !== JSON.stringify(answers) || input.expectedGoalRevision !== question.goalRevision || input.expectedContextFingerprint !== question.contextFingerprint) throw new Error('此Owner问题已有不同答复，请使用当前问题继续沟通')
      result = old.goal
      return
    }
    if (input.expectedGoalRevision !== question.goalRevision || input.expectedContextFingerprint !== question.contextFingerprint) throw new Error('Owner问题来源已变化，请读取当前对话')
    assertQuestionCurrent(question)
    const current = getProjectOwnerGoalDraft(input.projectId, question.taskId)
    if (!current || current.revision !== question.goalRevision) throw new Error('Owner目标已变化，不能套用旧问题答复')
    const applied = applyOwnerClarificationAnswers(current.goal.constraints, question.questions, answers)
    if (!applied.ok) throw new Error('答复无法完整写入目标：请核对问题是否重复，并精简长度和约束数量')
    result = saveProjectOwnerGoalDraft(input.projectId, current.revision, { objective: current.goal.objective, constraints: applied.constraints, acceptanceCriteria: current.goal.acceptanceCriteria, ...(current.goal.codeSourceAccess ? { codeSourceAccess: current.goal.codeSourceAccess } : {}) }, question.taskId, { recordManagementMessage: false })
    const saved: AnswerReceipt = { questionId: question.id, projectId: input.projectId, requestId: input.requestId, answers, goal: result }
    store.getProjectDb().prepare('INSERT INTO project_owner_management_answers (question_id, project_id, request_id, payload, integrity_hash) VALUES (?, ?, ?, ?, ?)').run(question.id, input.projectId, input.requestId, JSON.stringify(saved), digest(saved))
    if (result.revision === current.revision) recordOwnerManagementAnswer(result, question.id)
    appendOwnerManagementMessage({ projectId: input.projectId, eventId: `answer:${question.id}`, ...(question.taskId ? { taskId: question.taskId } : {}), role: 'user', kind: 'answer', questionId: question.id, content: question.questions.map(item => `${item.question}：${answers[item.key]}`).join('\n') })
  })()
  if (!result) throw new Error('Owner答复未保存')
  return result
}


/** 截至冻结历史边界的必要问题资料；不递归调用完整来源重建，也不授予答复许可。 */
export function getOwnerConversationQuestionSources(context: import('@gravitas/shared').ProjectOwnerPlanningContext, historyThroughMessageId: string): NonNullable<import('@gravitas/shared').OwnerPlanningConversationContext['openQuestions']> {
  const projectId = context.goal.goal.projectId, taskId = context.goal.goal.taskId
  const rows = store.getProjectDb().prepare("SELECT DISTINCT q.id FROM project_owner_management_questions q JOIN project_owner_management_messages m ON json_extract(m.payload, '$.questionId') = q.id AND json_extract(m.payload, '$.kind') = 'clarification' WHERE q.project_id = ? AND m.project_id = q.project_id AND m.rowid <= (SELECT rowid FROM project_owner_management_messages WHERE id = ?) ORDER BY q.rowid DESC LIMIT 50").all(projectId, historyThroughMessageId) as { id: string }[]
  const binding = require('./project-owner-runtime-binding') as typeof import('./project-owner-runtime-binding')
  const plan = getProjectOwnerPlanDraft(projectId, taskId), currentBinding = binding.getOwnerRuntimeBinding(projectId)
  for (const row of rows) {
    const question = readQuestion(projectId, row.id)
    if (question.taskId !== taskId || question.goalRevision !== context.goal.revision || question.contextFingerprint !== context.fingerprint || existingAnswer(question)) continue
    const source = readOwnerPlanningSnapshot(question.planningTaskId)!
    if (source.link.planRevision !== (plan?.revision ?? 0) || source.link.bindingRevision !== currentBinding?.revision) continue
    return [{ id: question.id, goalRevision: question.goalRevision, contextFingerprint: question.contextFingerprint, reason: question.reason, questions: question.questions }]
  }
  return []
}

/** 相同答复也可解除问题；重验精确回执后准备一次新规划，不重放上次Run。 */
export function prepareOwnerUnchangedAnswer(event: import('@gravitas/shared').OwnerManagementEvent): void {
  if (event.kind !== 'answer_saved' || !event.sourceId) throw new Error('Owner答复事件缺少来源')
  const question = readQuestion(event.projectId, event.sourceId), answer = existingAnswer(question)
  const current = getProjectOwnerGoalDraft(event.projectId, event.taskId)
  if (!answer || question.taskId !== event.taskId || answer.goal.revision !== event.sourceRevision) throw new Error('Owner答复事件与回执不一致')
  if (!current || digest(current) !== digest(answer.goal)) return
  assertQuestionCurrent(question)
  const binding = require('./project-owner-runtime-binding') as typeof import('./project-owner-runtime-binding')
  const owner = binding.getOwnerRuntimeBinding(event.projectId)!, plan = getProjectOwnerPlanDraft(event.projectId, event.taskId)
  const link = binding.prepareOwnerPlanning(event.projectId, { requestId: `management:${event.id}`, ...(event.taskId ? { taskId: event.taskId } : {}), expectedBindingRevision: owner.revision, expectedGoalRevision: current.revision, expectedPlanRevision: plan?.revision ?? 0, expectedContextFingerprint: question.contextFingerprint })
  appendOwnerManagementMessage({ projectId: event.projectId, eventId: event.id, ...(event.taskId ? { taskId: event.taskId } : {}), role: 'assistant', kind: 'planning_confirmation', planningTaskId: link.planningTaskId, content: '答复已确认，已有目标内容保持不变。我会在有效管理额度内继续规划。' })
}
