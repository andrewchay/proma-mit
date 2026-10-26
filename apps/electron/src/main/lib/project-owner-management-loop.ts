import { hasUnstartedOwnerConversation, preparePendingOwnerConversation } from './project-owner-management-conversation'
import { prepareOwnerManagementAssignment, projectOwnerManagementAssignmentResult, queueOwnerAssignmentProtocolRetry, isRecoverableOwnerAssignmentRejection } from './project-owner-management-assignment'
import { getOwnerManagementDelegation, hasActiveOwnerManagementRequest } from './project-owner-management-delegation'
import type { OwnerManagementEvent } from '@gravitas/shared'
import { prepareOwnerUnchangedAnswer, projectOwnerManagementRunResult } from './project-owner-management-questions'
import { getProjectOwnerGoalDraft } from './project-owner-goal-service'
import { confirmProjectOwnerPlanDraftForOwner, getProjectOwnerPlanDraft, getProjectOwnerPlanningContext } from './project-owner-plan-service'
import { getOwnerRuntimeBinding, prepareOwnerPlanning, resolveOwnerRuntimeBindingFromDefaults } from './project-owner-runtime-binding'
import { onOwnerManagementChanged, onOwnerManagementWake, type OwnerManagementChanged } from './project-owner-management-events'
import { appendOwnerManagementMessage, appendOwnerManagementTrace, consumeOwnerManagementEvent, getOwnerManager, listPendingOwnerManagementEvents, recordOwnerManagementAssignmentRecheck, recordStaleOwnerManagementTrace } from './project-owner-management-store'
import * as store from './project-sqlite-store'
import { scanOwnerExecutionObservations } from './project-owner-management-execution'
import { readOwnerPlanningSnapshot } from './project-owner-planning-source'
import { publishOwnerManagementCompletion } from './project-owner-management-delivery'
import { onOwnerAutonomousScheduleWake } from './project-owner-autonomous-scheduler-events'
import { listOwnerExecutionAssignmentRuns } from './project-owner-execution-assignment-service'
import { getOwnerPlanningRunOutcome, getOwnerPlanningRunReceipt, recoverLegacyOwnerConversationReply, recoverLegacyOwnerAssignmentProposal } from './project-owner-planning-run-service'

/** 即使当前没有可继续处理的Run，也要把失效授权反馈写回Owner对话。 */
function reportStaleManagementDelegations(projectId: string): void {
  const subjects = store.getProjectDb().prepare('SELECT DISTINCT subject_key FROM project_owner_revisions WHERE project_id = ?').all(projectId) as { subject_key: string }[]
  for (const { subject_key: key } of subjects) {
    const taskId = key === 'project' ? undefined : key.startsWith('task:') ? key.slice(5) : null
    if (taskId === null) continue
    const view = getOwnerManagementDelegation(projectId, taskId)
    if (view.state !== 'stale' || !view.delegation) continue
    recordStaleOwnerManagementTrace(projectId, view.delegation.id, taskId)
    appendOwnerManagementMessage({
      projectId,
      eventId: `management-delegation-stale:${view.delegation.id}`,
      role: 'assistant',
      kind: 'attention',
      ...(taskId ? { taskId } : {}),
      content: '我已暂停后续推进：管理配置、资料来源或费用上界已变化，旧授权不会用于新请求。目标和已保存成果仍保留；请核对当前范围、项目总预算和期限并重新确认，确认后我会继续处理。',
    })
  }
}

