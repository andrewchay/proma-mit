import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import { confirmOwnerTeamWorkspaceAccessAtom, editOwnerMessageAtom, getOwnerManagementEditor, getOwnerMessageComposer, loadOwnerManagementAtom, ownerManagementEditorsAtom, ownerMessageComposersAtom, ownerTeamWorkspaceApprovalStatesAtom, sendOwnerMessageAtom } from '../../atoms/project-owner-management-atoms'
import { getOwnerDelegationEditor, ownerDelegationEditorsAtom } from '../../atoms/owner-management-delegation-atoms'
import { getOwnerPlanEditor, loadOwnerPlanAtom, ownerPlanEditorsAtom } from '../../atoms/project-owner-plan-atoms'
import { allPendingPermissionRequestsAtom } from '../../atoms/agent-atoms'
import { retakeOwnerAssignmentAtom } from '../../atoms/project-owner-management-atoms'
import { PermissionBanner } from '../agent/PermissionBanner'
import { Button } from '../ui/button'
import { RichTextInput } from '../ai-elements/rich-text-input'
import { cn } from '../../lib/utils'
import { OwnerConversationChanges } from './OwnerConversationChanges'
import { OwnerDeliveredArtifact } from './OwnerDeliveredArtifact'
import { OwnerManagementQuestions } from './OwnerManagementQuestions'
import { isOwnerWaitingForUser } from './project-owner-progress-state'
import { CornerDownLeft } from 'lucide-react'
import { sendWithCmdEnterAtom } from '../../atoms/shortcut-atoms'

