/**
 * DelegateFileTaskDialog — 文件委派给研发 AI 员工（M2 / W04）
 *
 * 从文件浏览器菜单进入：预填项目/工作区/目标文件，选择已拍板决策后
 * 新建任务或关联同项目已有任务。只写范围不派发执行，执行由指派链路触发。
 */
import * as React from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import type { AgentWorkspace } from '@gravitas/shared'

interface DelegateFileTaskDialogProps {
  open: boolean
  onClose: () => void
  /** 预填：所在工作区 ID（可能为空，由用户选择） */
  workspaceId?: string | null
  /** 预填：仓库相对目标路径（会话目录内文件无法推出时为空） */
  initialTargetPath?: string
  /** 委派成功后回调（返回 taskId），宿主可跳转 Review */
  onDelegated?: (taskId: string) => void
}

interface EmployeeOption {
  id: string
  name: string
  enabled: boolean
  executionProfile?: string
  workspaceIds?: string[]
  workspaceId?: string
}

async function projectApi<T>(method: string, ...args: unknown[]): Promise<T> {
  const api = (window as unknown as { electronAPI?: { paa?: { project?: Record<string, (...args: unknown[]) => Promise<unknown>> } } }).electronAPI?.paa?.project
  const fn = api?.[method]
  if (!fn) throw new Error('Project API 未初始化')
  return fn(...args) as Promise<T>
}

function agentApi(): {
  list: () => Promise<EmployeeOption[]>
  prepareFileDelegation: (input: Record<string, unknown>) => Promise<{ taskId: string; created: boolean }>
} | null {
  return (window as unknown as { electronAPI?: { paa?: { agentEmployees?: { list: () => Promise<EmployeeOption[]>; prepareFileDelegation: (input: Record<string, unknown>) => Promise<{ taskId: string; created: boolean }> } } } }).electronAPI?.paa?.agentEmployees ?? null
}

/** 由绝对路径与仓库根推导相对路径；不在仓库内时返回 null */
function toRelativePath(absolutePath: string, rootPath: string | undefined): string | null {
  if (!rootPath) return null
  const norm = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '')
  const root = norm(rootPath)
  const file = norm(absolutePath)
  if (file === root) return null
  if (!file.startsWith(`${root}/`)) return null
  return file.slice(root.length + 1)
}