/** 每次只处理当前持久事件；准备为无费动作，付费模型仍走独立受控准入。 */
function handleTeamChange(event: OwnerManagementEvent): void {
  const subjects = store.getProjectDb().prepare('SELECT DISTINCT subject_key FROM project_owner_revisions WHERE project_id = ?').all(event.projectId) as { subject_key: string }[]
  for (const { subject_key: subjectKey } of subjects) {
    const taskId = subjectKey === 'project' ? undefined : subjectKey.startsWith('task:') ? subjectKey.slice(5) : null
    if (taskId === null) continue
    if (event.taskId !== undefined && event.taskId !== taskId) continue
    const plan = getProjectOwnerPlanDraft(event.projectId, taskId)
    if (!plan || !['proposed', 'confirmed'].includes(plan.state)) continue
    if (plan.state === 'proposed') {
      const delegation = getOwnerManagementDelegation(event.projectId, taskId)
      if (!event.sourceId?.startsWith('team-access:') || delegation.state !== 'active' || !delegation.delegation) continue
    }
    const existing = store.getProjectDb().prepare("SELECT 1 FROM project_owner_planning_links WHERE project_id = ? AND json_extract(payload, '$.purpose') = 'owner_execution_assignment' AND json_extract(payload, '$.targetTaskId') IS ? AND json_extract(payload, '$.planRevision') = ? LIMIT 1")
      .get(event.projectId, taskId ?? null, plan.revision)
    if (existing) continue
    prepareOwnerManagementAssignment({ ...event, id: `${event.id}:${subjectKey}`, ...(taskId ? { taskId } : {}), sourceRevision: plan.revision })
  }
}

function acceptPlanAndArrange(event: OwnerManagementEvent, proposed: NonNullable<ReturnType<typeof getProjectOwnerPlanDraft>>): void {
  const delegation = getOwnerManagementDelegation(event.projectId, event.taskId)
  if (delegation.state !== 'active' || !delegation.delegation) return
  if (!delegation.delegation.autonomousExecution) {
    prepareOwnerManagementAssignment(event)
    return
  }
  const accepted = confirmProjectOwnerPlanDraftForOwner(event.projectId, proposed.goalRevision, proposed.revision, event.taskId)
  prepareOwnerManagementAssignment({ ...event, id: `owner-plan-accepted:${event.id}:${accepted.revision}`, kind: 'plan_confirmed', sourceRevision: accepted.revision })
}

