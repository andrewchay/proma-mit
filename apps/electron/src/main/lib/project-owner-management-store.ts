import { createHash, randomUUID } from 'node:crypto'
import type { OwnerExecutionObservation, OwnerManagementDelivery, OwnerManagementEvent, OwnerManagementMessage, OwnerManagementTraceEntry, OwnerManagementView, ProjectOwnerGoalDraft, ProjectOwnerPlanDraft, ProjectOwnerManager } from '@gravitas/shared'
import * as store from './project-sqlite-store'
import { requestOwnerManagementChanged, requestOwnerManagementWake } from './project-owner-management-events'

interface PayloadRow { payload: string; integrity_hash: string }
interface EventRow extends PayloadRow { consumed_at: number | null }
const tracePhases = ['assignment_preparation', 'assignment_run', 'execution_start', 'executor', 'reviewer', 'owner_quality', 'owner_response'] as const
const traceStates = ['started', 'queued', 'completed', 'failed', 'blocked', 'waiting', 'stalled', 'expired'] as const
const traceDetails = ['team_check', 'provider_pending', 'result_ready', 'start_verified', 'no_update', 'grant_expired', 'decision_required', 'authorization_changed', 'claim_without_fact'] as const
function parseTraceEntry(input: unknown): OwnerManagementTraceEntry {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Owner诊断Trace记录无效')
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !['eventId', 'projectId', 'taskId', 'phase', 'state', 'createdAt', 'detailCode'].includes(key))
    || typeof value.eventId !== 'string' || !value.eventId || value.eventId.length > 200
    || typeof value.projectId !== 'string' || !value.projectId
    || (value.taskId !== undefined && (typeof value.taskId !== 'string' || !value.taskId || value.taskId.length > 128))
    || !tracePhases.includes(value.phase as typeof tracePhases[number]) || !traceStates.includes(value.state as typeof traceStates[number])
    || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) <= 0
    || (value.detailCode !== undefined && !traceDetails.includes(value.detailCode as typeof traceDetails[number]))) throw new Error('Owner诊断Trace记录无效')
  const eventId = /^[a-f0-9]{64}$/.test(value.eventId) ? value.eventId : digest({ projectId: value.projectId, eventId: value.eventId })
  return { eventId, projectId: value.projectId, ...(value.taskId ? { taskId: value.taskId as string } : {}), phase: value.phase as OwnerManagementTraceEntry['phase'], state: value.state as OwnerManagementTraceEntry['state'], createdAt: value.createdAt as number, ...(value.detailCode ? { detailCode: value.detailCode as OwnerManagementTraceEntry['detailCode'] } : {}) }
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function project(projectId: string): void {
  if (typeof projectId !== 'string' || !projectId || projectId !== projectId.trim() || !store.getProject(projectId)) throw new Error('Owner管理项目不存在')
}
function read<T>(row: PayloadRow): T {
  const value: unknown = JSON.parse(row.payload)
  if (!value || typeof value !== 'object' || digest(value) !== row.integrity_hash) throw new Error('Owner管理记录完整性无效，请保留数据核查')
  return value as T
}
function assertDeliveryMessage(message: Pick<OwnerManagementMessage, 'role' | 'kind' | 'delivery' | 'deliveryReference' | 'teamWorkspaceProposal' | 'teamWorkspaceApproval'>): void {
  const proposal = message.teamWorkspaceProposal
  if (proposal !== undefined && (message.role !== 'assistant' || message.kind !== 'attention'
    || !proposal || typeof proposal.workspaceId !== 'string' || !proposal.workspaceId.trim()
    || typeof proposal.workspaceName !== 'string' || !proposal.workspaceName.trim() || proposal.workspaceName.length > 200
    || !Number.isSafeInteger(proposal.eligibleEmployeeCount) || proposal.eligibleEmployeeCount < 2
    || !/^[a-f0-9]{64}$/.test(proposal.scopeFingerprint))) throw new Error('Owner团队工作区建议无效')
  const approval = message.teamWorkspaceApproval
  if (approval !== undefined && (message.role !== 'user' || message.kind !== 'conversation'
    || !approval || !/^[a-f0-9]{64}$/.test(approval.sourceMessageId) || typeof approval.workspaceId !== 'string' || !approval.workspaceId.trim()
    || !/^[a-f0-9]{64}$/.test(approval.scopeFingerprint))) throw new Error('Owner团队工作区授权回执无效')
  if (message.deliveryReference !== undefined && (message.role !== 'user' || message.kind !== 'conversation'
    || !message.deliveryReference || !/^[a-f0-9]{64}$/.test(message.deliveryReference.messageId)
    || (message.deliveryReference.stepKey !== undefined && (typeof message.deliveryReference.stepKey !== 'string' || !message.deliveryReference.stepKey.trim() || message.deliveryReference.stepKey.length > 100))
    || !/^[a-f0-9]{64}$/.test(message.deliveryReference.artifactHash))) throw new Error('Owner消息交付引用身份无效')
  if (message.kind !== 'delivery') {
    if (message.delivery !== undefined) throw new Error('非交付消息不能包含成果包')
    return
  }
  const delivery = message.delivery as OwnerManagementDelivery | undefined
  if (message.role !== 'assistant' || !delivery || delivery.schemaVersion !== 1 || !Number.isSafeInteger(delivery.planVersion)
    || delivery.planVersion < 1 || !Array.isArray(delivery.items) || delivery.items.length < 1 || delivery.items.length > 32) throw new Error('Owner成果包结构无效')
  let totalBytes = 0
  for (const item of delivery.items) {
    if (!item || typeof item.stepKey !== 'string' || !item.stepKey || item.stepKey.length > 100 || typeof item.title !== 'string' || !item.title || item.title.length > 200
      || !Array.isArray(item.acceptanceCriteria) || item.acceptanceCriteria.length < 1 || item.acceptanceCriteria.length > 32
      || item.acceptanceCriteria.some(value => typeof value !== 'string' || !value.trim() || value.length > 1000)
      || !/^[a-f0-9]{64}$/.test(item.artifactHash) || typeof item.content !== 'string' || Buffer.byteLength(item.content, 'utf8') > 65_536
      || createHash('sha256').update(item.content, 'utf8').digest('hex') !== item.artifactHash
      || typeof item.ownerDecision !== 'string' || !item.ownerDecision.trim() || item.ownerDecision.length > 4000
      || typeof item.reviewerSummary !== 'string' || !item.reviewerSummary.trim() || item.reviewerSummary.length > 2000) throw new Error('Owner成果条目无效')
    totalBytes += Buffer.byteLength(item.content, 'utf8')
  }
  if (totalBytes > 2_000_000) throw new Error('Owner成果包超出大小限制')
}
function transaction<T>(operation: () => T): T {
  let result: T | undefined
  store.getProjectDb().transaction(() => { result = operation() })()
  if (result === undefined) throw new Error('Owner管理事务没有产生结果')
  return result
}
export function getOwnerManager(projectId: string): ProjectOwnerManager | null {
  project(projectId)
  const row = store.getProjectDb().prepare('SELECT payload, integrity_hash FROM project_owner_managers WHERE project_id = ? ORDER BY revision DESC LIMIT 1').get(projectId) as PayloadRow | undefined
  if (!row) return null
  const value = read<ProjectOwnerManager>(row)
  if (value.schemaVersion !== 1 || value.projectId !== projectId || !value.ownerId || !value.conversationId || !Number.isSafeInteger(value.revision) || value.revision < 1 || !['active', 'paused'].includes(value.status)) throw new Error('Owner管理主体身份无效')
  return value
}
function appendManager(value: ProjectOwnerManager): ProjectOwnerManager {
  store.getProjectDb().prepare('INSERT INTO project_owner_managers (project_id, revision, payload, integrity_hash) VALUES (?, ?, ?, ?)').run(value.projectId, value.revision, JSON.stringify(value), digest(value))
  return value
}
/** 仅新目标的显式发起建立管理主体；旧绑定/启动扫描不自动启用项目。 */
function ensureManager(projectId: string): ProjectOwnerManager {
  return getOwnerManager(projectId) ?? appendManager({ schemaVersion: 1, projectId, ownerId: randomUUID(), conversationId: randomUUID(), revision: 1, status: 'active', createdAt: Date.now(), updatedAt: Date.now() })
}
export function setOwnerManagerStatus(projectId: string, expectedRevision: number, status: ProjectOwnerManager['status']): ProjectOwnerManager {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !['active', 'paused'].includes(status)) throw new Error('Owner管理状态请求无效')
  const result = transaction(() => {
    const current = getOwnerManager(projectId)
    if (!current || current.revision !== expectedRevision) throw new Error('Owner管理状态已更新，请重新读取')
    if (current.status === status) return current
    return appendManager({ ...current, revision: current.revision + 1, status, updatedAt: Date.now() })
  })
  if (status === 'active') enqueue(projectId, 'team_changed', result.revision, undefined, `owner-resume:${result.revision}`)
  return result
}
export function appendOwnerManagementMessage(input: Omit<OwnerManagementMessage, 'id' | 'conversationId' | 'createdAt'>): OwnerManagementMessage {
  assertDeliveryMessage(input)
  const manager = getOwnerManager(input.projectId)
  if (!manager) throw new Error('Owner管理主体未建立')
  const id = digest({ eventId: input.eventId, role: input.role, kind: input.kind })
  const existing = store.getProjectDb().prepare('SELECT payload, integrity_hash FROM project_owner_management_messages WHERE id = ?').get(id) as PayloadRow | undefined
  if (existing) {
    const old = read<OwnerManagementMessage>(existing)
    if (old.projectId !== input.projectId || old.conversationId !== manager.conversationId || old.content !== input.content || old.planningTaskId !== input.planningTaskId || old.questionId !== input.questionId || old.taskId !== input.taskId || JSON.stringify(old.employeeInteraction) !== JSON.stringify(input.employeeInteraction) || JSON.stringify(old.runEvidence) !== JSON.stringify(input.runEvidence) || old.goalRevision !== input.goalRevision || old.changeId !== input.changeId || JSON.stringify(old.changeDecision) !== JSON.stringify(input.changeDecision) || JSON.stringify(old.executionObservation) !== JSON.stringify(input.executionObservation) || JSON.stringify(old.delivery) !== JSON.stringify(input.delivery) || JSON.stringify(old.deliveryReference) !== JSON.stringify(input.deliveryReference) || JSON.stringify(old.teamWorkspaceProposal) !== JSON.stringify(input.teamWorkspaceProposal) || JSON.stringify(old.teamWorkspaceApproval) !== JSON.stringify(input.teamWorkspaceApproval)) throw new Error('Owner管理消息与已有事件不一致')
    return old
  }
  const message: OwnerManagementMessage = { ...input, id, conversationId: manager.conversationId, createdAt: Date.now() }
  store.getProjectDb().prepare('INSERT INTO project_owner_management_messages (id, project_id, event_id, payload, integrity_hash) VALUES (?, ?, ?, ?, ?)').run(id, input.projectId, input.eventId, JSON.stringify(message), digest(message))
  requestOwnerManagementChanged({ projectId: input.projectId, ...(input.kind === 'execution_observation' ? {} : { messageId: message.id }) }, () => !store.getProjectDb().isTransactionActive() && Boolean(store.getProjectDb().prepare('SELECT id FROM project_owner_management_messages WHERE id = ? AND project_id = ? AND integrity_hash = ?').get(message.id, input.projectId, digest(message))))
  return message
}
function enqueue(projectId: string, kind: OwnerManagementEvent['kind'], sourceRevision: number, taskId?: string, sourceId?: string, recoveryId?: string): OwnerManagementEvent {
  project(projectId)
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1) throw new Error('Owner管理来源修订无效')
  const id = digest({ projectId, kind, taskId: taskId ?? null, sourceRevision, ...(sourceId ? { sourceId } : {}), ...(recoveryId ? { recoveryId } : {}) })
  const existing = store.getProjectDb().prepare('SELECT payload, integrity_hash, consumed_at FROM project_owner_management_events WHERE id = ?').get(id) as EventRow | undefined
  if (existing) return { ...read<OwnerManagementEvent>(existing), consumedAt: existing.consumed_at }
  const event: OwnerManagementEvent = { id, projectId, kind, ...(taskId ? { taskId } : {}), sourceRevision, ...(sourceId ? { sourceId } : {}), createdAt: Date.now(), consumedAt: null }
  store.getProjectDb().prepare('INSERT INTO project_owner_management_events (id, project_id, payload, integrity_hash, consumed_at) VALUES (?, ?, ?, ?, NULL)').run(id, projectId, JSON.stringify(event), digest(event))
  requestOwnerManagementWake(projectId)
  return event
}
/** 与权威目标写入同事务，外层回滚时身份、消息和唤醒事实一起回滚。 */
export function recordOwnerManagementGoal(goal: ProjectOwnerGoalDraft, recordMessage = true): void {
  transaction(() => {
    ensureManager(goal.goal.projectId)
    const event = enqueue(goal.goal.projectId, 'goal_saved', goal.revision, goal.goal.taskId)
    if (recordMessage) appendOwnerManagementMessage({ projectId: event.projectId, eventId: event.id, role: 'user', kind: 'goal', ...(goal.goal.taskId ? { taskId: goal.goal.taskId } : {}), content: [goal.goal.objective, ...goal.goal.constraints.map(value => `约束：${value}`), ...goal.goal.acceptanceCriteria.map(value => `完成标准：${value}`)].join('\n') })
    return true
  })
}
export function recordOwnerManagementBinding(projectId: string, revision: number): void {
  if (!getOwnerManager(projectId)) return
  // 一个项目可以只有任务目标；绑定变化必须恢复每个仍存在的目标主体。
  const subjects = store.getProjectDb().prepare('SELECT DISTINCT subject_key FROM project_owner_revisions WHERE project_id = ?').all(projectId) as { subject_key: string }[]
  for (const subject of subjects) {
    if (subject.subject_key === 'project') enqueue(projectId, 'binding_changed', revision)
    else if (subject.subject_key.startsWith('task:')) {
      const taskId = subject.subject_key.slice(5)
      if (store.getTask(taskId)?.projectId === projectId) enqueue(projectId, 'binding_changed', revision, taskId)
    }
  }
}
/** 委托确认后重读当前目标，补偿旧规划来源失效或唤醒丢失。 */
export function recordOwnerManagementDelegationConfirmed(projectId: string, revision: number, delegationId: string, taskId?: string): void {
  enqueue(projectId, 'delegation_confirmed', revision, taskId, delegationId)
}
/** 活跃管理委托下，待审方案缺少安排记录时只生成一次可恢复检查事件。 */
/** 用户手动重排：sourceId 带请求ID，重复点击不会重复排队。 */
export function recordOwnerManagementManualRecheck(projectId: string, planRevision: number, requestId: string, taskId?: string): OwnerManagementEvent {
  return enqueue(projectId, 'assignment_recheck', planRevision, taskId, `manual-retry:${requestId}`)
}

