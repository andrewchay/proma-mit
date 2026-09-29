import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  PilotCommandUsageLine,
  PilotControlSnapshot,
  PilotGrantIssuePreview,
  PilotGrantPauseImpact,
  PilotRunningChoice,
  PilotRunningDisposition,
} from '@gravitas/shared'
import { ProjectPilotPolicyEditor } from './ProjectPilotPolicyEditor'

const formatCost = (micros: number): string => `${(micros / 1_000_000).toFixed(2)} USD 上限`
const formatSpent = (micros: number): string => `${(micros / 1_000_000).toFixed(4)}`
const commandStateLabel: Record<PilotCommandUsageLine['state'], string> = {
  reserved: '预留中', queued: '已排队', running: '执行中', settled: '已结算', released: '已释放', needs_reconcile: '待对账',
}

export function ProjectPilotGrantControl({ projectId, refreshKey }: {
  projectId: string
  refreshKey?: unknown
}): React.ReactElement {
  const [control, setControl] = useState<PilotControlSnapshot | null>(null)
  const [issuePreview, setIssuePreview] = useState<PilotGrantIssuePreview | null>(null)
  const [pausePreview, setPausePreview] = useState<PilotGrantPauseImpact | null>(null)
  const [runningChoices, setRunningChoices] = useState<Record<string, PilotRunningDisposition>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      setControl(await window.electronAPI.paa.project.getPilotControl(projectId))
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载 Pilot 授权状态失败')
    }
  }, [projectId])

  useEffect(() => {
    setControl(null)
    setIssuePreview(null)
    setPausePreview(null)
    setRunningChoices({})
    setNotice('')
    void load()
  }, [load])

  useEffect(() => {
    if (refreshKey !== undefined && refreshKey !== null) void load()
  }, [load, refreshKey])

  const previewIssue = async (): Promise<void> => {
    if (!control?.policy) return
    setBusy(true)
    setNotice('')
    try {
      setIssuePreview(await window.electronAPI.paa.project.previewPilotGrant(projectId, control.policy.revision))
      setError('')
    } catch (cause) {
      setIssuePreview(null)
      setError(cause instanceof Error ? cause.message : '授权影响面预览失败')
      await load()
    } finally { setBusy(false) }
  }

  const confirmIssue = async (): Promise<void> => {
    if (!issuePreview) return
    setBusy(true)
    try {
      await window.electronAPI.paa.project.confirmPilotGrant(issuePreview, issuePreview.approvalFingerprint)
      setIssuePreview(null)
      setNotice('活动授权已发行；符合条件的候选会在后台重新核验全部门禁后进入受控派发。')
      setError('')
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '活动授权发行失败')
      await load()
    } finally { setBusy(false) }
  }

  const previewPause = async (): Promise<void> => {
    if (!control?.activeGrant) return
    setBusy(true)
    setNotice('')
    try {
      const preview = await window.electronAPI.paa.project.previewPilotGrantPause(control.activeGrant.grantId)
      setPausePreview(preview)
      setRunningChoices({})
      setError('')
    } catch (cause) {
      setPausePreview(null)
      setError(cause instanceof Error ? cause.message : '暂停影响面预览失败')
      await load()
    } finally { setBusy(false) }
  }

  const choicesComplete = useMemo(() => pausePreview?.running.every((item) => Boolean(runningChoices[item.executionId])) ?? false,
    [pausePreview, runningChoices])

  const confirmPause = async (): Promise<void> => {
    if (!pausePreview || !choicesComplete) return
    const choices: PilotRunningChoice[] = pausePreview.running.map((item) => ({
      executionId: item.executionId,
      disposition: runningChoices[item.executionId]!,
    }))
    setBusy(true)
    try {
      const result = await window.electronAPI.paa.project.confirmPilotGrantPause(pausePreview, choices)
      setPausePreview(null)
      setRunningChoices({})
      setNotice(`授权已暂停；释放 ${result.releasedReservationCommandIds.length} 条预留，取消 ${result.cancelledExecutionIds.length} 条未启动执行。${result.pendingStopExecutionIds.length ? ` ${result.pendingStopExecutionIds.length} 条运行中停止请求尚待真实停止器核验。` : ''}`)
      setError('')
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '暂停活动授权失败')
      await load()
    } finally { setBusy(false) }
  }

  return (
    <div className="rounded-xl bg-card p-4 shadow-sm" aria-label="Pilot 活动授权">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold">活动授权</h3>
          <p className="mt-1 text-sm text-muted-foreground">授权只冻结工作区、员工、模型和预算边界。Runtime 启动仍被硬门禁阻断。</p>
        </div>
        <button type="button" className="rounded-md bg-muted px-3 py-1.5 text-sm" onClick={() => void load()} disabled={busy}>刷新授权</button>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-950">{notice}</p>}
      {!control && !error && <p className="mt-3 text-sm text-muted-foreground">正在读取授权状态…</p>}
      {control && !control.policy && <div className="mt-3 rounded-lg bg-muted p-3 text-sm">
        <p className="font-medium">尚未保存 Pilot 策略草案</p>
        <p className="mt-1 text-muted-foreground">需先配置隔离 Git 工作区、两名不同员工、渠道/模型、预算、次数和有效期。</p>
      </div>}
      {control && !control.activeGrant && <div className="mt-3"><ProjectPilotPolicyEditor projectId={projectId} control={control}
        onSaved={(snapshot) => { setControl(snapshot); setIssuePreview(null); setNotice('策略草案已保存，需通过预检并另行确认活动授权。') }} /></div>}
      {control?.policy && <div className="mt-3 space-y-3">
        <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <span className="rounded-md bg-muted px-3 py-2">策略版本 {control.policy.revision}</span>
          <span className="rounded-md bg-muted px-3 py-2">执行者 {control.policy.executorEmployeeId ?? '未绑定'}</span>
          <span className="rounded-md bg-muted px-3 py-2">评审者 {control.policy.reviewerEmployeeId ?? '未绑定'}</span>
          <span className="rounded-md bg-muted px-3 py-2">模型 {control.policy.channelId} / {control.policy.modelId}</span>
          <span className="rounded-md bg-muted px-3 py-2">{formatCost(control.policy.maxCostMicros)} · {control.policy.maxRuns} 次</span>
          <span className="rounded-md bg-muted px-3 py-2">有效期至 {new Date(control.policy.expiresAt).toLocaleString()}</span>
        </div>
        {!control.readiness.bindingsValid && <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
          <p className="font-medium">预检未通过</p>
          <ul className="mt-1 list-inside list-disc">{control.readiness.blockers.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>}
        {!control.activeGrant && !issuePreview && <button type="button" className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
          onClick={() => void previewIssue()} disabled={busy || !control.readiness.bindingsValid}>预览活动授权影响面</button>}
        {issuePreview && <div className="rounded-lg bg-blue-50 p-4 text-sm text-blue-950" aria-label="授权发行确认">
          <p className="font-semibold">确认发行版本 {issuePreview.policyRevision} 的活动授权</p>
          <p className="mt-1">工作区 {issuePreview.workspaceId}；执行 {issuePreview.executorEmployeeId}；评审 {issuePreview.reviewerEmployeeId}。</p>
          <p className="mt-1">模型 {issuePreview.channelId} / {issuePreview.modelId}；{formatCost(issuePreview.maxCostMicros)}；最多 {issuePreview.maxRuns} 次，返工 {issuePreview.maxRework} 次；有效期至 {new Date(issuePreview.expiresAt).toLocaleString()}。</p>
          <p className="mt-1">本次确认只写入授权记录；随后后台可能对符合条件的候选重新核验并受控派发。</p>
          <div className="mt-3 flex gap-2">
            <button type="button" className="rounded-md bg-primary px-3 py-2 text-primary-foreground" onClick={() => void confirmIssue()} disabled={busy}>确认发行活动授权</button>
            <button type="button" className="rounded-md bg-white px-3 py-2" onClick={() => setIssuePreview(null)} disabled={busy}>取消</button>
          </div>
        </div>}
        {control.activeGrant && !pausePreview && <div className={`flex items-center justify-between gap-3 rounded-lg p-3 text-sm ${control.grantStatus === 'active' ? 'bg-emerald-50 text-emerald-950' : 'bg-amber-50 text-amber-950'}`}>
          <span>{control.grantStatus === 'active' ? '活动授权' : control.grantStatus === 'expired' ? '授权已过期，不可派发' : '授权与策略不一致，需对账'} {control.activeGrant.grantId}</span>
          <button type="button" className="rounded-md bg-red-600 px-3 py-2 text-white" onClick={() => void previewPause()} disabled={busy}>预览暂停影响面</button>
        </div>}
        {control.budgetUsage && <div className="rounded-lg bg-muted p-3 text-sm" aria-label="Pilot 消耗合计">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-background px-3 py-2 font-medium">已占用 {formatSpent(control.budgetUsage.committedCostMicros)} / {formatSpent(control.budgetUsage.maxCostMicros)}</span>
            <span className="rounded-md bg-background px-3 py-2">剩余 {formatSpent(control.budgetUsage.remainingCostMicros)}</span>
            <span className="rounded-md bg-background px-3 py-2">run {control.budgetUsage.usedRuns}/{control.budgetUsage.maxRuns}</span>
            <span className="rounded-md bg-background px-3 py-2">授权状态 {control.budgetUsage.state === 'active' ? 'active' : 'paused'}</span>
          </div>
          {control.budgetUsage.commands.length > 0 && <table className="mt-2 w-full text-left text-xs" aria-label="Pilot 命令消耗明细">
            <thead><tr className="text-muted-foreground">
              <th className="py-1 font-medium">命令</th><th className="font-medium">角色</th><th className="font-medium">状态</th>
              <th className="font-medium">预留</th><th className="font-medium">实结</th><th className="font-medium">请求（已结/总）</th>
            </tr></thead>
            <tbody>
              {control.budgetUsage.commands.map((line) => <tr key={line.commandId} className="border-t border-border/40">
                <td className="py-1 font-mono">{line.commandId.slice(0, 18)}…</td>
                <td>{line.role === 'executor' ? '执行' : '评审'}</td>
                <td>{commandStateLabel[line.state]}</td>
                <td>{formatSpent(line.reservedCostMicros)}</td>
                <td>{line.actualCostMicros === null ? '—' : formatSpent(line.actualCostMicros)}</td>
                <td>{line.requestsSettled}/{line.requestsTotal}{line.requestsNeedsReconcile > 0 ? `（待对账 ${line.requestsNeedsReconcile}）` : ''}</td>
              </tr>)}
            </tbody>
          </table>}
          <p className="mt-2 text-muted-foreground">口径与预算核验一致：已结算按实结计，未结命令按预留占额；待对账占额不自动释放。</p>
        </div>}
        {pausePreview && <div className="rounded-lg bg-red-50 p-4 text-sm text-red-950" aria-label="暂停授权确认">
          <p className="font-semibold">暂停后立即阻止新派发</p>
          <p className="mt-1">将释放 {pausePreview.reservedCommandIds.length} 条未排队预留，取消 {pausePreview.queued.length} 条未启动执行；{pausePreview.running.length} 条运行中执行需逐项选择。</p>
          {pausePreview.running.map((item) => <label key={item.executionId} className="mt-3 block rounded-md bg-white p-3">
            <span className="block font-medium">执行 {item.executionId} · 任务 {item.taskId}</span>
            <select className="mt-2 w-full rounded-md bg-muted px-3 py-2" value={runningChoices[item.executionId] ?? ''}
              onChange={(event) => setRunningChoices((current) => ({ ...current, [item.executionId]: event.target.value as PilotRunningDisposition }))}>
              <option value="">请选择处理方式</option>
              <option value="finish_current">允许完成当前执行</option>
              <option value="request_stop">记录停止请求（终止结果待核验）</option>
            </select>
          </label>)}
          <div className="mt-3 flex gap-2">
            <button type="button" className="rounded-md bg-red-600 px-3 py-2 text-white disabled:opacity-50" onClick={() => void confirmPause()} disabled={busy || !choicesComplete}>确认暂停并取消未启动任务</button>
            <button type="button" className="rounded-md bg-white px-3 py-2" onClick={() => { setPausePreview(null); setRunningChoices({}) }} disabled={busy}>取消</button>
          </div>
        </div>}
      </div>}
    </div>
  )
}