const ORGANIZATION_STALL_HINT_MS = 2 * 60 * 1000
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
export function OwnerManagementConversation({ projectId, taskId, children, currentFocus, historyFacts }: { projectId: string; taskId?: string; children: ReactNode; currentFocus?: ReactNode; historyFacts?: ReactNode }): React.ReactElement {
  const subject = useMemo(() => ({ projectId, ...(taskId ? { taskId } : {}) }), [projectId, taskId])
  const view = useMemo(() => atom(get => ({ editor: getOwnerManagementEditor(get(ownerManagementEditorsAtom), projectId), composer: getOwnerMessageComposer(get(ownerMessageComposersAtom), subject), plan: getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject), delegation: getOwnerDelegationEditor(get(ownerDelegationEditorsAtom), subject) })), [projectId, subject])
  const { editor, composer, plan, delegation } = useAtomValue(view)
  const pendingPermissions = useAtomValue(allPendingPermissionRequestsAtom)
  const sendWithCmdEnter = useAtomValue(sendWithCmdEnterAtom)
  const pendingAction = editor.view?.actionRequests?.find(item =>
    (taskId === undefined || item.taskId === taskId) && pendingPermissions.get(item.sessionId)?.[0]?.requestId === item.requestId
    && pendingPermissions.get(item.sessionId)?.[0]?.requiresPerActionApproval,
  )
  const workspaceApprovalStates = useAtomValue(ownerTeamWorkspaceApprovalStatesAtom)
  const approveWorkspace = useSetAtom(confirmOwnerTeamWorkspaceAccessAtom)
  const retakeAssignment = useSetAtom(retakeOwnerAssignmentAtom)
  const [retakeStatus, setRetakeStatus] = useState('')
  const load = useSetAtom(loadOwnerManagementAtom), loadPlan = useSetAtom(loadOwnerPlanAtom), edit = useSetAtom(editOwnerMessageAtom), send = useSetAtom(sendOwnerMessageAtom)
  const loadedMessage = useRef('')
  const [clock, setClock] = useState(Date.now())
  const messages = editor.view?.messages.filter(message => message.taskId === taskId && message.kind !== 'goal') ?? []
  const latestUserMessageIndex = messages.findLastIndex(message => message.role === 'user')
  const latestUserMessage = latestUserMessageIndex >= 0 ? messages[latestUserMessageIndex] : undefined
  const latestAssistantMessage = messages.findLast(message => message.role === 'assistant')
  const latestAttention = latestAssistantMessage?.kind === 'attention' ? latestAssistantMessage : undefined
  const latestOwnerResponse = latestUserMessageIndex >= 0 ? messages.slice(latestUserMessageIndex + 1).findLast(message =>
    message.role === 'assistant' && ['reply', 'conversation', 'clarification', 'answer', 'plan_proposal', 'change_proposal', 'change_decision', 'delivery'].includes(message.kind),
  ) : undefined
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
    return !supersededByLaterPhase && !supersededByDelivery
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
    const refresh = () => { void load(projectId) }
    refresh(); window.addEventListener('focus', refresh)
    const off = window.electronAPI?.paa?.project?.onOwnerManagementChanged?.(change => { if (change.projectId === projectId) refresh() })
    return () => { window.removeEventListener('focus', refresh); off?.() }
  }, [load, projectId])
  // 项目Owner消息属于同一段持续对话：执行、确认与交付都必须留在用户眼前，
  // 不能因为写入时的目标版本较旧就在确认后整段消失。
  const waitingForUser = isOwnerWaitingForUser(messages)
  const ownerProcessing = (composer.sending || hasActiveTrace) && !waitingForUser
    && editor.view?.manager?.status !== 'paused' && delegation.view?.state !== 'stale' && delegation.view?.state !== 'attention'
  const focusLatestRecord = (): void => {
    document.querySelector<HTMLElement>('[aria-label=\"Owner历史对话\"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const focusReplyComposer = (): void => {
    requestAnimationFrame(() => {
      const reply = document.querySelector<HTMLElement>('form[aria-label="向Owner发送消息"] [contenteditable="true"][aria-label="给项目 Owner 的消息"]')
      reply?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      reply?.focus()
    })
  }
  const referencedDelivery = composer.deliveryReference
    ? editor.view?.messages.find(message => message.id === composer.deliveryReference?.messageId && message.role === 'assistant' && message.kind === 'delivery')?.delivery?.items.find(item => item.artifactHash === composer.deliveryReference?.artifactHash)
    : undefined
  const canSendMessage = !composer.sending && Boolean(composer.text.trim())
    && !(composer.deliveryReference && !referencedDelivery)
  return <div className="space-y-5" aria-label="项目Owner持续对话">
    {editor.loading && <p role="status" className="text-sm text-muted-foreground">正在读取 Owner 对话…</p>}
    {editor.error && <div className="space-y-2"><p role="alert" className="text-sm text-destructive">Owner对话读取失败：{editor.error}</p><button type="button" className="text-xs text-primary underline" disabled={editor.loading} onClick={() => void load(projectId)}>重新读取 Owner 对话</button></div>}
    {!editor.view?.manager && delegation.view?.state === 'none' && !plan.snapshot && <p role="status" className="rounded-xl bg-primary/5 px-4 py-3 text-sm leading-6">Owner尚未开始规划：当前没有已确认的项目总模型费用额度。请在下方确认预算与有效期；确认后，Owner会在额度内自动整理方案并回到这里回应。</p>}
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.85fr)]" aria-label="Owner当前工作台">
    <section className="min-w-0 rounded-2xl bg-card p-4 shadow-sm sm:p-5" aria-label="现阶段最需要关注">
      <h3 className="text-base font-semibold">现在最需要关注</h3>
      {(assignmentTrace || ownerProcessing) && <div className="mt-3 rounded-xl bg-primary/5 px-4 py-3 text-sm" role="status" aria-label="Owner组织进度">
      <div className="flex items-center gap-2">
        {ownerProcessing && <span className="sidebar-breathe-dot sidebar-breathe-running size-2 flex-shrink-0 bg-current text-blue-500" aria-label="Owner正在处理" />}
        <p>{waitingForUser ? 'Owner正在等你处理一项待确认内容。' : assignmentTrace ? ownerTraceStatus(assignmentTrace) : 'Owner正在处理你的消息。'}</p>
      </div>
      {waitingForUser && <div role="alert" className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-amber-500/10 p-3"><p>查看 Owner 的最新说明后，可以直接在对话里回复。</p><button type="button" className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground" onClick={focusReplyComposer}>回复 Owner</button></div>}
      {assignmentActive && !waitingForUser && <p className="mt-1 text-xs text-muted-foreground">{elapsedLabel(clock - assignmentTrace.createdAt)}；这类安排没有可靠的固定预计时长。{clock - assignmentTrace.createdAt >= ORGANIZATION_STALL_HINT_MS ? '暂时还没有新进展；Owner会继续检查处理状态，你不必重复发送。收到结果或需要你决定的事项时，我会在这里更新。' : ''}</p>}
      </div>}
      {latestAttention && <section className="mt-3 space-y-2 rounded-xl bg-amber-500/10 p-4" role="alert" aria-label="Owner最新处理结果">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold">Owner 最新处理结果</h4><time className="text-xs text-muted-foreground">{new Date(latestAttention.createdAt).toLocaleString('zh-CN')}</time></div>
        <p className="whitespace-pre-wrap break-words text-sm leading-6">{ownerFacingMessage(latestAttention.content)}</p>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="text-xs text-primary underline underline-offset-4" onClick={focusLatestRecord}>查看 Owner 历史记录</button>
          {latestAttention.content.includes('人员安排') && <button type="button" className="rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50" disabled={retakeStatus === 'sending'} onClick={() => { setRetakeStatus('sending'); void retakeAssignment(subject).then(result => setRetakeStatus(result.message)) }}>{retakeStatus === 'sending' ? '正在重新安排…' : '按当前已确认方案重新安排'}</button>}
        </div>
        {retakeStatus && retakeStatus !== 'sending' && <p role="status" className="text-xs text-muted-foreground">{retakeStatus}</p>}
      </section>}
      {currentFocus ?? <p className="mt-3 text-sm text-muted-foreground">当前没有需要优先处理的项目事项。</p>}
      {latestUserMessage && <section className="mt-4 rounded-xl bg-muted/40 p-4" aria-label="最近补充对项目的影响">
        <h4 className="text-sm font-semibold">你最近补充的内容</h4>
        <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-sm">{latestUserMessage.content}</p>
        <p role="status" className="mt-2 text-xs leading-5 text-muted-foreground">{latestOwnerResponse ? 'Owner已对此回应；请看上方当前目标、方案和进度，那里会显示已经产生的项目变化。若尚未变化，这条补充目前只作为后续判断依据。' : ownerProcessing ? '已记录，Owner正在处理；结果会更新当前目标或方案，或在这里说明需要你决定的事项。' : waitingForUser ? '已记录；Owner正在等待右侧的决定，之后会继续推进。' : '已记录在项目历史中，尚无对应的Owner回复。'}</p>
        {latestOwnerResponse && <details className="mt-2 rounded-lg bg-background/70 p-3"><summary className="cursor-pointer text-xs font-medium">查看Owner对此的最近回应</summary><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{ownerFacingMessage(latestOwnerResponse.content)}</p></details>}
      </section>}
    </section>
    <aside className="min-w-0 space-y-3 rounded-2xl bg-card p-4 shadow-sm sm:p-5" aria-label="需要你决定">
      <h3 className="text-base font-semibold">需要你决定</h3>
      {pendingAction && <section aria-label="员工动作需要你逐次审批" className="space-y-3 rounded-xl bg-amber-500/10 p-3">
        <p className="text-sm leading-6">员工执行已暂停，等待你核对下面的准确操作。Owner不能代签；在对话中讨论不等于批准。一次确认仅适用于本次参数，不扩大预算或范围。</p>
        <PermissionBanner key={pendingAction.requestId} sessionId={pendingAction.sessionId} keyboardShortcuts={false} />
      </section>}
      <OwnerConversationChanges projectId={projectId} taskId={taskId} />
      {children}
      <OwnerManagementQuestions projectId={projectId} taskId={taskId} embedded />
    </aside>
    </div>
    <section className="space-y-4 rounded-2xl bg-muted/20 p-4 sm:p-5" aria-label="项目历史与事实">
    <div><h3 className="text-base font-semibold">项目记录</h3><p className="mt-1 text-xs text-muted-foreground">已确认的目标、范围、方案和结果，以及之后发生的对话。</p></div>
    {historyFacts}
    {messages.length > 0 && <div className="space-y-3 border-t border-border/60 pt-4" role="log" aria-label="Owner历史对话" aria-live="polite" aria-relevant="additions">
      {messages.map(message => <article key={message.id} className={`max-w-3xl rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm ${message.role === 'user' ? 'ml-6 rounded-tr-sm bg-primary/10' : 'mr-6 rounded-tl-sm bg-muted/60'}`}>
        <p className="mb-1 text-xs font-medium text-muted-foreground">{message.role === 'user' ? '你' : '项目 Owner'}</p>
        {message.kind === 'employee_interaction' && message.employeeInteraction && <section className="mb-3 rounded-xl bg-amber-500/10 p-3" aria-label="员工待决事项">
          <div className="flex items-center justify-between gap-3"><p className="font-medium">员工需要 Owner 判断</p><span className="rounded-full bg-background/70 px-2 py-1 text-xs">{({ pending_owner: '等待 Owner', discussing_user: '讨论中', decided: '已决定', delivering: '回传中', resolved: '已回传', cancelled: '已取消', stale: '已失联', delivery_failed: '回传失败' } as Record<string, string>)[(editor.view?.employeeInteractions?.find(item => item.id === message.employeeInteraction?.id) ?? message.employeeInteraction).state] ?? '状态待核对'}</span></div>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm">{message.employeeInteraction.summary}</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">这是员工执行中的待决事项，不是用户授权。权限、预算、访问范围和系统接管仍须由你在明确入口中确认；Owner不能代签。</p>
        </section>}
        <p className="whitespace-pre-wrap break-words">{ownerFacingMessage(message.content)}</p>
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
        {message.teamWorkspaceProposal && <section className="mt-3 space-y-2 rounded-xl bg-background/80 p-3 shadow-sm" aria-label="团队工作区范围建议">
          <p className="font-medium">建议扩大本项目可用资料范围</p>
          <p>允许后，“{message.teamWorkspaceProposal.workspaceName}”工作区的资料、技能和配置会纳入本项目上下文。Owner会自行选择员工并准备安排；这次授权只确认资料范围，不会提前启动员工。</p>
          <p className="text-xs text-muted-foreground">这是项目资料范围授权，会影响本项目后续规划与执行。只确认当前工作区；项目目标和员工执行权限不变。</p>
          {(() => {
            const state = workspaceApprovalStates.get(message.id)
            return <>
              {state?.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
              {state?.approved ? <p role="status" className="text-sm text-emerald-700">范围已确认，Owner正在继续核对团队安排。</p> : <button type="button" className="rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={state?.busy} onClick={() => void approveWorkspace({ projectId, ...(message.taskId ? { taskId: message.taskId } : {}), messageId: message.id, workspaceId: message.teamWorkspaceProposal!.workspaceId, scopeFingerprint: message.teamWorkspaceProposal!.scopeFingerprint })}>{state?.busy ? '正在确认并恢复安排…' : '允许本项目使用这个团队工作区'}</button>}
            </>
          })()}
        </section>}
        {message.kind === 'delivery' && message.delivery && <section className="mt-3 space-y-2" aria-label="已验收成果">
          {message.delivery.items.map(item => <OwnerDeliveredArtifact key={item.stepKey} item={item} />)}
        </section>}
      </article>)}
    </div>}
    </section>
    {editor.view?.manager && <form className="sticky bottom-0 z-10 px-2.5 pb-2.5 md:px-[18px] md:pb-[18px]" aria-label="向Owner发送消息" onSubmit={event => { event.preventDefault(); void send(subject) }}>
      <div className="rounded-[10px] border border-solid border-border/80 bg-muted/30 backdrop-blur-sm transition-all duration-200 focus-within:border-ring focus-within:bg-muted/50" data-input-mode="chat">
        <RichTextInput ariaLabel="给项目 Owner 的消息" value={composer.text} onChange={text => edit({ subject, text: text.slice(0, 4000) })} onSubmit={() => { void send(subject) }} placeholder={sendWithCmdEnter ? '回答问题、补充想法或询问进度… (⌘/Ctrl+Enter 发送，Enter 换行)' : '回答问题、补充想法或询问进度… (Enter 发送，Shift+Enter 换行)'} disabled={composer.sending || Boolean(composer.pending)} sendWithCmdEnter={sendWithCmdEnter} />
        <p className="px-[15px] pb-2 text-xs leading-5 text-muted-foreground">这条消息会进入项目记录并交给 Owner 判断；实际目标、方案或进度变化会显示在上方“现在最需要关注”。要直接修改正式目标，请使用“调整目标”。</p>
        {composer.deliveryReference && <p className={`px-[15px] pb-2 text-xs ${referencedDelivery ? 'text-muted-foreground' : 'text-destructive'}`} role={referencedDelivery ? 'status' : 'alert'}>{referencedDelivery ? `本条意见将关联已验收成果《${referencedDelivery.title}》及其准确版本。` : '关联成果版本已无法核对；这条消息不会发送，请从当前交付卡重新选择成果。'}</p>}
        {composer.error && <p role="alert" className="px-[15px] pb-2 text-sm text-destructive">{composer.error}。原消息已保留。</p>}
        <div className="flex items-center justify-between gap-3 border-t border-border/40 px-2.5 py-2">
          <p role={delegation.view?.state === 'stale' ? 'alert' : undefined} className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">{editor.view.manager.status === 'paused' ? '管理已暂停，消息会保留，恢复后再处理。' : delegation.view?.state === 'stale' ? '管理授权因项目目标、配置、资料或费用依据变化而暂停。消息会保留且不会发送；请在上方重新核对并确认当前范围，Owner随后会继续处理。' : delegation.view?.state === 'attention' ? '你的消息会保存，但 Owner 正暂停在上次请求核对；当前不会发送新模型请求。请勿重复提交，先在上方核对原请求状态。' : 'Owner 在已确认的管理额度内回应；必要的方案或执行确认会在这里提出。'}</p>
          <Button type="submit" variant="ghost" size="icon" className={cn('size-[36px] rounded-full', canSendMessage ? 'text-primary hover:bg-primary/10' : 'cursor-not-allowed text-foreground/30')} disabled={!canSendMessage} aria-label={composer.pending ? '重新确认原消息已保存' : '发送给 Owner'} title={composer.pending ? '重新确认原消息已保存' : '发送给 Owner'}><CornerDownLeft className="size-[22px]" /></Button>
        </div>
      </div>
    </form>}
  </div>
}