export function recordOwnerManagementAssignmentRecheck(projectId: string, planRevision: number, delegationId: string, taskId?: string): OwnerManagementEvent {
  return enqueue(projectId, 'assignment_recheck', planRevision, taskId, delegationId)
}
/** 协议拒绝后的唯一受限续跑；来源绑定原Run，事件ID天然幂等。 */
export function recordOwnerManagementAssignmentProtocolRetry(projectId: string, planRevision: number, executionId: string, taskId?: string): OwnerManagementEvent {
  if (!/^[a-f0-9-]{36}$/.test(executionId)) throw new Error('Owner安排重试来源无效')
  return enqueue(projectId, 'assignment_recheck', planRevision, taskId, `protocol-retry:${executionId}`)
}
/** 用户确认资料范围后，只唤醒对应目标主体的团队安排，不广播到其他项目。 */
export function recordOwnerManagementTeamAccessApproved(projectId: string, taskId: string | undefined, planRevision: number, approvalSource: string): OwnerManagementEvent {
  if (!/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(approvalSource)) throw new Error('Owner团队工作区授权来源无效')
  return enqueue(projectId, 'team_changed', planRevision, taskId, `team-access:${approvalSource}`)
}
export function listPendingOwnerManagementEvents(projectId: string): OwnerManagementEvent[] {
  project(projectId)
  return (store.getProjectDb().prepare('SELECT payload, integrity_hash, consumed_at FROM project_owner_management_events WHERE project_id = ? AND consumed_at IS NULL ORDER BY rowid').all(projectId) as EventRow[]).map(row => {
    const event = read<OwnerManagementEvent>(row)
    if (event.projectId !== projectId || !['goal_saved', 'binding_changed', 'plan_confirmed', 'delegation_confirmed', 'assignment_recheck', 'planning_result', 'assignment_result', 'message_received', 'answer_saved', 'execution_observed', 'team_changed'].includes(event.kind) || !Number.isSafeInteger(event.sourceRevision) || event.sourceRevision < 1) throw new Error('Owner管理事件身份无效')
    return { ...event, consumedAt: row.consumed_at }
  })
}
export function consumeOwnerManagementEvent(event: OwnerManagementEvent): void {
  store.getProjectDb().prepare('UPDATE project_owner_management_events SET consumed_at = ? WHERE id = ? AND project_id = ? AND consumed_at IS NULL').run(Date.now(), event.id, event.projectId)
}
export function appendOwnerManagementTrace(input: OwnerManagementTraceEntry): OwnerManagementTraceEntry {
  project(input.projectId)
  const keys = Object.keys(input)
  if (keys.some(key => !['eventId', 'projectId', 'taskId', 'phase', 'state', 'createdAt', 'detailCode'].includes(key))
    || typeof input.eventId !== 'string' || !input.eventId || input.eventId.length > 200
    || (input.taskId !== undefined && (typeof input.taskId !== 'string' || !input.taskId || input.taskId.length > 128))
    || !tracePhases.includes(input.phase) || !traceStates.includes(input.state)
    || !Number.isSafeInteger(input.createdAt) || input.createdAt <= 0
    || (input.detailCode !== undefined && !traceDetails.includes(input.detailCode))) throw new Error('Owner诊断Trace字段无效')
  const id = /^[a-f0-9]{64}$/.test(input.eventId) ? input.eventId : digest({ projectId: input.projectId, eventId: input.eventId })
  const trace: OwnerManagementTraceEntry = { eventId: id, projectId: input.projectId, ...(input.taskId ? { taskId: input.taskId } : {}), phase: input.phase, state: input.state, createdAt: input.createdAt, ...(input.detailCode ? { detailCode: input.detailCode } : {}) }
  const database = store.getProjectDb()
  const existing = database.prepare('SELECT payload, integrity_hash FROM project_owner_management_traces WHERE id = ?').get(id) as PayloadRow | undefined
  if (existing) {
    const old = parseTraceEntry(read<unknown>(existing))
    const { createdAt: _oldCreatedAt, ...oldEvent } = old
    const { createdAt: _newCreatedAt, ...newEvent } = trace
    if (JSON.stringify(oldEvent) !== JSON.stringify(newEvent)) throw new Error('Owner诊断Trace事件与已有记录不一致')
    return old
  }
  database.prepare('INSERT INTO project_owner_management_traces (id, project_id, payload, integrity_hash) VALUES (?, ?, ?, ?)').run(id, input.projectId, JSON.stringify(trace), digest(trace))
  requestOwnerManagementChanged({ projectId: input.projectId }, () => Boolean(database.prepare('SELECT 1 FROM project_owner_management_traces WHERE id = ? AND project_id = ?').get(id, input.projectId)))
  return trace
}
export function recordStaleOwnerManagementTrace(projectId: string, delegationId: string, taskId?: string): void {
  appendOwnerManagementTrace({ eventId: `management-delegation-stale-trace:${delegationId}`, projectId, ...(taskId ? { taskId } : {}), phase: 'owner_response', state: 'blocked', createdAt: Date.now(), detailCode: 'authorization_changed' })
}
export function getOwnerManagementView(projectId: string): OwnerManagementView {
  const manager = getOwnerManager(projectId)
  const messages = (store.getProjectDb().prepare("SELECT payload, integrity_hash FROM project_owner_management_messages WHERE project_id = ? AND json_extract(payload, '$.kind') <> 'execution_observation' ORDER BY rowid DESC LIMIT 200").all(projectId) as PayloadRow[]).reverse().map(row => {
    const message = read<OwnerManagementMessage>(row)
    assertDeliveryMessage(message)
    if (!manager || message.projectId !== projectId || message.conversationId !== manager.conversationId) throw new Error('Owner管理会话身份不匹配')
    return message
  })
  const trace = (store.getProjectDb().prepare('SELECT payload, integrity_hash FROM project_owner_management_traces WHERE project_id = ? ORDER BY rowid DESC LIMIT 100').all(projectId) as PayloadRow[]).reverse().map(row => {
    const entry = parseTraceEntry(read<unknown>(row))
    if (entry.projectId !== projectId) throw new Error('Owner诊断Trace项目归属无效')
    return entry
  })
  const employeeInteractions = (require('./project-owner-employee-interactions') as typeof import('./project-owner-employee-interactions')).listOwnerEmployeeInteractions(projectId)
  const projection = manager ? (require('./project-owner-state-projection') as typeof import('./project-owner-state-projection')).readOwnerStateProjection(projectId) : null
  const actionRequests = (require('./project-owner-action-approval') as typeof import('./project-owner-action-approval')).listOwnerPendingActionRequests(projectId)
  return { manager, messages, ...(projection ? { stateProjection: { stateHash: projection.stateHash, dirtyDomains: projection.dirtyDomains, lastReconciledAt: projection.lastReconciledAt } } : {}), ...(actionRequests.length ? { actionRequests } : {}), ...(employeeInteractions.length ? { employeeInteractions } : {}), pendingEvents: listPendingOwnerManagementEvents(projectId).length, questions: [], trace }
}

