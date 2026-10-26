import { lazy, Suspense, useCallback, useEffect, useMemo } from 'react'
import { atom, useAtom, useAtomValue, useSetAtom } from 'jotai'
import type { OwnerExecutionCommandAckPreview, OwnerExecutionCommandRole, OwnerExecutionCommandView, OwnerExecutionNextAction, OwnerExecutionRevalidationRecord, OwnerExecutionGrant, OwnerPreflightReconciliationPreview, ProjectOwnerExecutionCommandApi, ProjectOwnerGoalSubject } from '@gravitas/shared'
import { AgentExecutionStopButton } from './AgentExecutionStopButton'
import { ProjectOwnerPreflightReconciliationConfirm } from './ProjectOwnerPreflightReconciliationConfirm'
import { addOwnerDeliveryFeedbackToGoalAtom, type OwnerDeliveryFeedbackResult } from './project-owner-delivery-feedback'
import { deriveOwnerRecoveryGuidance } from './project-owner-recovery-guidance'
import { loadOwnerGrantAtom } from '../../atoms/project-owner-execution-grant-atoms'
import { getOwnerCommandProgress, loadOwnerCommandProgressAtom, ownerCommandProgressAtom } from '../../atoms/owner-command-progress-atoms'
import { useOpenSession } from '@/hooks/useOpenSession'
import { agentSessionsAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { resolveOwnerCommandSession } from './owner-command-session'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
const FeedbackConversation = lazy(() => import('./ProjectOwnerConversation').then(module => ({ default: module.ProjectOwnerConversation })))


const button = 'rounded-md bg-muted px-3 py-2 text-sm disabled:opacity-50'
const field = 'mt-1 min-w-0 max-w-full rounded-md border bg-background p-2 text-sm'
const nextActionLabels: Record<OwnerExecutionNextAction, string> = {
  execute: '安排执行', review: '安排技术评审', rework: '授权范围内有限返工',
  await_business_acceptance: '等待人工业务验收', human_decision: '等待人工决策/处理', none: '无后续动作',
}
export function getOwnerExecutionNextActionLabel(action: OwnerExecutionNextAction): string { return nextActionLabels[action] }
function api(): ProjectOwnerExecutionCommandApi {
  const value = typeof window === 'undefined' ? undefined : window.electronAPI?.paa?.project
  if (!value || typeof value.getOwnerAutonomousScheduleStatus !== 'function' || typeof value.previewOwnerExecutionCommandAck !== 'function' || typeof value.queueOwnerExecutionCommand !== 'function' || typeof value.listOwnerExecutionCommands !== 'function' || typeof value.dispatchOwnerExecutionCommand !== 'function' || typeof value.cancelQueuedOwnerExecutionCommand !== 'function' || typeof value.previewOwnerPreflightReconciliation !== 'function' || typeof value.confirmOwnerPreflightReconciliation !== 'function') throw new Error('当前版本没有Owner命令执行接口')
  return value
}

export function OwnerExecutionReviewDetails({ command, onSubmitFeedback }: {
  command: OwnerExecutionCommandView
  onSubmitFeedback?: (commandId: string, taskId: string, feedback: string) => Promise<OwnerDeliveryFeedbackResult>
}): React.ReactElement {
  // biome-ignore lint/correctness/useExhaustiveDependencies: 命令切换后不继承另一个交付的意见。
  const fields = useMemo(() => ({ feedback: atom(''), status: atom(''), error: atom(''), saving: atom(false) }), [command.commandId])
  const [feedback, setFeedback] = useAtom(fields.feedback)
  const [feedbackStatus, setFeedbackStatus] = useAtom(fields.status)
  const [feedbackError, setFeedbackError] = useAtom(fields.error)
  const [feedbackSaving, setFeedbackSaving] = useAtom(fields.saving)
  const submitFeedback = async (): Promise<void> => {
    if (!onSubmitFeedback || feedbackSaving) return
    setFeedbackSaving(true)
    let result: OwnerDeliveryFeedbackResult
    try { result = await onSubmitFeedback(command.commandId, command.taskId, feedback) }
    catch { setFeedbackError('提交意见失败，输入已保留，请核对后重试。'); return }
    finally { setFeedbackSaving(false) }
    if (!result.ok) {
      const labels: Record<Extract<OwnerDeliveryFeedbackResult, { ok: false }>['reason'], string> = {
        invalid: '请填写修改意见。', too_long: '修改意见超出长度限制，请精简后再试。',
        too_many: 'Goal约束已达上限；请先合并或删除草案中的约束。', goal_unavailable: '对应Task Goal尚未加载或正在冲突处理中；请先刷新并比较。',
      }
      setFeedbackError(labels[result.reason]); setFeedbackStatus(''); return
    }
    setFeedback(''); setFeedbackError(''); setFeedbackStatus('修改意见已加入对应Task的未保存Goal草案。请检查并保存，再重新规划；这不会启动执行或应用/外发成果。')
  }
  return <details className="rounded-md bg-muted/40 p-3">
    <summary className="cursor-pointer text-sm font-medium">交付审阅材料（只读）</summary>
    <div className="mt-3 space-y-3 text-sm">
      <div>
        <h5 className="font-medium">冻结验收标准</h5>
        <ol className="mt-1 list-decimal space-y-1 pl-5">{command.acceptanceCriteria.map((criterion, index) => <li key={`${index}-${criterion}`}>{criterion}</li>)}</ol>
      </div>
      <div>
        <h5 className="font-medium">{command.role === 'reviewer' ? '技术评审执行回报' : '执行者回报'}</h5>
        <p className="text-xs text-muted-foreground">{command.role === 'reviewer' ? '这是 Reviewer 输出；它不构成业务验收或独立验证。' : '这是执行者自述；它不构成测试通过、技术评审或业务验收。'}</p>
        {command.executionResultSummary
          ? <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-xs">{command.executionResultSummary}</pre>
          : <p className="mt-1 text-xs text-muted-foreground">当前没有可核验的命令执行回报。</p>}
      </div>
      {command.technicalReview && <section className="space-y-2 rounded bg-background p-2">
        <div>
          <h5 className="font-medium">结构化技术评审：{command.technicalReview.verdict}</h5>
          <p>{command.technicalReview.summary}</p>
        </div>
        <ul className="list-disc space-y-1 pl-5">
          {command.technicalReview.criteria.map((criterion, index) => <li key={`${index}-${criterion.criterion}`}>{criterion.criterion} · {criterion.status} · {criterion.evidence}</li>)}
        </ul>
        {command.technicalReview.findings.length > 0 && <ul className="list-disc space-y-1 pl-5">
          {command.technicalReview.findings.map((finding, index) => <li key={`${index}-${finding.description}`}>{finding.severity} · {finding.description} → {finding.requestedChange}</li>)}
        </ul>}
        {command.technicalReview.blockerReason && <p>阻塞原因：{command.technicalReview.blockerReason}</p>}
        <p className="text-xs text-muted-foreground">这是 Reviewer 按冻结标准形成的工程证据，不能替代外部验证或业务验收。</p>
      </section>}
      {command.actionApprovals && command.actionApprovals.length > 0 && <section className="space-y-2 rounded bg-background p-2" aria-label="Owner敏感动作审批记录">
        <h5 className="font-medium">Owner敏感动作审批记录</h5>
        <ul className="space-y-2 text-xs">{command.actionApprovals.map(item => <li key={item.requestId} className="rounded bg-muted/40 p-2">
          <p>{item.toolName} · {item.status === 'pending' ? '待处理' : item.status === 'allowed' ? '已批准' : item.status === 'denied' ? '已拒绝' : '已失效'}</p>
          <p>动作指纹：{item.actionFingerprint}</p>
          <p>请求时间：{new Date(item.requestedAt).toLocaleString()} · 裁决人：{item.decidedBy ?? '尚无'}</p>
          {item.reason && <p>原因：{item.reason}</p>}
        </li>)}</ul>
        <p className="text-muted-foreground">此处不保存或展示工具参数正文；动作指纹用于对应审批记录。</p>
      </section>}
      <p className="text-xs text-muted-foreground">技术评审仅作为工程建议；业务 Task 仍需人工验收，Owner 命令不会自动应用成果或更改业务验收状态。</p>
      {onSubmitFeedback && <section className="space-y-2 rounded bg-background p-2" aria-label="提交交付修改意见">
        <label className="block text-sm font-medium">针对本交付提出修改意见<textarea className={`${field} mt-1 w-full`} rows={3} maxLength={1800} value={feedback} onChange={event => { setFeedback(event.target.value); setFeedbackError(''); setFeedbackStatus('') }} placeholder="说明希望调整的内容或需要重新核对的范围" /></label>
        {feedbackError && <p role="alert" className="text-xs text-destructive">{feedbackError}</p>}
        {feedbackStatus && <p role="status" className="text-xs">{feedbackStatus}</p>}
        <button type="button" className={button} disabled={!feedback.trim() || feedbackSaving} onClick={() => void submitFeedback()}>加入对应Task的Goal草案</button>
        <p className="text-xs text-muted-foreground">意见绑定命令 {command.commandId}，只改本地未保存草案。保存后Owner可基于新目标重新规划；执行范围和授权仍需重验，写回/外发不会因提交意见而发生。</p>
      </section>}
    </div>
  </details>
}

/** Owner 命令双确认面板：费用确认只排队；第二次独立确认才显式dispatch。 */
export function ProjectOwnerExecutionCommandPanel({ subject, grant, revalidation, onGrantChanged }: { subject: ProjectOwnerGoalSubject; grant: OwnerExecutionGrant | null; revalidation: OwnerExecutionRevalidationRecord | null; onGrantChanged?: () => void }): React.ReactElement {
  const { openSession } = useOpenSession()
  const setSessions = useSetAtom(agentSessionsAtom), setWorkspace = useSetAtom(currentAgentWorkspaceIdAtom)
  const projectId = subject.projectId
  const subjectTaskId = subject.taskId
  // biome-ignore lint/correctness/useExhaustiveDependencies: 主体或冻结授权变化时撤销旧费用/启动/对账确认。
  const fields = useMemo(() => ({
    taskId: atom(''), role: atom<OwnerExecutionCommandRole>('executor'), preview: atom<OwnerExecutionCommandAckPreview | null>(null),
    costAcknowledged: atom(false), executionConfirmation: atom(''), preflightPreview: atom<OwnerPreflightReconciliationPreview | null>(null),
    preflightChecked: atom(false), busy: atom(false), error: atom(''), feedbackTarget: atom<{ taskId: string; title: string } | null>(null),
  }), [projectId, subjectTaskId, grant?.grantId, grant?.state, grant?.policyRevision, revalidation?.id])
  const [taskId, setTaskId] = useAtom(fields.taskId), [role, setRole] = useAtom(fields.role)
  const [preview, setPreview] = useAtom(fields.preview), [costAcknowledged, setCostAcknowledged] = useAtom(fields.costAcknowledged)
  const [executionConfirmation, setExecutionConfirmation] = useAtom(fields.executionConfirmation)
  const [preflightPreview, setPreflightPreview] = useAtom(fields.preflightPreview), [preflightChecked, setPreflightChecked] = useAtom(fields.preflightChecked)
  const [mutating, setBusy] = useAtom(fields.busy), [error, setError] = useAtom(fields.error)
  const [feedbackTarget, setFeedbackTarget] = useAtom(fields.feedbackTarget)
  const progressView = useMemo(() => atom(get => getOwnerCommandProgress(get(ownerCommandProgressAtom), { projectId, ...(subjectTaskId === undefined ? {} : { taskId: subjectTaskId }) })), [projectId, subjectTaskId])
  const progress = useAtomValue(progressView)
  const { commands } = progress
  const otherTaskSchedule = Boolean(subjectTaskId && progress.schedule?.taskId && progress.schedule.taskId !== subjectTaskId)
  const schedule = otherTaskSchedule ? null : progress.schedule
  const busy = mutating || progress.loading || !progress.loaded
  const loadProgress = useSetAtom(loadOwnerCommandProgressAtom)
  const loadGrant = useSetAtom(loadOwnerGrantAtom)
  const addDeliveryFeedback = useSetAtom(addOwnerDeliveryFeedbackToGoalAtom)
  const recoveryGuidance = schedule ? deriveOwnerRecoveryGuidance(schedule) : null
  const sourceTasks = useMemo(() => revalidation?.source?.tasks.filter(task => task.status === 'paused') ?? [], [revalidation])
  const refresh = useCallback(async (): Promise<void> => {
    const request = { projectId, ...(subjectTaskId === undefined ? {} : { taskId: subjectTaskId }) }
    await Promise.all([loadProgress(request), loadGrant(request)])
  }, [loadProgress, loadGrant, projectId, subjectTaskId])
  useEffect(() => {
    void refresh()
    // 所有模式都自动只读更新，包括人工启动后运行、停止或待审批状态；绝不在轮询中派工。
    const timer = window.setInterval(() => { void refresh() }, 4000)
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [refresh])
  const input = taskId && grant && revalidation ? { grantId: grant.grantId, taskId, role, reworkOrdinal: 0, expectedRevalidationRevision: revalidation.revision } : null
  const onPreview = async (): Promise<void> => {
    if (!input) return
    setBusy(true); setError(''); setPreview(null); setCostAcknowledged(false)
    try {
      const result = await api().previewOwnerExecutionCommandAck({ ...subject, input })
      if (!result.ok) throw new Error(result.error.message)
      setPreview(result.value)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '预览Owner命令失败') }
    finally { setBusy(false) }
  }
  const onQueue = async (): Promise<void> => {
    if (!input || !preview || !costAcknowledged) return
    setBusy(true); setError('')
    try {
      const acknowledgement = { input, preview, confirmedFingerprint: preview.ackFingerprint, acknowledgeModelCosts: true }
      const result = await api().queueOwnerExecutionCommand({ ...subject, input: { ...input, requestId: crypto.randomUUID() }, acknowledgement })
      if (!result.ok) throw new Error(result.error.message)
      setPreview(null); setCostAcknowledged(false); await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Owner命令排队失败') }
    finally { setBusy(false) }
  }
  const cancel = async (item: OwnerExecutionCommandView): Promise<void> => {
    setBusy(true); setError('')
    try {
      const result = await api().cancelQueuedOwnerExecutionCommand({ commandId: item.commandId })
      if (!result.ok) throw new Error(result.error.message)
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '取消Owner队列命令失败') }
    finally { setBusy(false) }
  }
  const dispatch = async (item: OwnerExecutionCommandView): Promise<void> => {
    if (executionConfirmation !== item.commandId) return
    setBusy(true); setError('')
    try {
      const result = await api().dispatchOwnerExecutionCommand({ commandId: item.commandId, ackFingerprint: item.ackFingerprint, acknowledgeExecution: true })
      if (!result.ok) throw new Error(result.error.message)
      setExecutionConfirmation(''); await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Owner执行启动失败') }
    finally { setBusy(false) }
  }
  const openCommandSession = async (command: OwnerExecutionCommandView) => {
    setBusy(true); setError('')
    try {
      const [executions, sessions] = await Promise.all([
        window.electronAPI.paa.agentEmployees.listExecutionsByEntity('task', command.taskId), window.electronAPI.listAgentSessions(),
      ])
      const session = resolveOwnerCommandSession(projectId, command, executions, sessions)
      setSessions(sessions)
      if (session.workspaceId) setWorkspace(session.workspaceId)
      openSession('agent', session.id, session.title)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '打开执行会话失败') }
    finally { setBusy(false) }
  }
  const previewPreflightRelease = async (item: OwnerExecutionCommandView): Promise<void> => {
    setBusy(true); setError(''); setPreflightPreview(null); setPreflightChecked(false)
    try {
      const result = await api().previewOwnerPreflightReconciliation({ ...subject, commandId: item.commandId })
      if (!result.ok) throw new Error(result.error.message)
      setPreflightPreview(result.value)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '读取Owner发送前对账预览失败') }
    finally { setBusy(false) }
  }
  const confirmPreflightRelease = async (): Promise<void> => {
    if (!preflightPreview || !preflightChecked) return
    setBusy(true); setError('')
    try {
      const result = await api().confirmOwnerPreflightReconciliation({ ...subject, commandId: preflightPreview.commandId,
        confirmedFingerprint: preflightPreview.fingerprint, providerConsoleCheckedNoUsage: true })
      if (!result.ok) throw new Error(result.error.message)
      setPreflightPreview(null); setPreflightChecked(false); await refresh(); onGrantChanged?.()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Owner发送前失败对账未完成') }
    finally { setBusy(false) }
  }
  return <section className="mt-4 space-y-3 rounded-lg bg-muted/30 p-3" aria-label="Owner业务命令">
    <div className="flex items-center justify-between gap-2"><h4 className="font-medium">Owner 业务命令（费用确认与本次启动分开）</h4><button type="button" className={button} disabled={mutating || progress.loading} onClick={() => void refresh()}>刷新命令与审批记录</button></div>
    <p className="text-xs text-muted-foreground">{grant?.dispatchMode === 'autonomous' ? '自主授权由主进程按冻结范围派发，可能产生真实 Provider 费用；用量缺失、异常或停止未证实会保持 unknown 并占额，不自动重试。' : '排队不调用模型。只有对单条排队命令再次勾选并点击“本次执行”才启动；这可能产生真实 Provider 费用。用量缺失、异常或停止未证实会保持 unknown 并占额，不自动重试。'}</p>
    {(error || progress.error) && <p role="alert" className="text-sm text-destructive">{error || progress.error}。上次结果保留，当前状态尚未更新。</p>}
    {otherTaskSchedule && <p role="status" className="text-sm">项目调度当前关注其他任务；下方仅展示本任务的命令与成果。</p>}
    {schedule && <div role="status" className="rounded-md bg-card p-3 text-sm">
      <p>{grant?.dispatchMode === 'autonomous' ? '自主调度' : '运行进度'}：{schedule.state} · {schedule.reason}</p>
      {(schedule.taskId || schedule.role || schedule.reworkOrdinal !== undefined || schedule.nextAction) && <p className="mt-1 text-xs">当前任务 {schedule.taskId ?? '—'} · 角色 {schedule.role ?? '—'} · 返工轮次 {schedule.reworkOrdinal ?? 0} · 下一步 {schedule.nextAction ? getOwnerExecutionNextActionLabel(schedule.nextAction) : '—'}</p>}
      {schedule.reviewVerdict && <div className="mt-2 rounded-md bg-muted/40 p-2 text-xs"><p>技术评审：{schedule.reviewVerdict} · {schedule.reviewSummary ?? '—'}</p>{schedule.reviewFindings?.length ? <ul className="mt-1 list-disc pl-4">{schedule.reviewFindings.map((finding, index) => <li key={`${index}-${finding}`}>{finding}</li>)}</ul> : null}</div>}
      <p className="mt-2 text-xs text-muted-foreground">本地预算已占用 {schedule.committedCostMicros.toLocaleString()} 微美元，当前未结预留 {schedule.reservedCostMicros.toLocaleString()} 微美元，用量记录 {schedule.runReservations}/{grant?.budget.maxRuns ?? '—'} 次。Scheduler 只在同一冻结授权内安排 Executor/Reviewer 和有限返工；unknown/异常/来源漂移会停等。技术评审不等于业务验收，不会自动完成 Task 或应用成果。</p>
      {recoveryGuidance && <section className="mt-3 space-y-1 rounded bg-muted/40 p-2" aria-label="Owner处理建议"><p className="font-medium">{recoveryGuidance.title}</p><ol className="list-decimal space-y-1 pl-5 text-xs">{recoveryGuidance.actions.map(action => <li key={action}>{action}</li>)}</ol><p className="text-xs text-muted-foreground">{recoveryGuidance.caution}</p></section>}
    </div>}
    {grant?.dispatchMode === 'autonomous' && <p className="text-xs text-muted-foreground">此授权由主进程自主调度；本面板不提供 Renderer 侧派发按钮。依赖解除事件会触发重验，费用/停止状态未知时会暂停并保留占额。</p>}
    {grant?.state === 'active' && grant.dispatchMode !== 'autonomous' && revalidation && <div className="flex flex-wrap items-end gap-2">
      <label className="text-sm">暂停任务<select className={field} value={taskId} disabled={busy} onChange={event => { setTaskId(event.target.value); setPreview(null); setCostAcknowledged(false) }}><option value="">选择当前冻结任务</option>{sourceTasks.map(task => <option key={task.taskId} value={task.taskId}>{task.stepKey} · {task.taskId}</option>)}</select></label>
      <label className="text-sm">角色<select className={field} value={role} disabled={busy} onChange={event => { setRole(event.target.value as OwnerExecutionCommandRole); setPreview(null); setCostAcknowledged(false) }}><option value="executor">执行者</option><option value="reviewer">技术评审</option></select></label>
      <button type="button" className={button} disabled={busy || !input} onClick={() => void onPreview()}>{busy ? '处理中…' : '预览单次费用与命令'}</button>
    </div>}
    {preview && <div className="space-y-2 rounded-md bg-card p-3 text-sm">
      <p>任务 {preview.taskId} · {preview.roleKey ? `岗位 ${preview.roleKey} · ` : ''}{preview.role}：{preview.employeeName}（{preview.employeeId}）· 单次请求占额 {preview.derivedReservationMicros.toLocaleString()} 微美元（上限）</p>
      <p className="text-xs text-muted-foreground">授权剩余额度 {preview.remainingCostMicros.toLocaleString()} 微美元 · 剩余次数 {preview.remainingRuns}{preview.roleBudgetCapMicros !== undefined ? ` · 岗位上限 ${preview.roleBudgetCapMicros.toLocaleString()} 微美元，岗位剩余 ${preview.remainingRoleCostMicros?.toLocaleString() ?? '未知'} 微美元` : ''} · 截止 {new Date(preview.expiresAt).toLocaleString()}。模型来自冻结版本；确认只表示接受这次预留上限，不会启动模型。岗位上限与共享总额分别核验。</p>
      {preview.blockers.length > 0 && <ul role="alert">{preview.blockers.map(item => <li key={item}>{item}</li>)}</ul>}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={costAcknowledged} disabled={busy || preview.blockers.length > 0} onChange={event => setCostAcknowledged(event.target.checked)} /><span>我确认接受本次模型费用预留上限；这只会建立命令，不会启动执行。</span></label>
      <button type="button" className={button} disabled={busy || !costAcknowledged || preview.blockers.length > 0} onClick={() => void onQueue()}>确认费用并排队（不启动）</button>
    </div>}
    <div className="space-y-2">{commands.map(item => <article key={item.commandId} className="space-y-2 rounded-md bg-card p-3 text-sm">
      <p className="break-all">{item.taskTitle} · {item.role}{item.budgetRoleKey ? ` · 预算岗位 ${item.budgetRoleKey}` : ''} · 员工 {item.employeeId} · {item.state}{item.executionStatus ? ` / ${item.executionStatus}` : ''}</p>
      <p className="text-xs text-muted-foreground">单次预留 {item.reservedCostMicros.toLocaleString()} 微美元 · 结算 {item.state === 'released' ? (item.preflightReconciliation ? '操作人确认发送前拒绝后释放' : '未启动，预留已释放') : item.actualCostMicros === null ? '未知（不是零元）' : `${item.actualCostMicros.toLocaleString()} 微美元`}</p>
      {item.executionId && <button type="button" className={button} disabled={mutating} onClick={() => void openCommandSession(item)}>打开执行会话 / 处理审批</button>}
      <OwnerExecutionReviewDetails command={item} onSubmitFeedback={async (commandId, taskId, feedback) => {
        const result = await addDeliveryFeedback({ projectId, taskId, commandId, feedback, delivery: { title: item.taskTitle, acceptanceCriteria: item.acceptanceCriteria } })
        if (result.ok) setFeedbackTarget({ taskId, title: item.taskTitle })
        return result
      }} />
      {item.preflightReconciliation && <p className="text-xs text-muted-foreground">发送前失败对账：{item.preflightReconciliation.evidenceKind === 'typed_preflight' ? '类型化拒绝证据' : '历史兼容记录（当时无类型化拒绝事件）'} · {item.preflightReconciliation.reasonCode} · {item.preflightReconciliation.preReconciliationUsageMarker === 'runtime_unknown' ? 'Runtime unknown标记摘要已留审计（非Provider逐请求用量） · ' : ''}本地操作人已确认控制台无用量；不是Provider签名回执。</p>}
      {item.state === 'needs_reconcile' && item.executionStatus === 'failed' && !item.preflightReconciliation && <button type="button" className={button} disabled={busy} onClick={() => void previewPreflightRelease(item)}>预览发送前失败对账</button>}
      {preflightPreview?.commandId === item.commandId && <ProjectOwnerPreflightReconciliationConfirm preview={preflightPreview} busy={busy} checked={preflightChecked} onCheckedChange={setPreflightChecked} onConfirm={() => void confirmPreflightRelease()} />}
      {item.state === 'queued' && <div className="space-y-2"><button type="button" className={button} disabled={busy} onClick={() => void cancel(item)}>取消未启动命令并释放预留</button>{grant?.dispatchMode !== 'autonomous' && <><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={executionConfirmation === item.commandId} disabled={busy} onChange={event => setExecutionConfirmation(event.target.checked ? item.commandId : '')} /><span>我确认现在启动此命令；可能产生 Provider 费用，单次预留上限为 {item.reservedCostMicros.toLocaleString()} 微美元。</span></label><button type="button" className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={busy || executionConfirmation !== item.commandId} onClick={() => void dispatch(item)}>本次执行</button></>}</div>}
      {item.state === 'running' && item.executionId && <AgentExecutionStopButton execution={{ id: item.executionId, status: 'running', entityType: 'task', entityId: item.taskId }} onChanged={refresh} />}
    </article>)}{!commands.length && <p className="text-xs text-muted-foreground">{grant?.dispatchMode === 'autonomous' ? '暂无命令。Scheduler 会在冻结任务满足门禁时自动安排下一角色。' : '暂无命令。任务准备或费用确认不会自动创建命令。'}</p>}</div>
    <Dialog open={Boolean(feedbackTarget)} onOpenChange={open => { if (!open) setFeedbackTarget(null) }}>
      {feedbackTarget && <DialogContent className="flex min-w-0 w-[calc(100vw-2rem)] max-w-3xl max-h-[calc(100dvh-2rem)] flex-col overflow-hidden p-4 sm:p-6">
        <DialogHeader className="shrink-0"><DialogTitle>按交付反馈调整目标</DialogTitle><DialogDescription>{feedbackTarget.title} · 意见已加入未保存草案。核对并保存后再规划；现有执行授权不会自动扩展。</DialogDescription></DialogHeader>
        <div className="min-h-0 min-w-0 overflow-y-auto"><Suspense fallback={<p role="status">正在打开任务目标…</p>}><FeedbackConversation projectId={projectId} taskId={feedbackTarget.taskId} /></Suspense></div>
      </DialogContent>}
    </Dialog>
  </section>
}
