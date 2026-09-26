import { useCallback, useEffect, useRef, useState } from 'react'
import type { PilotIntent, PilotObservation } from '@gravitas/shared'
import { ProjectPilotGrantControl } from './ProjectPilotGrantControl'

const LABELS: Record<PilotObservation['tasks'][number]['state'], string> = {
  waiting_dependency: '等待依赖', awaiting_review: '待人工审阅',
  needs_attention: '需要关注', ready: '可安排', running: '进行中', done: '已完成', inactive: '不参与推进',
}
const INTENT_LABELS: Record<PilotIntent['kind'], string> = {
  dependency_wait: '等待依赖解除', ready_candidate: '待核实可安排',
  review_candidate: '待人工审阅', attention_candidate: '待人工关注',
}

export function ProjectPilotOverview({ projectId, refreshKey, onOpenSource }: {
  projectId: string
  refreshKey?: unknown
  onOpenSource: (intent: PilotIntent, task?: PilotObservation['tasks'][number]) => void
}): React.ReactElement {
  const [observation, setObservation] = useState<PilotObservation | null>(null)
  const [intents, setIntents] = useState<PilotIntent[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const refreshVersion = useRef(0)
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current
    setLoading(true)
    try {
      const snapshot = await window.electronAPI.paa.project.getPilotOverview(projectId)
      if (version !== refreshVersion.current) return
      setObservation(snapshot.observation)
      setIntents(snapshot.intents)
      setError('')
    } catch (cause) {
      if (version !== refreshVersion.current) return
      setError(cause instanceof Error ? cause.message : '加载项目状态失败')
    } finally {
      if (version === refreshVersion.current) setLoading(false)
    }
  }, [projectId])
  useEffect(() => {
    setObservation(null)
    setIntents([])
    void refresh()
    const off = window.electronAPI.paa.project.onProjectActivityChanged((payload) => {
      if (!payload.projectId || payload.projectId === projectId) void refresh()
    })
    return () => { refreshVersion.current++; off() }
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
          <p className="text-sm text-muted-foreground">这里根据项目事实展示下一步线索；只有活动授权和全部门禁通过的执行候选才会进入受控派发。人工事项请到原任务/协作入口审阅。</p>
        </div>
        <button className="rounded-md bg-muted px-3 py-1.5 text-sm" type="button" onClick={() => void refresh()} disabled={loading}>刷新状态</button>
      </div>
      <ProjectPilotGrantControl projectId={projectId} refreshKey={refreshKey} />
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
        <div className="rounded-xl bg-card p-4 shadow-sm" aria-label="当前候选意图">
          <h3 className="font-semibold">当前待处理线索 · {intents.length}</h3>
          <p className="mt-1 text-sm text-muted-foreground">后台保存候选记录并重新核对项目事实；执行候选仍须通过活动授权、预算和 Runtime 门禁，交付不会自动批准。</p>
          {intents.length > 0 && <ul className="mt-3 space-y-2 text-sm">
            {intents.map((intent) => {
              const task = intent.sourceType === 'task' ? observation.tasks.find((item) => item.taskId === intent.sourceId) : undefined
              const attention = observation.attention.find((item) => item.sourceType === intent.sourceType && item.sourceId === intent.sourceId)
              return <li key={intent.id}>
                <button type="button" onClick={() => onOpenSource(intent, task)} className="w-full rounded-lg bg-muted px-3 py-2 text-left hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                  <strong>{task?.title ?? attention?.reason ?? intent.sourceId}</strong> · {INTENT_LABELS[intent.kind]}
                  <span className="ml-2 text-muted-foreground">{intent.sourceType !== 'task' ? '前往决策与协作链路' : task?.parentTaskId ? '定位上级任务' : '定位原任务'}</span>
                </button>
              </li>
            })}
          </ul>}
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
