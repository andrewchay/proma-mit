import { useEffect, useState } from 'react'
import type { OwnerExecutionAutonomousScheduleStatus, ProjectOwnerGoalSubject } from '@gravitas/shared'
import { summarizeOwnerProjectRow, type OwnerProjectRowSummary } from './project-owner-progress-state'

interface ProjectRow {
  id: string
  title: string
}

interface RowState extends OwnerProjectRowSummary {
  projectId: string
  title: string
  questionTaskId?: string
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
export function OwnerProjectStatusList({ projects, loadStatus, onOpen }: {
  projects: ReadonlyArray<ProjectRow>
  loadStatus: (subject: ProjectOwnerGoalSubject) => Promise<{ ok: true; value: OwnerExecutionAutonomousScheduleStatus } | { ok: false; error: { message: string } }>
  onOpen: (projectId: string, taskId?: string) => void
}): React.ReactElement | null {
  const [rows, setRows] = useState<RowState[]>([])
  const [loading, setLoading] = useState(true)
  // 只有项目集合或标题变化才整体读取；普通更新只刷新对应项目。
  const projectKey = JSON.stringify(projects.map(({ id, title }) => [id, title]))

  useEffect(() => {
    let cancelled = false
    const currentProjects = new Map(projects.map(project => [project.id, project]))
    const requests = new Map<string, number>()
    setLoading(true)
    const readRow = async (project: ProjectRow): Promise<RowState | undefined> => {
      const sequence = (requests.get(project.id) ?? 0) + 1
      requests.set(project.id, sequence)
      const base = { projectId: project.id, title: project.title }
      let row: RowState
      try {
        const result = await loadStatus({ projectId: project.id })
        row = result.ok
          ? { ...base, ...summarizeOwnerProjectRow([], undefined, result.value), questionTaskId: result.value.waitingQuestion?.taskId }
          : { ...base, ...summarizeOwnerProjectRow([], undefined, undefined), error: result.error.message }
      } catch (cause) {
        row = { ...base, ...summarizeOwnerProjectRow([], undefined, undefined), error: cause instanceof Error ? cause.message : '读取失败' }
      }
      if (!cancelled && requests.get(project.id) === sequence) return row
    }
    void Promise.all(projects.map(readRow)).then(next => {
      if (!cancelled) {
        setRows(rows => {
          const merged = new Map(rows.filter(row => currentProjects.has(row.projectId)).map(row => [row.projectId, row]))
          for (const row of next) if (row && requests.get(row.projectId) === 1) merged.set(row.projectId, row)
          return [...merged.values()]
        })
        setLoading(false)
      }
    })
    const off = window.electronAPI?.paa?.project?.onOwnerManagementChanged?.(({ projectId }) => {
      const project = currentProjects.get(projectId)
      if (!project) return
      const refresh = readRow(project)
      const sequence = requests.get(projectId)
      void refresh.then(row => {
        if (row && !cancelled) setRows(rows => requests.get(projectId) === sequence
          ? [...rows.filter(item => item.projectId !== projectId), row] : rows)
      })
    })
    return () => { cancelled = true; off?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey, loadStatus])

  if (!projects.length) return null
  if (loading && !rows.length) return <p className="text-sm text-muted-foreground">正在读取各项目进展…</p>

  // 等待用户的排前面；同组内按标题稳定排序，避免刷新时跳动。
  const ordered = [...rows].sort((left, right) =>
    Number(right.needsUser) - Number(left.needsUser) || left.title.localeCompare(right.title, 'zh-CN'))

  return <section aria-label="项目状态" className="space-y-2">
    <h2 className="text-sm font-medium">项目状态</h2>
    {ordered.map(row => <button key={row.projectId} type="button" onClick={() => onOpen(row.projectId, row.questionTaskId)}
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
