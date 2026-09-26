import { useCallback, useEffect, useState } from 'react'
import type { PilotObservation } from '@gravitas/shared'

const LABELS: Record<PilotObservation['tasks'][number]['state'], string> = {
  waiting_dependency: '等待依赖', awaiting_review: '待人工审阅',
  needs_attention: '需要关注', ready: '可安排', running: '进行中', done: '已完成', inactive: '不参与推进',
}

export function ProjectPilotOverview({ projectId, refreshKey }: { projectId: string; refreshKey?: unknown }): React.ReactElement {
  const [observation, setObservation] = useState<PilotObservation | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.paa.project.observePilot(projectId)
      setObservation(result)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载项目状态失败')
    } finally {
      setLoading(false)
    }
  }, [projectId])
  useEffect(() => {
    setObservation(null)
    void refresh()
    const off = window.electronAPI.paa.project.onProjectActivityChanged((payload) => {
      if (!payload.projectId || payload.projectId === projectId) void refresh()
    })
    return () => off()
  }, [projectId, refresh])
  useEffect(() => {
    if (refreshKey !== undefined && refreshKey !== null) void refresh()
  }, [refreshKey, refresh])
  // 链路审批、依赖交接等没有统一推送；只在概览可见时定期重读权威事实。
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, 30_000)
    return () => window.clearInterval(timer)
  }, [refresh])
  const counts = observation?.tasks.reduce<Record<string, number>>((result, task) => {
    result[task.state] = (result[task.state] ?? 0) + 1
    return result
  }, {}) ?? {}
  return (
    <section className="space-y-4" aria-label="项目驾驶观察" data-project-id={projectId}>
      <div className="flex items-start justify-between gap-4 rounded-xl bg-card p-5 shadow-sm">
        <div>
          <h2 className="text-lg font-semibold">项目驾驶 · 状态观察</h2>
          <p className="text-sm text-muted-foreground">当前仅根据项目事实展示下一步线索，不调用模型或自动派发。需要人工处理的事项请到原任务/协作入口审阅。</p>
        </div>
        <button className="rounded-md bg-muted px-3 py-1.5 text-sm" type="button" onClick={() => void refresh()} disabled={loading}>刷新状态</button>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {observation && <>
        {observation.attention.length > 0 && <div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-950">
          <h3 className="font-semibold">需要人工处理 · {observation.attention.length}</h3>
          <ul className="mt-2 list-inside list-disc space-y-1">
            {observation.attention.map((item) => <li key={`${item.sourceType}:${item.sourceId}`}>{item.reason}（版本 {item.sourceVersion}）</li>)}
          </ul>
          <p className="mt-2">请在「决策与协作链路」中查看权威记录与证据后处理；这里不直接批准。</p>
        </div>}
        <div className="flex flex-wrap gap-2 text-sm" aria-label="项目状态汇总">
          {(Object.keys(LABELS) as Array<keyof typeof LABELS>).map((state) => <span key={state} className="rounded-md bg-muted px-3 py-2">{LABELS[state]} {counts[state] ?? 0}</span>)}
        </div>
        <div className="space-y-2">
          {observation.tasks.length === 0 && <p className="text-sm text-muted-foreground">暂无任务。先在任务页创建任务。</p>}
          {observation.tasks.map((task) => (
            <div key={task.taskId} className="rounded-xl bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2"><strong>{task.title}</strong><span className="text-xs text-muted-foreground">{LABELS[task.state]}</span></div>
              <p className="mt-1 text-sm text-muted-foreground">{task.reason}</p>
            </div>
          ))}
        </div>
      </>}
    </section>
  )
}
