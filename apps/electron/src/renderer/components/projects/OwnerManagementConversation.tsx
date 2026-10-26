import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import { confirmOwnerTeamWorkspaceAccessAtom, editOwnerMessageAtom, getOwnerManagementEditor, getOwnerMessageComposer, loadOwnerManagementAtom, ownerManagementEditorsAtom, ownerMessageComposersAtom, ownerTeamWorkspaceApprovalStatesAtom, sendOwnerMessageAtom } from '../../atoms/project-owner-management-atoms'
import { getOwnerDelegationEditor, ownerDelegationEditorsAtom } from '../../atoms/owner-management-delegation-atoms'
import { getOwnerPlanEditor, loadOwnerPlanAtom, ownerPlanEditorsAtom } from '../../atoms/project-owner-plan-atoms'
import { OwnerConversationChanges } from './OwnerConversationChanges'
import { OwnerManagementQuestions } from './OwnerManagementQuestions'
import { isOwnerWaitingForUser } from './project-owner-progress-state'

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
  const workspaceApprovalStates = useAtomValue(ownerTeamWorkspaceApprovalStatesAtom)
  const approveWorkspace = useSetAtom(confirmOwnerTeamWorkspaceAccessAtom)
  const load = useSetAtom(loadOwnerManagementAtom), loadPlan = useSetAtom(loadOwnerPlanAtom), edit = useSetAtom(editOwnerMessageAtom), send = useSetAtom(sendOwnerMessageAtom)
  const id = useId(), loadedMessage = useRef('')
  const [clock, setClock] = useState(Date.now())
  const messages = editor.view?.messages.filter(message => message.taskId === taskId && message.kind !== 'goal') ?? []
  const latestUserMessageIndex = messages.findLastIndex(message => message.role === 'user')
  const latestUserMessage = latestUserMessageIndex >= 0 ? messages[latestUserMessageIndex] : undefined
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
  const focusReplyComposer = (): void => {
    requestAnimationFrame(() => {
      const reply = document.querySelector<HTMLTextAreaElement>('form[aria-label="向Owner发送消息"] textarea')
      reply?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      reply?.focus()
    })
  }
  const referencedDelivery = composer.deliveryReference
    ? editor.view?.messages.find(message => message.id === composer.deliveryReference?.messageId && message.role === 'assistant' && message.kind === 'delivery')?.delivery?.items.find(item => item.artifactHash === composer.deliveryReference?.artifactHash)
    : undefined
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
        <p className="whitespace-pre-wrap break-words">{ownerFacingMessage(message.content)}</p>
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
          {message.delivery.items.map(item => <details key={item.stepKey} className="rounded-xl bg-background/70 p-3 shadow-sm">
            <summary className="cursor-pointer font-medium">{item.title}</summary>
            <div className="mt-3 space-y-3">
              <div><p className="text-xs font-medium text-muted-foreground">验收标准</p><ul className="list-disc pl-5">{item.acceptanceCriteria.map((criterion, index) => <li key={`${index}-${criterion}`}>{criterion}</li>)}</ul></div>
              <p><span className="font-medium">Owner验收：</span>{item.ownerDecision}</p>
              <p><span className="font-medium">独立评审：</span>{item.reviewerSummary}</p>
              <div><p className="text-xs font-medium text-muted-foreground">员工提交的成果原文</p><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 font-sans">{item.content}</pre></div>
            </div>
          </details>)}
        </section>}
      </article>)}
    </div>}
    </section>
    {editor.view?.manager && <form className="sticky bottom-0 z-10 space-y-3 rounded-2xl bg-background/95 p-4 shadow-lg backdrop-blur" aria-label="向Owner发送消息" onSubmit={event => { event.preventDefault(); void send(subject) }}>
      <label className="sr-only" htmlFor={id}>给项目 Owner 的消息</label>
      <textarea id={id} rows={3} maxLength={4000} className="w-full resize-y rounded-xl bg-muted/30 p-3 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="回答问题、补充想法、询问进度，或说明希望修改的目标和方案…" disabled={composer.sending || Boolean(composer.pending)} value={composer.text} onChange={event => edit({ subject, text: event.target.value })} />
      <p className="text-xs leading-5 text-muted-foreground">这条消息会进入项目记录并交给 Owner 判断；实际目标、方案或进度变化会显示在上方“现在最需要关注”。要直接修改正式目标，请使用“调整目标”。</p>
      {composer.deliveryReference && <p className={`text-xs ${referencedDelivery ? 'text-muted-foreground' : 'text-destructive'}`} role={referencedDelivery ? 'status' : 'alert'}>{referencedDelivery ? `本条意见将关联已验收成果《${referencedDelivery.title}》及其准确版本。` : '关联成果版本已无法核对；这条消息不会发送，请从当前交付卡重新选择成果。'}</p>}
      {composer.error && <p role="alert" className="text-sm text-destructive">{composer.error}。原消息已保留。</p>}
      <div className="flex flex-wrap items-center gap-3"><button type="submit" className="rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={composer.sending || !composer.text.trim() || Boolean(composer.deliveryReference && !referencedDelivery)}>{composer.sending ? '正在发送…' : composer.pending ? '重新确认原消息已保存' : '发送给 Owner'}</button><p role={delegation.view?.state === 'stale' ? 'alert' : undefined} className="text-xs text-muted-foreground">{editor.view.manager.status === 'paused' ? '管理已暂停，消息会保留，恢复后再处理。' : delegation.view?.state === 'stale' ? '管理授权因项目目标、配置、资料或费用依据变化而暂停。消息会保留且不会发送；请在上方重新核对并确认当前范围，Owner随后会继续处理。' : delegation.view?.state === 'attention' ? '你的消息会保存，但 Owner 正暂停在上次请求核对；当前不会发送新模型请求。请勿重复提交，先在上方核对原请求状态。' : 'Owner 在已确认的管理额度内回应；必要的方案或执行确认会在这里提出。'}</p></div>
    </form>}
  </div>
}
