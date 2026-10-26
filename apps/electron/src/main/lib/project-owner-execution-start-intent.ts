import type { MaterializeOwnerTasksRequest, OwnerExecutionGrant, OwnerExecutionPreparationInput, OwnerExecutionStartIntent, OwnerExecutionStartIntentRequest, OwnerManagementMessage, ProjectOwnerGoalSubject, ProjectOwnerPlanDraft } from '@gravitas/shared'
import { getProjectOwnerGoalDraft } from './project-owner-goal-service'
import { confirmProjectOwnerPlanDraft, getProjectOwnerPlanDraft, getProjectOwnerPlanningContext } from './project-owner-plan-service'
import { assertLocalActorEnabled } from './project-owner-plan-service'
import { getProjectDb } from './project-sqlite-store'
import { ownerExecutionHash, ownerExecutionObject, parseOwnerExecutionInput, parseOwnerExecutionSubject } from './project-owner-execution-source'
import { getOwnerExecutionPreparation, previewOwnerExecutionPreparation, saveOwnerExecutionPreparation } from './project-owner-execution-preparation'
import { getOwnerTaskMaterialization, materializeOwnerTasks, previewOwnerTaskMaterialization } from './project-owner-task-materialization'
import { launchOwnerPreparedExecution } from './project-owner-execution-launch'
import { confirmOwnerExecutionGrantRevoke, getOwnerExecutionGrant, previewOwnerExecutionGrantRevoke } from './project-owner-execution-grant-issue'
import { appendOwnerManagementMessage, getOwnerManagementMessage, getOwnerManager, recordOwnerManagementStartAccepted, recordOwnerManagementStartBlocked } from './project-owner-management-store'
import { getPilotPolicy } from './project-pilot-policy'
import { getOwnerManagementDelegation } from './project-owner-management-delegation'

interface IntentRow { id: string; project_id: string; task_id: string | null; payload: string; integrity_hash: string; state: string; grant_id: string | null; created_at: number; recovery_status: string }
const key = (subject: ProjectOwnerGoalSubject) => subject.taskId ?? null
interface StartIntentDependencies { launch: (request: MaterializeOwnerTasksRequest) => Promise<OwnerExecutionGrant> }
const production: StartIntentDependencies = { launch: request => launchOwnerPreparedExecution(request) }
const attentionEventId = (intentId: string) => `execution-start-recovery:${intentId}:attention`
interface StartIntentRef { intentId: string; projectId: string; taskId?: string; expectedGoalRevision?: number }
function needsGrantReconciliation(cause: unknown): boolean {
  return cause instanceof Error && /待核对记录|核对原授权/.test(cause.message)
}

function safeRecoveryErrorDetail(cause: unknown): string {
  if (!(cause instanceof Error)) return '未知异常'
  return cause.message
    .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk|key|token)[-_][A-Za-z0-9_-]{12,}\b/gi, '[凭证已隐藏]')
    .replace(/(api[_-]?key|authorization|access[_-]?token)\s*[:=]\s*[^,;\s]+/gi, '$1=[已隐藏]')
    .replace(/(?:\/Users\/[^\s:]+|\/tmp\/[^\s:]+|[A-Z]:\\[^\s:]+)/g, '[本地路径]')
    .slice(0, 220) || '未知异常'
}

