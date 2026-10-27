import { createHash } from 'node:crypto'
import type { AskUserQuestion, OwnerEmployeeInteraction, OwnerEmployeeInteractionDecision } from '@gravitas/shared'
import * as store from './project-sqlite-store'

interface Row { payload: string; integrity_hash: string }
interface Binding { project_id: string; entity_id: string; agent_id: string; execution_id: string; command_id: string }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/**
 * 员工等待Owner的默认期限。机制已实现；该具体数值仍待用户确认，
 * 调整只需改此常量或后续接入项目级配置，不改变收尾语义。
 */
export const OWNER_EMPLOYEE_INTERACTION_TIMEOUT_MS = 30 * 60 * 1000
/** 稳定问题键：优先使用生成的问题ID，旧记录回退到问题原文。 */
export function ownerEmployeeQuestionKeys(questions: readonly AskUserQuestion[]): string[] {
  return questions.map((question, index) => question.id?.trim() || question.question || `q${index + 1}`)
}

/**
 * 接受稳定问题ID或问题原文作为答复键（兼容旧记录与旧模型输出），
 * 但必须逐题覆盖；返回按问题原文索引的答复，供员工工具结果使用。
 */
export function resolveOwnerEmployeeAnswers(questions: readonly AskUserQuestion[], answers: Record<string, unknown>): Record<string, string> {
  const allowed = new Set<string>()
  const resolved: Record<string, string> = {}
  questions.forEach((question, index) => {
    const id = ownerEmployeeQuestionKeys(questions)[index]!
    allowed.add(id); allowed.add(question.question)
    const value = answers[id] ?? answers[question.question]
    if (typeof value !== 'string' || !value.trim()) throw new Error('员工决定必须准确覆盖原请求的全部问题')
    resolved[question.question] = value.trim()
  })
  if (Object.keys(answers).some(key => !allowed.has(key))) throw new Error('员工决定包含原请求之外的问题')
  return resolved
}

function interactionDeadline(interaction: Pick<OwnerEmployeeInteraction, 'createdAt' | 'expiresAt'>): number {
  return interaction.expiresAt ?? interaction.createdAt + OWNER_EMPLOYEE_INTERACTION_TIMEOUT_MS
}

