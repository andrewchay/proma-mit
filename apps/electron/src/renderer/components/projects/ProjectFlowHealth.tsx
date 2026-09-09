import type { CollaborationBlocker, CollaborationTask } from './ProjectCollaborationTasks'
import { calculateProjectFlowMetrics } from './project-flow-metrics'

interface Props {
  tasks: CollaborationTask[]
  blockers: CollaborationBlocker[]
  serviceLevelDays: number
  busy: boolean
  onServiceLevelChange: (days: number) => void
}

export function ProjectFlowHealth({
  tasks,
  blockers,
  serviceLevelDays,
  busy,
  onServiceLevelChange,
}: Props): React.ReactElement {
  const metrics = calculateProjectFlowMetrics(
    tasks,
    new Set(blockers.map((item) => item.taskId)),
    serviceLevelDays,
  )
  const values: Array<[string, string | number]> = [
    ['在制品', metrics.workInProgress],
    ['等待', metrics.waiting],
    ['30 天吞吐', metrics.throughput30Days],
    ['平均周期', metrics.averageCycleTimeDays === undefined ? '—' : `${metrics.averageCycleTimeDays} 天`],
    ['最老工作项', metrics.oldestWorkItemAgeDays === undefined ? '—' : `${metrics.oldestWorkItemAgeDays} 天`],
    ['SLE 超时', metrics.serviceLevelBreaches],
  ]
  return (
    <section className="rounded-xl bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-medium">流动健康</h3>
          <p className="text-sm text-muted-foreground">基于任务权威时间戳；吞吐窗口为最近 30 天。</p>
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            onServiceLevelChange(Number(new FormData(event.currentTarget).get('serviceLevelDays')))
          }}
        >
          <label className="text-sm">SLE（天）</label>
          <input
            name="serviceLevelDays"
            type="number"
            min="0.1"
            max="365"
            step="0.1"
            required
            defaultValue={serviceLevelDays}
            className="w-24 rounded-md bg-background px-3 py-2 text-sm shadow-sm ring-1 ring-border"
          />
          <button
            disabled={busy}
            className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            保存
          </button>
        </form>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {values.map(([label, value]) => (
          <div key={label} className="rounded-lg bg-primary/10 p-3 shadow-sm">
            <div className="text-xl font-semibold">{value}</div>
            <div className="text-xs">{label}</div>
          </div>
        ))}
      </div>
    </section>
  )
}