function reportRecoveryAttention(intent: StartIntentRef, cause: unknown): boolean {
  const manager = getOwnerManager(intent.projectId)
  if (!manager) return false
  const message = cause instanceof Error ? cause.message : ''
  const detail = safeRecoveryErrorDetail(cause)
  const content = needsGrantReconciliation(cause)
    ? '已有执行授权或授权状态需要核对，因此我没有再次派发，也不会自动重试。原授权与执行记录已保留；请先核对原授权，再决定是否继续。'
    : manager.status === 'paused'
      ? '我保留了这次已确认的工作范围。项目Owner目前处于暂停状态，因此没有启动员工；恢复项目管理后我会先核对原确认，再继续。'
      : /目标或方案来源已变化|方案版本已变化|执行配置已变化/.test(message)
        ? `开始前我发现目标、方案或执行边界已变化，因此没有启动员工。${detail}。原确认和任务记录都已保留；请在当前方案下重新确认结果与范围。`
        : `启动没有完成，且不会自动重试。原因：${detail}。原确认和已有记录已保留；请核对原因后再决定是否重新确认启动。`
  const eventId = attentionEventId(intent.intentId)
  const exists = getProjectDb().prepare('SELECT 1 FROM project_owner_management_messages WHERE project_id=? AND event_id=? LIMIT 1').get(intent.projectId, eventId)
  if (exists) {
    const diagnosticEventId = `${eventId}:diagnostic`
    const diagnosticExists = getProjectDb().prepare('SELECT 1 FROM project_owner_management_messages WHERE project_id=? AND event_id=? LIMIT 1').get(intent.projectId, diagnosticEventId)
    if (diagnosticExists || needsGrantReconciliation(cause) || manager.status === 'paused') return false
    appendOwnerManagementMessage({ projectId: intent.projectId, eventId: diagnosticEventId, role: 'assistant', kind: 'attention', ...(intent.taskId ? { taskId: intent.taskId } : {}), content: `补充核查：上次启动未完成，原因是${detail}。该启动意图已暂停自动重试；核对后可重新确认启动。` })
    return true
  }
  recordOwnerManagementStartBlocked(intent.projectId, intent.intentId, intent.expectedGoalRevision ?? getProjectOwnerGoalDraft(intent.projectId, intent.taskId)?.revision ?? 0, content, intent.taskId)
  return true
}

function reportRecoveryResolved(intent: OwnerExecutionStartIntent): void {
  const exists = getProjectDb().prepare('SELECT 1 FROM project_owner_management_messages WHERE project_id=? AND event_id=? LIMIT 1').get(intent.projectId, attentionEventId(intent.intentId))
  if (!exists) return
  appendOwnerManagementMessage({ projectId: intent.projectId, eventId: `execution-start-recovery:${intent.intentId}:resolved`, role: 'assistant', kind: 'management_progress', ...(intent.taskId ? { taskId: intent.taskId } : {}), content: '上次启动核对已经完成。我已按原来确认的结果与边界继续组织工作，你不需要重复确认。' })
}

function coalesceEquivalentPendingIntents(completed: OwnerExecutionStartIntent, grant: OwnerExecutionGrant): void {
  const rows = getProjectDb().prepare("SELECT * FROM project_owner_execution_start_intents WHERE project_id=? AND task_id IS ? AND state='pending' AND recovery_status='pending' ORDER BY created_at,id")
    .all(completed.projectId, completed.taskId ?? null) as IntentRow[]
  const compactInput = (input: OwnerExecutionPreparationInput) => {
    const { requestId: _requestId, expiresAt: _expiresAt, ...scope } = input
    return scope
  }
  for (const row of rows) {
    try {
      const duplicate = readRow(row)
      if (duplicate.createdAt < completed.createdAt
        || duplicate.expectedGoalRevision !== completed.expectedGoalRevision
        || duplicate.expectedPlanRevision !== completed.expectedPlanRevision
        || duplicate.planFingerprint !== completed.planFingerprint
        || duplicate.contextFingerprint !== completed.contextFingerprint
        || duplicate.input.expiresAt < grant.budget.expiresAt
        || ownerExecutionHash(compactInput(duplicate.input)) !== ownerExecutionHash(compactInput(completed.input))) continue
      getProjectDb().prepare("UPDATE project_owner_execution_start_intents SET state='completed',grant_id=? WHERE id=? AND state='pending' AND recovery_status='pending'")
        .run(grant.grantId, duplicate.intentId)
      reportRecoveryResolved({ ...duplicate, state: 'completed', grantId: grant.grantId })
    } catch (cause) {
      console.warn('[Owner执行] 重复启动确认未能安全归并，保留原记录', row.project_id, row.id, cause)
    }
  }
}

