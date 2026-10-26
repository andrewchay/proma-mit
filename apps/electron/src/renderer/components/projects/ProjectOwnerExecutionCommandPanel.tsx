import { useCallback, useEffect, useMemo, useState } from 'react'
import type { OwnerExecutionAutonomousScheduleStatus, OwnerExecutionCommandAckPreview, OwnerExecutionCommandRole, OwnerExecutionCommandView, OwnerExecutionNextAction, OwnerExecutionRevalidationRecord, OwnerExecutionGrant, OwnerPreflightReconciliationPreview, ProjectOwnerExecutionCommandApi, ProjectOwnerGoalSubject } from '@gravitas/shared'
import { AgentExecutionStopButton } from './AgentExecutionStopButton'
import { ProjectOwnerPreflightReconciliationConfirm } from './ProjectOwnerPreflightReconciliationConfirm'

const button = 'rounded-md bg-muted px-3 py-2 text-sm disabled:opacity-50'
const field = 'mt-1 rounded-md border bg-background p-2 text-sm'
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

/** Owner 命令双确认面板：费用确认只排队；第二次独立确认才显式dispatch。 */
export function ProjectOwnerExecutionCommandPanel({ subject, grant, revalidation, onGrantChanged }: { subject: ProjectOwnerGoalSubject; grant: OwnerExecutionGrant | null; revalidation: OwnerExecutionRevalidationRecord | null; onGrantChanged?: () => void }): React.ReactElement {
  const [commands, setCommands] = useState<OwnerExecutionCommandView[]>([])
  const [schedule, setSchedule] = useState<OwnerExecutionAutonomousScheduleStatus | null>(null)
  const [taskId, setTaskId] = useState('')
  const [role, setRole] = useState<OwnerExecutionCommandRole>('executor')
  const [preview, setPreview] = useState<OwnerExecutionCommandAckPreview | null>(null)
  const [costAcknowledged, setCostAcknowledged] = useState(false)
  const [executionConfirmation, setExecutionConfirmation] = useState('')
  const [preflightPreview, setPreflightPreview] = useState<OwnerPreflightReconciliationPreview | null>(null)
  const [preflightChecked, setPreflightChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const projectId = subject.projectId
  const subjectTaskId = subject.taskId
  const sourceTasks = useMemo(() => revalidation?.source?.tasks.filter(task => task.status === 'paused') ?? [], [revalidation])
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const request = { projectId, ...(subjectTaskId === undefined ? {} : { taskId: subjectTaskId }) }
      const [result, scheduleResult] = await Promise.all([api().listOwnerExecutionCommands(request), api().getOwnerAutonomousScheduleStatus(request)])
      if (!result.ok) throw new Error(result.error.message)
      if (!scheduleResult.ok) throw new Error(scheduleResult.error.message)
      setCommands(result.value)
      setSchedule(scheduleResult.value)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '读取Owner命令失败') }
  }, [projectId, subjectTaskId])
  useEffect(() => {
    setCommands([]); setPreflightPreview(null); setPreflightChecked(false); void refresh()
    if (grant?.dispatchMode !== 'autonomous' || grant.state !== 'active') return
    const timer = window.setInterval(() => { void refresh() }, 4000)
    return () => window.clearInterval(timer)
  }, [refresh, grant?.dispatchMode, grant?.state])
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
    <h4 className="font-medium">Owner 业务命令（费用确认与本次启动分开）</h4>
    <p className="text-xs text-muted-foreground">{grant?.dispatchMode === 'autonomous' ? '自主授权由主进程按冻结范围派发，可能产生真实 Provider 费用；用量缺失、异常或停止未证实会保持 unknown 并占额，不自动重试。' : '排队不调用模型。只有对单条排队命令再次勾选并点击“本次执行”才启动；这可能产生真实 Provider 费用。用量缺失、异常或停止未证实会保持 unknown 并占额，不自动重试。'}</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {grant?.dispatchMode === 'autonomous' && grant.state === 'active' && schedule && <div role="status" className="rounded-md bg-card p-3 text-sm">
      <p>自主调度：{schedule.state} · {schedule.reason}</p>
      {(schedule.taskId || schedule.role || schedule.reworkOrdinal !== undefined || schedule.nextAction) && <p className="mt-1 text-xs">当前任务 {schedule.taskId ?? '—'} · 角色 {schedule.role ?? '—'} · 返工轮次 {schedule.reworkOrdinal ?? 0} · 下一步 {schedule.nextAction ? getOwnerExecutionNextActionLabel(schedule.nextAction) : '—'}</p>}
      {schedule.reviewVerdict && <div className="mt-2 rounded-md bg-muted/40 p-2 text-xs"><p>技术评审：{schedule.reviewVerdict} · {schedule.reviewSummary ?? '—'}</p>{schedule.reviewFindings?.length ? <ul className="mt-1 list-disc pl-4">{schedule.reviewFindings.map((finding, index) => <li key={`${index}-${finding}`}>{finding}</li>)}</ul> : null}</div>}
      <p className="mt-2 text-xs text-muted-foreground">本地预算已占用 {schedule.committedCostMicros.toLocaleString()} 微美元，当前未结预留 {schedule.reservedCostMicros.toLocaleString()} 微美元，用量记录 {schedule.runReservations}/{grant.budget.maxRuns} 次。Scheduler 只在同一冻结授权内安排 Executor/Reviewer 和有限返工；unknown/异常/来源漂移会停等。技术评审不等于业务验收，不会自动完成 Task 或应用成果。</p>
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
      {item.preflightReconciliation && <p className="text-xs text-muted-foreground">发送前失败对账：{item.preflightReconciliation.evidenceKind === 'typed_preflight' ? '类型化拒绝证据' : '历史兼容记录（当时无类型化拒绝事件）'} · {item.preflightReconciliation.reasonCode} · {item.preflightReconciliation.preReconciliationUsageMarker === 'runtime_unknown' ? 'Runtime unknown标记摘要已留审计（非Provider逐请求用量） · ' : ''}本地操作人已确认控制台无用量；不是Provider签名回执。</p>}
      {item.state === 'needs_reconcile' && item.executionStatus === 'failed' && !item.preflightReconciliation && <button type="button" className={button} disabled={busy} onClick={() => void previewPreflightRelease(item)}>预览发送前失败对账</button>}
      {preflightPreview?.commandId === item.commandId && <ProjectOwnerPreflightReconciliationConfirm preview={preflightPreview} busy={busy} checked={preflightChecked} onCheckedChange={setPreflightChecked} onConfirm={() => void confirmPreflightRelease()} />}
      {item.state === 'queued' && <div className="space-y-2"><button type="button" className={button} disabled={busy} onClick={() => void cancel(item)}>取消未启动命令并释放预留</button>{grant?.dispatchMode !== 'autonomous' && <><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={executionConfirmation === item.commandId} disabled={busy} onChange={event => setExecutionConfirmation(event.target.checked ? item.commandId : '')} /><span>我确认现在启动此命令；可能产生 Provider 费用，单次预留上限为 {item.reservedCostMicros.toLocaleString()} 微美元。</span></label><button type="button" className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={busy || executionConfirmation !== item.commandId} onClick={() => void dispatch(item)}>本次执行</button></>}</div>}
      {item.state === 'running' && item.executionId && <AgentExecutionStopButton execution={{ id: item.executionId, status: 'running', entityType: 'task', entityId: item.taskId }} onChanged={refresh} />}
    </article>)}{!commands.length && <p className="text-xs text-muted-foreground">{grant?.dispatchMode === 'autonomous' ? '暂无命令。Scheduler 会在冻结任务满足门禁时自动安排下一角色。' : '暂无命令。任务准备或费用确认不会自动创建命令。'}</p>}</div>
  </section>
}