/** 可信回调只追加来源事件；真正的问题展示由后台重读Run与快照后处理。 */
export function recordOwnerManagementRun(projectId: string, executionId: string, goalRevision: number, taskId?: string, purpose: 'owner_planning' | 'owner_execution_assignment' = 'owner_planning'): void {
  if (getOwnerManager(projectId)) enqueue(projectId, purpose === 'owner_execution_assignment' ? 'assignment_result' : 'planning_result', goalRevision, taskId, executionId)
}
/** 与本地恢复记录同事务追加独立结果事件；原失败结果事件保持已消费状态。 */
export function recordOwnerManagementRecoveredAssignment(projectId: string, executionId: string, goalRevision: number, receiptId: string, taskId?: string): void {
  if (!/^[a-f0-9]{64}$/.test(receiptId)) throw new Error('Owner恢复回执身份无效')
  if (getOwnerManager(projectId)) enqueue(projectId, 'assignment_result', goalRevision, taskId, executionId, receiptId)
}
/** 方案内容确认是管理判断的唤醒事实，不授予调用或业务执行许可。 */
export function recordOwnerManagementPlanConfirmed(plan: ProjectOwnerPlanDraft): void {
  if (getOwnerManager(plan.projectId)) enqueue(plan.projectId, 'plan_confirmed', plan.revision, plan.taskId)
}