function readRow(row: IntentRow): OwnerExecutionStartIntent {
  const value = ownerExecutionObject(JSON.parse(row.payload), ['schemaVersion', 'intentId', 'projectId', 'taskId', 'expectedGoalRevision', 'expectedPlanRevision', 'planFingerprint', 'contextFingerprint', 'input', 'createdAt', 'integrityHash'])
  const { integrityHash, ...body } = value
  const subject = parseOwnerExecutionSubject({ projectId: value.projectId, ...(value.taskId === undefined ? {} : { taskId: value.taskId }) })
  const input = parseOwnerExecutionInput(value.input)
  if (value.schemaVersion !== 1 || value.intentId !== row.id || subject.projectId !== row.project_id || key(subject) !== row.task_id
    || input.expectedGoalRevision !== value.expectedGoalRevision || input.expectedPlanRevision !== value.expectedPlanRevision
    || typeof value.planFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.planFingerprint)
    || typeof value.contextFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.contextFingerprint)
    || !Number.isSafeInteger(value.createdAt) || row.created_at !== value.createdAt
    || integrityHash !== row.integrity_hash || integrityHash !== ownerExecutionHash(body)
    || (row.state !== 'pending' && row.state !== 'completed') || (row.recovery_status !== 'pending' && row.recovery_status !== 'needs_attention')
    || (row.state === 'completed' && (typeof row.grant_id !== 'string' || !row.grant_id.trim())))
    throw new Error('Owner启动确认意图损坏，请保留记录核查')
  return { ...subject, intentId: row.id, expectedGoalRevision: value.expectedGoalRevision as number, expectedPlanRevision: value.expectedPlanRevision as number,
    planFingerprint: value.planFingerprint as string, contextFingerprint: value.contextFingerprint as string, input, createdAt: row.created_at,
    state: row.state, ...(row.grant_id ? { grantId: row.grant_id } : {}), integrityHash: row.integrity_hash }
}

function parseRequest(raw: unknown): OwnerExecutionStartIntentRequest {
  const value = ownerExecutionObject(raw, ['projectId', 'taskId', 'intentId', 'expectedGoalRevision', 'expectedPlanRevision', 'planFingerprint', 'contextFingerprint', 'input'])
  const subject = parseOwnerExecutionSubject({ projectId: value.projectId, ...(value.taskId === undefined ? {} : { taskId: value.taskId }) })
  if (typeof value.intentId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.intentId)) throw new Error('Owner启动确认意图ID无效')
  for (const field of ['expectedGoalRevision', 'expectedPlanRevision'] as const) if (!Number.isSafeInteger(value[field]) || Number(value[field]) < 1) throw new Error('Owner启动确认意图版本无效')
  for (const field of ['planFingerprint', 'contextFingerprint'] as const) if (typeof value[field] !== 'string' || !/^[a-f0-9]{64}$/.test(value[field])) throw new Error('Owner启动确认意图来源指纹无效')
  const input = parseOwnerExecutionInput(value.input)
  if (input.expectedGoalRevision !== value.expectedGoalRevision || input.expectedPlanRevision !== value.expectedPlanRevision) throw new Error('Owner启动确认意图与执行边界版本不一致')
  return { ...subject, intentId: value.intentId, expectedGoalRevision: value.expectedGoalRevision as number, expectedPlanRevision: value.expectedPlanRevision as number,
    planFingerprint: value.planFingerprint as string, contextFingerprint: value.contextFingerprint as string, input }
}

function supersedeDeliveredFeedbackBatch(subject: ProjectOwnerGoalSubject, plan: ProjectOwnerPlanDraft | null, materializationId: string): boolean {
  const assessment = plan?.proposal.deliveryFeedbackAssessment
  if (!plan || plan.origin !== 'generated' || !plan.sourceRun || !assessment) return false
  const message = getOwnerManagementMessage(subject.projectId, assessment.messageId)
  if (!message || message.role !== 'assistant' || message.kind !== 'delivery' || message.taskId !== subject.taskId || !message.delivery) return false
  const matches = message.delivery.items.filter(item => item.artifactHash === assessment.artifactHash
    && (assessment.stepKey === undefined || item.stepKey === assessment.stepKey))
  const grantId = /^owner-delivery:([^:]+):[a-f0-9]{64}$/.exec(message.eventId)?.[1]
  if (matches.length !== 1 || !grantId) return false
  const grant = getOwnerExecutionGrant(subject)
  if (!grant || grant.grantId !== grantId || grant.materializationId !== materializationId || grant.taskId !== subject.taskId) return false
  if (grant.state === 'active') {
    const preview = previewOwnerExecutionGrantRevoke(subject, { grantId })
    if (preview.blockers.length) throw new Error(`原交付仍有未收敛的执行或费用状态，暂不能开始修订：${preview.blockers.join('；')}`)
    const closed = confirmOwnerExecutionGrantRevoke(subject, { grantId, confirmedFingerprint: preview.fingerprint })
    if (closed.state !== 'paused') throw new Error('原交付授权未能安全暂停；修订工作尚未开始')
  } else if (!['paused', 'archived'].includes(grant.state)) return false
  return true
}

