/**
 * CreateProjectTaskDialog — 统一「新建任务」入口（R-P0-03/04/05）
 *
 * 第一步选择工作方式：
 * - 普通任务：只填日常字段（标题/说明/优先级/负责人/截止日期）
 * - 交给 AI 完成：完整组装研发执行范围（员工/工作区/目标路径/允许范围/决策/验证命令），
 *   复用主进程 prepareFileDelegation，不会创建缺少 developmentScope 的半有效 AI 任务。
 * 权限申请、依赖、Token 配额等高级字段保留在原「高级新建」表单中。
 */
import * as React from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useAtomValue } from 'jotai'
import { userProfileAtom } from '@/atoms/user-profile'
import type { AgentWorkspace } from '@gravitas/shared'

/** 与 ProjectView 本地 Task 接口对齐的优先级取值（避免跨组件循环引用） */
type TaskPriority = 'low' | 'medium' | 'high' | 'critical'

interface CreateProjectTaskDialogProps {
  open: boolean
  onClose: () => void
  projectId: string
  /** 创建成功后回调（返回 taskId），宿主可刷新任务列表 */
  onCreated: (taskId: string) => void
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

const fieldClass = 'mt-1 w-full rounded-md bg-background px-2 py-1.5 text-sm'

export function CreateProjectTaskDialog({ open, onClose, projectId, onCreated }: CreateProjectTaskDialogProps): React.ReactElement {
  const userProfile = useAtomValue(userProfileAtom)
  const [mode, setMode] = React.useState<'normal' | 'ai'>('normal')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [done, setDone] = React.useState<{ taskId: string; created: boolean } | null>(null)

  // 普通任务字段
  const [title, setTitle] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [priority, setPriority] = React.useState<TaskPriority>('medium')
  const [assigneeName, setAssigneeName] = React.useState('')
  const [dueDate, setDueDate] = React.useState('')

  // AI 任务字段（完整研发执行范围）
  const [employees, setEmployees] = React.useState<EmployeeOption[]>([])
  const [workspaces, setWorkspaces] = React.useState<AgentWorkspace[]>([])
  const [decisions, setDecisions] = React.useState<Array<{ id: string; title: string }>>([])
  const [employeeId, setEmployeeId] = React.useState('')
  const [scopeWorkspaceId, setScopeWorkspaceId] = React.useState('')
  const [targetPaths, setTargetPaths] = React.useState('')
  const [allowedPaths, setAllowedPaths] = React.useState('')
  const [decisionId, setDecisionId] = React.useState('')
  const [verificationCommand, setVerificationCommand] = React.useState('')

  // 打开时重置表单并读取员工/工作区；R-P0-05：依赖 open 触发，避免复用陈旧快照
  React.useEffect(() => {
    if (!open) return
    setError(null); setDone(null)
    setTitle(''); setDescription(''); setPriority('medium'); setAssigneeName(''); setDueDate('')
    setEmployeeId(''); setScopeWorkspaceId(''); setTargetPaths(''); setAllowedPaths('')
    setDecisionId(''); setVerificationCommand('')
    void (async () => {
      try {
        const [workspaceList, employeeList] = await Promise.all([
          window.electronAPI.listAgentWorkspaces(),
          agentApi()?.list() as Promise<EmployeeOption[]> ?? Promise.resolve([]),
        ])
        setWorkspaces(workspaceList ?? [])
        const development = (employeeList ?? []).filter((e: EmployeeOption) => e.enabled && e.executionProfile === 'development')
        setEmployees(development)
        if (development.length === 1) setEmployeeId(development[0]!.id)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [open])

  // 决策列表：打开或项目变化时重新读取（拍板后无需关闭重开）
  React.useEffect(() => {
    if (!open || !projectId) { setDecisions([]); return }
    void (async () => {
      try {
        const chain = await projectApi<{ decisions: Array<{ id: string; title: string; status: string }> }>('getChain', projectId)
        setDecisions((chain.decisions ?? []).filter((d) => d.status === 'decided'))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [open, projectId])

  // 员工变化时收敛可选工作区
  React.useEffect(() => {
    const employee = employees.find((e) => e.id === employeeId)
    const ids = employee?.workspaceIds?.length ? employee.workspaceIds : employee?.workspaceId ? [employee.workspaceId] : []
    if (ids.length === 1) setScopeWorkspaceId(ids[0]!)
    else if (ids.length > 1 && !ids.includes(scopeWorkspaceId)) setScopeWorkspaceId('')
  }, [employeeId, employees, scopeWorkspaceId])

  // 默认允许范围 = 第一个目标路径所在目录
  React.useEffect(() => {
    const first = targetPaths.split(/[,\n]/).map((p) => p.trim()).filter(Boolean)[0]
    if (first && !allowedPaths.trim()) {
      const dir = first.includes('/') ? first.slice(0, first.lastIndexOf('/')) : '.'
      setAllowedPaths(dir === '.' ? '.' : dir)
    }
  }, [targetPaths, allowedPaths])

  const normalCanSubmit = Boolean(title.trim())
  const aiCanSubmit = Boolean(title.trim() && employeeId && scopeWorkspaceId && targetPaths.trim() && allowedPaths.trim() && decisionId)
  const canSubmit = mode === 'normal' ? normalCanSubmit : aiCanSubmit

  const submit = async (): Promise<void> => {
    setBusy(true); setError(null)
    try {
      if (mode === 'normal') {
        const input: Record<string, unknown> = {
          title: title.trim(),
          description,
          priority,
          createdByUserId: `paa-${userProfile.userName}`,
        }
        if (assigneeName.trim()) input.assignee = { userId: `paa-${assigneeName.trim()}`, displayName: assigneeName.trim() }
        if (dueDate) input.dueDate = new Date(`${dueDate}T00:00:00`).getTime()
        const task = await projectApi<{ id: string }>('createTask', projectId, input)
        setDone({ taskId: task.id, created: true })
        onCreated(task.id)
      } else {
        const api = agentApi()
        if (!api) throw new Error('Agent Employee API 未初始化')
        const result = await api.prepareFileDelegation({
          projectId,
          workspaceId: scopeWorkspaceId,
          employeeId,
          targetPaths: targetPaths.split(/[,\n]/).map((p) => p.trim()).filter(Boolean),
          allowedPaths: allowedPaths.split(/[,\n]/).map((p) => p.trim()).filter(Boolean),
          decisionIds: [decisionId],
          verificationCommands: verificationCommand.trim() ? [verificationCommand.trim()] : [],
          reviewerId: 'local-user',
          newTask: { title: title.trim(), description },
        }) as { taskId: string; created: boolean }
        setDone(result)
        onCreated(result.taskId)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto" data-testid="create-project-task-dialog">
        <DialogHeader>
          <DialogTitle className="text-base">新建任务</DialogTitle>
        </DialogHeader>
        {done ? (
          <div className="space-y-3 text-sm">
            <p className="text-emerald-600 dark:text-emerald-400">
              {mode === 'ai'
                ? `已创建 AI 任务（${done.taskId.slice(0, 8)}…），包含完整执行范围；完成后将进入「待人工验收」。`
                : `已创建任务（${done.taskId.slice(0, 8)}…）。`}
            </p>
            <div className="flex justify-end">
              <button className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground" onClick={onClose}>关闭</button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <fieldset>
              <legend className="text-xs text-muted-foreground">选择工作方式</legend>
              <div className="mt-1 grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setMode('normal')} aria-pressed={mode === 'normal'}
                  className={`rounded-md border p-2 text-left ${mode === 'normal' ? 'border-primary bg-primary/5' : ''}`}>
                  <span className="block text-sm font-medium">普通任务</span>
                  <span className="mt-1 block text-xs text-muted-foreground">自己或真人协作完成，填写目标即可</span>
                </button>
                <button type="button" onClick={() => setMode('ai')} aria-pressed={mode === 'ai'}
                  className={`rounded-md border p-2 text-left ${mode === 'ai' ? 'border-primary bg-primary/5' : ''}`}>
                  <span className="block text-sm font-medium">交给 AI 完成</span>
                  <span className="mt-1 block text-xs text-muted-foreground">AI 员工在指定仓库范围内执行，完成后进入人工验收</span>
                </button>
              </div>
            </fieldset>
            <label className="block">任务目标（标题）
              <input value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder={mode === 'ai' ? '例如：修复报价负数边界并补测试' : '例如：整理本周会议纪要'} className={fieldClass} />
            </label>
            <label className="block">说明与验收标准
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
                placeholder="希望做成什么样？怎么算完成？" className={fieldClass} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">优先级
                <select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)} className={fieldClass}>
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                  <option value="critical">严重</option>
                </select>
              </label>
              {mode === 'normal' && (
                <label className="block">负责人（可选）
                  <input value={assigneeName} onChange={(e) => setAssigneeName(e.target.value)} placeholder="留空则未指派" className={fieldClass} />
                </label>
              )}
              {mode === 'normal' && (
                <label className="block">截止日期（可选）
                  <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={fieldClass} />
                </label>
              )}
            </div>
            {mode === 'ai' && (
              <fieldset className="space-y-3 rounded-md border p-3">
                <legend className="text-xs text-muted-foreground">AI 执行配置（全部必填，避免任务无法进入交付）</legend>
                <label className="block">研发员工
                  <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className={fieldClass}>
                    <option value="">选择研发员工…</option>
                    {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
                  </select>
                </label>
                <label className="block">执行工作区（须绑定本地 Git 仓库）
                  <select value={scopeWorkspaceId} onChange={(e) => setScopeWorkspaceId(e.target.value)} className={fieldClass}>
                    <option value="">选择工作区…</option>
                    {workspaces.filter((w) => w.rootPath).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </label>
                <label className="block">目标文件/目录（仓库相对路径，逗号或换行分隔）
                  <textarea value={targetPaths} onChange={(e) => setTargetPaths(e.target.value)} rows={2}
                    placeholder="src/pricing.py" className={`${fieldClass} font-mono text-xs`} />
                </label>
                <label className="block">允许修改范围
                  <textarea value={allowedPaths} onChange={(e) => setAllowedPaths(e.target.value)} rows={2}
                    placeholder="src, tests" className={`${fieldClass} font-mono text-xs`} />
                </label>
                <label className="block">关联决策（必须已拍板）
                  <select value={decisionId} onChange={(e) => setDecisionId(e.target.value)} className={fieldClass}>
                    <option value="">{decisions.length ? '选择决策…' : '该项目暂无已拍板决策，请先到「治理与交付详情」拍板'}</option>
                    {decisions.map((decision) => <option key={decision.id} value={decision.id}>{decision.title}</option>)}
                  </select>
                </label>
                <label className="block">验证命令（可选）
                  <input value={verificationCommand} onChange={(e) => setVerificationCommand(e.target.value)}
                    placeholder="bun test src/pricing.test.ts" className={`${fieldClass} font-mono text-xs`} />
                </label>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  首次派发要求仓库无未提交改动；执行在独立 worktree 进行，交付后停在「待人工验收」，由你在任务详情中审阅差异。
                </p>
              </fieldset>
            )}
            {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
            <div className="flex justify-end gap-2">
              <button className="rounded border px-3 py-1.5 text-xs" onClick={onClose} disabled={busy}>取消</button>
              <button className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
                disabled={!canSubmit || busy} onClick={() => void submit()}>
                {busy ? '提交中…' : mode === 'ai' ? '创建 AI 任务' : '创建任务'}
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