function handle(event: OwnerManagementEvent): void {
  if (event.kind === 'team_changed') { handleTeamChange(event); return }
  const goal = getProjectOwnerGoalDraft(event.projectId, event.taskId)
  if (!goal || (event.kind === 'goal_saved' && goal.revision !== event.sourceRevision)) return
  if (event.kind === 'execution_observed') {
    if (goal.revision === event.sourceRevision) preparePendingOwnerConversation(event.projectId, event.taskId)
    return
  }
  if (event.kind === 'assignment_recheck') {
    const plan = getProjectOwnerPlanDraft(event.projectId, event.taskId)
    const delegation = getOwnerManagementDelegation(event.projectId, event.taskId)
    const protocolRetry = event.sourceId?.startsWith('protocol-retry:') === true
    if (!plan || (protocolRetry ? plan.state !== 'confirmed' : plan.state !== 'proposed') || plan.revision !== event.sourceRevision
      || delegation.state !== 'active' || (protocolRetry ? !delegation.delegation?.autonomousExecution : delegation.delegation?.id !== event.sourceId)) {
      appendOwnerManagementMessage({ projectId: event.projectId, eventId: event.id, ...(event.taskId ? { taskId: event.taskId } : {}), role: 'assistant', kind: 'attention', content: '当前方案或持续管理授权已变化，我已停止使用旧安排条件；请在项目对话中核对最新方案与管理范围。' })
      return
    }
    prepareOwnerManagementAssignment(event)
    return
  }
  if (event.kind === 'answer_saved') { prepareOwnerUnchangedAnswer(event); return }
  if (event.kind === 'message_received') { preparePendingOwnerConversation(event.projectId, event.taskId); return }
  if (event.kind === 'delegation_confirmed') {
    const delegation = getOwnerManagementDelegation(event.projectId, event.taskId)
    if (delegation.state !== 'active' || delegation.delegation?.id !== event.sourceId) return
    if (hasUnstartedOwnerConversation(event.projectId, event.taskId)) {
      preparePendingOwnerConversation(event.projectId, event.taskId)
      return
    }
    const plan = getProjectOwnerPlanDraft(event.projectId, event.taskId)
    if (plan?.state === 'proposed') { acceptPlanAndArrange(event, plan); return }
    if (plan?.state === 'confirmed') { prepareOwnerManagementAssignment(event); return }
    const binding = getOwnerRuntimeBinding(event.projectId) ?? resolveOwnerRuntimeBindingFromDefaults(event.projectId)
    if (!binding) {
      appendOwnerManagementMessage({ projectId: event.projectId, eventId: event.id, ...(event.taskId ? { taskId: event.taskId } : {}), role: 'assistant', kind: 'configuration_required', content: '管理范围已确认，但本项目还没有可用的模型和工作位置。我会在这里说明需要补齐的项目配置；尚未发送模型请求。' })
      return
    }
    const context = getProjectOwnerPlanningContext(event.projectId, event.taskId)
    const planningTaskId = prepareOwnerPlanning(event.projectId, { requestId: `delegation:${event.sourceId}`, ...(event.taskId ? { taskId: event.taskId } : {}), expectedBindingRevision: binding.revision, expectedGoalRevision: goal.revision, expectedPlanRevision: plan?.revision ?? 0, expectedContextFingerprint: context.fingerprint }).planningTaskId
    appendOwnerManagementMessage({ projectId: event.projectId, eventId: event.id, ...(event.taskId ? { taskId: event.taskId } : {}), role: 'assistant', kind: 'management_progress', planningTaskId, content: '管理范围已确认。我正在按当前目标和资料重新整理方案；需要你决定的业务问题会在这里说明。' })
    return
  }
  if (event.kind === 'assignment_result') { projectOwnerManagementAssignmentResult(event); preparePendingOwnerConversation(event.projectId, event.taskId); return }
  if (event.kind === 'plan_confirmed') { prepareOwnerManagementAssignment(event); return }
  if (event.kind === 'planning_result') {
    if (!event.sourceId) throw new Error('Owner运行事件缺少来源')
    projectOwnerManagementRunResult(event.projectId, event.sourceId, event.id)
    const proposed = getProjectOwnerPlanDraft(event.projectId, event.taskId)
    if (proposed?.state === 'proposed' && proposed.sourceRun?.executionId === event.sourceId) acceptPlanAndArrange(event, proposed)
    preparePendingOwnerConversation(event.projectId, event.taskId)
    return
  }
  const binding = getOwnerRuntimeBinding(event.projectId) ?? resolveOwnerRuntimeBindingFromDefaults(event.projectId)
  if (event.kind === 'binding_changed' && binding?.revision !== event.sourceRevision) return
  if (!binding) {
    appendOwnerManagementMessage({ projectId: event.projectId, eventId: event.id, ...(event.taskId ? { taskId: event.taskId } : {}), role: 'assistant', kind: 'configuration_required', content: '目标已收到。我正在准备方案。为保护项目资料，需要确认本项目的专用资料空间；模型和团队选择由我负责。如果内部条件不足，我会在这里说明具体影响，不要求你配置技术选项或安排步骤。' })
    return
  }
  if (event.kind === 'binding_changed' && preparePendingOwnerConversation(event.projectId, event.taskId)) return
  const context = getProjectOwnerPlanningContext(event.projectId, event.taskId)
  const plan = getProjectOwnerPlanDraft(event.projectId, event.taskId)
  if (plan && plan.state !== 'stale') {
    if (plan.state === 'confirmed') prepareOwnerManagementAssignment(event)
    return
  }
  // 同来源已存在规划时复用准确记录，避免前台旧入口与后台同时准备两份。
  const links = store.getProjectDb().prepare("SELECT planning_task_id FROM project_owner_planning_links WHERE project_id = ? AND json_extract(payload, '$.purpose') = 'owner_planning' AND json_extract(payload, '$.targetTaskId') IS ? AND json_extract(payload, '$.bindingRevision') = ? AND json_extract(payload, '$.goalRevision') = ? AND json_extract(payload, '$.planRevision') = ? AND json_extract(payload, '$.contextFingerprint') = ? AND json_extract(payload, '$.conversationMessageId') IS NULL ORDER BY rowid DESC LIMIT 1")
    .get(event.projectId, event.taskId ?? null, binding.revision, goal.revision, plan?.revision ?? 0, context.fingerprint) as { planning_task_id: string } | undefined
  const planningTaskId = links?.planning_task_id ?? prepareOwnerPlanning(event.projectId, { requestId: `management:${event.id}`, ...(event.taskId ? { taskId: event.taskId } : {}), expectedBindingRevision: binding.revision, expectedGoalRevision: goal.revision, expectedPlanRevision: plan?.revision ?? 0, expectedContextFingerprint: context.fingerprint }).planningTaskId
  const previousRun = store.listAgentExecutionsByEntity('task', planningTaskId).length > 0
  const delegation = getOwnerManagementDelegation(event.projectId, event.taskId)
  const awaitingAuthorization = delegation.state !== 'active' || !delegation.delegation?.autonomousExecution
  appendOwnerManagementMessage({ projectId: event.projectId, eventId: event.id, ...(event.taskId ? { taskId: event.taskId } : {}), role: 'assistant', kind: previousRun ? 'attention' : 'planning_confirmation', planningTaskId,
    content: previousRun ? '这份目标已有规划运行记录，我会保留结果和费用记录。需要新的调用时应先核对上次结果和授权。' : awaitingAuthorization ? '目标已保存。持续管理范围尚未确认，我没有发送模型请求。请在下方确认项目总预算和有效期限；确认后我会自动继续。' : '目标已收到。我会先核对项目已有的资料与费用范围，再整理方案；缺少边界时会在这里请你决定。方案确认后，我会组织团队并开始推进。' })
}

