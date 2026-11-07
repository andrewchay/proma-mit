import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { atom, useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ownerDeliveryValidationBlocker, type OwnerManagementDeliveryReference } from '@gravitas/shared'
import { confirmOwnerTeamWorkspaceAccessAtom, editOwnerMessageAtom, getOwnerManagementEditor, getOwnerMessageComposer, loadOwnerManagementAtom, ownerAttentionAlertKey, ownerAttentionAlertsAtom, ownerManagementEditorsAtom, ownerMessageComposersAtom, ownerTeamWorkspaceApprovalStatesAtom, sendOwnerMessageAtom } from '../../atoms/project-owner-management-atoms'
import { getOwnerDelegationEditor, ownerDelegationEditorsAtom } from '../../atoms/owner-management-delegation-atoms'
import { getOwnerPlanEditor, loadOwnerPlanAtom, loadOwnerPlanHistoryAtom, ownerPlanEditorsAtom } from '../../atoms/project-owner-plan-atoms'
import { getOwnerExecutionAssignmentEditor, ownerExecutionAssignmentEditorsAtom } from '../../atoms/project-owner-execution-assignment-atoms'
import { allPendingPermissionRequestsAtom } from '../../atoms/agent-atoms'
import { retakeOwnerAssignmentAtom } from '../../atoms/project-owner-management-atoms'
import { PermissionBanner } from '../agent/PermissionBanner'
import { Button } from '../ui/button'
import { RichTextInput } from '../ai-elements/rich-text-input'
import { cn, formatMessageTime } from '../../lib/utils'
import { OwnerConversationChanges } from './OwnerConversationChanges'
import { OwnerDeliveredArtifact } from './OwnerDeliveredArtifact'
import { OwnerDeliveryCatalog } from './OwnerDeliveryCatalog'
import { OwnerDesignHistory, designDeliveryAnchor, revealOwnerHistoryTarget } from './OwnerDesignHistory'
import { OwnerDesignBrief } from './OwnerDesignBrief'
import { findLatestDeliveryReview, findReferencedDelivery } from './owner-delivery-reference'
import { OwnerManagementQuestions } from './OwnerManagementQuestions'
import { OwnerAcceptanceCard } from './OwnerAcceptanceCard'
import { OwnerDeliveredDecisionCard } from './OwnerDeliveredDecisionCard'
import { ownerAcceptanceChainsAtom, ownerAcceptancePendingAtom, rememberOwnerAcceptanceChainAtom } from '@/atoms/owner-acceptance-chain-atoms'
import { ownerDiscussionTimeline, type OwnerDiscussionEntry } from './owner-discussion-timeline'
import { getOwnerDispatchEditor, getOwnerDispatchEvents, loadOwnerDispatchEventsAtom, ownerDispatchControlsAtom, ownerDispatchEventsAtom } from '../../atoms/owner-dispatch-control-atoms'
import { WebChangeObservationCard } from './WebChangeObservationCard'
import { getOwnerWaitingLabel, getOwnerWaitingMessage, hasCompletedOwnerDelivery, isOwnerWaitingForUser } from './project-owner-progress-state'
import { getOwnerCommandProgress, loadOwnerCommandProgressAtom, ownerCommandProgressAtom } from '@/atoms/owner-command-progress-atoms'
import { getOwnerGrantEditor, loadOwnerGrantAtom, loadOwnerGrantHistoryAtom, ownerGrantEditorsAtom } from '@/atoms/project-owner-execution-grant-atoms'
import { CornerDownLeft } from 'lucide-react'
import { sendWithCmdEnterAtom } from '../../atoms/shortcut-atoms'

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 })
const ORGANIZATION_STALL_HINT_MS = 2 * 60 * 1000
const dismissedEvidenceAlertsAtom = atom(new Set<string>())
function ownerFacingMessage(content: string): string {
  try {
    const value: unknown = JSON.parse(content)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return content
    const result = value as { schemaVersion?: unknown; verdict?: unknown; summary?: unknown; criteria?: unknown }
    if (result.schemaVersion !== 2 || !['approved', 'changes_requested', 'blocked'].includes(String(result.verdict)) || typeof result.summary !== 'string') return content
    const verdict = result.verdict === 'approved' ? '检查通过' : result.verdict === 'changes_requested' ? '需要修改' : '暂时无法确认'
    const criteria = Array.isArray(result.criteria) ? result.criteria.flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const criterion = item as { criterion?: unknown; status?: unknown }
      if (typeof criterion.criterion !== 'string' || !['met', 'not_met', 'not_verified'].includes(String(criterion.status))) return []
      const status = criterion.status === 'met' ? '符合' : criterion.status === 'not_met' ? '未符合' : '尚未核实'
      return [`• ${criterion.criterion}：${status}`]
    }) : []
    return [`独立检查：${verdict}`, result.summary, ...criteria].join('\n')
  } catch { return content }
}
function ownerTraceStatus(entry: NonNullable<import('@gravitas/shared').OwnerManagementView['trace']>[number]): string {
  if (entry.phase === 'owner_response') return entry.state === 'queued' ? '补充或进展已排队，等待 Owner 回复。' : entry.state === 'started' ? 'Owner 正在处理你的补充或最新项目进展。' : entry.state === 'completed' ? 'Owner 已完成本轮对话跟进。' : entry.state === 'waiting' ? 'Owner 的回复需要你决定下一步。' : 'Owner 对话跟进需要核对。'
  if (entry.phase === 'assignment_preparation') return entry.state === 'blocked' ? '团队核对发现阻塞，安排未启动。' : entry.state === 'completed' ? '团队能力核对已完成。' : '正在核对项目团队能力。'
  if (entry.phase === 'assignment_run') return entry.state === 'queued' ? '安排请求已排队，等待运行开始。' : entry.state === 'started' ? '正在生成内部团队安排。' : entry.state === 'completed' ? '内部安排已生成，正在核对下一步。' : entry.state === 'waiting' ? '安排结果需要你决定。' : '安排请求未能形成可用结果，需要核对。'
  if (entry.phase === 'execution_start') return entry.state === 'started' ? '正在核验并启动已确认的工作。' : entry.state === 'completed' ? '执行启动核对已完成。' : '执行启动需要核对。'
  if (entry.phase === 'executor') return entry.state === 'stalled' ? '执行阶段较长时间没有新心跳。' : entry.state === 'expired' ? '执行授权已到期。' : entry.state === 'completed' ? '执行结果已返回，等待 Owner 检查。' : '执行未能正常完成。'
  if (entry.phase === 'reviewer') return entry.state === 'stalled' ? '独立检查较长时间没有新心跳。' : entry.state === 'completed' ? '独立检查结果已返回。' : entry.state === 'expired' ? '检查授权已到期。' : '独立检查未能正常完成。'
  return entry.state === 'completed' ? 'Owner 正在整理质量检查结果。' : 'Owner 质量检查需要核对。'
}
function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return seconds < 60 ? `已等待 ${seconds} 秒` : `已等待 ${Math.floor(seconds / 60)} 分钟`
}
/** 一个项目入口承载历史、必要卡片与同一输入框；草稿按主体保留，不随切页丢失。 */
export function OwnerManagementConversation({ projectId, taskId, children, currentFocus, progress, planDetails, planDetailsId, workspaceName, showProjectDetails, projectDetailsKind, onProjectDetailsHost, onShowOwner }: { projectId: string; taskId?: string; children: ReactNode; currentFocus?: ReactNode; progress?: ReactNode; planDetails?: ReactNode; planDetailsId?: string; workspaceName?: string; showProjectDetails?: boolean; projectDetailsKind?: 'tasks' | 'chain' | 'knowledge' | 'pilot'; onProjectDetailsHost?: React.RefCallback<HTMLDivElement>; onShowOwner?: () => void }): React.ReactElement {
  const settingsId = useId()
  // 讨论栏展开状态随项目或任务隔离，消息草稿仍由既有 composer 管理。
  const discussionOpenAtom = useMemo(() => atom(window.matchMedia('(min-width: 1280px)').matches), [projectId, taskId])
  const wideScreenAtom = useMemo(() => atom(window.matchMedia('(min-width: 1280px)').matches), [])
  const [wideScreen, setWideScreen] = useAtom(wideScreenAtom)
  useEffect(() => { const query = window.matchMedia('(min-width: 1280px)'); const update = () => setWideScreen(query.matches); query.addEventListener('change', update); return () => query.removeEventListener('change', update) }, [setWideScreen])
  const [discussionOpen, setDiscussionOpen] = useAtom(discussionOpenAtom)
  const subject = useMemo(() => ({ projectId, ...(taskId ? { taskId } : {}) }), [projectId, taskId])
  const dispatchEvents = getOwnerDispatchEvents(useAtomValue(ownerDispatchEventsAtom), subject)
  const loadDispatchEvents = useSetAtom(loadOwnerDispatchEventsAtom)
  const view = useMemo(() => atom(get => ({ editor: getOwnerManagementEditor(get(ownerManagementEditorsAtom), projectId), composer: getOwnerMessageComposer(get(ownerMessageComposersAtom), subject), plan: getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject), delegation: getOwnerDelegationEditor(get(ownerDelegationEditorsAtom), subject), usage: getOwnerCommandProgress(get(ownerCommandProgressAtom), subject) })), [projectId, subject])
  const { editor, composer, plan, delegation, usage } = useAtomValue(view)
  useEffect(() => { if (editor.view?.manager) void loadDispatchEvents(subject) }, [editor.view?.manager, loadDispatchEvents, subject])
  const grant = getOwnerGrantEditor(useAtomValue(ownerGrantEditorsAtom), subject)
  const dispatchControls = useAtomValue(ownerDispatchControlsAtom)
  const dispatchPaused = grant.grant ? getOwnerDispatchEditor(dispatchControls, subject.projectId, grant.grant.grantId).control?.paused : false
  const loadGrant = useSetAtom(loadOwnerGrantAtom)
  const loadPlanHistory = useSetAtom(loadOwnerPlanHistoryAtom)
  const loadGrantHistory = useSetAtom(loadOwnerGrantHistoryAtom)
  const refreshCommandProgress = useSetAtom(loadOwnerCommandProgressAtom)
  const acceptanceChain = useAtomValue(ownerAcceptanceChainsAtom).get(projectId)
  const pendingAcceptance = [...useAtomValue(ownerAcceptancePendingAtom).values()].find(request => request.projectId === projectId)
  const rememberAcceptanceChain = useSetAtom(rememberOwnerAcceptanceChainAtom)
  const [acceptanceHistoryError, setAcceptanceHistoryError] = useState(false)
  useEffect(() => {
    let active = true
    const getChain = window.electronAPI?.paa?.project?.getChain
    const refresh = () => { if (getChain) void getChain(projectId).then(chain => { if (active) { rememberAcceptanceChain({ projectId, chain }); setAcceptanceHistoryError(false) } }).catch(() => { if (active) setAcceptanceHistoryError(true) }) }
    refresh()
    window.addEventListener('focus', refresh)
    return () => { active = false; window.removeEventListener('focus', refresh) }
  }, [projectId, rememberAcceptanceChain])
  useEffect(() => { if (plan.snapshot) void loadGrant(subject) }, [loadGrant, subject, plan.snapshot?.revision])
  useEffect(() => { if (editor.view?.manager && !plan.historyLoaded && !plan.historyLoading && !plan.historyError) void loadPlanHistory(subject) }, [editor.view?.manager, plan.historyLoaded, plan.historyLoading, plan.historyError, loadPlanHistory, subject])
  useEffect(() => { if (editor.view?.manager && !grant.historyLoaded && !grant.historyLoading && !grant.historyError && !grant.confirming && !grant.revoking) void loadGrantHistory(subject) }, [editor.view?.manager, grant.historyLoaded, grant.historyLoading, grant.historyError, grant.confirming, grant.revoking, loadGrantHistory, subject])
  const [attentionAlerts, setAttentionAlerts] = useAtom(ownerAttentionAlertsAtom)
  const [dismissedEvidenceAlerts, setDismissedEvidenceAlerts] = useAtom(dismissedEvidenceAlertsAtom)
  const attentionKey = ownerAttentionAlertKey(projectId, taskId)
  const alertMessageId = attentionAlerts.get(attentionKey)?.messageId
  const pendingPermissions = useAtomValue(allPendingPermissionRequestsAtom)
  const sendWithCmdEnter = useAtomValue(sendWithCmdEnterAtom)
  const pendingAction = editor.view?.actionRequests?.find(item =>
    (taskId === undefined || item.taskId === taskId) && pendingPermissions.get(item.sessionId)?.[0]?.requestId === item.requestId
    && pendingPermissions.get(item.sessionId)?.[0]?.requiresPerActionApproval,
  )
  const workspaceApprovalStates = useAtomValue(ownerTeamWorkspaceApprovalStatesAtom)
  const approveWorkspace = useSetAtom(confirmOwnerTeamWorkspaceAccessAtom)
  const retakeAssignment = useSetAtom(retakeOwnerAssignmentAtom)
  const artifactWorkspaceRef = useRef<HTMLElement>(null)
  const discussionLauncherRef = useRef<HTMLButtonElement>(null)
  const discussionCloseRef = useRef<HTMLButtonElement>(null)
  const pendingDiscussionFocus = useRef<'open' | 'close' | null>(null)
  useEffect(() => {
    if (pendingDiscussionFocus.current === 'open' && discussionOpen) discussionCloseRef.current?.focus()
    if (pendingDiscussionFocus.current === 'close' && !discussionOpen) discussionLauncherRef.current?.focus()
    pendingDiscussionFocus.current = null
  }, [discussionOpen])
  const [selectedDelivery, setSelectedDelivery] = useState<{ messageId: string; stepKey: string; artifactHash: string } | null>(null)
  useEffect(() => setSelectedDelivery(null), [projectId, taskId])
  useEffect(() => { if (selectedDelivery && artifactWorkspaceRef.current) { artifactWorkspaceRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }); artifactWorkspaceRef.current.focus({ preventScroll: true }) } }, [selectedDelivery])
  const [retakeStatus, setRetakeStatus] = useState('')
  const [retakeRequested, setRetakeRequested] = useState(false)
  const assignmentEditors = useAtomValue(ownerExecutionAssignmentEditorsAtom)
  const assignmentRuns = getOwnerExecutionAssignmentEditor(assignmentEditors, subject).runs
  const staleAssignment = assignmentRuns[0]?.sourceStatus === 'stale'
    && !assignmentRuns.some(run => run.executions.some(execution => execution.status === 'queued' || execution.status === 'running'))
  useEffect(() => { if (subject.projectId) { setRetakeStatus(''); setRetakeRequested(false) } }, [subject])
  const load = useSetAtom(loadOwnerManagementAtom), loadPlan = useSetAtom(loadOwnerPlanAtom), edit = useSetAtom(editOwnerMessageAtom), send = useSetAtom(sendOwnerMessageAtom)
  const loadedMessage = useRef('')
  const [clock, setClock] = useState(Date.now())
  const reviewHistory = editor.view?.reviewHistory?.filter(round => taskId === undefined || round.taskId === taskId) ?? []
  const blockedReviews = reviewHistory.filter((round, index) => round.businessTaskId && round.qualityState === 'blocked' && reviewHistory.findIndex(item => item.businessTaskId === round.businessTaskId) === index)
  const messages = editor.view?.messages.filter(message => message.taskId === taskId && message.kind !== 'goal') ?? []
  const timeline = ownerDiscussionTimeline(messages, plan.history, plan.snapshot, grant.history, grant.grant, dispatchEvents.events)
  const latestUserMessage = messages.findLast(message => message.role === 'user')
  const latestUserMessageIndex = timeline.findIndex(entry => entry.kind === 'message' && entry.message.id === latestUserMessage?.id)
  const latestMessageIndex = timeline.findLastIndex(entry => entry.kind === 'message')
  const latestRoundStart = latestUserMessageIndex >= 0 ? latestUserMessageIndex : Math.max(0, latestMessageIndex)
  const olderEntries = timeline.slice(0, latestRoundStart)
  const latestEntries = timeline.slice(latestRoundStart)
  const latestAssistantMessage = messages.findLast(message => message.role === 'assistant')
  const latestAttention = latestAssistantMessage?.kind === 'attention' ? latestAssistantMessage : undefined
  const priorAttention = !latestAttention ? messages.findLast(message => message.role === 'assistant' && message.kind === 'attention') : undefined
  const alertMessage = messages.find(message => message.id === alertMessageId && message.role === 'assistant' && message.kind === 'attention')
  const dismissAttention = () => setAttentionAlerts(previous => { if (previous.get(attentionKey)?.messageId !== alertMessageId) return previous; const next = new Map(previous); next.delete(attentionKey); return next })
  const latestWorkspaceProposal = latestAssistantMessage?.teamWorkspaceProposal
    && !workspaceApprovalStates.get(latestAssistantMessage.id)?.approved
    && !messages.some(message => message.teamWorkspaceApproval?.sourceMessageId === latestAssistantMessage.id)
    ? latestAssistantMessage : undefined
  const allTraces = editor.view?.trace ?? []
  const assignmentRunIndex = allTraces.findLastIndex(entry => entry.phase === 'assignment_run' && (taskId === undefined || entry.taskId === taskId))
  const latestAssignmentRun = assignmentRunIndex >= 0 ? allTraces[assignmentRunIndex] : undefined
  const assignmentSuperseded = latestAssignmentRun && (allTraces.slice(assignmentRunIndex + 1).some(entry => (taskId === undefined || entry.taskId === taskId) && ['execution_start', 'executor', 'reviewer', 'owner_quality', 'owner_response'].includes(entry.phase))
    || messages.some(message => message.kind === 'delivery' && message.createdAt >= latestAssignmentRun.createdAt))
  const assignmentTrace = assignmentSuperseded ? undefined : latestAssignmentRun
  const assignmentActive = assignmentTrace && ['queued', 'started'].includes(assignmentTrace.state)
  const scopedTraces = allTraces.filter(entry => taskId === undefined || entry.taskId === taskId)
  const latestTraceByPhase = new Map(scopedTraces.map(entry => [entry.phase, entry]))
  const deliveryTimes = messages.filter(message => message.kind === 'delivery').map(message => message.createdAt)
  const phases = ['assignment_preparation', 'assignment_run', 'execution_start', 'executor', 'reviewer', 'owner_quality', 'owner_response']
  const hasActiveTrace = [...latestTraceByPhase.entries()].some(([phase, entry]) => {
    if (entry.state !== 'queued' && entry.state !== 'started') return false
    const phaseIndex = phases.indexOf(phase)
    const supersededByLaterPhase = [...latestTraceByPhase.entries()].some(([laterPhase, laterEntry]) => phases.indexOf(laterPhase) > phaseIndex && laterEntry.createdAt >= entry.createdAt)
    const supersededByDelivery = deliveryTimes.some(createdAt => createdAt >= entry.createdAt)
    // 旧版本可能漏写回复完成的 trace；后续真实回复可阻止旧 started 一直显示为进行中。
    const supersededByReply = phase === 'owner_response' && messages.some(message => message.role === 'assistant'
      && ['reply', 'conversation', 'clarification', 'answer', 'plan_proposal', 'change_proposal', 'change_decision', 'delivery'].includes(message.kind)
      && message.createdAt >= entry.createdAt)
    return !supersededByLaterPhase && !supersededByDelivery && !supersededByReply
  })
  useEffect(() => {
    if (!assignmentActive) return
    const timer = window.setInterval(() => setClock(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [assignmentActive])
  const lastMessageId = editor.view?.messages.at(-1)?.id
  useEffect(() => {
    const marker = JSON.stringify([projectId, taskId, lastMessageId])
    if (!lastMessageId || plan.loading || plan.saving || loadedMessage.current === marker) return
    loadedMessage.current = marker
    void loadPlan(subject)
  }, [lastMessageId, plan.loading, plan.saving, loadPlan, projectId, taskId, subject])
  useEffect(() => {
    let disposed = false, running = false, queued = false
    const refresh = () => {
      queued = true
      if (running) return
      running = true
      void (async () => {
        try {
          while (queued && !disposed) {
            queued = false
            await load(projectId)
            if (disposed) break
            await loadPlan(subject)
            await loadGrant(subject)
            if (!disposed) await Promise.all([loadPlanHistory(subject), loadGrantHistory(subject)])
          }
        } finally { running = false }
      })()
    }
    refresh(); window.addEventListener('focus', refresh)
    const off = window.electronAPI?.paa?.project?.onOwnerManagementChanged?.(change => { if (change.projectId === projectId) refresh() })
    return () => { disposed = true; window.removeEventListener('focus', refresh); off?.() }
  }, [load, loadPlan, loadGrant, loadPlanHistory, loadGrantHistory, projectId, subject])
  // 项目Owner消息属于同一段持续对话：执行、确认与交付都必须留在用户眼前，
  // 不能因为写入时的目标版本较旧就在确认后整段消失。
  const waitingForUser = isOwnerWaitingForUser(messages)
  const waitingMessage = getOwnerWaitingMessage(messages, taskId)
  const decisionLabel = waitingMessage?.kind !== 'attention' ? getOwnerWaitingLabel(messages, taskId) : null
  const waitingForDecision = decisionLabel !== null
  const authorizationDecision = ['none', 'expired', 'stale', 'revoked', 'exhausted'].includes(delegation.view?.state ?? '')
  const needsArrangementRetry = staleAssignment || Boolean(latestAttention?.content.includes('人员安排'))
  const hasOpenQuestions = editor.view?.questions.some(question => question.state === 'open' && question.taskId === taskId)
  const hasPendingChange = editor.view?.changes?.some(change => change.state === 'pending' && change.taskId === taskId)
  const planRisks = plan.snapshot?.proposal.risks ?? []
  const ownerBudget = delegation.view?.ownerModelBudget
  const teamUsage = usage.loaded && usage.schedule?.grantId ? usage.schedule : undefined
  const awaitingBusinessAcceptance = Boolean(grant.grant && teamUsage?.grantId === grant.grant.grantId && teamUsage.state === 'waiting' && teamUsage.nextAction === 'await_business_acceptance')
  const acceptanceSchedule = pendingAcceptance ? { projectId, state: 'waiting' as const, nextAction: 'await_business_acceptance' as const, grantId: pendingAcceptance.grantId, taskId: pendingAcceptance.taskId, reworkOrdinal: pendingAcceptance.reworkOrdinal, reservedCostMicros: 0, committedCostMicros: 0, runReservations: 0, reason: '' } : awaitingBusinessAcceptance ? teamUsage : undefined
  const deliveredRound = grant.grant?.dispatchMode === 'autonomous' && hasCompletedOwnerDelivery(messages, usage.commands, taskId, plan.snapshot?.planVersion, grant.grant.grantId)
    ? messages.findLast(message => message.kind === 'delivery' && message.delivery?.planVersion === plan.snapshot?.planVersion && message.eventId?.startsWith(`owner-delivery:${grant.grant!.grantId}:`)) : undefined
  const pendingDeliveredItem = deliveredRound?.delivery?.items.find(item => !findLatestDeliveryReview(editor.view?.messages ?? [], taskId, { messageId: deliveredRound.id, stepKey: item.stepKey, artifactHash: item.artifactHash }))
  const pendingDeliveredReference = deliveredRound && pendingDeliveredItem ? { messageId: deliveredRound.id, stepKey: pendingDeliveredItem.stepKey, artifactHash: pendingDeliveredItem.artifactHash } : undefined
  const validationFor = (reference: OwnerManagementDeliveryReference | null | undefined) => reference ? editor.view?.deliveryValidations?.find(record => record.messageId === reference.messageId && record.artifactHash === reference.artifactHash && (!reference.stepKey || record.stepKey === reference.stepKey)) : undefined
  const acceptanceBlocker = ownerDeliveryValidationBlocker(validationFor(pendingDeliveredReference))
  const evidenceRisk = deliveredRound?.delivery?.items.map(item => {
    const reference = { messageId: deliveredRound.id, stepKey: item.stepKey, artifactHash: item.artifactHash }
    return { reference, blocker: ownerDeliveryValidationBlocker(validationFor(reference)) }
  }).find(item => item.blocker)
  const evidenceBlocker = evidenceRisk?.blocker
  const evidenceAlertKey = evidenceRisk ? JSON.stringify([projectId, taskId ?? null, evidenceRisk.reference, evidenceBlocker]) : ''
  const acceptanceHistory = (acceptanceChain?.events ?? []).filter(event => (event.action === 'accept' || event.action === 'reject') && !messages.some(message => message.chainReview?.draftId === event.entityId && message.chainReview.version === event.version && message.chainReview.choice === event.action) && [...(acceptanceChain?.draftHistory ?? []), ...(acceptanceChain?.drafts ?? [])].some(draft => draft.id === event.entityId && draft.version === event.version && (!taskId || draft.taskId === taskId) && usage.commands.some(command => command.taskId === draft.taskId && command.executionId === draft.executionId)))
  const ownerProcessing = (composer.sending || hasActiveTrace) && !waitingForUser
    && editor.view?.manager?.status !== 'paused' && delegation.view?.state !== 'stale' && delegation.view?.state !== 'attention'
  // 普通对话不再落占位回复；当最新消息仍在等待 Owner 回应或回应运行在进行中时，像普通聊天一样显示正在处理。
  const lastTimelineEntry = timeline.at(-1)
  const lastTimelineMessage = lastTimelineEntry?.kind === 'message' ? lastTimelineEntry.message : undefined
  const ownerResponseTrace = latestTraceByPhase.get('owner_response')
  const ownerReplyRunning = Boolean(ownerResponseTrace && ['queued', 'started'].includes(ownerResponseTrace.state)
    && !messages.some(message => message.role === 'assistant'
      && ['reply', 'conversation', 'clarification', 'answer', 'plan_proposal', 'change_proposal', 'change_decision', 'delivery'].includes(message.kind)
      && message.createdAt >= ownerResponseTrace.createdAt))
  const showOwnerWorking = Boolean(editor.view?.manager && editor.view.manager.status === 'active'
    && (composer.sending || ownerReplyRunning
      || (lastTimelineMessage?.role === 'user' && lastTimelineMessage.deliveryReviewDecision !== 'deferred' && !lastTimelineMessage.teamWorkspaceApproval)))
  const revealDiscussionTarget = (target: string): void => {
    setDiscussionOpen(true)
    requestAnimationFrame(() => revealOwnerHistoryTarget(target))
  }
  const closeDiscussion = (): void => {
    if (!wideScreen) pendingDiscussionFocus.current = 'close'
    setDiscussionOpen(false)
  }
  const openDiscussion = (): void => {
    pendingDiscussionFocus.current = 'open'
    setDiscussionOpen(true)
  }
  const currentStatus = editor.loading && !editor.view ? '正在读取项目状态'
    : editor.error ? '项目状态读取失败，需要重新读取'
      : pendingAction ? '员工操作等待你的逐次确认'
        : latestAttention ? 'Owner 提出需要关注的事项'
          : blockedReviews.length > 0 ? '成果质量决定被阻断，需要核对'
          : delegation.view?.state === 'attention' ? '项目管理需要核对'
          : delegation.view?.state === 'stale' ? '项目授权范围已变化，需重新核对'
            : editor.view?.manager?.status === 'paused' ? '项目管理已暂停'
              : dispatchPaused ? '后续自主派工已暂停'
              : authorizationDecision && editor.view?.manager ? '项目管理授权需要确认'
              : evidenceBlocker ? '成果验证证据需要核对'
              : awaitingBusinessAcceptance ? '成果等待人工业务验收'
              : waitingForDecision || hasOpenQuestions || hasPendingChange ? 'Owner 正在等待你的决定'
                : ownerProcessing ? 'Owner 正在处理项目工作'
                  : grant.grant?.dispatchMode === 'autonomous' && hasCompletedOwnerDelivery(messages, usage.commands, taskId, plan.snapshot?.planVersion, grant.grant.grantId) ? '本轮成果已交付'
                  : assignmentTrace ? ownerTraceStatus(assignmentTrace)
                    : !editor.view?.manager ? 'Owner 尚未完成准备' : '等待下一步项目进展'
  const focusReplyComposer = (): void => {
    setDiscussionOpen(true)
    requestAnimationFrame(() => {
      const reply = document.querySelector<HTMLElement>('form[aria-label="向Owner发送消息"] [contenteditable="true"][aria-label="给项目 Owner 的消息"]')
      reply?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      reply?.focus()
    })
  }
  const referencedDelivery = composer.deliveryReference
    ? findReferencedDelivery(editor.view?.messages ?? [], taskId, composer.deliveryReference)
    : undefined
  const composerBlocker = composer.deliveryReviewDecision === 'accepted' ? ownerDeliveryValidationBlocker(validationFor(composer.deliveryReference)) : null
  const canSendMessage = !composer.sending && Boolean(composer.text.trim() || composer.deliveryReviewDecision) && composer.text.trim().length + (composer.deliveryReviewDecision ? 18 : 0) <= 4000 && (!composerBlocker || Boolean(composer.pending))
    && !(composer.deliveryReference && !referencedDelivery)
  const selectDelivery = (reference: { messageId: string; stepKey: string; artifactHash: string }): void => { onShowOwner?.(); setSelectedDelivery(reference); if (!wideScreen) setDiscussionOpen(false) }
  const selectedArtifact = selectedDelivery ? findReferencedDelivery(editor.view?.messages ?? [], taskId, selectedDelivery) : undefined
  const selectedBlocker = ownerDeliveryValidationBlocker(validationFor(selectedDelivery))
  const selectedReview = selectedDelivery ? findLatestDeliveryReview(editor.view?.messages ?? [], taskId, selectedDelivery) : undefined
  const renderMessage = (message: (typeof messages)[number]) => (
    <article key={message.id} id={`owner-message-${message.id}`} tabIndex={-1} className={`max-w-3xl rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm ${message.role === 'user' ? 'ml-6 rounded-tr-sm bg-primary/10' : 'mr-6 rounded-tl-sm bg-muted/60'}`}>
        <header className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-muted-foreground">
          <span className="font-medium">{message.role === 'user' ? '你' : '项目 Owner'}</span>
          <time dateTime={new Date(message.createdAt).toISOString()}>{formatMessageTime(message.createdAt)}</time>
        </header>
        {message.kind === 'employee_interaction' && message.employeeInteraction && <section className="mb-3 rounded-xl bg-amber-500/10 p-3" aria-label="员工待决事项">
          <div className="flex items-center justify-between gap-3"><p className="font-medium">员工需要 Owner 判断</p><span className="rounded-full bg-background/70 px-2 py-1 text-xs">{({ pending_owner: '等待 Owner', discussing_user: '讨论中', decided: '已决定', delivering: '回传中', resolved: '已回传', cancelled: '已取消', stale: '已失联', delivery_failed: '回传失败' } as Record<string, string>)[(editor.view?.employeeInteractions?.find(item => item.id === message.employeeInteraction?.id) ?? message.employeeInteraction).state] ?? '状态待核对'}</span></div>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm">{message.employeeInteraction.summary}</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">这是员工执行中的待决事项，不是用户授权。权限、预算、访问范围和系统接管仍须由你在明确入口中确认；Owner不能代签。</p>
        </section>}
        {message.role === 'user' && message.deliveryReviewDecision && <p className="mb-2 text-xs font-medium text-primary">{message.deliveryReviewDecision === 'accepted' ? '你认可了这个成果版本' : message.deliveryReviewDecision === 'deferred' ? '你选择稍后决定' : '你要求修改这个成果版本'} · 审阅记录{message.deliveryReference && (() => { const item = findReferencedDelivery(editor.view?.messages ?? [], taskId, message.deliveryReference!); return item ? ` · ${item.title}（${message.deliveryReference!.artifactHash.slice(0, 12)}）` : ' · 成果版本待核对' })()}</p>}
        {message.chainReview && <p className="mb-2 text-xs font-medium text-primary">{message.chainReview.choice === 'accept' ? '你验收通过' : message.chainReview.choice === 'reject' ? '你要求修改' : '你选择稍后决定'} · 版本 {message.chainReview.version}</p>}
        {message.role === 'user' && message.deliveryReference && !message.deliveryReviewDecision && (() => {
          const reference = message.deliveryReference
          const item = findReferencedDelivery(editor.view?.messages ?? [], taskId, reference)
          return item ? <button type="button" className="mb-2 block text-left text-xs font-medium text-primary underline underline-offset-2" onClick={() => selectDelivery({ ...reference, stepKey: item.stepKey })}>查看关联成果：{item.title}（{reference.artifactHash.slice(0, 12)}）</button> : <p className="mb-2 text-xs text-muted-foreground">关联成果版本待核对</p>
        })()}
        {message.role === 'user' && (message.kind === 'answer' || message.kind === 'change_decision' || message.teamWorkspaceApproval) && <p className="mb-2 text-xs font-medium text-primary">{message.kind === 'answer' ? '你的已保存答复' : message.kind === 'change_decision' ? '你的变更决定' : '你的资料范围确认'}</p>}
        <p className="whitespace-pre-wrap break-words">{ownerFacingMessage(message.content)}</p>
        {message.teamWorkspaceApproval && <p className="mt-2 text-xs text-muted-foreground">工作区范围已确认。</p>}
        {message.runEvidence && <details className="mt-2 rounded-lg bg-background/70 p-3 text-xs" aria-label="本轮请求证据（只读）">
          <summary className="cursor-pointer font-medium">本轮请求证据（只读）</summary>
          <dl className="mt-2 grid gap-1 sm:grid-cols-2">
            <div><dt className="text-muted-foreground">输入 token</dt><dd>{message.runEvidence.inputTokens ?? '未知'}</dd></div>
            <div><dt className="text-muted-foreground">输出 token</dt><dd>{message.runEvidence.outputTokens ?? '未知'}</dd></div>
            <div><dt className="text-muted-foreground">费用</dt><dd>{message.runEvidence.costSource === 'runtime_reported' && message.runEvidence.costUsd !== null ? `${message.runEvidence.costUsd} 美元（服务商报告，未对账）` : '未知（保留预留，未释放）'}</dd></div>
            <div><dt className="text-muted-foreground">停止请求</dt><dd>{message.runEvidence.stopped ? '已请求停止（是否生效需原运行记录确认）' : '未请求停止'}</dd></div>
            <div className="sm:col-span-2"><dt className="text-muted-foreground">自动重试</dt><dd>没有自动重试</dd></div>
          </dl>
          <p className="mt-2 text-muted-foreground">这些是本地保存的证据摘要，不代表已确认账单，也不是执行许可。</p>
        </details>}
        {message.teamWorkspaceProposal && <section id={`owner-workspace-proposal-${message.id}`} tabIndex={-1} className="mt-3 space-y-2 rounded-xl bg-background/80 p-3 shadow-sm" aria-label="团队工作区范围建议">
          <p className="font-medium">建议扩大本项目可用资料范围</p>
          <p>允许后，“{message.teamWorkspaceProposal.workspaceName}”工作区的资料、技能和配置会纳入本项目上下文。Owner会自行选择员工并准备安排；这次授权只确认资料范围，不会提前启动员工。</p>
          <p className="text-xs text-muted-foreground">这是项目资料范围授权，会影响本项目后续规划与执行。只确认当前工作区；项目目标和员工执行权限不变。</p>
          {(() => {
            const state = workspaceApprovalStates.get(message.id)
            const approved = state?.approved || messages.some(item => item.teamWorkspaceApproval?.sourceMessageId === message.id)
            return <>
              {state?.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
              {approved ? <p role="status" className="text-sm text-emerald-700">该工作区已获项目授权。</p> : <button type="button" className="rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={state?.busy} onClick={() => void approveWorkspace({ projectId, ...(message.taskId ? { taskId: message.taskId } : {}), messageId: message.id, workspaceId: message.teamWorkspaceProposal!.workspaceId, scopeFingerprint: message.teamWorkspaceProposal!.scopeFingerprint })}>{state?.busy ? '正在确认并恢复安排…' : '允许本项目使用这个团队工作区'}</button>}
            </>
          })()}
        </section>}
        {message.kind === 'web_change_observation' && message.webChangeObservationId && <WebChangeObservationCard projectId={projectId} observationId={message.webChangeObservationId} fallbackText={ownerFacingMessage(message.content)} />}
        {message.kind === 'delivery' && message.delivery && <section className="mt-3 space-y-2" aria-label="已交付成果">
          {message.delivery.items.map(item => <button type="button" key={item.stepKey} id={designDeliveryAnchor(message.id, item.stepKey, item.artifactHash)} className="block w-full rounded-lg bg-background p-3 text-left text-primary" onClick={() => selectDelivery({ messageId: message.id, stepKey: item.stepKey, artifactHash: item.artifactHash })}>查看成果：{item.title}</button>)}
        </section>}
      </article>
  )
  const renderTimelineEntry = (entry: OwnerDiscussionEntry): ReactNode => {
    if (entry.kind === 'message') return renderMessage(entry.message)
    if (entry.kind === 'dispatch_control') return <article key={`dispatch-${entry.event.grantId}-${entry.event.revision}`} className="rounded-xl bg-primary/5 p-3 text-sm" aria-label="派工控制记录"><p className="font-medium">{entry.event.paused ? '你暂停了后续自主派工' : '你恢复了后续自主派工'}</p><p className="mt-1 text-xs text-muted-foreground">{new Date(entry.at).toLocaleString('zh-CN')} · {entry.event.paused ? '在途执行和已保留的队列不因此停止。' : '后续工作仍须通过当前授权与来源检查。'}</p></article>
    if (entry.kind === 'plan') return <article key={`plan-${entry.plan.revision}`} className="rounded-xl bg-primary/5 p-3 text-sm" aria-label="方案确认记录"><p className="font-medium">{entry.plan.actor === 'local-user' ? '你确认了方案' : 'Owner 确认了方案'} · v{entry.plan.planVersion}</p><p className="mt-1 whitespace-pre-wrap break-words">{entry.plan.proposal.summary}</p><p className="mt-1 text-xs text-muted-foreground">{new Date(entry.at).toLocaleString('zh-CN')} · 方案确认不等于执行授权。</p></article>
    if (entry.kind === 'grant_revoked') return <article key={`grant-revoked-${entry.grant.grantId}`} className="rounded-xl bg-primary/5 p-3 text-sm" aria-label="执行撤权记录"><p className="font-medium">你撤销了执行授权</p><p className="mt-1 text-xs text-muted-foreground">{new Date(entry.at).toLocaleString('zh-CN')} · 对应 {new Date(entry.grant.issuedAt).toLocaleString('zh-CN')} 确认的授权；当前状态请查看授权设置。</p></article>
    return <article key={`grant-${entry.grant.grantId}`} className="rounded-xl bg-primary/5 p-3 text-sm" aria-label="执行授权记录"><p className="font-medium">执行授权记录</p><p className="mt-1 text-xs text-muted-foreground">{new Date(entry.at).toLocaleString('zh-CN')} · {entry.grant.dispatchMode === 'autonomous' ? '自主调度' : '逐次启动'} · 上限 {dollars.format(entry.grant.budget.maxCostMicros / 1_000_000)}。授权不代表完成或验收；当前状态请查看授权设置。</p></article>
  }
  return <div className="space-y-5" aria-label="项目Owner持续对话">
    {editor.loading && <p role="status" className="text-sm text-muted-foreground">正在读取 Owner 对话…</p>}
    {editor.error && <div className="space-y-2"><p role="alert" className="text-sm text-destructive">Owner对话读取失败：{editor.error}</p><button type="button" className="text-xs text-primary underline" disabled={editor.loading} onClick={() => void load(projectId)}>重新读取 Owner 对话</button></div>}
    {!editor.view?.manager && delegation.view?.state === 'none' && !plan.snapshot && <p role="status" className="rounded-xl bg-primary/5 px-4 py-3 text-sm leading-6">Owner尚未开始规划：当前没有已确认的项目总模型费用额度。请在授权设置中确认预算与有效期；确认后，Owner会在额度内自动整理方案并回到这里回应。</p>}
    <div className={cn('grid min-w-0 items-start gap-0', discussionOpen ? 'xl:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)]' : 'xl:grid-cols-[minmax(0,1fr)_auto]')}><section className="min-w-0 xl:pr-7" aria-label="Owner当前工作台"><div hidden={showProjectDetails} className="space-y-6">
      <section className="rounded-xl bg-primary/10 px-5 py-4" aria-label="Owner当前状态"><h3 className="text-base font-semibold">{currentStatus}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{editor.view?.stateProjection ? `上次状态核对：${new Date(editor.view.stateProjection.lastReconciledAt).toLocaleString('zh-CN')}` : '状态以项目当前记录为准。'}</p></section>
      {selectedDelivery && selectedArtifact && <section ref={artifactWorkspaceRef} tabIndex={-1} className="rounded-xl bg-muted/40 p-4" aria-label="成果工作区">
        <div className="mb-3 flex items-center justify-between gap-3"><h3 className="font-semibold">成果工作区</h3><button type="button" className="text-sm text-primary underline" onClick={() => setSelectedDelivery(null)}>关闭成果</button></div>
        <div className="mb-4 rounded-lg bg-background/70 p-3" aria-label="审阅这个成果版本">
          <p className="text-sm font-medium">记录你的审阅决定</p><p className="mt-1 text-xs text-muted-foreground">决定只关联当前成果版本，发送后进入 Owner 对话；不会自动完成任务或批准发布。</p>
          {selectedBlocker && <p role="alert" className="mt-2 text-sm text-amber-700">{selectedBlocker}</p>}
          {selectedReview && <p role="status" className="mt-2 text-sm">{selectedReview.deliveryReviewDecision === 'accepted' ? '你已认可这个成果版本' : '你已提出这个成果版本需要修改'} · {new Date(selectedReview.createdAt).toLocaleString('zh-CN')}</p>}
          <div className="mt-3 flex flex-wrap gap-2">{([{ value: 'accepted', label: '认可这个版本' }, { value: 'changes_requested', label: '需要修改' }] as const).map(choice => <button type="button" key={choice.value} disabled={composer.sending || Boolean(composer.pending) || !editor.view?.manager || (choice.value === 'accepted' && Boolean(selectedBlocker))} aria-pressed={composer.deliveryReviewDecision === choice.value && composer.deliveryReference?.messageId === selectedDelivery.messageId && composer.deliveryReference?.artifactHash === selectedDelivery.artifactHash && composer.deliveryReference?.stepKey === selectedDelivery.stepKey} className="rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary disabled:opacity-50 aria-pressed:bg-primary aria-pressed:text-primary-foreground" onClick={() => { edit({ subject, text: composer.text, deliveryReference: selectedDelivery, deliveryReviewDecision: choice.value }); focusReplyComposer() }}>{choice.label}</button>)}</div>
        </div>
        <OwnerDeliveredArtifact item={selectedArtifact} validation={editor.view?.deliveryValidations?.find(record => record.messageId === selectedDelivery.messageId && record.stepKey === selectedDelivery.stepKey && record.artifactHash === selectedDelivery.artifactHash)} feedbackCapacity={4000 - composer.text.length} feedbackDisabled={composer.sending || Boolean(composer.pending) || !editor.view?.manager} onRequestChanges={(excerpt, intent) => { const text = excerpt ? `${composer.text}${composer.text.trim() ? '\n\n' : ''}${intent === 'question' ? '针对这段内容提问' : '针对这段内容提出修改'}：\n“${excerpt}”\n` : composer.text; if (text.length > 4000) return; edit({ subject, text, deliveryReference: selectedDelivery, deliveryReviewDecision: null }); focusReplyComposer() }} />
      </section>}
      {selectedDelivery && !selectedArtifact && <p role="alert" className="text-sm text-destructive">所选成果版本已无法核对，请重新选择。</p>}
      <div className="space-y-6">
        <section className="min-w-0 space-y-4 rounded-xl bg-card p-5 shadow-sm ring-1 ring-border/40 sm:p-6" aria-label="需要你决定">
          <h4 className="text-base font-semibold">需要你决定</h4>
          {pendingDeliveredItem && pendingDeliveredReference && <OwnerDeliveredDecisionCard subject={subject} item={pendingDeliveredItem} reference={pendingDeliveredReference} acceptanceBlocker={acceptanceBlocker} onOpen={() => selectDelivery(pendingDeliveredReference)} />}
          {!editor.loading && editor.view && !pendingAction && !latestWorkspaceProposal && !needsArrangementRetry && !authorizationDecision && !waitingForDecision && !hasOpenQuestions && !hasPendingChange && !acceptanceSchedule && !pendingDeliveredItem
            && <p className="text-sm text-muted-foreground">暂无待你决定的事项。</p>}
          {acceptanceSchedule && <OwnerAcceptanceCard projectId={projectId} schedule={acceptanceSchedule} commands={usage.commands} onChanged={() => { void refreshCommandProgress(subject) }} feedbackDisabled={composer.sending || Boolean(composer.pending || composer.deliveryReference || composer.deliveryReviewDecision) || !editor.view?.manager} feedbackCapacity={Math.max(0, 3700 - composer.text.length)} onDiscuss={(delivery, excerpt, intent) => { const context = `交付「${delivery.title}」版本 ${delivery.version}（记录 ${delivery.id}）${excerpt ? `，${intent === 'question' ? '想询问' : '希望修改'}：\n“${excerpt}”` : '：'}\n`; const text = `${composer.text}${composer.text.trim() ? '\n\n' : ''}${context}`; if (text.length > 4000) return; edit({ subject, text }); focusReplyComposer() }} />}
          {acceptanceSchedule && (composer.deliveryReference || composer.deliveryReviewDecision) && <p className="text-xs text-muted-foreground">对话草稿已关联另一成果。请先发送或取消该关联，再对这个交付点选反馈。</p>}
          {waitingForDecision && <div className="flex flex-wrap items-center gap-3 rounded-lg bg-amber-500/10 p-3 text-sm">
            <p>{decisionLabel}</p>
            {waitingMessage?.kind === 'clarification' && !hasOpenQuestions && <button type="button" className="text-primary underline underline-offset-4" onClick={focusReplyComposer}>回复 Owner</button>}
            {planDetails && planDetailsId && waitingMessage && ['plan_proposal', 'planning_confirmation', 'execution_arranged'].includes(waitingMessage.kind)
              && <a href={`#${planDetailsId}`} className="text-primary underline underline-offset-4">查看方案与确认项</a>}
            {waitingMessage?.kind === 'configuration_required' && children && <a href={`#${settingsId}`} className="text-primary underline underline-offset-4">查看项目配置</a>}
          </div>}
          {authorizationDecision && children && <div className="space-y-2"><p className="text-sm font-medium">{delegation.view?.state === 'none' ? '确认项目预算与管理范围' : '项目管理授权需要核对'}</p>{children}</div>}
          {pendingAction && <section aria-label="员工动作需要你逐次审批" className="space-y-3 rounded-xl bg-amber-500/10 p-3">
            <p className="text-sm leading-6">员工执行已暂停，等待你核对下面的准确操作。Owner不能代签；在对话中讨论不等于批准。一次确认仅适用于本次参数，不扩大预算或范围。</p>
            <PermissionBanner key={pendingAction.requestId} sessionId={pendingAction.sessionId} keyboardShortcuts={false} />
          </section>}
          {latestWorkspaceProposal && <div className="rounded-xl bg-amber-500/10 p-3 text-sm" aria-label="待查看团队工作区建议">
            <p>Owner 建议将“{latestWorkspaceProposal.teamWorkspaceProposal?.workspaceName}”纳入项目资料范围。</p>
            <button type="button" className="mt-2 text-primary underline underline-offset-4" onClick={() => revealDiscussionTarget(`owner-workspace-proposal-${latestWorkspaceProposal.id}`)}>查看范围与确认选项</button>
          </div>}
          {needsArrangementRetry && <section className="space-y-2 rounded-xl bg-amber-500/10 p-3 text-sm" aria-label="团队安排需要重新核对">
            <p>{staleAssignment ? '项目资料或团队范围已经变化，旧安排不能继续使用。' : '人员安排需要重新核对。'}可以让 Owner 按当前已确认方案重新安排。</p>
            {delegation.view?.state !== 'active' && <p>请先重新核对项目管理授权，再重新安排。</p>}
            <button type="button" className="rounded-lg bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" disabled={delegation.view?.state !== 'active' || retakeStatus === 'sending' || retakeRequested} onClick={() => { setRetakeStatus('sending'); void retakeAssignment(subject).then(result => { setRetakeStatus(result.message); setRetakeRequested(result.ok) }) }}>{retakeStatus === 'sending' ? '正在重新安排…' : '按当前方案重新安排'}</button>
            {retakeStatus && retakeStatus !== 'sending' && <p role="status">{retakeStatus}</p>}
          </section>}
          <OwnerConversationChanges projectId={projectId} taskId={taskId} />
          <OwnerManagementQuestions projectId={projectId} taskId={taskId} embedded />
        </section>
        <section className="min-w-0 border-b border-border/50 pb-5" aria-label="项目风险">
          <h4 className="text-sm font-semibold">风险与关注事项</h4>
          {evidenceBlocker && evidenceRisk && <div className="mt-3 rounded-xl bg-amber-500/10 p-3 text-sm" role="alert"><p className="font-medium">成果验证证据需要核对</p><p className="mt-1">{evidenceBlocker}</p><button type="button" className="mt-2 text-primary underline" onClick={() => selectDelivery(evidenceRisk.reference)}>查看成果和证据</button></div>}
          {planRisks.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-sm [overflow-wrap:anywhere]">{planRisks.map((risk, index) => <li key={index}>{risk}</li>)}</ul>}
          {blockedReviews.map(round => <div key={round.id} className="mt-3 rounded-xl bg-amber-500/10 p-3 text-sm" aria-label="质量阻断"><p className="font-medium">{round.title} · 质量决定被阻断</p><p className="mt-1 whitespace-pre-wrap break-words">{round.steps.find(step => step.label === 'Owner 决定')?.detail ?? '请核对当前质量决定和恢复条件。'}</p></div>)}
          {delegation.view?.state === 'attention' && children && <a href={`#${settingsId}`} className="mt-2 block text-sm text-primary underline underline-offset-4">上次请求待核对，查看请求记录</a>}
          {!evidenceBlocker && !latestAttention && !priorAttention && blockedReviews.length === 0 && delegation.view?.state !== 'attention' && planRisks.length === 0 && <p className="mt-2 text-sm text-muted-foreground">暂无已记录的风险提示，不代表已完成全面风险检查。</p>}
          {priorAttention && <p className="mt-2 text-xs text-muted-foreground">此前 Owner 曾提出关注事项；后续进展是否解决该事项，请查看 <button type="button" className="text-primary underline" onClick={() => revealDiscussionTarget(`owner-message-${priorAttention.id}`)}>历史记录</button>核对。</p>}
          {latestAttention && <section className="mt-3 space-y-2 rounded-lg bg-amber-500/10 px-3 py-2" role="alert" aria-label="Owner最新处理结果">
            <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold">Owner 最新处理结果</h4><time className="text-xs text-muted-foreground">{new Date(latestAttention.createdAt).toLocaleString('zh-CN')}</time></div>
            <p className="whitespace-pre-wrap break-words text-sm leading-6">{ownerFacingMessage(latestAttention.content)}</p>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="text-xs text-primary underline underline-offset-4" onClick={() => revealDiscussionTarget(`owner-message-${latestAttention.id}`)}>查看 Owner 历史记录</button>
            </div>
          </section>}
        </section>
        <section id="owner-project-progress" className="min-w-0" aria-label="项目进展">
          <h4 className="text-sm font-semibold">项目进展</h4>
          {(assignmentTrace || ownerProcessing) && <div className="mt-3 rounded-xl bg-primary/5 px-4 py-3 text-sm" role="status" aria-label="Owner组织进度">
          <div className="flex items-center gap-2">
            {ownerProcessing && <span className="sidebar-breathe-dot sidebar-breathe-running size-2 flex-shrink-0 bg-current text-blue-500" aria-label="Owner正在处理" />}
            <p>{waitingForDecision ? 'Owner 正在等你处理决策事项。' : latestAttention ? 'Owner 提出需要关注的事项，详情见风险。' : assignmentTrace ? ownerTraceStatus(assignmentTrace) : 'Owner正在处理你的消息。'}</p>
          </div>
          {assignmentActive && !waitingForUser && <p className="mt-1 text-xs text-muted-foreground">{elapsedLabel(clock - assignmentTrace.createdAt)}；这类安排没有可靠的固定预计时长。{clock - assignmentTrace.createdAt >= ORGANIZATION_STALL_HINT_MS ? '暂时还没有新进展；Owner会继续检查处理状态，你不必重复发送。收到结果或需要你决定的事项时，我会在这里更新。' : ''}</p>}
          </div>}
          {progress ?? (!assignmentTrace && !ownerProcessing && <p className="mt-2 text-sm text-muted-foreground">暂无新的进展记录。</p>)}
          {reviewHistory.length > 0 && <details className="mt-3 rounded-xl bg-muted/40 p-4">
            <summary className="cursor-pointer text-sm font-medium">查看进展与决策依据</summary>
            {reviewHistory.map(round => <section key={round.id} className="mt-3 rounded-lg bg-background/70 p-3">
              <h4 className="text-sm font-medium">{round.title}{round.reworkOrdinal > 0 ? ` · 返工第 ${round.reworkOrdinal} 轮` : ''}</h4>
              <ol className="mt-2 space-y-2 text-sm">
                {round.steps.map(step => <li key={step.label}><div className="flex flex-wrap items-center gap-x-2"><span className="font-medium">{step.label}</span>{step.at !== undefined && <time className="text-xs text-muted-foreground" dateTime={new Date(step.at).toISOString()}>{new Date(step.at).toLocaleString('zh-CN')}</time>}</div><p className="whitespace-pre-wrap break-words text-muted-foreground">{step.detail}</p></li>)}
              </ol>
            </section>)}
          </details>}
        </section>
        {currentFocus && <details className="min-w-0 rounded-xl bg-muted/30 p-3"><summary className="cursor-pointer text-sm font-semibold">目标与方案</summary><div className="mt-3 space-y-3">{currentFocus}</div></details>}
        <details className="min-w-0 rounded-xl bg-muted/30 p-3" aria-label="资源消耗">
          <summary className="cursor-pointer text-sm font-semibold">资源消耗</summary>
          {delegation.view?.delegation ? <dl className="mt-2 grid grid-cols-2 gap-3 text-sm tabular-nums">
            <div><dt className="text-xs text-muted-foreground">项目模型预算上限</dt><dd>{dollars.format(delegation.view.delegation.maxCostMicros / 1_000_000)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Owner 请求次数</dt><dd>{delegation.view.usedRequests}</dd></div>
            <div><dt className="text-xs text-muted-foreground">项目预算占用</dt><dd>{dollars.format(delegation.view.reservedCostMicros / 1_000_000)}</dd></div>
            {ownerBudget && <div><dt className="text-xs text-muted-foreground">Owner 已结算 / 保留占额</dt><dd>{dollars.format(ownerBudget.settledMicros / 1_000_000)} / {dollars.format(ownerBudget.inFlightMicros / 1_000_000)}</dd></div>}
            {teamUsage && <div><dt className="text-xs text-muted-foreground">执行已记账 / 预留</dt><dd>{dollars.format(teamUsage.committedCostMicros / 1_000_000)} / {dollars.format(teamUsage.reservedCostMicros / 1_000_000)}</dd></div>}
          </dl> : <p className="mt-2 text-sm text-muted-foreground">{delegation.view ? '尚未确认项目模型预算。' : '暂无预算数据。'}</p>}
          <p className="mt-2 text-xs text-muted-foreground">预算占用含预留，实际费用以服务商账单为准。{workspaceName && `资料工作区：${workspaceName}。`}</p>
        </details>
      </div></div>{showProjectDetails && projectDetailsKind === 'chain' && <OwnerDeliveryCatalog messages={messages} loading={editor.loading} error={editor.error} onSelect={selectDelivery} />}<div ref={onProjectDetailsHost} hidden={!showProjectDetails} />
    </section>
    <aside hidden={!wideScreen && !discussionOpen} onKeyDown={event => { if (!wideScreen && event.key === 'Escape') closeDiscussion() }} className={cn('fixed inset-x-0 bottom-0 top-[12vh] z-40 flex min-w-0 flex-col overflow-hidden rounded-t-2xl bg-background shadow-2xl sm:left-auto sm:w-[min(26rem,100vw)] xl:sticky xl:top-4 xl:z-auto xl:h-[max(22rem,calc(100vh-15rem))] xl:w-auto xl:rounded-none xl:border-l xl:border-border/40 xl:bg-muted/20 xl:shadow-none', !wideScreen && !discussionOpen && '!hidden')} aria-label="与项目Owner讨论"><div className="flex items-center justify-between gap-2 px-4 py-3"><h3 className="text-sm font-semibold">与项目 Owner 讨论</h3><button ref={discussionCloseRef} type="button" className="rounded-lg px-2 py-1 text-xs text-primary hover:bg-muted" aria-expanded={discussionOpen} onClick={() => discussionOpen ? closeDiscussion() : openDiscussion()}>{discussionOpen ? '收起讨论' : '展开讨论'}</button></div><div hidden={!discussionOpen} className={discussionOpen ? 'flex min-h-0 flex-1 flex-col' : undefined}><section className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5" aria-label="项目历史与事实">
      {(plan.historyError || grant.historyError || dispatchEvents.error) && <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-xs">方案、授权或派工历史读取失败，讨论中可能缺少记录。<button type="button" className="ml-2 text-primary underline" onClick={() => { if (plan.historyError) void loadPlanHistory(subject); if (grant.historyError) void loadGrantHistory(subject); if (dispatchEvents.error) void loadDispatchEvents(subject) }}>重新读取</button></div>}
      <OwnerDesignHistory messages={messages} onSelect={(messageId, stepKey, artifactHash) => selectDelivery({ messageId, stepKey, artifactHash })} />
      {acceptanceHistoryError && <p role="alert" className="text-xs text-destructive">业务验收记录读取失败，当前对话可能不完整。</p>}
      {acceptanceHistory.length > 0 && <section aria-label="业务验收记录" className="space-y-2">{acceptanceHistory.map(event => <article key={event.id} className="rounded-xl bg-primary/5 p-3 text-sm"><p className="font-medium">{event.actor === 'local-user' ? '你' : event.actor} {event.action === 'accept' ? '验收通过' : '要求修改'} · 版本 {event.version}</p><p className="mt-1 whitespace-pre-wrap break-words">{event.comment}</p><p className="mt-1 text-xs text-muted-foreground">{new Date(event.at).toLocaleString('zh-CN')} · 项目交付记录</p></article>)}</section>}
      {timeline.length > 0 && <div className="space-y-3" role="log" aria-label="Owner历史对话" aria-live="polite" aria-relevant="additions">
        {olderEntries.length > 0 && <details key={JSON.stringify([projectId, taskId])} data-owner-earlier-messages className="rounded-xl bg-background/70 p-3">
          <summary className="cursor-pointer text-sm font-medium">展开更早的对话 · {olderEntries.length} 条</summary>
          <div className="mt-3 space-y-3">{olderEntries.map(renderTimelineEntry)}</div>
        </details>}
        <div className="space-y-3" aria-label="最新一轮对话">{latestEntries.map(renderTimelineEntry)}</div>
      </div>}
      {showOwnerWorking && <p role="status" aria-label="Owner正在回复" className="mr-6 flex max-w-3xl items-center gap-2 rounded-2xl rounded-tl-sm bg-muted/60 px-4 py-3 text-sm text-muted-foreground shadow-sm"><span className="sidebar-breathe-dot sidebar-breathe-running size-2 flex-shrink-0 bg-current text-blue-500" />Owner 正在处理你的消息…</p>}
      {(editor.view?.manager || messages.some(message => message.kind === 'delivery' && message.delivery)) && <details className="rounded-xl bg-background/70 p-3"><summary className="cursor-pointer text-xs font-medium text-muted-foreground">设计任务草稿与交付记录</summary><div className="mt-3 space-y-3">{editor.view?.manager && <OwnerDesignBrief key={JSON.stringify([projectId, taskId ?? null])} projectId={projectId} disabled={composer.sending || Boolean(composer.pending)} onAdd={text => {
        const next = composer.text.trim() ? `${composer.text}\n\n${text}` : text
        if (next.length > 4000) return false
        edit({ subject, text: next }); focusReplyComposer(); return true
      }} />}
      {messages.some(message => message.kind === 'delivery' && message.delivery) && <details className="rounded-xl bg-background/70 p-3" aria-label="交付成果记录">
        <summary className="cursor-pointer text-sm font-medium">查看交付成果与评审</summary>
        <div className="mt-3 space-y-3 text-sm">{messages.filter(message => message.kind === 'delivery' && message.delivery).map(message => <section key={message.id} className="rounded-lg bg-muted/40 p-3"><p className="font-medium">Owner 质量检查后的交付 · 方案 v{message.delivery?.planVersion}</p><p className="mt-1 text-xs text-muted-foreground">{message.delivery?.items.map(item => item.title).join('、')}。Owner 质量检查不等于人类业务认可或发布批准。</p><button type="button" className="mt-2 text-xs text-primary underline" onClick={() => revealOwnerHistoryTarget(`owner-message-${message.id}`)}>查看准确成果与评审</button></section>)}</div>
      </details>}</div></details>}
    </section>
    {editor.view?.manager && <form className="sticky bottom-0 z-10 px-2.5 pb-2.5 md:px-[18px] md:pb-[18px]" aria-label="向Owner发送消息" onSubmit={event => { event.preventDefault(); if (canSendMessage) void send(subject) }}>
      <div className="rounded-[10px] border border-solid border-border/80 bg-muted/30 backdrop-blur-sm transition-all duration-200 focus-within:border-ring focus-within:bg-muted/50" data-input-mode="chat">
        <RichTextInput ariaLabel="给项目 Owner 的消息" value={composer.text} onChange={text => edit({ subject, text: text.slice(0, 4000) })} onSubmit={() => { if (canSendMessage) void send(subject) }} placeholder={sendWithCmdEnter ? '回答问题、补充想法或询问进度… (⌘/Ctrl+Enter 发送，Enter 换行)' : '回答问题、补充想法或询问进度… (Enter 发送，Shift+Enter 换行)'} disabled={composer.sending || Boolean(composer.pending)} sendWithCmdEnter={sendWithCmdEnter} />
        {composerBlocker && !composer.pending && <p role="alert" className="px-[15px] pb-2 text-xs text-destructive">{composerBlocker}可取消认可选择或先核对证据。</p>}
        {composer.deliveryReference && <div className={`flex items-center gap-2 px-[15px] pb-2 text-xs ${referencedDelivery ? 'text-muted-foreground' : 'text-destructive'}`}><p role={referencedDelivery ? 'status' : 'alert'}>{referencedDelivery ? `本条意见将关联已交付成果《${referencedDelivery.title}》及其准确版本。${composer.deliveryReviewDecision ? composer.deliveryReviewDecision === 'accepted' ? ' 审阅决定：认可。' : ' 审阅决定：需要修改。' : ''}` : '关联成果版本已无法核对；这条消息不会发送，请从当前交付卡重新选择成果。'}</p><button type="button" className="shrink-0 text-primary underline disabled:opacity-50" disabled={composer.sending || Boolean(composer.pending)} onClick={() => edit({ subject, text: composer.text, deliveryReference: null })}>取消关联</button></div>}
        {composer.error && <p role="alert" className="px-[15px] pb-2 text-sm text-destructive">{composer.error}。原消息已保留。</p>}
        <div className="flex items-center justify-between gap-3 border-t border-border/40 px-2.5 py-2">
          <p role={delegation.view?.state === 'stale' ? 'alert' : undefined} className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">{editor.view.manager.status === 'paused' ? '管理已暂停，消息会保留，恢复后再处理。' : delegation.view?.state === 'stale' ? '管理授权因项目目标、配置、资料或费用依据变化而暂停。消息会保留且不会发送；请在授权设置中重新核对并确认当前范围，Owner随后会继续处理。' : delegation.view?.state === 'attention' ? '你的消息会保存，但 Owner 正暂停在上次请求核对；当前不会发送新模型请求。请勿重复提交，先在授权设置中核对原请求状态。' : '讨论会保留在项目记录中，不直接改变目标或授权。'}</p>
          <Button type="submit" variant="ghost" size="icon" className={cn('size-[36px] rounded-full', canSendMessage ? 'text-primary hover:bg-primary/10' : 'cursor-not-allowed text-foreground/30')} disabled={!canSendMessage} aria-label={composer.pending ? '重新确认原消息已保存' : '发送给 Owner'} title={composer.pending ? '重新确认原消息已保存' : '发送给 Owner'}><CornerDownLeft className="size-[22px]" /></Button>
        </div>
      </div>
    </form>}
    </div></aside></div>
    {!discussionOpen && <button ref={discussionLauncherRef} type="button" className="fixed bottom-4 right-4 z-30 rounded-full bg-primary px-4 py-3 text-sm font-medium text-primary-foreground shadow-lg xl:hidden" onClick={openDiscussion}>与 Owner 讨论</button>}
    {evidenceBlocker && evidenceAlertKey && evidenceRisk && !alertMessage && !dismissedEvidenceAlerts.has(evidenceAlertKey) && <aside role="alert" aria-label="成果验证风险提醒" className="fixed bottom-20 right-4 z-40 w-[min(24rem,calc(100vw-2rem))] rounded-2xl bg-background p-4 shadow-xl ring-1 ring-border"><div className="flex justify-between gap-3"><h3 className="font-semibold">成果验证证据需要核对</h3><button type="button" className="text-xs underline" onClick={() => setDismissedEvidenceAlerts(previous => new Set(previous).add(evidenceAlertKey))}>收起提醒</button></div><p className="mt-2 text-sm">{evidenceBlocker}</p><p className="mt-2 text-xs text-muted-foreground">收起提醒不会解决问题，也不会批准当前版本。</p><button type="button" className="mt-3 text-sm text-primary underline" onClick={() => { setDismissedEvidenceAlerts(previous => new Set(previous).add(evidenceAlertKey)); selectDelivery(evidenceRisk.reference) }}>查看成果和证据</button></aside>}
    {alertMessage && <aside role="alert" aria-label="Owner 新的关注事项" className="fixed bottom-20 right-4 z-40 w-[min(24rem,calc(100vw-2rem))] rounded-2xl bg-background p-4 shadow-xl ring-1 ring-border">
      <div className="flex items-start justify-between gap-3"><h3 className="font-semibold">Owner 发现需要关注的事项</h3><button type="button" className="text-xs text-muted-foreground underline" onClick={dismissAttention}>收起提醒</button></div>
      <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm">{ownerFacingMessage(alertMessage.content)}</p>
      <p className="mt-2 text-xs text-muted-foreground">{new Date(alertMessage.createdAt).toLocaleString('zh-CN')} · 收起仅隐藏提醒，不表示问题已解决。</p>
      <button type="button" className="mt-3 text-sm text-primary underline" onClick={() => { dismissAttention(); revealDiscussionTarget(`owner-message-${alertMessage.id}`) }}>查看记录与上下文</button>
    </aside>}
    <div hidden={showProjectDetails}>{planDetails}
    {children && !authorizationDecision && <div id={settingsId} tabIndex={-1} className="space-y-3">{children}</div>}</div>
  </div>
}