export function DelegateFileTaskDialog({ open, onClose, workspaceId, initialTargetPath, onDelegated }: DelegateFileTaskDialogProps): React.ReactElement {
  const [projects, setProjects] = React.useState<Array<{ id: string; title: string }>>([])
  const [employees, setEmployees] = React.useState<EmployeeOption[]>([])
  const [workspaces, setWorkspaces] = React.useState<AgentWorkspace[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [done, setDone] = React.useState<{ taskId: string; created: boolean } | null>(null)

  const [projectId, setProjectId] = React.useState('')
  const [employeeId, setEmployeeId] = React.useState('')
  const [scopeWorkspaceId, setScopeWorkspaceId] = React.useState('')
  const [targetPath, setTargetPath] = React.useState('')
  const [allowedPaths, setAllowedPaths] = React.useState('')
  const [decisionId, setDecisionId] = React.useState('')
  const [verificationCommand, setVerificationCommand] = React.useState('')
  const [mode, setMode] = React.useState<'new' | 'link'>('new')
  const [taskTitle, setTaskTitle] = React.useState('')
  const [taskDescription, setTaskDescription] = React.useState('')
  const [existingTaskId, setExistingTaskId] = React.useState('')
  const [existingTasks, setExistingTasks] = React.useState<Array<{ id: string; title: string; status: string }>>([])
  const [decisions, setDecisions] = React.useState<Array<{ id: string; title: string }>>([])

  React.useEffect(() => {
    if (!open) return
    setError(null); setDone(null)
    setTargetPath(initialTargetPath ?? '')
    void (async () => {
      try {
        const [projectList, workspaceList, employeeList] = await Promise.all([
          projectApi<Array<{ id: string; title: string }>>('listProjects'),
          window.electronAPI.listAgentWorkspaces(),
          agentApi()?.list() as Promise<EmployeeOption[]> ?? Promise.resolve([]),
        ])
        setProjects(projectList ?? [])
        setWorkspaces(workspaceList ?? [])
        const development = (employeeList ?? []).filter((e: EmployeeOption) => e.enabled && e.executionProfile === 'development')
        setEmployees(development)
        if (development.length === 1) setEmployeeId(development[0]!.id)
        const presetWorkspace = workspaceList?.find((w) => w.id === workspaceId)
        if (presetWorkspace) setScopeWorkspaceId(presetWorkspace.id)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [open, initialTargetPath, workspaceId])

  // 员工 / 工作区变化时收敛可选工作区；单目标路径默认把所在目录纳入允许范围
  React.useEffect(() => {
    const employee = employees.find((e) => e.id === employeeId)
    const ids = employee?.workspaceIds?.length ? employee.workspaceIds : employee?.workspaceId ? [employee.workspaceId] : []
    if (ids.length === 1) setScopeWorkspaceId(ids[0]!)
    else if (ids.length > 1 && !ids.includes(scopeWorkspaceId)) setScopeWorkspaceId('')
  }, [employeeId, employees, scopeWorkspaceId])

  React.useEffect(() => {
    const dir = targetPath.includes('/') ? targetPath.slice(0, targetPath.lastIndexOf('/')) : '.'
    if (targetPath && !allowedPaths.trim()) setAllowedPaths(dir === '.' ? '.' : dir)
  }, [targetPath, allowedPaths])

  // 项目变化时拉取已拍板决策与可关联任务
  React.useEffect(() => {
    if (!projectId) { setDecisions([]); setExistingTasks([]); return }
    void (async () => {
      try {
        const chain = await projectApi<{ decisions: Array<{ id: string; title: string; status: string }> }>('getChain', projectId)
        setDecisions((chain.decisions ?? []).filter((d) => d.status === 'decided'))
        const tasks = await projectApi<Array<{ id: string; title: string; status: string; completedAt?: number }>>('listTasks', projectId)
        setExistingTasks((tasks ?? []).filter((task) => !task.completedAt).map((task) => ({ id: task.id, title: task.title, status: task.status })))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [projectId])

  const submit = async (): Promise<void> => {
    setBusy(true); setError(null)
    try {
      const api = agentApi()
      if (!api) throw new Error('Agent Employee API 未初始化')
      const result = await api.prepareFileDelegation({
        projectId,
        workspaceId: scopeWorkspaceId,
        employeeId,
        targetPaths: targetPath.trim() ? [targetPath.trim()] : [],
        allowedPaths: allowedPaths.split(/[,\n]/).map((p) => p.trim()).filter(Boolean),
        decisionIds: decisionId ? [decisionId] : [],
        verificationCommands: verificationCommand.trim() ? [verificationCommand.trim()] : [],
        reviewerId: 'local-user',
        ...(mode === 'link' ? { existingTaskId } : { newTask: { title: taskTitle.trim(), description: taskDescription } }),
      }) as { taskId: string; created: boolean }
      setDone(result)
      onDelegated?.(result.taskId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = Boolean(projectId && employeeId && scopeWorkspaceId && targetPath.trim() && allowedPaths.trim() && decisionId
    && (mode === 'link' ? existingTaskId : taskTitle.trim()))

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto" data-testid="delegate-file-task-dialog">
        <DialogHeader>
          <DialogTitle className="text-base">交给 AI 员工修改</DialogTitle>
        </DialogHeader>
        {done ? (
          <div className="space-y-3 text-sm">
            <p className="text-emerald-600 dark:text-emerald-400">
              {done.created ? '已创建研发任务' : '已关联到已有任务'}（{done.taskId.slice(0, 8)}…）。
              指派链路将按配置派发执行；完成后可在任务详情中 Review 差异。
            </p>
            <div className="flex justify-end">
              <button className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground" onClick={onClose}>关闭</button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <label className="block">项目
              <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setDecisionId(''); setExistingTaskId('') }} className="mt-1 w-full rounded-md bg-background px-2 py-1.5">
                <option value="">选择项目…</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
              </select>
            </label>
            <label className="block">研发员工
              <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="mt-1 w-full rounded-md bg-background px-2 py-1.5">
                <option value="">选择研发员工…</option>
                {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
              </select>
            </label>
            <label className="block">执行工作区（须绑定本地 Git 仓库）
              <select value={scopeWorkspaceId} onChange={(e) => setScopeWorkspaceId(e.target.value)} className="mt-1 w-full rounded-md bg-background px-2 py-1.5">
                <option value="">选择工作区…</option>
                {workspaces.filter((w) => w.rootPath).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
            <label className="block">目标文件（仓库相对路径）
              <input value={targetPath} onChange={(e) => setTargetPath(e.target.value)} placeholder="src/format.ts" className="mt-1 w-full rounded-md bg-background px-2 py-1.5 font-mono text-xs" />
            </label>
            <label className="block">允许修改范围（逗号或换行分隔）
              <textarea value={allowedPaths} onChange={(e) => setAllowedPaths(e.target.value)} rows={2} placeholder="src, docs/usage.md" className="mt-1 w-full rounded-md bg-background px-2 py-1.5 font-mono text-xs" />
            </label>
            <label className="block">关联决策（必须已拍板）
              <select value={decisionId} onChange={(e) => setDecisionId(e.target.value)} className="mt-1 w-full rounded-md bg-background px-2 py-1.5" disabled={!projectId}>
                <option value="">{decisions.length ? '选择决策…' : '该项目暂无已拍板决策'}</option>
                {decisions.map((decision) => <option key={decision.id} value={decision.id}>{decision.title}</option>)}
              </select>
            </label>
            <label className="block">验证命令（可选）
              <input value={verificationCommand} onChange={(e) => setVerificationCommand(e.target.value)} placeholder="bun test src/format.test.ts" className="mt-1 w-full rounded-md bg-background px-2 py-1.5 font-mono text-xs" />
            </label>
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1"><input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> 新建任务</label>
              <label className="flex items-center gap-1"><input type="radio" checked={mode === 'link'} onChange={() => setMode('link')} /> 关联已有任务</label>
            </div>
            {mode === 'new' ? (
              <>
                <label className="block">任务标题
                  <input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} className="mt-1 w-full rounded-md bg-background px-2 py-1.5" />
                </label>
                <label className="block">任务说明
                  <textarea value={taskDescription} onChange={(e) => setTaskDescription(e.target.value)} rows={2} className="mt-1 w-full rounded-md bg-background px-2 py-1.5 text-xs" />
                </label>
              </>
            ) : (
              <label className="block">关联任务
                <select value={existingTaskId} onChange={(e) => setExistingTaskId(e.target.value)} className="mt-1 w-full rounded-md bg-background px-2 py-1.5" disabled={!projectId}>
                  <option value="">选择任务…</option>
                  {existingTasks.map((task) => <option key={task.id} value={task.id}>{task.title}（{task.status}）</option>)}
                </select>
              </label>
            )}
            {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
            <div className="flex justify-end gap-2">
              <button className="rounded border px-3 py-1.5 text-xs" onClick={onClose} disabled={busy}>取消</button>
              <button className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50" disabled={!canSubmit || busy} onClick={() => void submit()}>
                {busy ? '提交中…' : '创建委派'}
              </button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              首次派发要求仓库无未提交改动；执行在独立 worktree 进行，交付后停在「待人工验收」，由你在任务详情中审阅差异。
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** 供 SidePanel 等宿主判定文件是否位于仓库内并推导相对路径 */
export function resolveDelegationTarget(absolutePath: string, workspace: AgentWorkspace | undefined): { workspaceId: string; relativePath: string } | null {
  const relative = toRelativePath(absolutePath, workspace?.rootPath)
  return relative ? { workspaceId: workspace!.id, relativePath: relative } : null
}