function getConfirmedPreparationInput(intent: OwnerExecutionStartIntent, plan: ProjectOwnerPlanDraft): OwnerExecutionPreparationInput {
  const subject = { projectId: intent.projectId, ...(intent.taskId ? { taskId: intent.taskId } : {}) }
  const planRevision = plan.revision
  const requestId = planRevision === intent.expectedPlanRevision ? intent.input.requestId : `owner-start-preparation:${intent.intentId}:${planRevision}`
  const current = getOwnerExecutionPreparation(subject), existing = current.preparation
  if (existing?.input.requestId === requestId && existing.input.expectedPlanRevision === planRevision) return existing.input
  const policy = getPilotPolicy(intent.projectId)
  const roleAssignments = intent.input.roleAssignments?.slice().sort((left, right) => left.roleKey.localeCompare(right.roleKey))
  const selectedRoleKeys = (plan.revision === intent.expectedPlanRevision || plan.revision === intent.expectedPlanRevision + 1)
    && plan.planFingerprint === intent.planFingerprint
    ? [...new Set(plan.proposal.steps
      .filter(step => intent.input.selectedStepKeys.includes(step.key))
      .map(step => step.roleKey))].sort()
    : []
  // 修复旧版本按方案步骤顺序选择executor、但按roleKey冻结岗位映射的启动意图。
  // 仅在岗位集合与当前确认方案完全一致且原executor仍在映射内时，派生兼容输入；不改写原始确认记录。
  const canNormalizeLegacyExecutor = Boolean(roleAssignments?.length
    && selectedRoleKeys.length === roleAssignments.length
    && roleAssignments.every((assignment, index) => assignment.roleKey === selectedRoleKeys[index])
    && roleAssignments.some(assignment => assignment.employeeId === intent.input.executorEmployeeId))
  const normalizedInput = canNormalizeLegacyExecutor && roleAssignments
    ? { ...intent.input, roleAssignments, executorEmployeeId: roleAssignments[0]!.employeeId }
    : intent.input
  return {
    ...normalizedInput,
    requestId,
    expectedPreparationRevision: current.revision,
    expectedPolicyRevision: policy?.state === 'paused' ? policy.revision : intent.input.expectedPolicyRevision,
    expectedPlanRevision: planRevision,
  }
}

export function saveOwnerExecutionStartIntent(raw: unknown): OwnerExecutionStartIntent {
  assertLocalActorEnabled()
  const request = parseRequest(raw), db = getProjectDb()
  const existing = db.prepare('SELECT * FROM project_owner_execution_start_intents WHERE id=?').get(request.intentId) as IntentRow | undefined
  if (existing) {
    const saved = readRow(existing)
    const currentPlan = getProjectOwnerPlanDraft(request.projectId, request.taskId)
    const sameConfirmedSuccessor = currentPlan?.state === 'confirmed' && currentPlan.revision === saved.expectedPlanRevision + 1
      && currentPlan.planFingerprint === saved.planFingerprint
    const normalizedInput = sameConfirmedSuccessor ? { ...request.input, expectedPlanRevision: saved.expectedPlanRevision } : request.input
    if (saved.projectId !== request.projectId || saved.taskId !== request.taskId || saved.expectedGoalRevision !== request.expectedGoalRevision
      || (saved.expectedPlanRevision !== request.expectedPlanRevision && !(sameConfirmedSuccessor && request.expectedPlanRevision === currentPlan?.revision))
      || saved.planFingerprint !== request.planFingerprint || saved.contextFingerprint !== request.contextFingerprint
      || ownerExecutionHash(saved.input) !== ownerExecutionHash(normalizedInput)) throw new Error('Owner启动确认意图ID已绑定其他范围')
    return saved
  }
  const goal = getProjectOwnerGoalDraft(request.projectId, request.taskId)
  const plan = getProjectOwnerPlanDraft(request.projectId, request.taskId)
  const context = getProjectOwnerPlanningContext(request.projectId, request.taskId)
  if (!goal || goal.revision !== request.expectedGoalRevision || !plan || !['proposed', 'confirmed'].includes(plan.state) || plan.revision !== request.expectedPlanRevision
    || plan.planFingerprint !== request.planFingerprint || plan.contextFingerprint !== request.contextFingerprint
    || context.goal.revision !== request.expectedGoalRevision || context.fingerprint !== request.contextFingerprint)
    throw new Error('方案或目标来源已变化；未记录执行确认')
  if (request.input.selectedStepKeys.some(stepKey => !plan.proposal.steps.some(step => step.key === stepKey))
    || !request.input.selectedStepKeys.length || new Set(request.input.selectedStepKeys).size !== request.input.selectedStepKeys.length)
    throw new Error('Owner启动确认选择了当前方案中不存在的成果')
  const createdAt = Date.now()
  const body = { schemaVersion: 1 as const, intentId: request.intentId, projectId: request.projectId, ...(request.taskId ? { taskId: request.taskId } : {}),
    expectedGoalRevision: request.expectedGoalRevision, expectedPlanRevision: request.expectedPlanRevision, planFingerprint: request.planFingerprint,
    contextFingerprint: request.contextFingerprint, input: request.input, createdAt }
  const integrityHash = ownerExecutionHash(body)
  db.prepare('INSERT INTO project_owner_execution_start_intents(id,project_id,task_id,payload,integrity_hash,state,grant_id,created_at) VALUES(?,?,?,?,?,?,NULL,?)')
    .run(request.intentId, request.projectId, request.taskId ?? null, JSON.stringify({ ...body, integrityHash }), integrityHash, 'pending', createdAt)
  const row = db.prepare('SELECT * FROM project_owner_execution_start_intents WHERE id=?').get(request.intentId) as IntentRow
  return readRow(row)
}