/** 团队变化与员工写入同事务；后台收到项目事件后再核对当前目标、Owner状态和安排状态。 */
export function recordOwnerManagementTeamChanged(changeId: string): void {
  if (!/^[a-zA-Z0-9:_-]{1,200}$/.test(changeId)) throw new Error('Owner团队变化来源无效')
  const database = store.getProjectDb()
  const managers = database.prepare('SELECT m.project_id, MAX(m.revision) AS revision FROM project_owner_managers m JOIN projects p ON p.id = m.project_id GROUP BY m.project_id').all() as { project_id: string; revision: number }[]
  for (const { project_id: projectId, revision } of managers) {
    if (Number.isSafeInteger(revision) && revision > 0) enqueue(projectId, 'team_changed', revision, undefined, changeId)
  }
}


export function getOwnerManagementMessage(projectId: string, id: string): OwnerManagementMessage | null {
  const row = store.getProjectDb().prepare('SELECT payload, integrity_hash FROM project_owner_management_messages WHERE project_id = ? AND id = ?').get(projectId, id) as PayloadRow | undefined
  if (!row) return null
  const value = read<OwnerManagementMessage>(row)
  if (value.id !== id || value.projectId !== projectId || value.conversationId !== getOwnerManager(projectId)?.conversationId) throw new Error('Owner消息身份不一致')
  assertDeliveryMessage(value)
  return value
}
/** 消息与待处理事件同事务；调用方负责核对目标与用户身份。 */
export function recordOwnerConversationMessage(input: Omit<OwnerManagementMessage, 'id' | 'conversationId' | 'createdAt'> & { goalRevision: number }): OwnerManagementMessage {
  const message = appendOwnerManagementMessage(input)
  enqueue(input.projectId, 'message_received', input.goalRevision, input.taskId, message.id)
  return message
}