export function reconcileOwnerManagement(projectId: string): void {
  const db = store.getProjectDb()
  // 提交前收到唤醒不能消费未提交事件；启动扫描会补偿进程关闭时未发出的唤醒。
  if (db.isTransactionActive() || !store.getProject(projectId) || getOwnerManager(projectId)?.status !== 'active') return
  reportStaleManagementDelegations(projectId)
  // 同轮先投影可信回调，再准备用户积压消息，避免后续请求漏掉刚到达的Owner回应。
  const isResult = (event: OwnerManagementEvent) => event.kind === 'planning_result' || event.kind === 'assignment_result'
  const events = listPendingOwnerManagementEvents(projectId).sort((a, b) => Number(isResult(b)) - Number(isResult(a)))
  for (const event of events) {
    try {
      db.transaction(() => {
        if (getOwnerManager(projectId)?.status !== 'active') return
        // 同库其他消费者已完成时，不重复发消息或准备。
        if (!listPendingOwnerManagementEvents(projectId).some(item => item.id === event.id)) return
        handle(event)
        consumeOwnerManagementEvent(event)
      })()
    } catch (cause) {
      // 先让整轮事务回滚，再保存问题；避免内层准备失败留下半个Task。
      console.warn('[Owner管理] 当前事件需要核对', event.id, cause)
      db.transaction(() => {
        if (getOwnerManager(projectId)?.status !== 'active' || !listPendingOwnerManagementEvents(projectId).some(item => item.id === event.id)) return
        appendOwnerManagementMessage({ projectId, eventId: event.id, ...(event.taskId ? { taskId: event.taskId } : {}), role: 'assistant', kind: 'attention', content: '准备项目方案时遇到需要核对的内部条件。目标和历史已保留；我会先检查原因，并在这里说明对方案的具体影响。如果需要你决定资料范围或授权，我会单独提出。' })
        consumeOwnerManagementEvent(event)
      })()
    }
  }
  recoverLegacyOwnerConversationReplies(projectId)
  // 兼容旧版本已保存但没有启动执行的对话；恢复授权或进程重启后继续处理原消息。
  const subjects = store.getProjectDb().prepare('SELECT DISTINCT subject_key FROM project_owner_revisions WHERE project_id = ?').all(projectId) as { subject_key: string }[]
  for (const { subject_key: key } of subjects) {
    const taskId = key === 'project' ? undefined : key.startsWith('task:') ? key.slice(5) : null
    if (taskId === null || !hasUnstartedOwnerConversation(projectId, taskId)) continue
    preparePendingOwnerConversation(projectId, taskId)
  }
  recoverMissingProposedPlanAssignment(projectId)
  recoverProtocolRejectedOwnerAssignments(projectId)
  if (getOwnerManager(projectId)?.status === 'active') {
    try { publishOwnerManagementCompletion(projectId) }
    catch (cause) { console.warn('[Owner管理] 最终成果尚未完成核验，保留原成果并等待下次对账', projectId, cause) }
  }
}

