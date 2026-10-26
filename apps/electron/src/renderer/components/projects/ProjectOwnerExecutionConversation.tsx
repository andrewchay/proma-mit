import { supportsOwnerExecutionKind, supportsOwnerMixedTeam } from '@gravitas/shared'
import { getOwnerDeliveryFlow, ownerDeliveryFlowsAtom, reviewOwnerManagedExecutionAtom } from '../../atoms/owner-delivery-flow-atoms'
import { getOwnerManagementEditor, ownerManagementEditorsAtom } from '../../atoms/project-owner-management-atoms'
import { useEffect, useId, useMemo } from 'react'
import type { OwnerExecutionAssignmentProposal, ProjectOwnerPlanDraft } from '@gravitas/shared'
import { atom, useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import { getOwnerPlanEditor, ownerPlanEditorsAtom } from '../../atoms/project-owner-plan-atoms'
import { getOwnerGrantEditor, loadOwnerGrantAtom, ownerGrantEditorsAtom } from '../../atoms/project-owner-execution-grant-atoms'
import { getOwnerCommandProgress, loadOwnerCommandProgressAtom, ownerCommandProgressAtom } from '../../atoms/owner-command-progress-atoms'
import { canPreviewOwnerExecution, canSaveOwnerExecution, compareOwnerExecutionAtom, editOwnerExecutionAtom, getOwnerExecutionEditor, loadOwnerExecutionAtom, ownerExecutionEditorsAtom, ownerExecutionInput, ownerExecutionPlanReady, previewOwnerExecutionAtom, saveOwnerExecutionAtom, type OwnerExecutionEdit } from '../../atoms/project-owner-execution-atoms'
import { ownerDollarsToMicros, ownerExecutionAssignmentEdit, ownerExecutionArrangementMatches, ownerExecutionPeopleReady, ownerExecutionSetupSuggestion, ownerExecutionSuggestedLimits, ownerMicrosToDollars } from '../../atoms/owner-execution-setup'
import { getOwnerExecutionAssignmentEditor, loadOwnerExecutionAssignmentRunsAtom, ownerExecutionAssignmentEditorsAtom, prepareOwnerExecutionAssignmentAtom } from '../../atoms/project-owner-execution-assignment-atoms'
import { getOwnerDelegationEditor, ownerDelegationEditorsAtom } from '../../atoms/owner-management-delegation-atoms'
import { ControlledTaskStartButton } from './ControlledTaskStartButton'
import { PreviewFacts, ProjectOwnerExecutionPreparationPanel, SavedFacts } from './ProjectOwnerExecutionPreparationPanel'
import { ProjectOwnerDeliveryConversation } from './ProjectOwnerDeliveryConversation'
import { OwnerModuleStatus } from './OwnerModuleStatus'
import { getOwnerWaitingLabel, getOwnerWaitingMessage } from './project-owner-progress-state'

const field = 'mt-2 w-full min-w-0 rounded-lg bg-background p-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const button = 'rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50'

function OwnerDevelopmentScopeSummary({ scope, ownerFacing = false }: { scope: OwnerExecutionAssignmentProposal['developmentScope']; ownerFacing?: boolean }): React.ReactElement | null {
  if (!scope) return null
  if (ownerFacing) return <p className="rounded-lg bg-background/70 p-3 text-sm">我会在已确认的项目范围内处理相关内容并执行适用验证；内部文件范围和验证步骤由我负责。完成后会向你说明实际改动及验证结果，若需要扩大范围或权限会先与你商量。</p>
  return <div className="space-y-2 rounded-lg bg-background/70 p-3" aria-label="Owner建议的代码范围">
    <p className="font-medium">代码范围建议</p>
    <p>{scope.reason}</p>
    <p><span className="font-medium">本次目标：</span>{scope.targetPaths.join('、')}</p>
    <p><span className="font-medium">允许修改：</span>{scope.allowedPaths.join('、')}</p>
    <p><span className="font-medium">建议验证：</span>{scope.verificationCommands.join('；')}</p>
    <p className="text-xs text-muted-foreground">验证建议尚未执行。接受安排后会带入执行准备；任何执行仍须通过既有范围、命令和授权校验。</p>
  </div>
}

function OwnerManagedExecutionApprovalSummary({ summary, steps, executionKind }: { summary: string; steps: ProjectOwnerPlanDraft['proposal']['steps']; executionKind: 'controlled' | 'development' }): React.ReactElement {
  return <section className="space-y-2 rounded-xl bg-primary/5 p-3 text-sm" aria-label="本次执行结果与范围">
    <h4 className="font-medium">交付结果</h4>
    <p className="leading-6">{summary}</p>
    {steps.some(step => step.acceptanceCriteria.length > 0) && <details className="rounded-lg bg-background/70 p-3"><summary className="cursor-pointer text-xs">查看交付明细与完成标准</summary><div className="mt-2 space-y-2 text-xs text-muted-foreground"><ul className="list-disc space-y-1 pl-5">{steps.map(step => <li key={step.key}>{step.outcome}</li>)}</ul><ul className="list-disc space-y-1 pl-5">{steps.flatMap(step => step.acceptanceCriteria).map((criterion, index) => <li key={`${index}-${criterion}`}>{criterion}</li>)}</ul></div></details>}
    <p className="text-xs text-muted-foreground">本次执行与检查遵守项目已确认的费用上限，由 Owner 在授权内安排。</p>
    {executionKind === 'development' && <p className="text-xs text-muted-foreground">代码修改限于本项目内与上述成果相关的范围；扩大范围、发布或外发前会先与你商量。</p>}
  </section>
}

/** 对话只编排既有暂停准备接口，模型调用、业务授权和派工仍由各自门禁负责。 */
export function ProjectOwnerExecutionConversation({ projectId, taskId, ownerConversation = false }: { projectId: string; taskId?: string; ownerConversation?: boolean }): React.ReactElement {
  const subject = useMemo(() => ({ projectId, ...(taskId === undefined ? {} : { taskId }) }), [projectId, taskId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: 主体切换时重建对话展示状态，业务草案仍按主体保留。
  const localAtom = useMemo(() => atom({ started: false, budget: false, dollars: null as string | null, advanced: false, editing: false, assignmentFeedback: '', assignmentFeedbackError: '', appliedAssignmentId: '', replaceArrangement: false }), [subject])
  const [local, setLocal] = useAtom(localAtom)
  const stateAtom = useMemo(() => atom(get => ({
    editor: getOwnerExecutionEditor(get(ownerExecutionEditorsAtom), subject),
    plan: getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject).snapshot,
    managementMessages: getOwnerManagementEditor(get(ownerManagementEditorsAtom), subject.projectId).view?.messages ?? [],
    assignments: getOwnerExecutionAssignmentEditor(get(ownerExecutionAssignmentEditorsAtom), subject),
    delivery: getOwnerDeliveryFlow(get(ownerDeliveryFlowsAtom), subject),
    ownerBudget: getOwnerDelegationEditor(get(ownerDelegationEditorsAtom), subject),
    grant: getOwnerGrantEditor(get(ownerGrantEditorsAtom), subject),
    commandProgress: getOwnerCommandProgress(get(ownerCommandProgressAtom), subject),
    confirmedReady: ownerExecutionPlanReady(get, subject),
    reviewReady: ownerExecutionPlanReady(get, subject, true),
    canPreview: canPreviewOwnerExecution(get, subject), canSave: canSaveOwnerExecution(get, subject),
  })), [subject])
  const { editor: e, plan, assignments, delivery, grant, commandProgress, managementMessages, ownerBudget, confirmedReady, reviewReady, canPreview, canSave } = useAtomValue(stateAtom)
  const load = useSetAtom(loadOwnerExecutionAtom); const edit = useSetAtom(editOwnerExecutionAtom)
  const loadGrant = useSetAtom(loadOwnerGrantAtom)
  const loadCommandProgress = useSetAtom(loadOwnerCommandProgressAtom)
  const loadAssignments = useSetAtom(loadOwnerExecutionAssignmentRunsAtom); const prepareAssignment = useSetAtom(prepareOwnerExecutionAssignmentAtom)
  const reviewManaged = useSetAtom(reviewOwnerManagedExecutionAtom)
  const preview = useSetAtom(previewOwnerExecutionAtom); const save = useSetAtom(saveOwnerExecutionAtom)
  const compare = useSetAtom(compareOwnerExecutionAtom)
  const store = useStore()
  const id = useId()
  useEffect(() => {
    const refresh = () => { void load(subject); void loadAssignments(subject); void loadGrant(subject); void loadCommandProgress(subject) }
    refresh()
    window.addEventListener('focus', refresh)
    const off = window.electronAPI?.paa?.project?.onOwnerManagementChanged?.(change => { if (change.projectId === projectId) refresh() })
    return () => { window.removeEventListener('focus', refresh); off?.() }
  }, [load, loadAssignments, loadGrant, loadCommandProgress, subject, projectId])
  const busy = e.loading || e.previewing || e.saving || assignments.loading || assignments.preparing || delivery.loading || delivery.saving || Boolean(delivery.stage)
  const patch = (value: OwnerExecutionEdit) => edit({ subject, patch: value })
  const workspaceId = e.workspaceId || e.view?.workspaceRecommendation.workspaceId || ''
  const roles = [...new Set(plan?.proposal.steps.filter(step => e.selectedStepKeys.includes(step.key)).map(step => step.roleKey) ?? [])]
  const peopleReady = Boolean(plan && ownerExecutionPeopleReady(e, plan))
  const employees = e.view?.choices.employees.filter(employee => supportsOwnerExecutionKind(employee, e.executionKind) && employee.workspaceIds.includes(workspaceId)) ?? []
  const selected = roles.map(role => employees.find(employee => employee.id === e.roleAssignments[role]))
  const reviewer = employees.find(employee => employee.id === e.reviewerEmployeeId)
  const config = e.view?.executionConfigurationRecommendation
  const configurationConflict = Boolean(!supportsOwnerMixedTeam([...selected, reviewer]) && config && [...selected, reviewer].some(employee => employee && (employee.channelId !== config.channelId || employee.modelId !== config.modelId || employee.runtime !== config.runtime)))
  const workspaceConflict = e.view?.workspaceRecommendation.source === 'owner_binding' && workspaceId !== e.view.workspaceRecommendation.workspaceId
  const saved = e.view?.preparation
  const latestAssignmentRun = assignments.runs[0] ?? null
  const latestAssignmentOutcome = latestAssignmentRun?.outcomes.at(-1) ?? null
  const assignmentProposal = latestAssignmentRun?.sourceStatus === 'current' && latestAssignmentOutcome?.state === 'proposed' ? latestAssignmentOutcome.assignmentProposal ?? null : null
  const ownerApprovalSteps = plan?.proposal.steps.filter(step => e.selectedStepKeys.includes(step.key)) ?? []
  const ownerKnowledgeNames = e.knowledgeSourceIds.map(id => e.view?.choices.knowledgeSources.find(source => source.id === id)?.name).filter((name): name is string => Boolean(name))
  const ownerApprovalScopeReady = Boolean(plan && ownerApprovalSteps.length > 0 && ownerApprovalSteps.length === e.selectedStepKeys.length && ownerKnowledgeNames.length === e.knowledgeSourceIds.length)
  const assignmentInProgress = assignments.runs.some(run => run.executions.some(execution => execution.status === 'queued' || execution.status === 'running'))
  const hasAssignmentActivity = Boolean(assignmentProposal || assignmentInProgress || latestAssignmentRun?.sourceStatus === 'stale' || (latestAssignmentRun && !latestAssignmentOutcome))
  const managedByOwner = Boolean(latestAssignmentRun && (latestAssignmentRun.link.requestId.startsWith('management-assignment:') || managementMessages.some(message => message.planningTaskId === latestAssignmentRun.link.planningTaskId && ['management_progress', 'execution_arranged'].includes(message.kind))))
  const ownerWaitingLabel = ownerConversation ? getOwnerWaitingLabel(managementMessages, taskId, ownerBudget.view?.state) : null
  const ownerWaitingMessage = ownerConversation ? getOwnerWaitingMessage(managementMessages, taskId) : null
  const ownerConversationWaitingForUser = Boolean(ownerWaitingLabel)
  const singleConfirmation = ownerConversation && managedByOwner
  const projectBudget = ownerBudget.view?.delegation
  const projectBudgetRemainingMicros = projectBudget ? projectBudget.maxCostMicros - ownerBudget.view!.reservedCostMicros : 0
  const projectBudgetReady = Boolean(projectBudget && ['active', 'exhausted'].includes(ownerBudget.view?.state ?? '') && projectBudgetRemainingMicros > 0)
  const ownerAutonomyManaged = Boolean(singleConfirmation && grant.grant?.dispatchMode === 'autonomous' && grant.grant.state !== 'archived')
  const ownerGrantId = grant.grant?.grantId
  const ownerCommands = ownerGrantId ? commandProgress.commands.filter(command => command.grantId === ownerGrantId) : []
  const schedule = commandProgress.schedule
  const scheduleMatchesGrant = Boolean(ownerGrantId && schedule?.grantId === ownerGrantId)
  const currentPlanDelivery = managementMessages.some(message => message.taskId === taskId && message.kind === 'delivery' && message.delivery?.planVersion === plan?.planVersion)
  const ownerCompleted = Boolean(ownerAutonomyManaged && currentPlanDelivery && ownerCommands.length > 0 && ownerCommands.every(command => command.state === 'settled'))
  const ownerScheduleExpired = Boolean(ownerAutonomyManaged && commandProgress.loaded && scheduleMatchesGrant && schedule?.state === 'expired' && !ownerCompleted)
  const scheduleIdentityComplete = Boolean(scheduleMatchesGrant && schedule?.taskId && schedule.role && Number.isInteger(schedule.reworkOrdinal))
  const matchingScheduleCommands = scheduleIdentityComplete
    ? ownerCommands.filter(command => command.taskId === schedule?.taskId && command.role === schedule.role && command.reworkOrdinal === schedule.reworkOrdinal)
    : []
  const currentOwnerCommand = matchingScheduleCommands.length === 1 ? matchingScheduleCommands[0] : null
  const scheduleState = schedule?.state
  const nextAction = schedule?.nextAction
  const ownerNeedsAttention = Boolean(ownerAutonomyManaged && !ownerCompleted && (
    grant.grant?.state === 'paused' || grant.grant?.state === 'needs_reconcile' ||
    scheduleMatchesGrant && (scheduleState === 'needs_reconcile' || scheduleState === 'stale' || scheduleState === 'expired') ||
    currentOwnerCommand && ['needs_reconcile', 'unknown', 'failed', 'released', 'cancelled'].includes(currentOwnerCommand.state)
  ))
  const ownerQueued = Boolean(ownerAutonomyManaged && grant.grant?.state === 'active' && commandProgress.loaded && scheduleMatchesGrant && scheduleState === 'ready' && currentOwnerCommand && ['queued', 'reserved'].includes(currentOwnerCommand.state))
  const ownerStarted = Boolean(ownerAutonomyManaged && grant.grant?.state === 'active' && commandProgress.loaded && scheduleMatchesGrant && scheduleState === 'running' && currentOwnerCommand?.state === 'running')
  const ownerWaitingDecision = Boolean(ownerAutonomyManaged && commandProgress.loaded && scheduleMatchesGrant && scheduleState === 'waiting' && nextAction === 'human_decision')
  const ownerAwaitingQuality = Boolean(ownerAutonomyManaged && commandProgress.loaded && scheduleMatchesGrant && scheduleState === 'waiting' && nextAction === 'await_owner_quality')
  const ownerAwaitingAcceptance = Boolean(ownerAutonomyManaged && commandProgress.loaded && scheduleMatchesGrant && scheduleState === 'waiting' && nextAction === 'await_business_acceptance')
  const ownerWaitingForChange = Boolean(ownerAutonomyManaged && commandProgress.loaded && scheduleMatchesGrant && scheduleState === 'waiting' && nextAction === 'none')
  const ownerHasSpecificWaitingState = ownerWaitingDecision || ownerAwaitingQuality || ownerAwaitingAcceptance || ownerWaitingForChange
  const ready = !ownerAutonomyManaged && (ownerConversation ? reviewReady : confirmedReady)
  const savedCurrent = e.view?.status === 'current' && saved?.source.planFingerprint === plan?.planFingerprint && ready && !e.dirty
  const editing = local.editing && !(savedCurrent && saved?.input.requestId === e.requestId && !local.started)
  const canApproveAndStart = Boolean(singleConfirmation && projectBudgetReady && ownerExecutionInput(store.get, subject, true))
  useEffect(() => {
    if (!singleConfirmation || !projectBudgetReady || !projectBudget) return
    // Owner人员安排尚未合并前，预算回填不能伪装成用户修改并触发额外确认。
    if (assignmentProposal && local.appliedAssignmentId !== latestAssignmentOutcome?.executionId) return
    const localExpiry = new Date(projectBudget.expiresAt)
    localExpiry.setMinutes(localExpiry.getMinutes() - localExpiry.getTimezoneOffset())
    const expiresAtText = localExpiry.toISOString().slice(0, 16)
    if (e.maxCostMicrosText !== String(projectBudgetRemainingMicros) || e.expiresAtText !== expiresAtText) {
      edit({ subject, patch: { maxCostMicrosText: String(projectBudgetRemainingMicros), expiresAtText } })
    }
  }, [singleConfirmation, projectBudgetReady, projectBudget, projectBudgetRemainingMicros, assignmentProposal, local.appliedAssignmentId, latestAssignmentOutcome?.executionId, e.maxCostMicrosText, e.expiresAtText, edit, subject])
  useEffect(() => {
    if (savedCurrent) setLocal(value => ({ ...value, editing: false, started: false, budget: false }))
  }, [savedCurrent, setLocal])
  useEffect(() => {
    if (!ownerConversation || !ready || busy || local.started || !hasAssignmentActivity) return
    setLocal(value => ({ ...value, started: true, editing: true }))
  }, [ownerConversation, ready, busy, local.started, hasAssignmentActivity, setLocal])
  useEffect(() => {
    if (!assignmentInProgress) return
    const timer = window.setInterval(() => { void loadAssignments(subject) }, 3000)
    return () => window.clearInterval(timer)
  }, [assignmentInProgress, loadAssignments, subject])
  useEffect(() => {
    if (!ownerAutonomyManaged || ownerNeedsAttention || !['ready', 'running'].includes(scheduleState ?? '')) return
    const timer = window.setInterval(() => { void loadCommandProgress(subject) }, 4000)
    return () => window.clearInterval(timer)
  }, [ownerAutonomyManaged, ownerNeedsAttention, scheduleState, loadCommandProgress, subject])
  const requestOwnerAssignment = async (feedback = local.assignmentFeedback): Promise<void> => {
    if (!plan || !e.view || !ready || !e.loaded || e.requiresReview || busy || !e.view.ownerBindingRevision) return
    const link = await prepareAssignment({ subject, input: { requestId: managedByOwner ? `management-assignment:user:${crypto.randomUUID()}` : crypto.randomUUID(), expectedBindingRevision: e.view.ownerBindingRevision, expectedGoalRevision: plan.goalRevision, expectedPlanRevision: plan.revision, expectedPlanFingerprint: plan.planFingerprint, expectedContextFingerprint: plan.contextFingerprint, ...(feedback.trim() ? { feedback: feedback.trim() } : {}) } })
    if (link) setLocal(value => ({ ...value, started: true, editing: true, budget: false, replaceArrangement: managedByOwner, assignmentFeedback: '', assignmentFeedbackError: '' }))
  }
  const begin = () => {
    if (!plan || !e.view || !ready || !e.loaded || e.requiresReview || busy) return
    if (savedCurrent) patch(ownerExecutionSetupSuggestion(e.view, plan, e))
    setLocal(value => ({ ...value, started: true, editing: true, budget: false, dollars: null, assignmentFeedbackError: '' }))
  }
  const acceptAssignment = (proposal: OwnerExecutionAssignmentProposal): void => {
    if (!plan || !e.view || latestAssignmentRun?.sourceStatus !== 'current') return
    patch(ownerExecutionAssignmentEdit(proposal))
    setLocal(value => ({ ...value, budget: true, appliedAssignmentId: latestAssignmentOutcome?.executionId ?? '', replaceArrangement: false, dollars: null, assignmentFeedback: '', assignmentFeedbackError: '' }))
  }
  useEffect(() => {
    if (!managedByOwner || !ready || !e.loaded || busy || e.requiresReview || savedCurrent || local.advanced) return
    if (!local.started) setLocal(value => ({ ...value, started: true, editing: true }))
    if (!assignmentProposal || !latestAssignmentOutcome || local.appliedAssignmentId === latestAssignmentOutcome.executionId) return
    if (e.dirty && !local.replaceArrangement) {
      if (ownerExecutionArrangementMatches(e, assignmentProposal)) setLocal(value => ({ ...value, started: true, editing: true, budget: true, appliedAssignmentId: latestAssignmentOutcome.executionId }))
      return
    }
    const limits = ownerExecutionSuggestedLimits(assignmentProposal.selectedStepKeys.length)
    edit({ subject, patch: { ...ownerExecutionAssignmentEdit(assignmentProposal), maxRunsText: e.maxRunsText || limits.maxRunsText, maxReworkText: e.maxReworkText || limits.maxReworkText, expiresAtText: e.expiresAtText || limits.expiresAtText, changeReason: e.changeReason || limits.changeReason } })
    setLocal(value => ({ ...value, started: true, editing: true, budget: true, replaceArrangement: false, appliedAssignmentId: latestAssignmentOutcome.executionId }))
  }, [managedByOwner, ready, e, busy, savedCurrent, local.advanced, local.started, local.appliedAssignmentId, local.replaceArrangement, assignmentProposal, latestAssignmentOutcome, edit, subject, setLocal])
  useEffect(() => {
    const approvedWorkspace = e.view?.choices.workspaces.some(workspace => workspace.id === workspaceId)
    if (!singleConfirmation || !assignmentProposal || !workspaceConflict || e.acknowledgeOwnerWorkspaceOverride
      || !approvedWorkspace || assignmentProposal.workspaceId !== workspaceId) return
    edit({ subject, patch: { acknowledgeOwnerWorkspaceOverride: true } })
  }, [singleConfirmation, assignmentProposal, workspaceConflict, e.acknowledgeOwnerWorkspaceOverride, e.view, workspaceId, edit, subject])
  const returnAssignment = async (): Promise<void> => {
    if (!local.assignmentFeedback.trim()) { setLocal(value => ({ ...value, assignmentFeedbackError: '请写明希望Owner调整的内容。' })); return }
    await requestOwnerAssignment(local.assignmentFeedback)
  }
  const saveReviewed = async () => {
    const requestId = e.preview?.input.requestId
    await save(subject)
    const current = getOwnerExecutionEditor(store.get(ownerExecutionEditorsAtom), subject)
    if (!requestId || current.error || current.dirty || current.view?.preparation?.input.requestId !== requestId) return
    setLocal(value => ({ ...value, editing: false, started: false, budget: false }))
    await load(subject)
  }
  return <section className="mt-5 min-w-0 space-y-4 rounded-xl bg-muted/30 p-4 shadow-sm [overflow-wrap:anywhere]" aria-label="执行配置对话">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{ownerConversationWaitingForUser ? ownerWaitingLabel : ownerCompleted ? 'Owner 已完成本轮工作' : ownerScheduleExpired ? '执行授权已到期' : ownerAwaitingAcceptance ? '交付已完成，等待你验收' : ownerWaitingDecision ? 'Owner 等待你的决定' : ownerAwaitingQuality ? '成果等待 Owner 质量判断' : ownerWaitingForChange ? 'Owner 等待新的项目进展' : ownerStarted ? 'Owner 正在推进交付' : ownerQueued ? 'Owner 正在启动执行' : ownerNeedsAttention ? 'Owner 执行需要核对' : ownerAutonomyManaged ? 'Owner 正在核对启动状态' : singleConfirmation ? '确认成果范围并开始' : ownerConversation && ready && !hasAssignmentActivity ? 'Owner 尚未形成团队安排' : ownerConversation ? 'Owner 正在组织执行' : managedByOwner ? '确认执行边界' : '接下来，安排计划如何执行'}</h3><OwnerModuleStatus tone={ownerConversationWaitingForUser || ownerWaitingDecision || ownerNeedsAttention || e.requiresReview || latestAssignmentRun?.sourceStatus === 'stale' ? 'danger' : ownerCompleted || ownerStarted || ownerAwaitingAcceptance || savedCurrent || assignmentProposal ? 'accent' : ownerAutonomyManaged || saved || assignments.runs.length || (ownerConversation && ready && !hasAssignmentActivity) ? 'warn' : 'muted'}>{ownerConversationWaitingForUser ? '等待你处理' : ownerCompleted ? '本轮已交付' : ownerScheduleExpired ? '需要重新确认授权' : ownerAwaitingAcceptance ? '成果待你验收' : ownerWaitingDecision ? '需要你决定' : ownerAwaitingQuality ? '等待质量判断' : ownerWaitingForChange ? '当前没有待派发工作' : ownerStarted ? '员工已开始处理' : ownerQueued ? '工作已排队，等待员工启动' : ownerNeedsAttention ? '执行暂停，需核对状态' : ownerAutonomyManaged ? '授权已生效，正在核对派发' : e.requiresReview ? '来源需核对' : savedCurrent ? '已有当前准备' : assignmentProposal ? (managedByOwner ? '待确认执行边界' : '等待审核安排') : assignments.runs.length ? '安排需核对' : saved ? '准备需重新核对' : ready ? ownerConversation ? '尚无团队安排' : '待Owner提出安排' : '先确认计划'}</OwnerModuleStatus></div>
    {ownerWaitingMessage && <p role="status" className="whitespace-pre-wrap rounded-xl bg-amber-500/10 p-4 text-sm leading-6">{ownerWaitingMessage.content}</p>}
    {ownerConversation && ready && !hasAssignmentActivity && !ownerConversationWaitingForUser && <p role="status" className="rounded-xl bg-amber-500/10 p-4 text-sm leading-6">当前还没有可核对的团队安排或员工启动记录。员工尚未开始；Owner会在项目对话中说明安排结果或阻塞原因。</p>}
    {ownerStarted && <p role="status" className="rounded-xl bg-primary/10 p-4 text-sm leading-6">我已按你确认的结果和范围开始推进，正在协调执行与成果检查。出现需要你决定的事项或交付进展时，我会在这里告诉你。</p>}
    {ownerQueued && <p role="status" className="rounded-xl bg-muted/60 p-4 text-sm leading-6">工作已进入执行队列，正在等待员工启动。开始处理后，我会在这里更新进度。</p>}
    {ownerNeedsAttention && !ownerScheduleExpired && <p role="status" className="rounded-xl bg-amber-500/10 p-4 text-sm leading-6">执行状态需要核对，Owner 已暂停新的派发。下方会显示最新进度与可采取的处理方式。</p>}
    {ownerCompleted && <p role="status" className="rounded-xl bg-primary/10 p-4 text-sm leading-6">执行、独立检查和成果交付均已完成，本轮不再有待启动工作。管理授权已到期；如需拓展或修改目标，Owner会先与你确认新的范围和授权。</p>}
    {ownerScheduleExpired && <p role="alert" className="rounded-xl bg-amber-500/10 p-4 text-sm leading-6">执行授权已到期，Owner已暂停新的派发。已有进度和成果会保留；如需继续，先在上方对话重新确认管理范围与预算。</p>}
    {ownerWaitingDecision && <p role="status" className="rounded-xl bg-amber-500/10 p-4 text-sm leading-6">当前工作已停在需要你决定的事项前；Owner 不会继续派发，直到收到并核对你的答复。</p>}
    {ownerAwaitingQuality && <p role="status" className="rounded-xl bg-muted/60 p-4 text-sm leading-6">独立技术评审已返回，Owner 还需完成授权内的成果判断；判断完成后会继续推进，或带着需要你决定的问题回来。</p>}
    {ownerAwaitingAcceptance && <p role="status" className="rounded-xl bg-primary/10 p-4 text-sm leading-6">授权内执行和技术评审已完成，成果现在等待你验收。技术评审不代替你的业务验收。</p>}
    {ownerWaitingForChange && <p role="status" className="rounded-xl bg-muted/60 p-4 text-sm leading-6">当前没有待派发的工作。Owner 会在项目出现相关变化时继续判断下一步。</p>}
    {ownerAutonomyManaged && !ownerCompleted && !ownerStarted && !ownerQueued && !ownerNeedsAttention && !ownerHasSpecificWaitingState && <p role="status" className="rounded-xl bg-muted/60 p-4 text-sm leading-6">授权已经生效，我正在核对执行队列；确认员工开始处理后会在这里更新。</p>}
    {!ownerAutonomyManaged && !ready && <p className="text-sm text-muted-foreground">先确认当前计划内容，再核对执行配置。</p>}
    {!ownerAutonomyManaged && e.error && <p role="alert" className="text-sm text-destructive">{e.error}。输入已保留，请重新读取来源后核对。</p>}
    {delivery.error && <p role="alert" className="text-sm text-destructive">{delivery.error}。已保留当前方案与范围；未确认启动结果时不会自动重试。</p>}
    {delivery.saving && <p role="status" className="text-sm">正在确认当前方案…</p>}
    {delivery.loading && <p role="status" className="text-sm">正在核对项目范围和启动状态…</p>}
    {!ownerAutonomyManaged && e.loading && <p role="status" className="text-sm">正在读取本项目可用配置…</p>}
    {!ownerAutonomyManaged && saved && <><p className="text-sm">{savedCurrent ? '已有当前计划的暂停执行准备，可继续核对任务和执行授权。' : '已有暂停准备记录，当前来源是否有效需重新核对。'}</p>{!managedByOwner && <SavedFacts record={saved} />}</>}
    {ready && !managedByOwner && (!savedCurrent || editing) && !local.started && !ownerConversation && <div className="space-y-3 rounded-xl bg-card p-4 shadow-sm">
      <p className="text-sm">Owner项目经理会基于已确认计划与项目团队提出步骤范围、工作区、执行方式、岗位人员和独立评审建议。你审核、接受或退回；预算、资料范围和执行授权仍由你确认。</p>
      <button type="button" className={button} disabled={!e.loaded || busy || e.requiresReview} onClick={begin}>请 Owner 提出执行安排</button>
    </div>}
    {ready && local.started && !local.advanced && (!savedCurrent || editing) && <>
      {assignments.error && <p role="alert" className="text-sm text-destructive">{assignments.error}。没有自动重试或派工；请检查项目绑定、团队候选和Owner配置后再决定是否重新请求。</p>}
      {managedByOwner && assignmentProposal && !local.budget && e.dirty && !e.requiresReview && <div className="space-y-2 rounded-xl bg-amber-500/10 p-3 text-sm"><p>有未保存的执行范围与 Owner 新方案不同，已保留。采用新方案时会保留你的预算与资料草稿。</p><button type="button" className={button} disabled={busy} onClick={() => acceptAssignment(assignmentProposal)}>采用 Owner 新方案</button></div>}
      {managedByOwner && assignmentProposal && <><div className="space-y-3 rounded-xl bg-card p-3 text-sm shadow-sm"><p>{ownerConversation ? '我已结合你的目标整理了完成方式。' : assignmentProposal.scopeReason}</p><OwnerDevelopmentScopeSummary scope={assignmentProposal.developmentScope} ownerFacing={ownerConversation} /></div><details className="rounded-xl bg-card p-3 text-sm shadow-sm"><summary className="cursor-pointer">提出对结果或边界的调整</summary><div className="mt-3 space-y-3"><label className="block">希望调整的结果范围或边界<textarea className={field} value={local.assignmentFeedback} onChange={event => setLocal(value => ({ ...value, assignmentFeedback: event.target.value, assignmentFeedbackError: '' }))} placeholder="描述希望改变的结果或限制，不需要指定员工或执行步骤" /></label>{local.assignmentFeedbackError && <p role="alert">{local.assignmentFeedbackError}</p>}<button type="button" className={button} disabled={busy || !local.assignmentFeedback.trim()} onClick={() => void returnAssignment()}>请 Owner 按意见调整</button></div></details></>}
      {assignmentProposal && !managedByOwner && <section className="space-y-3 rounded-xl bg-primary/10 p-4 text-sm" aria-label="Owner执行安排提案">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold">Owner 已整理好执行方案</h4><OwnerModuleStatus tone="accent">{local.budget ? '待核对预算与范围' : '待确认执行边界'}</OwnerModuleStatus></div>
        <p>{assignmentProposal.scopeReason}</p>
        <OwnerDevelopmentScopeSummary scope={assignmentProposal.developmentScope} />
        <p className="text-xs text-muted-foreground">继续后仍需确认费用上限和资料访问范围，并单独确认执行授权。</p>
        {!local.budget && <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || latestAssignmentRun?.sourceStatus !== 'current'} onClick={() => acceptAssignment(assignmentProposal)}>继续确认预算与资料范围</button></div>}
        {!local.budget && <div className="space-y-2"><label className="block text-sm">希望调整什么结果或边界<textarea className={field} value={local.assignmentFeedback} onChange={event => setLocal(value => ({ ...value, assignmentFeedback: event.target.value, assignmentFeedbackError: '' }))} placeholder="描述想调整的结果、范围或限制；不用指定员工或内部步骤" /></label>{local.assignmentFeedbackError && <p role="alert" className="text-destructive">{local.assignmentFeedbackError}</p>}<button type="button" className="rounded-lg bg-background px-4 py-2 text-sm shadow-sm disabled:opacity-50" disabled={busy || !local.assignmentFeedback.trim()} onClick={() => void returnAssignment()}>请 Owner 按意见调整方案</button></div>}
      </section>}
      {latestAssignmentRun?.sourceStatus === 'stale' && <p role="status" className="rounded-lg bg-amber-500/10 p-3 text-sm">上次安排所依据的目标、计划、人员或工作区来源已变化，不能接受旧提案。{latestAssignmentRun.sourceDetail}</p>}
      {assignmentInProgress && !ownerConversation && <p role="status" className="rounded-lg bg-muted p-3 text-sm">Owner 正在提出安排。这里只刷新状态，不会重试或启动其他员工。</p>}
      {latestAssignmentRun && !assignmentInProgress && !assignmentProposal && latestAssignmentOutcome && <p role="status" className="rounded-lg bg-muted p-3 text-sm">{latestAssignmentOutcome.detail || `安排请求状态：${latestAssignmentOutcome.state}`}。不会自动重试。</p>}
      {managedByOwner && !assignmentInProgress && !latestAssignmentOutcome && <p role="status" className="rounded-lg bg-muted p-3 text-sm">Owner 已准备人员安排，等待有效的管理调用委托；请在项目对话中确认范围与额度。</p>}
      {ownerConversation && !managedByOwner && latestAssignmentRun && !assignmentInProgress && !latestAssignmentOutcome && <p role="status" className="rounded-xl bg-amber-500/10 p-4 text-sm leading-6">发现一条旧的手工安排请求，尚未启动且不属于 Owner 本轮安排。我已保留记录，不会替它启动；请勿将它视为工作已开始。旧请求自动移交给 Owner 的处理尚未接通。</p>}
      {!ownerConversation && !managedByOwner && latestAssignmentRun && !assignmentInProgress && !latestAssignmentOutcome && <div className="rounded-lg bg-muted p-3"><p className="mb-2 text-sm">安排请求已准备，实际模型请求尚未开始。下一步会显示冻结资料和可能未知的费用，需你单独确认一次。</p><ControlledTaskStartButton taskId={latestAssignmentRun.link.planningTaskId} revision={latestAssignmentRun.link.assignmentContextFingerprint ?? latestAssignmentRun.link.requestId} purpose="owner_execution_assignment" onChanged={() => loadAssignments(subject)} /></div>}
      {!managedByOwner && !assignmentProposal && !assignmentInProgress && !ownerConversation && <div className="space-y-2 rounded-xl bg-card p-4 shadow-sm">
        {!latestAssignmentRun && <p className="text-sm">提出安排前会先冻结当前计划与团队候选；准备请求本身不调用模型。</p>}
        {!e.view?.ownerBindingRevision && <p className="text-sm text-destructive">尚未找到有效的Owner模型绑定，请先完成Owner规划配置。</p>}
        <label className="block text-sm">给 Owner 的补充或修改意见（可选）<textarea className={field} value={local.assignmentFeedback} onChange={event => setLocal(value => ({ ...value, assignmentFeedback: event.target.value, assignmentFeedbackError: '' }))} placeholder="例如：优先保留研究步骤，安排不同的独立评审员" /></label>
        <button type="button" className={button} disabled={!e.loaded || busy || e.requiresReview || !e.view?.ownerBindingRevision || assignmentInProgress} onClick={() => void requestOwnerAssignment()}>{latestAssignmentRun ? '准备新的Owner安排请求' : '准备Owner安排请求'}</button>
      </div>}
      {local.budget && <>
        {ownerConversation ? <p className="rounded-xl bg-primary/10 p-4 text-sm leading-6">Owner 已按确认方案组织执行团队和独立检查。下面只需核对本次预算与允许使用的资料范围；执行方法和人员由 Owner 负责。</p> : <div className="rounded-xl bg-card p-4 text-sm shadow-sm"><h4 className="font-medium">{managedByOwner ? 'Owner 已安排的工作' : '接受的安排'}</h4><p className="mt-1">工作区：{e.view?.choices.workspaces.find(item => item.id === workspaceId)?.name ?? '未匹配'} · 执行方式：{e.executionKind === 'development' ? '研发' : '受控非研发'}</p><p>执行岗位：{roles.map(role => plan?.sources.roles.find(item => item.key === role)?.name ?? role).join('、')}；独立评审：{reviewer?.name ?? '未匹配'}</p></div>}
        {singleConfirmation && plan && <OwnerManagedExecutionApprovalSummary summary={plan.proposal.summary} steps={ownerApprovalSteps} executionKind={e.executionKind} />}
        {singleConfirmation && !ownerApprovalScopeReady && <p role="alert" className="text-sm text-destructive">确认范围无法与当前方案对应，请重新读取来源；暂未开始执行。</p>}
        {singleConfirmation && !projectBudgetReady && <p role="alert" className="text-sm text-destructive">项目执行授权当前无法确认，Owner不会启动工作，需先核对项目状态。</p>}
        {!peopleReady && <p role="status" className="text-sm text-amber-800">{singleConfirmation ? 'Owner正在核对项目执行配置；核对完成前不会启动工作。' : '当前资料或人员配置仍需核对；请完成下面的授权范围确认，系统不会因此自动派工。'}</p>}
        {singleConfirmation && ((workspaceConflict && !e.acknowledgeOwnerWorkspaceOverride) || configurationConflict) && <p role="alert" className="text-sm text-destructive">项目当前执行配置与 Owner 绑定不一致，已暂停启动；Owner需先核对项目配置。</p>}
        {!singleConfirmation && workspaceConflict && <label className="flex gap-2 text-sm"><input type="checkbox" checked={e.acknowledgeOwnerWorkspaceOverride} onChange={event => patch({ acknowledgeOwnerWorkspaceOverride: event.target.checked })} />我已核对并确认改用与 Owner 规划绑定不同的工作区</label>}
        {!singleConfirmation && configurationConflict && <label className="flex gap-2 text-sm"><input type="checkbox" checked={e.acknowledgeOwnerConfigurationOverride} onChange={event => patch({ acknowledgeOwnerConfigurationOverride: event.target.checked })} />我已核对并确认使用与 Owner 规划绑定不同的执行模型配置</label>}
      </>}
      {local.budget && <form className="space-y-3 rounded-xl bg-card p-4 shadow-sm" onSubmit={event => { event.preventDefault(); void (singleConfirmation ? reviewManaged(subject) : preview(subject)) }}>
        <h4 className="text-sm font-medium">{singleConfirmation ? '确认结果范围与必要边界' : '确认本次交付预算和资料范围'}</h4>
        <fieldset disabled={busy || !peopleReady} className="space-y-3">
          {singleConfirmation ? <p className="rounded-lg bg-primary/5 p-3 text-sm">项目费用上限：{projectBudget ? ownerMicrosToDollars(String(projectBudget.maxCostMicros)) : '正在核对'} 美元 USD。规划、执行和检查共用此上限，由 Owner 自动分配。</p> : <label className="block text-sm" htmlFor={`${id}-budget`}>项目共享费用上限（美元 USD）<input id={`${id}-budget`} className={field} inputMode="decimal" value={local.dollars ?? ownerMicrosToDollars(e.maxCostMicrosText)} onChange={event => { setLocal(value => ({ ...value, dollars: event.target.value })); patch({ maxCostMicrosText: ownerDollarsToMicros(event.target.value) }) }} /></label>}
          {local.dollars !== null && (!ownerDollarsToMicros(local.dollars) || ownerDollarsToMicros(local.dollars) === '0') && <p className="text-xs text-destructive">请输入大于零、最多六位小数的美元金额。</p>}
          {!singleConfirmation && <details open={!managedByOwner} className="space-y-2"><summary className="cursor-pointer text-sm">运行与返工边界{managedByOwner ? `（Owner建议：最多${e.maxRunsText}次、${e.maxReworkText}次返工，可调整）` : ''}</summary>
            {([['maxRunsText', '最多运行次数'], ['maxReworkText', '最多返工次数'], ['expiresAtText', '有效期至'], ['changeReason', '本次准备说明']] as const).map(([key, label]) => <label className="block text-sm" key={key}>{label}<input className={field} type={key === 'expiresAtText' ? 'datetime-local' : 'text'} inputMode={key.startsWith('max') ? 'numeric' : undefined} value={e[key]} onChange={event => patch({ [key]: event.target.value })} /></label>)}
          </details>}
          {e.executionKind === 'development' && !ownerConversation && <details className="rounded-lg bg-muted/50 p-3" open><summary className="cursor-pointer text-sm font-medium">代码范围与验证建议（已由 Owner 填写，可调整）</summary><div className="mt-2 space-y-2">{([['targetPathsText', '本次目标路径（每行一条）'], ['allowedPathsText', '允许修改的路径（每行一条）'], ['verificationCommandsText', '建议验证命令（每行一条；尚未执行）']] as const).map(([key, label]) => <label className="block text-sm" key={key}>{label}<textarea className={field} value={e[key]} onChange={event => patch({ [key]: event.target.value })} /></label>)}</div></details>}
          <fieldset><legend className="text-sm">{singleConfirmation ? '本次会参考的项目资料（可调整）' : '本次可访问的项目资料'}</legend>{e.view?.choices.knowledgeSources.length ? e.view.choices.knowledgeSources.map(source => <label className="mt-2 flex gap-2 text-sm" key={source.id}><input type="checkbox" checked={e.knowledgeSourceIds.includes(source.id)} onChange={event => patch({ knowledgeSourceIds: event.target.checked ? [...e.knowledgeSourceIds, source.id] : e.knowledgeSourceIds.filter(value => value !== source.id) })} />{source.name}</label>) : <p className="mt-2 text-xs text-muted-foreground">当前项目没有可选知识资料。</p>}</fieldset>
          {!singleConfirmation && e.roleBudgetCapsEnabled && <p className="text-sm">已有岗位单独上限，将一并保留；请在高级设置中调整，并核对下方完整预览。</p>}
          <p className="text-xs text-muted-foreground">{singleConfirmation ? '确认后 Owner 会按此结果与边界开始执行；只有需要扩大范围或作业务判断时才会再与你商量。' : '这里登记预算方案，不预留额度。执行准备保存后仍需在 Owner 对话中明确确认授权与启动；费用未知时会占用预留额度。运行次数包含执行及评审请求。'}</p>
          <button type="submit" className={button} disabled={busy || (singleConfirmation ? !canApproveAndStart || !ownerApprovalScopeReady : !canPreview)}>{busy ? singleConfirmation ? '正在确认方案并启动…' : '正在整理执行范围…' : singleConfirmation ? '确认方案并开始执行' : '生成执行准备摘要'}</button>
        </fieldset>
      </form>}
      {!singleConfirmation && e.preview && peopleReady && <div className="space-y-3"><PreviewFacts preview={e.preview} /><button type="button" className={button} disabled={!canSave} onClick={() => void saveReviewed()}>{e.saving ? '正在保存…' : '确认摘要，保存暂停准备'}</button></div>}
    </>}
    {savedCurrent && !editing && <button type="button" className={button} disabled={busy} onClick={begin}>调整执行准备</button>}
    {!ownerAutonomyManaged && e.requiresReview && <div className="space-y-2 rounded-xl bg-card p-4 text-sm shadow-sm">
      <p>来源需要重新核对。当前工作区：{e.view?.choices.workspaces.map(workspace => workspace.name).join('、') || '无可用工作区'}；Owner 模型建议：{config ? `${config.channelId} / ${config.modelId} / ${config.runtime}` : '无有效建议'}。</p>
      <p>已保留你的人员和预算输入。比较已登记快照与当前来源；确认后仍须生成新摘要，旧预览不会沿用。</p>
      <button type="button" className={button} disabled={!e.loaded || busy} onClick={() => compare(subject)}>已核对当前来源，保留输入继续</button>
    </div>}
    {!ownerConversation && <div className="flex flex-wrap gap-3 text-sm"><button type="button" disabled={busy} className="disabled:opacity-50" onClick={() => void load(subject)}>重新读取执行配置</button><button type="button" className="underline underline-offset-4" onClick={() => setLocal(value => ({ ...value, advanced: !value.advanced, dollars: null }))}>{local.advanced ? '返回配置对话' : '执行准备高级设置与历史'}</button></div>}
    {local.advanced && <ProjectOwnerExecutionPreparationPanel projectId={projectId} taskId={taskId} showDownstream={false} />}
    {saved && <ProjectOwnerDeliveryConversation projectId={projectId} taskId={taskId} managed={managedByOwner} singleConfirmation={singleConfirmation} ownerConversation={ownerConversation} />}
  </section>
}
