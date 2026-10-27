import { supportsOwnerExecutionKind, supportsOwnerMixedTeam } from '@gravitas/shared'
/** 将Owner方案接入现有团队；成果反馈形成的新方案须经用户确认后才启动。 */
import { createHash, randomUUID } from 'node:crypto'
import type { OwnerExecutionPreparationInput, OwnerManagementEvent } from '@gravitas/shared'
import { getProjectOwnerPlanDraft, getProjectOwnerPlanningContext } from './project-owner-plan-service'
import { getOwnerRuntimeBinding } from './project-owner-runtime-binding'
import { getCurrentOwnerExecutionAssignmentContext } from './project-owner-execution-assignment-context-service'
import { OwnerExecutionAssignmentCapabilityError, ownerAssignmentContextMatchesApprovalTransition, parseOwnerExecutionAssignmentContext } from './project-owner-execution-assignment-context'
import { listOwnerExecutionAssignmentRuns, prepareOwnerExecutionAssignment } from './project-owner-execution-assignment-service'
import { getOwnerExecutionPreparation } from './project-owner-execution-preparation'
import { getOwnerManagementDelegation } from './project-owner-management-delegation'
import { getOwnerPlanningRunOutcome, getOwnerPlanningRunReceipt } from './project-owner-planning-run-service'
import { readOwnerPlanningSnapshot, resolveOwnerPlanningTask } from './project-owner-planning-source'
import { appendOwnerManagementMessage, appendOwnerManagementTrace, listPendingOwnerManagementEvents, recordOwnerManagementAssignmentProtocolRetry } from './project-owner-management-store'
import { getPilotPolicy } from './project-pilot-policy'
import { getOwnerTeamWorkspaceProposal } from './project-owner-team-workspace-access'
import { ensureOwnerDefaultTeam } from './project-owner-default-team'
import { saveOwnerExecutionStartIntent } from './project-owner-execution-start-intent'
import * as store from './project-sqlite-store'

export function isRecoverableOwnerAssignmentRejection(detail: string): boolean {
  // 第三种是“结构/字段不合规”：方案本身有效，原预算内重排一次通常即可修复。
  return ['Owner安排必须由未承担执行岗位的独立评审员审核', 'Owner人员安排必须完整覆盖所选步骤的全部岗位', 'Owner人员安排提案格式无效或夹带未授权字段'].includes(detail)
}

export { ownerAssignmentFailureReason } from './project-owner-failure-reason'
import { ownerAssignmentFailureReason } from './project-owner-failure-reason'