/** 身份只从仍在运行的权威执行/命令联接读取，不接受调用方提供项目或员工。 */
function binding(sessionId: string): Binding {
  const rows = store.getProjectDb().prepare(`SELECT e.project_id,e.entity_id,e.agent_id,e.id AS execution_id,c.id AS command_id
    FROM agent_executions e JOIN project_owner_execution_commands c ON c.id=e.owner_command_id
    AND c.execution_id=e.id AND c.project_id=e.project_id AND c.employee_id=e.agent_id AND c.source_task_id=e.entity_id
    WHERE e.session_id=? AND e.entity_type='task' AND e.status='running' AND c.state='running'`).all(sessionId) as Binding[]
  if (rows.length !== 1) throw new Error('员工交互缺少唯一运行中的Owner执行')
  return rows[0]!
}
function decode(row: Row): OwnerEmployeeInteraction {
  const value = JSON.parse(row.payload) as OwnerEmployeeInteraction
  if (hash(value) !== row.integrity_hash || value.schemaVersion !== 1) throw new Error('员工交互记录完整性无效')
  return value
}
export function getOwnerEmployeeInteraction(projectId: string, id: string): OwnerEmployeeInteraction | null {
  const row = store.getProjectDb().prepare('SELECT payload,integrity_hash FROM project_owner_employee_interactions WHERE project_id=? AND id=? ORDER BY revision DESC LIMIT 1').get(projectId, id) as Row | undefined
  const value = row ? decode(row) : null
  if (value && (value.projectId !== projectId || value.id !== id)) throw new Error('员工交互身份不一致')
  return value
}
function transaction(operation: () => OwnerEmployeeInteraction): OwnerEmployeeInteraction {
  let result: OwnerEmployeeInteraction | undefined
  store.getProjectDb().transaction(() => { result = operation() })()
  if (!result) throw new Error('员工交互事务没有产生结果')
  return result
}
function append(value: OwnerEmployeeInteraction): OwnerEmployeeInteraction {
  store.getProjectDb().prepare('INSERT INTO project_owner_employee_interactions(id,project_id,request_id,revision,payload,integrity_hash) VALUES(?,?,?,?,?,?)').run(value.id, value.projectId, value.requestId, value.revision, JSON.stringify(value), hash(value))
  return value
}
export function createOwnerEmployeeInteraction(input: { sessionId: string; requestId: string; kind: OwnerEmployeeInteraction['kind']; toolInput: Record<string, unknown>; questions: AskUserQuestion[]; summary: string }): OwnerEmployeeInteraction {
  if (!input.requestId.trim() || input.requestId.length > 200 || !['question', 'permission'].includes(input.kind) || !input.summary.trim() || input.summary.length > 10000) throw new Error('员工交互输入无效')
  return transaction(() => {
    const source = binding(input.sessionId), id = hash({ sessionId: input.sessionId, requestId: input.requestId })
    // 为每个问题分配稳定标识，重复原文的问题也能区分，不再只靠文本匹配。
    const questions = input.questions.map((question, index) => ({ ...question, id: question.id?.trim() || `q${index + 1}` }))
    const requestHash = hash({ kind: input.kind, toolInput: input.toolInput, questions, summary: input.summary })
    const old = getOwnerEmployeeInteraction(source.project_id, id)
    if (old) {
      if (old.requestHash !== requestHash || old.executionId !== source.execution_id) throw new Error('员工请求标识已用于不同内容')
      return old
    }
    const now = Date.now()
    return append({ schemaVersion: 1, id, projectId: source.project_id, taskId: source.entity_id, employeeId: source.agent_id, executionId: source.execution_id, sessionId: input.sessionId, commandId: source.command_id, requestId: input.requestId, kind: input.kind, requestHash, questions, summary: input.summary, revision: 1, state: 'pending_owner', createdAt: now, expiresAt: now + OWNER_EMPLOYEE_INTERACTION_TIMEOUT_MS, updatedAt: now })
  })
}
const transitions: Record<OwnerEmployeeInteraction['state'], OwnerEmployeeInteraction['state'][]> = {
  pending_owner: ['discussing_user', 'decided', 'cancelled', 'stale'],
  discussing_user: ['decided', 'cancelled', 'stale'],
  decided: ['delivering', 'cancelled', 'stale'],
  delivering: ['resolved', 'delivery_failed', 'stale'],
  resolved: [], cancelled: [], stale: [], delivery_failed: [],
}
/** 此函数仅登记状态，不执行审批；投递入口仍须重验原请求、运行授权及参数哈希。 */
export function transitionOwnerEmployeeInteraction(input: { projectId: string; id: string; expectedRevision: number; state: OwnerEmployeeInteraction['state']; decision?: OwnerEmployeeInteractionDecision }): OwnerEmployeeInteraction {
  return transaction(() => {
    const current = getOwnerEmployeeInteraction(input.projectId, input.id)
    if (!current || current.revision !== input.expectedRevision) throw new Error('员工交互已更新，请重新读取')
    if (!transitions[current.state].includes(input.state)) throw new Error('员工交互状态转换无效')
    if (input.state !== 'cancelled' && input.state !== 'stale' && input.state !== 'delivery_failed') {
      const source = binding(current.sessionId)
      if (source.execution_id !== current.executionId || source.command_id !== current.commandId) throw new Error('员工原执行已失效')
    }
    if (input.state === 'decided') {
      const decision = input.decision
      if (!decision || !['owner', 'user'].includes(decision.source) || !['answer', 'deny'].includes(decision.action) || !decision.sourceMessageId.trim() || !decision.reason.trim()) throw new Error('员工交互决定无效')
      if (current.kind === 'permission' && decision.source !== 'user') throw new Error('Owner不得代用户审批员工权限')
      if (decision.action === 'answer' && (!decision.answers || !Object.keys(decision.answers).length || Object.values(decision.answers).some(answer => typeof answer !== 'string' || !answer.trim()))) throw new Error('员工交互缺少明确答复')
      // 有问题时才要求逐题覆盖；无问题的历史记录仍可登记决定（真实交互总有问题）。
      if (decision.action === 'answer' && current.questions.length > 0) resolveOwnerEmployeeAnswers(current.questions, decision.answers ?? {})
    } else if (input.decision) throw new Error('仅定案转换可附加决定')
    return append({ ...current, revision: current.revision + 1, state: input.state, ...(input.decision ? { decision: input.decision } : {}), updatedAt: Date.now() })
  })
}

