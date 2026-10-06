import { useEffect, useMemo, useState } from 'react'
import type { AgentEmployeeResult, AgentWorkspace, PilotControlSnapshot, PilotPolicyDraftInput } from '@gravitas/shared'

const employeeWorkspaces = (employee: AgentEmployeeResult): string[] => (
  employee.workspaceIds?.length ? employee.workspaceIds : employee.workspaceId ? [employee.workspaceId] : []
)

/** 首版只允许安全研发员工进入候选列表，最终仍由主进程预检。 */
export function isPilotEmployeeCandidate(employee: AgentEmployeeResult): boolean {
  return employee.enabled && employee.executionProfile === 'development' && !employee.workflowId
    && (employee.permissionMode ?? 'safe') === 'safe' && ['proma', 'ai-sdk'].includes(employee.runtime)
    && Boolean(employee.channelId && employee.modelId)
}

export function ProjectPilotPolicyEditor({ projectId, control, onSaved }: {
  projectId: string
  control: PilotControlSnapshot
  onSaved: (snapshot: PilotControlSnapshot) => void
}): React.ReactElement {
  const [open, setOpen] = useState(!control.policy)
  const [employees, setEmployees] = useState<AgentEmployeeResult[]>([])
  const [workspaces, setWorkspaces] = useState<AgentWorkspace[]>([])
  const [executorId, setExecutorId] = useState(control.policy?.executorEmployeeId ?? '')
  const [reviewerId, setReviewerId] = useState(control.policy?.reviewerEmployeeId ?? '')
  const [workspaceId, setWorkspaceId] = useState(control.policy?.workspaceId ?? '')
  const [costUsd, setCostUsd] = useState(control.policy ? String(control.policy.maxCostMicros / 1_000_000) : '2')
  const [maxRuns, setMaxRuns] = useState(String(control.policy?.maxRuns ?? 2))
  const [maxRework, setMaxRework] = useState(String(control.policy?.maxRework ?? 1))
  const [expiryHours, setExpiryHours] = useState(control.policy
    ? String(Math.max(1, Math.ceil((control.policy.expiresAt - Date.now()) / 3_600_000))) : '24')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void Promise.all([window.electronAPI.paa.agentEmployees.list(), window.electronAPI.listAgentWorkspaces()])
      .then(([employeeList, workspaceList]) => {
        setEmployees(employeeList.filter(isPilotEmployeeCandidate))
        setWorkspaces(workspaceList.filter((item) => Boolean(item.rootPath)))
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '加载员工与工作区失败'))
  }, [])

  const executor = employees.find((item) => item.id === executorId)
  const reviewer = employees.find((item) => item.id === reviewerId)
  const commonWorkspaceIds = useMemo(() => {
    if (!executor || !reviewer) return []
    const reviewerIds = new Set(employeeWorkspaces(reviewer))
    return employeeWorkspaces(executor).filter((id) => reviewerIds.has(id))
  }, [executor, reviewer])
  const bindingMatches = Boolean(executor && reviewer && executor.id !== reviewer.id
    && executor.channelId === reviewer.channelId && executor.modelId === reviewer.modelId)

  useEffect(() => {
    if (workspaceId && !commonWorkspaceIds.includes(workspaceId)) setWorkspaceId('')
  }, [commonWorkspaceIds, workspaceId])

  const save = async (): Promise<void> => {
    const cost = Number(costUsd)
    const runs = Number(maxRuns)
    const rework = Number(maxRework)
    const hours = Number(expiryHours)
    if (!executor || !reviewer || !bindingMatches || !workspaceId || !commonWorkspaceIds.includes(workspaceId)
      || !Number.isFinite(cost) || cost <= 0 || !Number.isInteger(runs) || runs <= 0
      || !Number.isInteger(rework) || rework < 0 || !Number.isFinite(hours) || hours <= 0) {
      setError('请完整选择两名同渠道/模型的安全研发员工、共同 Git 工作区和有效额度')
      return
    }
    const input: PilotPolicyDraftInput = {
      workspaceId,
      employeeIds: [executor.id, reviewer.id],
      executorEmployeeId: executor.id,
      reviewerEmployeeId: reviewer.id,
      channelId: executor.channelId,
      modelId: executor.modelId!,
      maxCostMicros: Math.round(cost * 1_000_000),
      maxRuns: runs,
      maxRework: rework,
      expiresAt: Date.now() + Math.round(hours * 3_600_000),
    }
    setBusy(true)
    try {
      const snapshot = await window.electronAPI.paa.project.savePilotPolicyDraft(
        projectId, input, control.policy?.revision ?? null,
      )
      onSaved(snapshot)
      setOpen(false)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存 Pilot 策略草案失败')
    } finally { setBusy(false) }
  }

  if (!open) return <button type="button" className="rounded-md bg-muted px-3 py-2 text-sm" onClick={() => setOpen(true)}>
    {control.policy ? '调整策略草案' : '配置策略草案'}
  </button>

  return <div className="rounded-lg bg-muted/70 p-4 text-sm" aria-label="Pilot 策略草案">
    <div className="flex items-center justify-between gap-3">
      <div><p className="font-semibold">{control.policy ? `调整策略草案 · 当前版本 ${control.policy.revision}` : '配置 Pilot 策略草案'}</p>
        <p className="mt-1 text-muted-foreground">保存后始终保持暂停；必须另行预览并确认才会发行活动授权。</p></div>
      {control.policy && <button type="button" className="rounded-md bg-background px-3 py-1.5" onClick={() => setOpen(false)}>收起</button>}
    </div>
    <div className="mt-3 grid gap-3 md:grid-cols-2">
      <label>执行员工<select className="mt-1 w-full rounded-md bg-background px-3 py-2" value={executorId} onChange={(event) => setExecutorId(event.target.value)}>
        <option value="">请选择</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.channelId}/{item.modelId}</option>)}
      </select></label>
      <label>技术评审员工<select className="mt-1 w-full rounded-md bg-background px-3 py-2" value={reviewerId} onChange={(event) => setReviewerId(event.target.value)}>
        <option value="">请选择</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.channelId}/{item.modelId}</option>)}
      </select></label>
      <label>共同 Git 工作区<select className="mt-1 w-full rounded-md bg-background px-3 py-2" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} disabled={!bindingMatches}>
        <option value="">请选择</option>{workspaces.filter((item) => commonWorkspaceIds.includes(item.id)).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.rootPath}</option>)}
      </select></label>
      <label>费用上限（USD）<input className="mt-1 w-full rounded-md bg-background px-3 py-2" type="number" min="0.01" step="0.01" value={costUsd} onChange={(event) => setCostUsd(event.target.value)} /></label>
      <label>最多执行次数<input className="mt-1 w-full rounded-md bg-background px-3 py-2" type="number" min="1" step="1" value={maxRuns} onChange={(event) => setMaxRuns(event.target.value)} /></label>
      <label>最多返工次数<input className="mt-1 w-full rounded-md bg-background px-3 py-2" type="number" min="0" step="1" value={maxRework} onChange={(event) => setMaxRework(event.target.value)} /></label>
      <label>有效期（小时）<input className="mt-1 w-full rounded-md bg-background px-3 py-2" type="number" min="1" step="1" value={expiryHours} onChange={(event) => setExpiryHours(event.target.value)} /></label>
    </div>
    {!bindingMatches && executorId && reviewerId && <p className="mt-3 text-amber-700">两名员工必须不同，并使用相同的渠道与模型。</p>}
    {error && <p role="alert" className="mt-3 text-destructive">{error}</p>}
    <button type="button" className="mt-3 rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" onClick={() => void save()} disabled={busy}>保存暂停草案</button>
  </div>
}