/** 仅完整、成功终态且仅被已知岗位覆盖或独立评审协议拒绝的安排，允许在原预算内续跑一次。 */
export function queueOwnerAssignmentProtocolRetry(projectId: string, taskId: string | undefined, executionId: string): boolean {
  const outcome = getOwnerPlanningRunOutcome(executionId)
  const receipt = outcome ? getOwnerPlanningRunReceipt(outcome.receiptId) : null
  if (!outcome || outcome.state !== 'failed' || !isRecoverableOwnerAssignmentRejection(outcome.detail)
    || !receipt || receipt.projectId !== projectId || receipt.executionId !== executionId || receipt.purpose !== 'owner_execution_assignment'
    || !receipt.validTerminal || receipt.stopped || receipt.error || receipt.runtimeResult?.subtype !== 'success' || receipt.runtimeResult.finish_reason !== 'stop'
    || !receipt.usage || !Number.isSafeInteger(receipt.usage.inputTokens) || receipt.usage.inputTokens === null || receipt.usage.inputTokens < 0
    || !Number.isSafeInteger(receipt.usage.outputTokens) || receipt.usage.outputTokens === null || receipt.usage.outputTokens < 0) return false
  const source = readOwnerPlanningSnapshot(receipt.planningTaskId)
  const plan = getProjectOwnerPlanDraft(projectId, taskId)
  const delegation = getOwnerManagementDelegation(projectId, taskId)
  if (!source || source.link.projectId !== projectId || source.link.targetTaskId !== taskId || !source.assignmentContext
    || !plan || plan.state !== 'confirmed' || source.link.planRevision < plan.revision - 1 || source.link.planRevision > plan.revision
    || delegation.state !== 'active' || !delegation.delegation?.autonomousExecution) return false
  const binding = getOwnerRuntimeBinding(projectId)
  const planningContext = getProjectOwnerPlanningContext(projectId, taskId)
  if (!binding) return false
  const current = getCurrentOwnerExecutionAssignmentContext({ projectId, ...(taskId ? { taskId } : {}) }, {
    requestId: `protocol-retry-check:${executionId}`, expectedBindingRevision: binding.revision,
    expectedGoalRevision: planningContext.goal.revision, expectedPlanRevision: plan.revision,
    expectedPlanFingerprint: plan.planFingerprint, expectedContextFingerprint: planningContext.fingerprint,
  })
  if (source.assignmentContext.contextFingerprint !== current.context.contextFingerprint
    && !ownerAssignmentContextMatchesApprovalTransition(source.assignmentContext, current.context)) return false
  const previousRetry = store.getProjectDb().prepare("SELECT 1 FROM project_owner_management_events WHERE project_id = ? AND json_extract(payload, '$.kind') = 'assignment_recheck' AND json_extract(payload, '$.taskId') IS ? AND json_extract(payload, '$.sourceRevision') = ? AND json_extract(payload, '$.sourceId') LIKE 'protocol-retry:%' LIMIT 1").get(projectId, taskId ?? null, plan.revision)
  if (previousRetry) return false
  const retry = recordOwnerManagementAssignmentProtocolRetry(projectId, plan.revision, executionId, taskId)
  appendOwnerManagementMessage({ projectId, eventId: `assignment-protocol-retry-progress:${executionId}`, ...(taskId ? { taskId } : {}), role: 'assistant', kind: 'management_progress', planningTaskId: receipt.planningTaskId, content: '上一条团队安排有完整运行记录，但未通过岗位覆盖或独立评审员校验。我已在当前项目授权和预算内重新安排一次；原记录保留，不会循环重试。' })
  return retry.kind === 'assignment_recheck'
}