export function completeOwnerExecutionStartIntent(raw: unknown): { intentId: string; state: 'completed' } {
  assertLocalActorEnabled()
  const value = ownerExecutionObject(raw, ['projectId', 'taskId', 'intentId', 'grantId'])
  const subject = parseOwnerExecutionSubject({ projectId: value.projectId, ...(value.taskId === undefined ? {} : { taskId: value.taskId }) })
  if (typeof value.intentId !== 'string' || !value.intentId.trim() || typeof value.grantId !== 'string' || !value.grantId.trim()) throw new Error('Owner启动确认完成回执无效')
  const db = getProjectDb(), row = db.prepare('SELECT * FROM project_owner_execution_start_intents WHERE id=? AND project_id=? AND task_id IS ?').get(value.intentId, subject.projectId, subject.taskId ?? null) as IntentRow | undefined
  if (!row) throw new Error('Owner启动确认意图不存在')
  const saved = readRow(row)
  if (saved.state === 'completed') {
    if (saved.grantId !== value.grantId) throw new Error('Owner启动确认意图已绑定其他授权')
    return { intentId: saved.intentId, state: 'completed' }
  }
  const plan = getProjectOwnerPlanDraft(subject.projectId, subject.taskId)
  const preparationRequestId = plan ? getConfirmedPreparationInput(saved, plan).requestId : ''
  const grant = getOwnerExecutionGrant(subject), materialization = getOwnerTaskMaterialization(subject).materialization
  // launch() 可以在同一轮调度中派发员工；若运行状态随后变为暂停/需核对，
  // 这不应撤销已经发生的启动确认。这里核验授权与冻结任务批次的绑定即可。
  if (!grant || grant.grantId !== value.grantId || !materialization
    || grant.materializationId !== materialization.id || grant.materializationIntegrityHash !== materialization.integrityHash
    || materialization.input.requestId !== `owner-start:${saved.intentId}`
    || materialization.preview.preparation.input.requestId !== preparationRequestId)
    throw new Error('启动意图不能绑定不匹配的任务批次或执行授权')
  db.prepare("UPDATE project_owner_execution_start_intents SET state='completed',grant_id=? WHERE id=? AND state='pending'").run(value.grantId, saved.intentId)
  return { intentId: saved.intentId, state: 'completed' }
}

export function listPendingOwnerExecutionStartIntents(): OwnerExecutionStartIntent[] {
  const rows = getProjectDb().prepare("SELECT * FROM project_owner_execution_start_intents WHERE state='pending' AND recovery_status='pending' ORDER BY created_at,id").all() as IntentRow[]
  return rows.map(readRow)
}