/** 同内容答复不增加目标版本，仍需凭独立答复事实唤醒下一轮。 */
export function recordOwnerManagementAnswer(goal: ProjectOwnerGoalDraft, questionId: string): void {
  enqueue(goal.goal.projectId, 'answer_saved', goal.revision, goal.goal.taskId, questionId)
}

/** 用户确认结果范围并启动后，必须先在同一次对话给出可见回应；否则用户只看到对话空白。 */
export function recordOwnerManagementStartAccepted(projectId: string, intentId: string, goalRevision: number, taskId?: string): void {
  if (!getOwnerManager(projectId)) return
  transaction(() => {
    appendOwnerManagementMessage({ projectId, eventId: `execution-start-accepted:${intentId}`, ...(taskId ? { taskId } : {}), role: 'assistant', kind: 'management_progress', goalRevision,
      content: '已按你确认的结果与边界开始组织执行。我会在关键进展、需要你决定的事项或成果交付时，继续在这里说明。' })
    return true
  })
}

/** 启动被阻断时同样回到同一对话解释，不让用户只觉得断掉了。 */
export function recordOwnerManagementStartBlocked(projectId: string, intentId: string, goalRevision: number, content: string, taskId?: string): void {
  if (!getOwnerManager(projectId)) return
  transaction(() => {
    appendOwnerManagementMessage({ projectId, eventId: `execution-start-recovery:${intentId}:attention`, ...(taskId ? { taskId } : {}), role: 'assistant', kind: 'attention', goalRevision, content })
    return true
  })
}