/** 只返回当前修订；历史修订保持可追溯，不参与新的决定。 */
export function listOwnerEmployeeInteractions(projectId: string): OwnerEmployeeInteraction[] {
  return (store.getProjectDb().prepare(`SELECT i.payload,i.integrity_hash FROM project_owner_employee_interactions i
    WHERE i.project_id=? AND i.revision=(SELECT MAX(j.revision) FROM project_owner_employee_interactions j WHERE j.id=i.id)
    ORDER BY i.rowid DESC LIMIT 100`).all(projectId) as Row[]).map(decode)
}

/** 全局AskUser路由：仅Owner业务会话接管，普通会话返回false继续原用户入口。 */
export function routeOwnerEmployeeAskUser(input: { sessionId: string; requestId: string; kind: 'question' | 'permission'; toolInput: Record<string, unknown>; questions: AskUserQuestion[] }): boolean {
  const gates = require('./project-owner-execution-gates') as typeof import('./project-owner-execution-gates')
  const context = gates.resolveOwnerExecutionGateSession(input.sessionId)
  if (context.kind === 'restricted') throw new Error(context.reason)
  if (context.kind !== 'owner_business') return false
  if (input.kind !== 'question' || input.toolInput.interactionType === 'computer_use_takeover') throw new Error('Owner员工系统接管必须保留人工安全入口，当前不支持转交')
  const interaction = createOwnerEmployeeInteraction({ ...input, summary: input.questions.map(item => item.question).join('；').slice(0, 10_000) || '员工请求用户确认' })
  const goal = require('./project-owner-goal-service') as typeof import('./project-owner-goal-service')
  const current = goal.getProjectOwnerGoalDraft(interaction.projectId, context.subject.taskId)
  if (!current) throw new Error('员工交互缺少当前Owner目标')
  const management = require('./project-owner-management-store') as typeof import('./project-owner-management-store')
  management.recordOwnerEmployeeInteractionMessage(interaction, current.revision, context.subject.taskId)
  return true
}
export function deliverOwnerEmployeeDecision(input: { projectId: string; decision: import('./project-owner-planning-protocol').OwnerEmployeeDecision; sourceMessageId: string }): OwnerEmployeeInteraction {
  if (store.getProjectDb().isTransactionActive()) throw new Error('员工决定必须在外层事务提交后投递')
  const current = getOwnerEmployeeInteraction(input.projectId, input.decision.interactionId)
  if (!current || current.revision !== input.decision.interactionRevision || !['pending_owner', 'discussing_user'].includes(current.state)) throw new Error('员工决定对应的待决事项已变化')
  // 答复按稳定问题ID或原文逐题核对，重复原文的问题会分别校验。
  const answersByText = input.decision.action === 'answer' ? resolveOwnerEmployeeAnswers(current.questions, input.decision.answers ?? {}) : {}
  if (current.kind === 'permission') throw new Error('Owner决定不能代用户审批员工权限')
  const approvals = require('./project-owner-action-approval') as typeof import('./project-owner-action-approval')
  approvals.assertLiveOwnerAction({ commandId: current.commandId, executionId: current.executionId, sessionId: current.sessionId })
  const gates = require('./project-owner-execution-gates') as typeof import('./project-owner-execution-gates')
  const gate = gates.resolveOwnerExecutionGateSession(current.sessionId)
  if (gate.kind !== 'owner_business' || gate.executionId !== current.executionId || gate.subject.projectId !== current.projectId) throw new Error('员工当前执行门禁失效，决定未投递')
  const decided = transitionOwnerEmployeeInteraction({ projectId: current.projectId, id: current.id, expectedRevision: current.revision, state: 'decided', decision: { source: 'owner', sourceMessageId: input.sourceMessageId, action: input.decision.action, ...(input.decision.answers ? { answers: input.decision.answers } : {}), reason: input.decision.reason } })
  const delivering = transitionOwnerEmployeeInteraction({ projectId: current.projectId, id: current.id, expectedRevision: decided.revision, state: 'delivering' })
  const askUser = require('./agent-ask-user-service') as typeof import('./agent-ask-user-service')
  const delivered = askUser.askUserService.respondToOwnerAskUser(current.requestId, current.sessionId, input.decision.action === 'answer' ? answersByText : null, input.decision.reason)
  if (!delivered) {
    transitionOwnerEmployeeInteraction({ projectId: current.projectId, id: current.id, expectedRevision: delivering.revision, state: 'delivery_failed' })
    throw new Error('员工原请求已结束，未投递Owner决定')
  }
  return transitionOwnerEmployeeInteraction({ projectId: current.projectId, id: current.id, expectedRevision: delivering.revision, state: 'resolved' })
}