/** 旧版解析器误拒绝的完整普通回应可从原文本地恢复，再由Owner接着履行已确认计划。 */
function recoverLegacyOwnerConversationReplies(projectId: string): void {
  const executions = store.getProjectDb().prepare(`SELECT o.execution_id FROM project_owner_planning_run_outcomes o
    JOIN project_owner_planning_run_receipts r ON r.id = o.receipt_id
    WHERE json_extract(r.payload, '$.projectId') = ? AND json_extract(r.payload, '$.purpose') = 'owner_planning'
      AND json_extract(o.payload, '$.state') = 'failed' AND json_extract(o.payload, '$.detail') IN ('Owner规划响应包含未知字段', 'Owner执行跟进只允许分析回应或必要协商', 'Owner质量决定与准确评审/成果不匹配')
    ORDER BY r.rowid`).all(projectId) as { execution_id: string }[]
  for (const { execution_id: executionId } of executions) {
    try {
      const recovered = recoverLegacyOwnerConversationReply(executionId)
      if (!recovered || recovered.state !== 'replied') continue
      const receipt = getOwnerPlanningRunReceipt(recovered.receiptId)
      if (!receipt) continue
      const snapshot = readOwnerPlanningSnapshot(receipt.planningTaskId)
      if (!snapshot || snapshot.link.projectId !== projectId || !snapshot.link.conversationMessageId) continue
      projectOwnerManagementRunResult(projectId, executionId, `legacy-response-recovered:${executionId}`)
      if (recovered.qualityDecision) continue

      // 只在仍有效的自主项目授权、已确认的同一方案和准确来源下续接安排；绝不重放旧请求。
      const plan = getProjectOwnerPlanDraft(projectId, snapshot.link.targetTaskId)
      const delegation = getOwnerManagementDelegation(projectId, snapshot.link.targetTaskId)
      if (!plan || plan.state !== 'confirmed' || plan.revision !== snapshot.link.planRevision
        || plan.goalRevision !== snapshot.link.goalRevision || delegation.state !== 'active'
        || delegation.delegation?.autonomousExecution !== true) continue
      prepareOwnerManagementAssignment({
        id: `legacy-response-plan-continuation:${executionId}:${plan.revision}`,
        projectId, kind: 'plan_confirmed', sourceRevision: plan.revision, createdAt: Date.now(), consumedAt: null,
        ...(snapshot.link.targetTaskId ? { taskId: snapshot.link.targetTaskId } : {}),
      })
    } catch (cause) {
      console.warn('[Owner管理] 旧回应本地恢复未通过核验，保留原失败记录', executionId, cause)
    }
  }
}

/** 进程在失败回执落库后退出时，从可信Run记录恢复唯一一次协议续跑。 */
function recoverProtocolRejectedOwnerAssignments(projectId: string): void {
  if (getOwnerManager(projectId)?.status !== 'active') return
  const subjects = store.getProjectDb().prepare('SELECT DISTINCT subject_key FROM project_owner_revisions WHERE project_id = ?').all(projectId) as { subject_key: string }[]
  for (const { subject_key: key } of subjects) {
    const taskId = key === 'project' ? undefined : key.startsWith('task:') ? key.slice(5) : null
    if (taskId === null) continue
    for (const run of listOwnerExecutionAssignmentRuns({ projectId, ...(taskId ? { taskId } : {}) })) {
      for (const outcome of run.outcomes) {
        if (outcome.state === 'failed' && outcome.detail === '受控非研发安排不得包含代码范围') {
          recoverLegacyOwnerAssignmentProposal(outcome.executionId)
        }
        if (outcome.state === 'failed' && isRecoverableOwnerAssignmentRejection(outcome.detail)) {
          queueOwnerAssignmentProtocolRetry(projectId, taskId, outcome.executionId)
        }
      }
    }
  }
}

