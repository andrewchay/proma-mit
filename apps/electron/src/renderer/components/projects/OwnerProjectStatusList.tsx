import { useEffect, useState } from 'react'
import type { OwnerManagementMessage, OwnerExecutionAutonomousScheduleStatus, ProjectOwnerGoalSubject } from '@gravitas/shared'
import { summarizeOwnerProjectRow, type OwnerProjectRowSummary } from './project-owner-progress-state'

interface ProjectRow {
  id: string
  title: string
}

interface RowState extends OwnerProjectRowSummary {
  projectId: string
  title: string
  /** 读取失败时不伪造状态：保留错误并让用户重新读取。 */
  error?: string
}

/**
 * 多项目状态列表。
 *
 * 目的是让用户不必逐个点开就能看出「哪个项目在等我」。等待用户的项目
 * 排在前面，其余按标题稳定排序，避免每次刷新跳动。
 *
 * 只读投影：不触发派工、不改授权，读取失败也不回退成「正常」。
 */
export function OwnerProjectStatusList({ projects, messagesByProject, loadStatus, onOpen }: {
  projects: ReadonlyArray<ProjectRow>
  /** 每个项目已加载的对话消息；缺失时按无消息处理，只用调度状态。 */
  messagesByProject: ReadonlyMap<string, readonly OwnerManagementMessage[]>
  loadStatus: (subject: ProjectOwnerGoalSubject) => Promise<{ ok: true; value: OwnerExecutionAutonomousScheduleStatus } | { ok: false; error: { message: string } }>
  onOpen: (projectId: string) => void
}): React.ReactElement | null {
  const [rows, setRows] = useState<RowState[]>([])
  const [loading, setLoading] = useState(true)
  // 用项目 id 拼成稳定依赖，避免父组件每次渲染都新建数组导致重复请求。
  const projectKey = projects.map(project => project.id).join(',')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void Promise.all(projects.map(async (project): Promise<RowState> => {
      const messages = messagesByProject.get(project.id) ?? []
      try {
        const result = await loadStatus({ projectId: project.id })
        if (!result.ok) return { projectId: project.id, title: project.title, ...summarizeOwnerProjectRow(messages, undefined, undefined), error: result.error.message }
        const schedule = result.value
        return { projectId: project.id, title: project.title, ...summarizeOwnerProjectRow(messages, schedule.taskId, schedule) }
      } catch (cause) {
        return { projectId: project.id, title: project.title, ...summarizeOwnerProjectRow(messages, undefined, undefined), error: cause instanceof Error ? cause.message : '读取失败' }
      }
    })).then((next) => { if (!cancelled) setRows(next) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // messagesByProject 变化不影响状态读取；状态由调度决定，消息只用于覆盖等待提示。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey, loadStatus])

  if (!projects.length) return null
  if (loading && !rows.length) return <p className="text-sm text-muted-foreground">正在读取各项目进展…</p>

  // 等待用户的排前面；同组内按标题稳定排序，避免刷新时跳动。
  const ordered = [...rows].sort((left, right) =>
    Number(right.needsUser) - Number(left.needsUser) || left.title.localeCompare(right.title, 'zh-CN'))

  return <section aria-label="项目状态" className="space-y-2">
    <h2 className="text-sm font-medium">项目状态</h2>
    {ordered.map(row => <button key={row.projectId} type="button" onClick={() => onOpen(row.projectId)}
      className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${row.needsUser ? 'bg-amber-500/10 hover:bg-amber-500/15' : 'bg-muted/50 hover:bg-muted'}`}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${row.needsUser ? 'bg-amber-500' : 'bg-muted-foreground/40'}`} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{row.title}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {row.error ? `读取失败：${row.error}` : `${row.stage}${row.waitingOn ? ` · 等待${row.waitingOn}` : ''} · ${row.nextAction}`}
        </span>
      </span>
      <span className="shrink-0 text-xs text-primary">打开</span>
    </button>)}
  </section>
}