/** 仅标记本轮冻结上下文中准确修订的原请求；讨论不产生答复或授权。 */
export function markOwnerEmployeeDiscussion(projectId: string, frozen: readonly OwnerEmployeeInteraction[]): void {
  for (const source of frozen) {
    if (source.projectId !== projectId) throw new Error('员工讨论来源跨项目')
    const current = getOwnerEmployeeInteraction(projectId, source.id)
    if (!current || current.revision !== source.revision || current.state !== 'pending_owner') continue
    transitionOwnerEmployeeInteraction({ projectId, id: current.id, expectedRevision: current.revision, state: 'discussing_user' })
  }
}

export function cancelOwnerEmployeeInteraction(requestId: string): void {
  const row = store.getProjectDb().prepare('SELECT id,project_id FROM project_owner_employee_interactions WHERE request_id=? ORDER BY revision DESC LIMIT 1').get(requestId) as { id: string; project_id: string } | undefined
  if (!row) return
  const current = getOwnerEmployeeInteraction(row.project_id, row.id)
  if (!current || ['resolved', 'cancelled', 'stale'].includes(current.state)) return
  try { transitionOwnerEmployeeInteraction({ projectId: current.projectId, id: current.id, expectedRevision: current.revision, state: current.state === 'delivering' ? 'stale' : 'cancelled' }) } catch { /* 终态竞争时保留权威结果。 */ }
}


/**
 * 等待到期收尾：先拒绝原等待，再登记失联；不重建Promise、不投旧决定、不释放未知费用。
 * 拒绝只结束员工本轮提问，不宣称Runtime已停，也不代表Provider用量已结清。
 */
export function expireOwnerEmployeeInteractions(projectId: string, now = Date.now()): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('员工交互期限时钟无效')
  const { askUserService } = require('./agent-ask-user-service') as typeof import('./agent-ask-user-service')
  const management = require('./project-owner-management-store') as typeof import('./project-owner-management-store')
  let count = 0
  const expiredItems: OwnerEmployeeInteraction[] = []
  for (const interaction of listOwnerEmployeeInteractions(projectId)) {
    // 只有“等待Owner自动答复”受期限约束；等待用户决定的事项不得因超时作废。
    if (interaction.state === 'discussing_user') { reportAwaitingAuthorization(projectId, interaction); continue }
    if (interaction.state !== 'pending_owner') continue
    if (interactionDeadline(interaction) > now) continue
    try { askUserService.expireOwnerAskUser(interaction.requestId, interaction.sessionId, '等待Owner答复已超时，本次提问已失效；请按已确认范围继续或结束本轮，不要重复提问') } catch { /* 内存等待可能已随重启丢失，仍须登记失联。 */ }
    let expired: OwnerEmployeeInteraction
    try { expired = transitionOwnerEmployeeInteraction({ projectId, id: interaction.id, expectedRevision: interaction.revision, state: 'stale' }) } catch { continue }
    count++
    expiredItems.push(expired)
  }
  // 同一轮多个员工同时超时只写一条合并说明；每件事项记录仍在共同工作空间可查。
  if (expiredItems.length && management.getOwnerManager(projectId)) management.appendOwnerManagementMessage({
    projectId, eventId: `employee-interaction-expired-batch:${createHash('sha256').update(expiredItems.map(item => `${item.id}:${item.revision}`).sort().join(',')).digest('hex').slice(0, 32)}`,
    role: 'assistant', kind: 'attention', ...(expiredItems.every(item => item.taskId === expiredItems[0]!.taskId) ? { taskId: expiredItems[0]!.taskId } : {}),
    content: expiredItems.length === 1
      ? `员工等待我答复已超过期限，原提问已失效，我没有自动重试，也没有向员工补发历史决定。原问题：${expiredItems[0]!.summary}。费用与运行状态未知时保留原证据并继续占额；请核对是否需要重新开始这项工作。`
      : `有 ${expiredItems.length} 项员工提问等待我答复超过期限，均已失效；我没有自动重试，也没有向员工补发历史决定。逐项可在员工待决事项中查看：\n${expiredItems.map((item, index) => `${index + 1}. ${item.summary}`).join('\n')}\n费用与运行状态未知时保留原证据并继续占额；请核对是否需要重新开始这些工作。`,
  })
  return count
}