/** 恢复没有产生安排或阻塞反馈的授权事件；每个方案版本只尝试一次。 */
function recoverMissingProposedPlanAssignment(projectId: string): void {
  if (getOwnerManager(projectId)?.status !== 'active') return
  const subjects = store.getProjectDb().prepare('SELECT DISTINCT subject_key FROM project_owner_revisions WHERE project_id = ?').all(projectId) as { subject_key: string }[]
  for (const { subject_key: subjectKey } of subjects) {
    const taskId = subjectKey.startsWith('task:') ? subjectKey.slice(5) : undefined
    const plan = getProjectOwnerPlanDraft(projectId, taskId)
    if (!plan || plan.state !== 'proposed') continue
    const delegation = getOwnerManagementDelegation(projectId, taskId)
    if (delegation.state !== 'active' || !delegation.delegation) continue
    const assignments = listOwnerExecutionAssignmentRuns({ projectId, ...(taskId ? { taskId } : {}) })
    if (assignments.some(run => run.link.planRevision === plan.revision && run.sourceStatus === 'current')) continue
    const blocked = store.getProjectDb().prepare("SELECT 1 FROM project_owner_management_events e JOIN project_owner_management_messages m ON m.event_id = e.id WHERE e.project_id = ? AND json_extract(e.payload, '$.kind') = 'delegation_confirmed' AND json_extract(e.payload, '$.sourceId') = ? AND json_extract(e.payload, '$.taskId') IS ? AND json_extract(m.payload, '$.kind') IN ('attention', 'configuration_required', 'clarification') LIMIT 1")
      .get(projectId, delegation.delegation.id, taskId ?? null)
    if (blocked) continue
    const recovery = store.getProjectDb().prepare("SELECT id, consumed_at FROM project_owner_management_events WHERE project_id = ? AND json_extract(payload, '$.kind') = 'assignment_recheck' AND json_extract(payload, '$.taskId') IS ? AND json_extract(payload, '$.sourceRevision') = ? AND json_extract(payload, '$.sourceId') = ? ORDER BY rowid DESC LIMIT 1")
      .get(projectId, taskId ?? null, plan.revision, delegation.delegation.id) as { id: string; consumed_at: number | null } | undefined
    if (!recovery) {
      recordOwnerManagementAssignmentRecheck(projectId, plan.revision, delegation.delegation.id, taskId)
      continue
    }
    if (recovery.consumed_at === null) continue
    const response = store.getProjectDb().prepare('SELECT 1 FROM project_owner_management_messages WHERE project_id = ? AND event_id = ? LIMIT 1').get(projectId, recovery.id)
    if (!response) appendOwnerManagementMessage({ projectId, eventId: `assignment-recheck-incomplete:${recovery.id}`, ...(taskId ? { taskId } : {}), role: 'assistant', kind: 'attention', content: '我已暂停：这份待审方案没有生成可核对的团队安排结果。原方案和授权记录仍保留；为避免重复请求，我没有自动重试。请在这里告诉我是否调整结果范围或项目可用团队。' })
  }
}