const recoveries = new Map<string, Promise<OwnerExecutionGrant>>()
/** 崩溃恢复只重放已持久化的用户意图，并逐个重验方案、准备、任务、许可与调度。 */
export function resumeOwnerExecutionStartIntent(intentId: string, expectedSubject?: ProjectOwnerGoalSubject, dependencies: StartIntentDependencies = production): Promise<OwnerExecutionGrant> {
  const active = recoveries.get(intentId)
  if (active) return active
  const recovery = (async () => {
    const row = getProjectDb().prepare('SELECT * FROM project_owner_execution_start_intents WHERE id=?').get(intentId) as IntentRow | undefined
    if (!row) throw new Error('Owner启动确认意图不存在')
    const intent = readRow(row)
    const subject = { projectId: intent.projectId, ...(intent.taskId ? { taskId: intent.taskId } : {}) }
    if (expectedSubject && (expectedSubject.projectId !== subject.projectId || expectedSubject.taskId !== subject.taskId)) throw new Error('Owner启动确认意图与当前项目不匹配')
    if (intent.state === 'completed') {
      const grant = getOwnerExecutionGrant(subject)
      if (!grant || grant.grantId !== intent.grantId) throw new Error('已完成启动意图的执行授权缺失或不匹配')
      return grant
    }
    assertLocalActorEnabled()
    const manager = getOwnerManager(subject.projectId)
    if (!manager || manager.status !== 'active') throw new Error('项目Owner当前已暂停；启动意图保持待处理')
    const context = getProjectOwnerPlanningContext(subject.projectId, subject.taskId)
    const goal = getProjectOwnerGoalDraft(subject.projectId, subject.taskId)
    let plan = getProjectOwnerPlanDraft(subject.projectId, subject.taskId)
    if (!goal || goal.revision !== intent.expectedGoalRevision || context.fingerprint !== intent.contextFingerprint || !plan
      || plan.planFingerprint !== intent.planFingerprint || plan.contextFingerprint !== intent.contextFingerprint
      || (plan.revision !== intent.expectedPlanRevision && plan.revision !== intent.expectedPlanRevision + 1))
      throw new Error('启动确认所绑定的目标或方案来源已变化；执行已停止，请重新审阅')
    if (plan.state === 'proposed') {
      if (plan.revision !== intent.expectedPlanRevision) throw new Error('待确认方案版本已变化；执行已停止')
      plan = confirmProjectOwnerPlanDraft(subject.projectId, intent.expectedGoalRevision, intent.expectedPlanRevision, subject.taskId)
    }
    const autonomousGrant = getOwnerManagementDelegation(subject.projectId, subject.taskId)
    const ownerConfirmed = plan.actor === 'system:owner-manager' && autonomousGrant.state === 'active' && autonomousGrant.delegation?.autonomousExecution === true
    if (plan.state !== 'confirmed' || (plan.actor !== 'local-user' && !ownerConfirmed) || plan.planFingerprint !== intent.planFingerprint)
      throw new Error('启动确认对应方案未能核实；执行已停止')
    const materializationView = getOwnerTaskMaterialization(subject)
    const previousMaterialization = materializationView.materialization
    const replacingPreviousBatch = Boolean(previousMaterialization && previousMaterialization.input.requestId !== `owner-start:${intent.intentId}`
      && supersedeDeliveredFeedbackBatch(subject, plan, previousMaterialization.id))
    const input = getConfirmedPreparationInput(intent, plan)
    const preparationView = getOwnerExecutionPreparation(subject)
    let preparation = preparationView.preparation
    if (preparation) {
      if (preparation.input.requestId !== input.requestId || ownerExecutionHash(preparation.input) !== ownerExecutionHash(input)) {
        if (getOwnerTaskMaterialization(subject).materialization && !replacingPreviousBatch)
          throw new Error('已有任务登记绑定其他执行准备；启动意图不能覆盖，请核对后处理')
        const preview = previewOwnerExecutionPreparation(subject, input)
        preparation = saveOwnerExecutionPreparation(subject, input, preview.previewFingerprint)
      }
    } else {
      if (preparationView.revision !== input.expectedPreparationRevision || preparationView.policyRevision !== input.expectedPolicyRevision)
        throw new Error('启动确认后的执行配置已变化；执行已停止，请重新审阅')
      const preview = previewOwnerExecutionPreparation(subject, input)
      preparation = saveOwnerExecutionPreparation(subject, input, preview.previewFingerprint)
    }
    const latestMaterializationView = getOwnerTaskMaterialization(subject)
    let materialization = materializationView.materialization
    if (materialization) {
      if (materialization.input.requestId !== `owner-start:${intent.intentId}` || materialization.preview.preparation.id !== preparation.id)
        if (!replacingPreviousBatch) throw new Error('存在其他任务登记批次，启动意图不能覆盖；请核对后处理')
        else materialization = null
    } else {
      materialization = null
    }
    if (!materialization) {
      const materialInput = {
        requestId: `owner-start:${intent.intentId}`,
        expectedMaterializationRevision: latestMaterializationView.revision,
        expectedPreparationId: preparation.id,
        expectedPreparationRevision: preparation.revision,
        expectedPreparationHash: preparation.integrityHash,
        expectedPolicyRevision: preparation.policyRevision,
      }
      const preview = previewOwnerTaskMaterialization(subject, materialInput)
      materialization = materializeOwnerTasks(subject, materialInput, preview.previewFingerprint)
    }
    const grant = await dependencies.launch({ ...subject, input: materialization.input, previewFingerprint: materialization.preview.previewFingerprint })
    completeOwnerExecutionStartIntent({ ...subject, intentId, grantId: grant.grantId })
    // 确认后必须立刻在同一次对话出现可见回应，否则界面只显示空白，像被中断。
    recordOwnerManagementStartAccepted(subject.projectId, intent.intentId, intent.expectedGoalRevision, subject.taskId)
    reportRecoveryResolved(intent)
    return grant
  })()
  recoveries.set(intentId, recovery)
  void recovery.finally(() => { if (recoveries.get(intentId) === recovery) recoveries.delete(intentId) }).catch(() => {})
  return recovery
}