/** 只读核对关联授权；讨论中的事项由授权有效期和租约约束，而不是计时器。 */
function interactionAuthorization(interaction: Pick<OwnerEmployeeInteraction, 'commandId' | 'projectId'>): { state: 'active' | 'inactive' | 'missing'; expiresAt: number | null } {
  const row = store.getProjectDb().prepare(`SELECT g.state, g.expires_at FROM project_owner_execution_commands c
    JOIN project_owner_execution_grants g ON g.id = c.grant_id AND g.project_id = c.project_id
    WHERE c.id = ? AND c.project_id = ?`).get(interaction.commandId, interaction.projectId) as { state: string; expires_at: number } | undefined
  if (!row) return { state: 'missing', expiresAt: null }
  return { state: row.state === 'active' ? 'active' : 'inactive', expiresAt: row.expires_at }
}

/** 授权失效时保留待决事项并说明，不清除用户尚未做出的决定。 */
function reportAwaitingAuthorization(projectId: string, interaction: OwnerEmployeeInteraction): void {
  const authorization = interactionAuthorization(interaction)
  if (authorization.state === 'active' && (authorization.expiresAt === null || authorization.expiresAt > Date.now())) return
  const management = require('./project-owner-management-store') as typeof import('./project-owner-management-store')
  if (!management.getOwnerManager(projectId)) return
  const reason = authorization.state === 'missing' ? '未找到关联执行授权' : authorization.state === 'inactive' ? '关联授权已暂停或结束' : '关联授权已到期'
  management.appendOwnerManagementMessage({
    projectId, eventId: `employee-interaction-authorization:${interaction.id}:${authorization.state}:${authorization.expiresAt ?? 0}`, role: 'assistant', kind: 'attention', taskId: interaction.taskId,
    content: `员工的问题仍保留在对话中等待你决定，我没有因为时间过去把它作废。${reason}，在你重新确认管理范围前，我不会把决定回传给员工，也不会自动重试。原问题：${interaction.summary}。`,
  })
}

/** 内存等待丢失只登记失联；不会重建Promise、重投旧问题或释放未知费用。 */
export function reconcileLostOwnerEmployeeInteractions(projectId: string): number {
  const { askUserService } = require('./agent-ask-user-service') as typeof import('./agent-ask-user-service')
  let count = 0
  for (const interaction of listOwnerEmployeeInteractions(projectId)) {
    if (!['pending_owner', 'discussing_user', 'decided', 'delivering'].includes(interaction.state)) continue
    if (askUserService.hasOwnerPendingRequest(interaction.requestId, interaction.sessionId)) continue
    transitionOwnerEmployeeInteraction({ projectId, id: interaction.id, expectedRevision: interaction.revision, state: 'stale' })
    const management = require('./project-owner-management-store') as typeof import('./project-owner-management-store')
    const message = management.getOwnerManagementView(projectId).messages.find(item => item.employeeInteraction?.id === interaction.id)
    // 只核对并如实说明执行终态；仍在running时不得伪造停止或结清。
    const execution = store.getAgentExecution(interaction.executionId)
    const executionState = execution && execution.projectId === projectId && execution.sessionId === interaction.sessionId && execution.ownerCommandId === interaction.commandId ? execution.status : 'missing'
    const executionNote = executionState === 'running' || executionState === 'queued'
      ? '原员工执行尚未确认结束；费用与运行状态未知时保留证据和占额。'
      : executionState === 'missing' ? '未找到与该提问精确关联的执行记录，请保留数据核查。' : `关联执行当前状态：${executionState}。`
    if (management.getOwnerManagementView(projectId).manager) management.appendOwnerManagementMessage({ projectId, eventId: `employee-interaction-stale:${interaction.id}`, role: 'assistant', kind: 'attention', ...(message?.taskId ? { taskId: message.taskId } : {}), content: `员工的原等待请求已失联，未将历史决定投给新会话。原问题：${interaction.summary}。${executionNote}请由Owner重新核对执行状态；原记录与费用证据保留。` })
    count++
  }
  return count
}