export function prepareOwnerManagementAssignment(event: OwnerManagementEvent): void {
  if (event.kind === 'delegation_confirmed') {
    const view = getOwnerManagementDelegation(event.projectId, event.taskId)
    if (view.state !== 'active' || view.delegation?.id !== event.sourceId) return
  }
  const plan = getProjectOwnerPlanDraft(event.projectId, event.taskId)
  if (!plan || !['proposed', 'confirmed'].includes(plan.state)
    || event.kind === 'planning_result' && (plan.state !== 'proposed' || plan.sourceRun?.executionId !== event.sourceId || plan.goalRevision !== event.sourceRevision)
    || event.kind === 'plan_confirmed' && (plan.state !== 'confirmed' || plan.revision !== event.sourceRevision)
    || event.kind === 'assignment_recheck' && (plan.revision !== event.sourceRevision || (plan.state !== 'proposed' && !(plan.state === 'confirmed' && (event.sourceId?.startsWith('protocol-retry:') || event.sourceId?.startsWith('manual-retry:')))))
    || event.kind === 'team_changed' && plan.revision !== event.sourceRevision
    || event.kind === 'team_changed' && plan.state !== 'confirmed' && !(plan.state === 'proposed' && event.sourceId?.startsWith('team-access:') && getOwnerManagementDelegation(event.projectId, event.taskId).state === 'active')
    || !['planning_result', 'plan_confirmed', 'team_changed', 'delegation_confirmed', 'assignment_recheck'].includes(event.kind)) return
  const binding = getOwnerRuntimeBinding(event.projectId)
  if (!binding) throw new Error('Owner安排缺少有效模型绑定')
  if (!getOwnerTeamWorkspaceProposal(event.projectId, event.taskId)) ensureOwnerDefaultTeam(event.projectId, binding, plan.proposal.steps.map(step => step.roleKey))
  const context = getProjectOwnerPlanningContext(event.projectId, event.taskId)
  const requestKey = createHash('sha256').update(event.id).digest('hex').slice(0, 32)
  const input = { requestId: `management-assignment:${requestKey}`, expectedBindingRevision: binding.revision, expectedGoalRevision: context.goal.revision, expectedPlanRevision: plan.revision, expectedPlanFingerprint: plan.planFingerprint, expectedContextFingerprint: context.fingerprint }
  const messageEventId = (kind: 'capability' | 'assignment', fingerprint = '') => event.kind === 'team_changed'
    ? `team-${kind}:${event.projectId}:${event.taskId ?? 'project'}:${plan.revision}${fingerprint ? `:${fingerprint}` : ''}`
    : kind === 'capability' ? `owner-capability:${event.projectId}:${event.taskId ?? 'project'}:${plan.revision}:${fingerprint}${event.kind === 'delegation_confirmed' ? `:${event.sourceId}` : ''}`
    : event.id
  const trace = (phase: 'assignment_preparation' | 'assignment_run', state: 'started' | 'queued' | 'completed' | 'failed' | 'blocked', detailCode: 'team_check' | 'provider_pending' | 'result_ready' | 'decision_required', suffix: string) => appendOwnerManagementTrace({ eventId: `owner-trace:${phase}:${messageEventId('assignment', suffix)}:${state}`, projectId: event.projectId, ...(event.taskId ? { taskId: event.taskId } : {}), phase, state, createdAt: Date.now(), detailCode })
  trace('assignment_preparation', 'started', 'team_check', String(plan.revision))
  let source: ReturnType<typeof getCurrentOwnerExecutionAssignmentContext>
  try { source = getCurrentOwnerExecutionAssignmentContext({ projectId: event.projectId, ...(event.taskId ? { taskId: event.taskId } : {}) }, input) }
  catch (cause) {
    const reason = cause instanceof Error ? cause.message : ''
    const prefix = plan.state === 'proposed' ? '目标和方案已保留，方案仍待你确认；' : '目标和已确认方案已保留；'
    const genericNextStep = '我暂时找不到可承担这项工作的合格团队，所以工作尚未开始；扩大项目资料范围也不能解决当前团队配置问题。目标和方案已保留。我会在团队配置发生变化时自动重新核对；如需调整交付目标或验收标准，会先回来和你商量。'
    const message = cause instanceof OwnerExecutionAssignmentCapabilityError
      ? cause.reason === 'no-executable-employee'
        ? `当前获准用于本项目的工作区里没有能承担这项工作的员工，因此这部分工作还没有派工。${prefix}${genericNextStep}`
        : `当前团队不足以同时完成执行和独立检查，因此这部分工作还没有派工。${prefix}${genericNextStep}`
      : (reason.includes('没有符合岗位模板的独立评审员') || reason.includes('缺少可独立检查成果的另一位员工')) ? `当前团队没有可独立检查成果的员工，因此这部分工作还没有派工。${prefix}${genericNextStep}`
        : reason.includes('没有可用执行人员') ? `当前获准用于本项目的工作区里没有可用执行员工，因此这部分工作还没有派工。${prefix}${genericNextStep}`
          : null
    if (!message) throw cause
    const teamWorkspaceProposal = getOwnerTeamWorkspaceProposal(event.projectId, event.taskId) ?? undefined
    const nextStep = teamWorkspaceProposal
      ? `为推进当前方案，我建议将“${teamWorkspaceProposal.workspaceName}”工作区纳入本项目资料范围；其中的资料、技能和配置会用于后续工作。确认后我会继续安排团队。`
      : genericNextStep
    const actionableMessage = message.replace(genericNextStep, nextStep)
    trace('assignment_preparation', 'blocked', 'team_check', cause instanceof OwnerExecutionAssignmentCapabilityError ? cause.reason : reason)
    const capabilityReason = cause instanceof OwnerExecutionAssignmentCapabilityError ? cause.reason : reason
    const capabilityFingerprint = `${capabilityReason}:${teamWorkspaceProposal?.scopeFingerprint ?? input.expectedContextFingerprint}`
    appendOwnerManagementMessage({ projectId: event.projectId, eventId: messageEventId('capability', capabilityFingerprint), role: 'assistant', kind: 'attention', content: actionableMessage, ...(teamWorkspaceProposal ? { teamWorkspaceProposal } : {}) })
    return
  }
  trace('assignment_preparation', 'completed', 'team_check', source.context.contextFingerprint)
  if (event.kind === 'plan_confirmed') {
    const prepared = store.getProjectDb().prepare("SELECT planning_task_id, assignment_snapshot FROM project_owner_planning_links WHERE project_id = ? AND json_extract(payload, '$.purpose') = 'owner_execution_assignment' AND json_extract(payload, '$.targetTaskId') IS ? AND json_extract(payload, '$.planRevision') = ? ORDER BY rowid DESC").all(event.projectId, event.taskId ?? null, plan.revision - 1) as Array<{ planning_task_id: string; assignment_snapshot: string | null }>
    const reusable = prepared.some(row => {
      if (!row.assignment_snapshot) return false
      try {
        const previous = parseOwnerExecutionAssignmentContext(JSON.parse(row.assignment_snapshot))
        if (!ownerAssignmentContextMatchesApprovalTransition(previous, source.context)) return false
        const resolved = resolveOwnerPlanningTask(row.planning_task_id, true)
        return Boolean(resolved?.assignmentContext && ownerAssignmentContextMatchesApprovalTransition(resolved.assignmentContext, source.context))
      } catch { return false }
    })
    if (reusable) return
  }
  const roles = [...new Set(source.context.steps.map(step => step.roleKey))]
  const completeTeam = source.context.workspaces.some(workspace => source.context.candidates.some(reviewer => {
    if ((source.context.teamContractVersion === undefined && !['reviewer', 'delivery-verifier'].includes(reviewer.roleTemplateId ?? '')) || !reviewer.workspaceIds.includes(workspace.id)) return false
    return roles.every(role => source.context.candidates.some(employee => employee.id !== reviewer.id && (source.context.teamContractVersion !== undefined || employee.roleTemplateId === role)
      && employee.workspaceIds.includes(workspace.id) && source.context.executionKinds.some(kind => supportsOwnerExecutionKind(employee, kind) && supportsOwnerExecutionKind(reviewer, kind))
      && (source.context.teamContractVersion === 3 ? supportsOwnerMixedTeam([employee, reviewer]) : employee.channelId === reviewer.channelId && employee.modelId === reviewer.modelId && employee.runtime === reviewer.runtime)))
  }))
  if (!completeTeam) {
    trace('assignment_preparation', 'blocked', 'team_check', 'team-contract-incomplete')
    const prefix = plan.state === 'proposed' ? '目标和方案已保留，方案仍待你确认；' : '目标和已确认方案已保留；'
    const teamWorkspaceProposal = getOwnerTeamWorkspaceProposal(event.projectId, event.taskId) ?? undefined
    const nextStep = teamWorkspaceProposal
      ? `为推进当前方案，我建议将“${teamWorkspaceProposal.workspaceName}”工作区纳入本项目资料范围；其中的资料、技能和配置会用于后续工作。确认后我会继续安排团队。`
      : '我暂时找不到可承担这项工作的合格团队，所以工作尚未开始；扩大项目资料范围也不能解决当前团队配置问题。目标和方案已保留。我会在团队配置发生变化时自动重新核对；如需调整交付目标或验收标准，会先回来和你商量。'
    appendOwnerManagementMessage({ projectId: event.projectId, eventId: messageEventId('capability', 'team-contract-incomplete'), role: 'assistant', kind: 'attention', content: `当前团队不足以覆盖方案需要的执行岗位和独立检查，因此这部分工作还没有派工。${prefix}${nextStep}`, ...(teamWorkspaceProposal ? { teamWorkspaceProposal } : {}) })
    return
  }
  // 只复用同一已确认方案和完整候选快照，人工旧入口也不能导致重复准备。
  const existing = store.getProjectDb().prepare("SELECT planning_task_id FROM project_owner_planning_links WHERE project_id = ? AND json_extract(payload, '$.purpose') = 'owner_execution_assignment' AND json_extract(payload, '$.targetTaskId') IS ? AND json_extract(payload, '$.assignmentContextFingerprint') = ? ORDER BY rowid DESC LIMIT 1").get(event.projectId, event.taskId ?? null, source.context.contextFingerprint) as { planning_task_id: string } | undefined
  const startApproval = getOwnerManagementDelegation(event.projectId, event.taskId).delegation?.startApproval
  if (existing && event.kind === 'plan_confirmed' && !startApproval) return
  if (existing && event.kind === 'delegation_confirmed' && !startApproval) {
    const arranged = store.getProjectDb().prepare("SELECT id FROM project_owner_management_messages WHERE project_id = ? AND json_extract(payload, '$.planningTaskId') = ? AND json_extract(payload, '$.kind') = 'execution_arranged' LIMIT 1").get(event.projectId, existing.planning_task_id)
    if (arranged) return
    const execution = store.getProjectDb().prepare("SELECT status FROM agent_executions WHERE entity_type = 'task' AND entity_id = ? ORDER BY started_at DESC LIMIT 1").get(existing.planning_task_id) as { status: string } | undefined
    if (execution && ['queued', 'running'].includes(execution.status)) return
    if (listPendingOwnerManagementEvents(event.projectId).some(pending => pending.kind === 'assignment_result' && pending.taskId === event.taskId)) return
    const previousRun = listOwnerExecutionAssignmentRuns({ projectId: event.projectId, ...(event.taskId ? { taskId: event.taskId } : {}) }).find(run => run.link.planningTaskId === existing.planning_task_id && run.sourceStatus === 'current')
    const previousOutcome = previousRun?.outcomes.at(-1)
    if (previousOutcome) {
      projectOwnerManagementAssignmentResult({ id: `assignment-replay:${previousOutcome.executionId}`, projectId: event.projectId, kind: 'assignment_result', ...(event.taskId ? { taskId: event.taskId } : {}), sourceRevision: plan.revision, sourceId: previousOutcome.executionId, createdAt: Date.now(), consumedAt: null })
      return
    }
    appendOwnerManagementMessage({ projectId: event.projectId, eventId: messageEventId('assignment', `existing-terminal:${existing.planning_task_id}`), role: 'assistant', kind: 'attention', planningTaskId: existing.planning_task_id, content: '我找到此前为当前方案准备的人员安排，但它已结束且没有可展示的安排结论。我没有重复发送请求；需要先核对原运行记录，再决定是否重新安排。' })
    return
  }
  const planningTaskId = prepareOwnerExecutionAssignment({ projectId: event.projectId, ...(event.taskId ? { taskId: event.taskId } : {}) }, input).planningTaskId
  trace('assignment_run', 'queued', 'provider_pending', source.context.contextFingerprint)
  appendOwnerManagementMessage({ projectId: event.projectId, eventId: messageEventId('assignment', source.context.contextFingerprint), role: 'assistant', kind: 'management_progress', planningTaskId, content: plan.state === 'proposed' ? '我正在依据已授权的项目目标和预算准备团队安排；完成后会继续执行和独立检查。如遇到范围外事项，我会回来与你商量。' : '我正在依据已确认方案和项目授权推进团队安排；完成后会继续执行和独立检查。如遇到范围外事项，我会回来与你商量。' })
}

