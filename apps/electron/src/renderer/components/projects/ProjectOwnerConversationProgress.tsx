import { useEffect, useMemo, useState } from 'react'
import { atom, useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import type { OwnerExecutionCommandView, OwnerManagementDeliveryReference, OwnerManagementMessage, ProjectOwnerGoalSubject } from '@gravitas/shared'
import { getOwnerCommandProgress, loadOwnerCommandProgressAtom, ownerCommandProgressAtom } from '../../atoms/owner-command-progress-atoms'
import { editOwnerMessageAtom, getOwnerManagementEditor, getOwnerMessageComposer, ownerManagementEditorsAtom, ownerMessageComposersAtom } from '../../atoms/project-owner-management-atoms'
import { isOwnerWaitingForUser } from './project-owner-progress-state'
import { useOpenSession } from '@/hooks/useOpenSession'
import { agentSessionsAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { resolveOwnerCommandSession } from './owner-command-session'
const button = 'rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50'
type ContinueDeliveryResult = 'ready' | 'busy' | 'too_long' | 'unlinked'

function continueDeliveryStatus(result: ContinueDeliveryResult): string {
  if (result === 'ready') return '已将这份成果的背景放入下方 Owner 对话。补充或修改内容后发送，Owner 会据此判断并继续处理。'
  if (result === 'too_long') return '对话草稿已接近字数上限，无法安全加入成果背景；请先精简草稿再试。'
  if (result === 'unlinked') return '这份执行结果尚未关联到Owner验收后交付的准确版本，暂不能作为修改意见的对象。'
  return '对话消息正在发送或等待确认；请先处理下方原消息。'
}

function acceptedDeliveryReference(messages: readonly OwnerManagementMessage[], command: OwnerExecutionCommandView, subject: ProjectOwnerGoalSubject): OwnerManagementDeliveryReference | null {
  const artifactHash = command.textDelivery?.artifact?.contentSha256
  if (!artifactHash) return null
  const stepKey = command.stepKey
  if (!stepKey) return null
  const matches = messages.flatMap(message => message.role === 'assistant' && message.kind === 'delivery' && message.taskId === subject.taskId
    ? (message.delivery?.items.filter(item => item.artifactHash === artifactHash && item.stepKey === stepKey) ?? []).map(() => ({ messageId: message.id, artifactHash, stepKey })) : [])
  return matches.length === 1 ? matches[0]! : null
}

function progressLabel(state: string | undefined, nextAction: string | undefined): string {
  if (nextAction === 'await_business_acceptance') return '成果已准备好，等待你审阅。'
  if (nextAction === 'await_owner_quality') return 'Owner 正在核对成果与质量依据。'
  if (nextAction === 'human_decision') return 'Owner 遇到需要你决定的问题，正在整理原因和建议。'
  if (nextAction === 'rework' || nextAction === 'review' || nextAction === 'execute') return 'Owner 正在组织团队继续推进。'
  if (state === 'running' || state === 'ready') return 'Owner 正在组织团队推进目标。'
  if (state === 'paused') return '当前工作已暂停。'
  if (state === 'needs_reconcile' || state === 'stale') return 'Owner 正在核对工作状态与授权范围。'
  if (state === 'expired' || state === 'archived') return '本次执行已结束。'
  return 'Owner 正在准备下一步。'
}

function DeliveryResultCard({ command, deliveryReference, onContinue }: {
  command: OwnerExecutionCommandView
  deliveryReference: OwnerManagementDeliveryReference | null
  onContinue: (command: OwnerExecutionCommandView, reference: OwnerManagementDeliveryReference | null) => ContinueDeliveryResult
}): React.ReactElement {
  const [status, setStatus] = useState('')
  return <article className="space-y-3 rounded-xl bg-card p-4 shadow-sm" aria-label={`交付成果：${command.taskTitle}`}>
    <div><h5 className="font-medium">{command.taskTitle}</h5><p className="text-xs text-muted-foreground">执行已完成；成果内容来自执行回复，尚不等于独立验证或最终业务验收。</p></div>
    <p className="rounded-lg bg-primary/5 p-3 text-sm">最终产物位置：本项目对话中的「本轮交付」消息。展开下方“查看完整成果”即可查看和复制；本轮没有另存为本地文件。</p>
    {command.textDelivery?.artifact
      ? <details><summary className="cursor-pointer text-sm text-primary">查看完整成果</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">{command.textDelivery.artifact.content}</pre></details>
      : command.textDelivery?.state === 'unavailable'
        ? <p role="alert" className="text-sm text-destructive">成果正文暂不可用，Owner 需要核对后才能继续审阅。</p>
        : command.executionResultSummary
          ? <div className="rounded-lg bg-muted/40 p-3 text-sm"><p className="mb-1 text-xs font-medium text-muted-foreground">执行进展摘要</p><p className="whitespace-pre-wrap break-words">{command.executionResultSummary}</p></div>
          : <p role="status" className="text-sm">完整成果尚未回到项目对话。</p>}
    {command.technicalReview && <div className="rounded-lg bg-muted/40 p-3 text-sm"><p className="font-medium">质量检查：{command.technicalReview.verdict === 'approved' ? '符合当前标准' : command.technicalReview.verdict === 'changes_requested' ? '需要调整' : '暂无法判定'}</p><p className="mt-1">{command.technicalReview.summary}</p>{command.technicalReview.artifactVerified === false && <p className="mt-1 text-destructive">被检查的成果已变化，不能沿用此前检查结果。</p>}</div>}
    <details className="rounded-lg bg-muted/30 p-3">
      <summary className="cursor-pointer text-sm font-medium">交付审阅材料（只读）</summary>
      <div className="mt-3 space-y-2 text-sm"><h6 className="font-medium">完成标准</h6><ul className="list-disc space-y-1 pl-5">{command.acceptanceCriteria.map((criterion, index) => <li key={`${index}-${criterion}`}>{criterion}</li>)}</ul>
        {command.technicalReview && <><h6 className="pt-2 font-medium">检查依据</h6><ul className="list-disc space-y-1 pl-5">{command.technicalReview.criteria.map((item, index) => <li key={`${index}-${item.criterion}`}>{item.criterion}：{item.status === 'met' ? '符合' : item.status === 'not_met' ? '未符合' : '未验证'}。{item.evidence}</li>)}</ul></>}
        {status && <p role="status" className="text-xs">{status}</p>}
        <button type="button" className={button} disabled={!deliveryReference} onClick={() => setStatus(continueDeliveryStatus(onContinue(command, deliveryReference)))}>在对话中继续修改</button>
        {!deliveryReference && <p className="text-xs text-muted-foreground">Owner验收后的准确成果版本尚未关联；此执行回报不能单独作为修改对象。</p>}
      </div>
    </details>
  </article>
}

export function ProjectOwnerConversationProgress({ subject }: { subject: ProjectOwnerGoalSubject }): React.ReactElement {
  const progressView = useMemo(() => atom(get => getOwnerCommandProgress(get(ownerCommandProgressAtom), subject)), [subject])
  const conversationView = useMemo(() => atom(get => getOwnerManagementEditor(get(ownerManagementEditorsAtom), subject.projectId).view), [subject.projectId])
  const progress = useAtomValue(progressView)
  const conversation = useAtomValue(conversationView)
  const waitingForUser = isOwnerWaitingForUser(conversation?.messages ?? [], subject.taskId)
  const refresh = useSetAtom(loadOwnerCommandProgressAtom)
  const editMessage = useSetAtom(editOwnerMessageAtom)
  const store = useStore()
  const { openSession } = useOpenSession()
  const setSessions = useSetAtom(agentSessionsAtom), setWorkspace = useSetAtom(currentAgentWorkspaceIdAtom)
  const [openingSession, setOpeningSession] = useState(''), [sessionError, setSessionError] = useState('')
  useEffect(() => {
    const reload = () => { void refresh(subject) }
    reload()
    const timer = window.setInterval(reload, 4000)
    window.addEventListener('focus', reload)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', reload) }
  }, [refresh, subject])
  const taskCommands = useMemo(() => {
    const byTask = new Map<string, OwnerExecutionCommandView[]>()
    for (const command of progress.commands.filter(item => item.role === 'executor')) {
      const commands = byTask.get(command.taskId) ?? []
      commands.push(command)
      byTask.set(command.taskId, commands)
    }
    return [...byTask.values()].map(commands => commands.sort((a, b) => b.updatedAt - a.updatedAt))
  }, [progress.commands])
  const onContinue = (command: OwnerExecutionCommandView, deliveryReference: OwnerManagementDeliveryReference | null): ContinueDeliveryResult => {
    if (!deliveryReference) return 'unlinked'
    const current = getOwnerMessageComposer(store.get(ownerMessageComposersAtom), subject)
    if (current.sending || current.pending) return 'busy'
    const context = `我想继续修改《${command.taskTitle}》这份交付。请结合当前方案中的对应完成标准处理我的意见。\n`
    const text = `${current.text.trim() ? `${current.text}\n\n` : ''}${context}`
    if (text.length > 4000) return 'too_long'
    editMessage({ subject, text, deliveryReference })
    requestAnimationFrame(() => {
      const composer = document.querySelector<HTMLTextAreaElement>('form[aria-label="向Owner发送消息"] textarea')
      composer?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      composer?.focus()
    })
    return 'ready'
  }
  const hasCurrentRun = taskCommands.some(commands => commands.some(command => command.state === 'running' || command.state === 'queued'))
  const completed = taskCommands.map(commands => commands.find(command => command.state === 'settled' && command.executionStatus === 'completed')).filter((command): command is OwnerExecutionCommandView => Boolean(command))
  const employeeCommands = useMemo(() => progress.commands.filter(command => command.executionId)
    .sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 6), [progress.commands])
  const openEmployeeSession = async (command: OwnerExecutionCommandView): Promise<void> => {
    if (!command.executionId || openingSession) return
    setOpeningSession(command.commandId); setSessionError('')
    try {
      const [executions, sessions] = await Promise.all([
        window.electronAPI.paa.agentEmployees.listExecutionsByEntity('task', command.taskId), window.electronAPI.listAgentSessions(),
      ])
      const session = resolveOwnerCommandSession(subject.projectId, command, executions, sessions)
      setSessions(sessions)
      if (session.workspaceId) setWorkspace(session.workspaceId)
      openSession('agent', session.id, session.title)
    } catch (cause) { setSessionError(cause instanceof Error ? cause.message : '打开员工会话失败') }
    finally { setOpeningSession('') }
  }
  return <section className="mt-4 space-y-3 rounded-2xl bg-muted/30 p-4 shadow-sm" aria-label="Owner项目进度与成果">
    <h4 className="font-semibold">项目进展</h4>
    <p role="status" className="text-sm">{waitingForUser ? 'Owner 正在等你处理一项待确认内容。' : progress.loading && !progress.loaded ? '正在读取最新进展…' : progress.error && !progress.loaded ? '暂时无法读取最新进展。' : progressLabel(progress.schedule?.state, progress.schedule?.nextAction)}</p>
    {waitingForUser && <p role="alert" className="rounded-lg bg-amber-500/10 p-3 text-sm">请查看下方 Owner 的最新说明并直接回复；确认前，受影响的新工作不会启动，其他仍在已确认范围内的工作可以继续。</p>}
    {progress.error && <p role="alert" className="text-xs text-destructive">最新进展读取失败；已保留上次记录，不会据此重新启动工作。</p>}
    {hasCurrentRun && <p className="text-sm text-muted-foreground">团队成员正在处理已确认的工作。</p>}
    {employeeCommands.length > 0 && <section className="space-y-2" aria-label="员工会话进度">
      <h5 className="text-sm font-medium">员工工作会话</h5>
      <p className="text-xs text-muted-foreground">每位员工在项目工作区有独立会话；打开后可查看该员工的实时进度和执行记录。</p>
      {employeeCommands.map(command => <article key={command.commandId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-card p-3 shadow-sm">
        <div className="min-w-0"><p className="truncate text-sm font-medium">{command.taskTitle}</p><p className="text-xs text-muted-foreground">{command.role === 'reviewer' ? '独立评审' : command.role === 'executor' ? '执行员工' : '员工'} · {command.state === 'running' ? '正在工作' : command.state === 'queued' ? '等待启动' : command.state === 'settled' && command.executionStatus === 'completed' ? '已完成' : command.state === 'needs_reconcile' || command.state === 'unknown' ? '需要核对' : command.executionStatus ?? command.state}</p></div>
        {command.state === 'queued' ? <span className="text-xs text-muted-foreground">会话将在员工启动时建立</span> : <button type="button" className={button} disabled={Boolean(openingSession)} onClick={() => void openEmployeeSession(command)}>{openingSession === command.commandId ? '正在打开…' : '打开员工会话'}</button>}
      </article>)}
      {sessionError && <p role="alert" className="text-xs text-destructive">{sessionError}</p>}
    </section>}
    {completed.map(command => <DeliveryResultCard key={command.commandId} command={command} deliveryReference={acceptedDeliveryReference(conversation?.messages ?? [], command, subject)} onContinue={onContinue} />)}
    {!waitingForUser && !completed.length && !hasCurrentRun && progress.loaded && progress.schedule?.state === 'manual' && <p className="text-sm text-muted-foreground">工作尚未开始；Owner 会在必要确认完成后继续。</p>}
  </section>
}