/** 仅由后台准确业务事实生成；assistant来源不伪装人类输入或授权。 */
export function recordOwnerManagementObservation(projectId: string, goalRevision: number, observation: OwnerExecutionObservation, taskId: string | undefined, observationHash: string): void {
  transaction(() => {
    const eventId = `execution-observation:${projectId}:${goalRevision}:${observationHash}`
    const message = appendOwnerManagementMessage({ projectId, eventId, role: 'assistant', kind: 'execution_observation', ...(taskId ? { taskId } : {}), goalRevision, executionObservation: observation, content: `后台观察：${observation.taskTitle}的${observation.role === 'reviewer' ? '检查' : '执行'}${observation.trigger === 'terminal' ? '已返回结果' : observation.trigger === 'expired' ? '许可已到期' : '较长时间未更新'}，需要Owner核对后续安排。` })
    const state = observation.trigger === 'terminal' ? observation.executionStatus === 'completed' ? 'completed' : 'failed' : observation.trigger === 'expired' ? 'expired' : 'stalled'
    appendOwnerManagementTrace({ eventId: `${eventId}:trace`, projectId, ...(taskId ? { taskId } : {}), phase: observation.role, state, createdAt: message.createdAt, detailCode: observation.trigger === 'terminal' ? 'result_ready' : observation.trigger === 'expired' ? 'grant_expired' : 'no_update' })
    const subject = observation.role === 'reviewer' ? '独立检查' : '员工执行'
    const needsManualReconciliation = observation.trigger === 'terminal'
      && observation.executionStatus !== 'completed'
      && (observation.commandState === 'needs_reconcile' || observation.actualCostMicros === null)
    if (needsManualReconciliation) {
      appendOwnerManagementMessage({ projectId, eventId: `${eventId}:progress`, role: 'assistant', kind: 'attention', ...(taskId ? { taskId } : {}), goalRevision,
        content: observation.requestsSent === 0
          ? `${subject}失败，没有可核验成果。本次失败发生在发送模型请求之前，没有产生模型费用，保守预留会在核对后退回；系统不会自动重发。失败原因：${observation.error.trim().slice(0, 300) || '未记录'}`
          : `${subject}失败，没有可核验成果。当前记录中的模型用量或实际费用未知，保守预留仍保留；系统不会自动重发。请先在服务商账单按模型与请求时间核对。当前版本不能把外部账单核对结果写回应用，也不会在核对前启动后续步骤。` })
      return true
    }
    // 独立检查有结论时，Owner 主动说明发现、影响与建议，而不是只报“检查已返回”。
    // 全部来自权威观察与评审证据，不做超出事实的推断；同一观察只写一次。
    const review = observation.review
    if (observation.trigger === 'terminal' && observation.role === 'reviewer' && observation.executionStatus === 'completed' && review) {
      const findings = review.findings.map(value => value.trim()).filter(Boolean)
      const summary = review.summary.trim()
      const lead = summary ? `（${summary}）` : ''
      const listed = findings.slice(0, 3).map((value, index) => `${index + 1}) ${value}`).join('；')
      const more = findings.length > 3 ? `；另有 ${findings.length - 3} 项` : ''
      const content = review.verdict === 'changes_requested'
        ? `发现：独立检查未通过${lead}，提出 ${findings.length} 项修改${listed ? `：${listed}${more}` : ''}。\n影响：本轮成果已保留但不能作为交付；受影响部分需要在剩余返工次数与额度内重做，范围不扩大。\n建议：先按上述修改点调整执行内容和验收依据，再重新独立检查；若修改要求超出已确认的目标、资料或费用边界，我会停下来请你决定。`
        : review.verdict === 'approved'
          ? `发现：独立检查通过${lead}，${findings.length ? `仍记录 ${findings.length} 项非阻断项：${listed}${more}` : '没有阻断项'}。\n影响：成果可以进入交付，不需要为此改动方案或追加授权。\n建议：我继续整理交付说明（成果位置、依据、限制）；除业务取舍外不需要你再次确认。`
          : `发现：独立检查结论为 ${review.verdict}${lead}。\n影响：结论不是通过，本轮不能按已通过处理，相关部分仍需在授权内核对或返工。\n建议：先核对检查依据与本轮成果，再决定返工还是请你对边界作决定；我不会自动扩大范围。`
      appendOwnerManagementMessage({ projectId, eventId: `${eventId}:plan-update`, role: 'assistant', kind: 'management_progress', ...(taskId ? { taskId } : {}), goalRevision, content })
      enqueue(projectId, 'execution_observed', goalRevision, taskId, message.id)
      return true
    }
    const progress = observation.trigger === 'stalled'
      ? `${subject}长时间没有新进度。我正在核对已有运行状态与授权，不会重复派发。`
      : observation.trigger === 'expired'
        ? `${subject}授权已到期，现有记录和成果已保留。我正在核对后续安排；需要你决定时会在这里说明。`
        : observation.executionStatus === 'completed'
          ? observation.role === 'reviewer' ? '独立检查已返回。我正在结合成果、检查结论和验收标准整理下一步。' : '员工已完成本轮工作。我正在核对成果与验收标准，完成后会在这里反馈。'
          : `${subject}未能正常完成。我正在核对失败原因和已有记录，不会自动重复派发。`
    appendOwnerManagementMessage({ projectId, eventId: `${eventId}:progress`, role: 'assistant', kind: 'management_progress', ...(taskId ? { taskId } : {}), goalRevision, content: progress })
    enqueue(projectId, 'execution_observed', goalRevision, taskId, message.id)
    return true
  })
}

/** 员工问题属于系统来源；不伪装成用户消息，也不修改目标或授予执行许可。 */
export function recordOwnerEmployeeInteractionMessage(interaction: import('@gravitas/shared').OwnerEmployeeInteraction, goalRevision: number, taskId?: string): OwnerManagementMessage {
  return transaction(() => {
    const message = appendOwnerManagementMessage({ projectId: interaction.projectId, eventId: `employee-interaction:${interaction.id}:${interaction.revision}`, role: 'assistant', kind: 'employee_interaction', ...(taskId ? { taskId } : {}), goalRevision, employeeInteraction: interaction, content: `员工提出问题，我已接管：\n${interaction.summary}\n我会先核对已确认边界；需要你决定时只在这里讨论，不需要进入员工会话。` })
    enqueue(interaction.projectId, 'message_received', goalRevision, taskId, message.id)
    return message
  })
}