export function projectOwnerManagementAssignmentResult(event: OwnerManagementEvent): void {
  if (!event.sourceId) throw new Error('Owner安排结论缺少准确运行来源')
  const outcome = getOwnerPlanningRunOutcome(event.sourceId)
  const receipt = outcome ? getOwnerPlanningRunReceipt(outcome.receiptId) : null
  const source = receipt ? readOwnerPlanningSnapshot(receipt.planningTaskId) : null
  if (!outcome || !receipt || receipt.projectId !== event.projectId || receipt.executionId !== event.sourceId || receipt.purpose !== 'owner_execution_assignment' || source?.link.targetTaskId !== event.taskId) throw new Error('Owner安排结论与当前项目身份不一致')
  if (outcome.state === 'failed' && queueOwnerAssignmentProtocolRetry(event.projectId, event.taskId, event.sourceId)) return
  try { resolveOwnerPlanningTask(receipt.planningTaskId, true) }
  catch {
    if (queueOwnerAssignmentProtocolRetry(event.projectId, event.taskId, event.sourceId)) return
    const plan = getProjectOwnerPlanDraft(event.projectId, event.taskId)
    if (!plan || !['proposed', 'confirmed'].includes(plan.state)) return
    const nextEvent: OwnerManagementEvent = plan.state === 'proposed' && plan.sourceRun
      ? { ...event, id: `${event.id}:plan:${plan.planFingerprint}`, kind: 'planning_result', sourceId: plan.sourceRun.executionId, sourceRevision: plan.goalRevision }
      : { ...event, id: `${event.id}:plan:${plan.planFingerprint}`, kind: 'plan_confirmed', sourceRevision: plan.revision }
    prepareOwnerManagementAssignment(nextEvent)
    return
  }
  if (outcome.state !== 'proposed' || !outcome.assignmentProposal) {
    appendOwnerManagementTrace({ eventId: `owner-trace:assignment-result:${event.id}:failed`, projectId: event.projectId, ...(event.taskId ? { taskId: event.taskId } : {}), phase: 'assignment_run', state: outcome.state === 'needs_clarification' ? 'waiting' : 'failed', createdAt: Date.now(), detailCode: outcome.state === 'needs_clarification' ? 'decision_required' : 'result_ready' })
    // 把可核对的失败原因写进对话，Owner 才能如实回答“需要核对什么”，而不是含糊其辞。
    const reason = ownerAssignmentFailureReason(outcome.detail)
    appendOwnerManagementMessage({ projectId: event.projectId, eventId: event.id, role: 'assistant', kind: 'attention', content: `这次人员安排没有得到可继续使用的结果。${reason ? `原因：${reason}。` : ''}我已保留原记录；除非确认可以修复，否则不会自动重复调用。` })
    return
  }
  appendOwnerManagementTrace({ eventId: `owner-trace:assignment-result:${event.id}:completed`, projectId: event.projectId, ...(event.taskId ? { taskId: event.taskId } : {}), phase: 'assignment_run', state: 'completed', createdAt: Date.now(), detailCode: 'result_ready' })
  const latest = store.getProjectDb().prepare("SELECT planning_task_id FROM project_owner_planning_links WHERE project_id = ? AND json_extract(payload, '$.purpose') = 'owner_execution_assignment' AND json_extract(payload, '$.targetTaskId') IS ? ORDER BY rowid DESC LIMIT 1").get(event.projectId, event.taskId ?? null) as { planning_task_id: string } | undefined
  if (latest?.planning_task_id !== receipt.planningTaskId) return
  const resolved = resolveOwnerPlanningTask(receipt.planningTaskId, true)
  if (!resolved) throw new Error('Owner安排来源无法核验')
  const plan = getProjectOwnerPlanDraft(event.projectId, event.taskId)
  const subject = { projectId: event.projectId, ...(event.taskId ? { taskId: event.taskId } : {}) }
  const delegationView = getOwnerManagementDelegation(event.projectId, event.taskId)
  const delegation = delegationView.delegation
  const startApproval = delegation?.startApproval
  const matchesStartApproval = Boolean(startApproval && plan?.state === 'confirmed'
    && plan.revision === startApproval.expectedPlanRevision + 1 && plan.goalRevision === startApproval.expectedGoalRevision
    && plan.planFingerprint === startApproval.planFingerprint && plan.contextFingerprint === startApproval.contextFingerprint
    && resolved.link.planRevision === plan.revision)
  const withinAutonomousProjectGrant = Boolean(delegation?.autonomousExecution && delegationView.state === 'active'
    && plan?.state === 'confirmed' && resolved.link.planRevision === plan.revision)
  if (startApproval && (!matchesStartApproval || delegationView.state !== 'active' || !delegation)) {
    appendOwnerManagementMessage({ projectId: event.projectId, eventId: `${event.id}:approved-start-stale`, role: 'assistant', kind: 'attention', ...(event.taskId ? { taskId: event.taskId } : {}), content: delegationView.state === 'active'
      ? '我发现已确认的目标或方案来源发生变化，因此没有启动团队。原方案、安排和预算记录都已保留；请在这里重新核对结果范围。'
      : `已确认的工作安排仍保留，但持续管理预算${delegationView.state === 'exhausted' ? '已用尽' : '已失效或需要核对'}，所以我没有启动团队。请在这里核对预算或授权状态后再继续。` })
    return
  }
  if ((matchesStartApproval || withinAutonomousProjectGrant) && plan && delegation && delegationView.state === 'active') {
    const selectedSteps = plan.proposal.steps.filter(step => outcome.assignmentProposal!.selectedStepKeys.includes(step.key))
    // 执行准备按稳定roleKey排序并要求首个岗位员工与executor一致；这里先统一排序再确定主执行员工。
    const roleAssignments = outcome.assignmentProposal.assignments
      .map(({ roleKey, employeeId }) => ({ roleKey, employeeId }))
      .sort((left, right) => left.roleKey.localeCompare(right.roleKey))
    const firstExecutor = roleAssignments.find(item => selectedSteps.some(step => step.roleKey === item.roleKey))
    const roles = [...new Set(selectedSteps.map(step => step.roleKey))].sort()
    const assignedRoles = [...new Set(roleAssignments.map(item => item.roleKey))].sort()
    const policy = getPilotPolicy(event.projectId)
    const remainingCost = delegation.maxCostMicros - delegationView.reservedCostMicros
    const executionPreparation = getOwnerExecutionPreparation(subject)
    if (!selectedSteps.length || !firstExecutor || JSON.stringify(roles) !== JSON.stringify(assignedRoles)
      || selectedSteps.length !== outcome.assignmentProposal.selectedStepKeys.length
      || selectedSteps.some(step => !step.dependencies.every(dependency => outcome.assignmentProposal!.selectedStepKeys.includes(dependency)))) {
      appendOwnerManagementMessage({ projectId: event.projectId, eventId: `${event.id}:approved-start-invalid`, role: 'assistant', kind: 'attention', ...(event.taskId ? { taskId: event.taskId } : {}), content: '我已完成团队安排，但无法将它完整映射到你确认的方案步骤，因此没有启动员工。方案与安排已保留，需核对后再继续。' })
      return
    }
    if (!Number.isSafeInteger(remainingCost) || remainingCost < 1) {
      appendOwnerManagementMessage({ projectId: event.projectId, eventId: `${event.id}:approved-start-budget`, role: 'assistant', kind: 'attention', ...(event.taskId ? { taskId: event.taskId } : {}), content: '团队安排已完成，但管理费用额度已无可用余额，因此我没有启动员工。方案和安排都已保留；请核对已用额度后再决定是否继续。' })
      return
    }
    const input: OwnerExecutionPreparationInput = {
      requestId: randomUUID(), expectedPreparationRevision: executionPreparation.revision,
      expectedPolicyRevision: policy?.revision ?? null, expectedGoalRevision: plan.goalRevision, expectedPlanRevision: plan.revision,
      selectedStepKeys: [...outcome.assignmentProposal.selectedStepKeys], executionKind: outcome.assignmentProposal.executionKind,
      employeeRuntimeVersion: 2,
      qualityManagementVersion: 1,
      // 代码任务按文件交付：带研发范围时不再强制完整文本交付，否则 Write/Edit 会被移出工具集，员工只能把代码写在回复里。
      ...(outcome.assignmentProposal.executionKind === 'controlled' && !outcome.assignmentProposal.developmentScope ? { textDeliveryVersion: 1 as const } : {}),
      // 自主管理额度仅覆盖当前项目已绑定工作区；该绑定来自项目预设或用户刚批准的团队范围。
      // 将其作为工作区覆盖确认，避免启动门禁再次要求用户批准同一资料/团队边界。
      ...(withinAutonomousProjectGrant ? { acknowledgeOwnerWorkspaceOverride: true } : {}),
      ...(outcome.assignmentProposal.developmentScope ? { developmentScope: { workspaceId: outcome.assignmentProposal.workspaceId, targetPaths: outcome.assignmentProposal.developmentScope.targetPaths, allowedPaths: outcome.assignmentProposal.developmentScope.allowedPaths, verificationCommands: outcome.assignmentProposal.developmentScope.verificationCommands } } : {}),
      executorEmployeeId: firstExecutor.employeeId, reviewerEmployeeId: outcome.assignmentProposal.reviewerEmployeeId, roleAssignments,
      workspaceId: outcome.assignmentProposal.workspaceId, knowledgeSourceIds: executionPreparation.choices.knowledgeSources.map(source => source.id), maxCostMicros: remainingCost,
      // 研发每轮需为读取/写入/收尾与独立评审留额，覆盖首轮及两轮返工；费用仍由原总额约束。
      maxRuns: Math.max(1, selectedSteps.length) * (outcome.assignmentProposal.executionKind === 'development' ? 12 : 6), maxRework: 2, expiresAt: delegation.expiresAt,
      changeReason: withinAutonomousProjectGrant ? '用户已确认项目目标、资料范围和总额度；Owner在授权内自主组织执行' : '用户已在项目对话确认结果方案与持续管理边界；Owner按确认方案自主组织执行',
    }
    const intent = saveOwnerExecutionStartIntent({ ...subject, intentId: input.requestId, expectedGoalRevision: plan.goalRevision,
      expectedPlanRevision: plan.revision, planFingerprint: plan.planFingerprint, contextFingerprint: plan.contextFingerprint, input })
    appendOwnerManagementMessage({ projectId: event.projectId, eventId: `${event.id}:approved-start:${intent.intentId}`, role: 'assistant', kind: 'management_progress', planningTaskId: resolved.link.planningTaskId, ...(event.taskId ? { taskId: event.taskId } : {}), content: '安排已完成。我正在按你确认的方案和预算核验工作范围并启动团队；如果执行前发现目标、资料或授权变化，我会暂停并在这里说明。' })
    return
  }
  appendOwnerManagementMessage({ projectId: event.projectId, eventId: event.id, role: 'assistant', kind: 'execution_arranged', planningTaskId: receipt.planningTaskId, content: '结果方案的内部安排已准备好，员工尚未启动。请审阅方案及明确展示的结果/执行边界；确认开始后，Owner会负责组织执行。' })
}