/** 主进程生命周期，不依赖页面挂载。旧项目无管理身份不会被启动扫描启用。 */
export function startOwnerManagementLoop(onChanged?: (change: OwnerManagementChanged) => void): () => void {
  let stopped = false
  const inFlight = new Set<string>(), pending = new Set<string>()
  const run = (projectId: string): void => {
    if (stopped) return
    try { scanOwnerExecutionObservations(projectId); reconcileOwnerManagement(projectId) }
    catch (cause) { console.warn('[Owner管理] 对账失败，保留待处理事件', projectId, cause); return }
    if (inFlight.has(projectId)) { pending.add(projectId); return }
    inFlight.add(projectId)
    void (async () => {
      do {
        pending.delete(projectId)
        if (stopped || getOwnerManager(projectId)?.status !== 'active') break
        const { recoverPendingOwnerExecutionStartIntents } = await import('./project-owner-execution-start-intent')
        await recoverPendingOwnerExecutionStartIntents(projectId)
        if (stopped || getOwnerManager(projectId)?.status !== 'active') break
        // 当前对话消息与业务观察是Owner已承担的管理责任；不能被更晚写入的内部安排Run抢先消费。
        const links = store.getProjectDb().prepare("SELECT planning_task_id, payload FROM project_owner_planning_links WHERE project_id = ? ORDER BY CASE WHEN json_extract(payload, '$.conversationMessageId') IS NOT NULL THEN 0 ELSE 1 END, rowid DESC").all(projectId) as { planning_task_id: string; payload: string }[]
        const conversationSubjects = new Set(links.flatMap(link => {
          const subject = JSON.parse(link.payload) as { targetTaskId?: string; goalRevision?: number; conversationMessageId?: string }
          const subjectKey = subject.targetTaskId ?? 'project'
          return subject.conversationMessageId && getProjectOwnerGoalDraft(projectId, subject.targetTaskId)?.revision === subject.goalRevision ? [subjectKey] : []
        }))
        const subjects = new Set<string>()
        const conversations = new Set<string>()
        for (const link of links) {
          if (stopped) break
          const subject = JSON.parse(link.payload) as { targetTaskId?: string; conversationMessageId?: string; purpose?: string }
          const subjectKey = subject.targetTaskId ?? 'project'
          if (subject.conversationMessageId) {
            if (conversations.has(subjectKey)) continue
            // 只保留主体最新的待处理消息；新消息回应后，不能回头重放旧消息。
            conversations.add(subjectKey)
          }
          // 初始规划Run对应的Link在提案写入后已经过期；待审/已确认方案
          // 必须走内部安排链，不能从旧Link再派发规划Run。
          if (subject.purpose === 'owner_planning' && !subject.conversationMessageId) {
            // 一旦主体已有对话消息链接，旧版初始规划不能在当前消息之后再单独运行，
            // 否则会与用户刚恢复的对话请求重复消耗预算并产生竞争结果。
            if (conversationSubjects.has(subjectKey)) continue
            const plan = getProjectOwnerPlanDraft(projectId, subject.targetTaskId)
            if (plan && ['proposed', 'confirmed'].includes(plan.state)) continue
          }
          if (subjects.has(subjectKey)) continue
          const view = getOwnerManagementDelegation(projectId, subject.targetTaskId)
          if (view.state === 'stale') continue
          // 最新对话已有Run时不重复调用；后续内部安排仍可继续处理。
          if (store.listAgentExecutionsByEntity('task', link.planning_task_id).length) continue
          subjects.add(subjectKey)
          // 已有调用时等待完成回调；先入队再失败回滚会产生新唤醒，造成忙重试。
          if (view.state !== 'active' || !view.delegation || hasActiveOwnerManagementRequest(view.delegation.id)) continue
          if (readOwnerPlanningSnapshot(link.planning_task_id)?.context.conversation?.executionObservation && view.delegation?.executionFollowupEnabled !== true) {
            appendOwnerManagementMessage({ projectId, eventId: `followup-scope:${link.planning_task_id}`, role: 'assistant', kind: 'attention', ...(subject.targetTaskId ? { taskId: subject.targetTaskId } : {}), content: '执行结果已保留。此前管理委托未包含主动跟进分析；重新确认管理范围后，我才能在额度内分析，不会自动消耗旧许可。' })
            continue
          }
          if (readOwnerPlanningSnapshot(link.planning_task_id)?.context.conversation?.deliveryReview && view.delegation?.fullDeliveryReviewEnabled !== true) {
            appendOwnerManagementMessage({ projectId, eventId: `delivery-scope:${link.planning_task_id}`, role: 'assistant', kind: 'attention', ...(subject.targetTaskId ? { taskId: subject.targetTaskId } : {}), content: '成果已保留。此前管理委托未包含完整成果读取；请在原对话确认新增范围，不会自动消耗旧许可。' })
            continue
          }
          if (readOwnerPlanningSnapshot(link.planning_task_id)?.context.conversation?.deliveryReview?.qualityDecisionVersion === 1 && view.delegation?.qualityDecisionEnabled !== true) {
            appendOwnerManagementMessage({ projectId, eventId: `quality-scope:${link.planning_task_id}`, role: 'assistant', kind: 'attention', ...(subject.targetTaskId ? { taskId: subject.targetTaskId } : {}), content: '完整成果和独立检查已保留，旧管理委托不含质量决定；确认管理范围后再继续，不消耗旧额度。' })
            continue
          }
          if (subject.conversationMessageId && view.delegation?.conversationEnabled !== true) {
            appendOwnerManagementMessage({ projectId, eventId: `conversation-scope:${link.planning_task_id}`, role: 'assistant', kind: 'attention', ...(subject.targetTaskId ? { taskId: subject.targetTaskId } : {}), content: '消息已保存。此前管理委托不包含持续对话调用，请先在这里重新确认管理范围；不会自动使用旧额度发送。' })
            continue
          }
          try {
            const { startDelegatedOwnerPlanningTask } = await import('./controlled-project-task-service')
            const started = await startDelegatedOwnerPlanningTask(link.planning_task_id)
            if (!['queued', 'running', 'completed'].includes(started.status)) throw new Error('管理运行尚未成功启动，请核对已有记录')
            const responseRun = Boolean(subject.conversationMessageId)
            appendOwnerManagementTrace({ eventId: `owner-run:${link.planning_task_id}:${started.status}`, projectId, ...(subject.targetTaskId ? { taskId: subject.targetTaskId } : {}), phase: responseRun ? 'owner_response' : 'assignment_run', state: started.status === 'queued' ? 'queued' : started.status === 'completed' ? 'completed' : 'started', createdAt: Date.now(), detailCode: started.status === 'completed' ? 'result_ready' : 'provider_pending' })
            appendOwnerManagementMessage({ projectId, eventId: `delegation-start:${view.delegation!.id}:${link.planning_task_id}`, role: 'assistant', kind: 'management_progress', ...(subject.targetTaskId ? { taskId: subject.targetTaskId } : {}), planningTaskId: link.planning_task_id, content: started.status === 'queued' ? '已在你确认的管理额度内排队，等待可用运行位置。' : started.status === 'completed' ? '本次管理请求已完成，正在整理方案或需要与你商量的问题。' : responseRun ? '我正在处理你的补充或最新项目进展；完成后会在这里回应。' : '已在你确认的管理额度内启动规划。我会继续整理方案，有需要决定的问题会在这里与你商量。' })
          } catch (cause) {
            console.warn('[Owner管理] 委托调用需要核对', cause)
            appendOwnerManagementMessage({ projectId, eventId: `delegation:${view.delegation!.id}:${link.planning_task_id}`, role: 'assistant', kind: 'attention', content: '管理调用尚未继续，当前来源、额度或运行需要核对。原目标与记录已保留，不会自动重试已发送请求。' })
          }
          break
        }
      } while (!stopped && pending.has(projectId))
    })().catch(cause => console.warn('[Owner管理] 对账失败，保留待处理事件', projectId, cause)).finally(() => { inFlight.delete(projectId); if (!stopped && pending.has(projectId)) run(projectId) })
  }
  const unsubscribeChanges = onChanged ? onOwnerManagementChanged(onChanged) : () => {}
  const unsubscribe = onOwnerManagementWake(run)
  const unsubscribeSchedule = onOwnerAutonomousScheduleWake(run)
  const timer = setInterval(() => { for (const project of store.listProjects()) run(project.id) }, 30_000)
  timer.unref?.()
  for (const project of store.listProjects()) run(project.id)
  return () => { stopped = true; clearInterval(timer); unsubscribe(); unsubscribeSchedule(); unsubscribeChanges() }
}