/** 启动扫描只接手pending确认；单个失败保留原记录并继续处理其他项目。 */
export async function recoverPendingOwnerExecutionStartIntents(projectId?: string, dependencies: StartIntentDependencies = production): Promise<void> {
  const rows = getProjectDb().prepare("SELECT * FROM project_owner_execution_start_intents WHERE state='pending' AND recovery_status='pending' AND (? IS NULL OR project_id=?) ORDER BY created_at,id").all(projectId ?? null, projectId ?? null) as IntentRow[]
  for (const row of rows) {
    const manager = getOwnerManager(row.project_id)
    if (!manager || manager.status !== 'active') continue
    let intent: OwnerExecutionStartIntent
    try { intent = readRow(row) }
    catch (cause) {
      const expectedGoalRevision = (() => { try { const value = (JSON.parse(row.payload) as { expectedGoalRevision?: unknown }).expectedGoalRevision; return typeof value === 'number' ? value : undefined } catch { return undefined } })()
      const invalidIntent: StartIntentRef = { intentId: row.id, projectId: row.project_id, ...(row.task_id ? { taskId: row.task_id } : {}), ...(expectedGoalRevision === undefined ? {} : { expectedGoalRevision }) }
      try {
        reportRecoveryAttention(invalidIntent, cause)
        getProjectDb().prepare("UPDATE project_owner_execution_start_intents SET recovery_status='needs_attention' WHERE id=? AND state='pending' AND recovery_status='pending'").run(row.id)
        console.warn('[Owner执行] 启动确认意图损坏，已隔离并继续恢复其他意图', row.project_id, row.id, cause)
      } catch (notificationError) {
        console.warn('[Owner执行] 损坏的启动确认意图暂无法写入对话提醒，将保留待核对状态', row.project_id, row.id, notificationError)
      }
      continue
    }
    try {
      const grant = await resumeOwnerExecutionStartIntent(intent.intentId, undefined, dependencies)
      const completedIntent = readRow(getProjectDb().prepare('SELECT * FROM project_owner_execution_start_intents WHERE id=?').get(intent.intentId) as IntentRow)
      if (completedIntent.state === 'completed') coalesceEquivalentPendingIntents(completedIntent, grant)
    }
    catch (cause) {
      try {
        const reported = reportRecoveryAttention(intent, cause)
        // 启动意图失败一律暂停自动恢复；由用户看清原因后决定是否重新确认，避免重复触发不确定的远端请求。
        getProjectDb().prepare("UPDATE project_owner_execution_start_intents SET recovery_status='needs_attention' WHERE id=? AND state='pending'").run(intent.intentId)
        if (reported) console.warn('[Owner执行] 启动确认恢复暂未完成，已在项目对话中告知用户', intent.projectId, cause)
      } catch (notificationError) {
        console.warn('[Owner执行] 启动确认恢复提醒写入失败，意图保持待处理以便后续重试', intent.projectId, intent.intentId, notificationError)
      }
    }
  }
}
