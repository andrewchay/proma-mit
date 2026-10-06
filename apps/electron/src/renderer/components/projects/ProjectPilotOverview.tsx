import { useCallback, useEffect, useRef, useState } from 'react'
import type { PilotInboxEntry, PilotIntent, PilotObservation } from '@gravitas/shared'
import { ProjectPilotGrantControl } from './ProjectPilotGrantControl'
import { buildNextStepItems, describeIntentKind, describeTaskState } from './project-user-language'

export function ProjectPilotOverview({ projectId, refreshKey, onOpenSource, onCreateTask }: {
  projectId: string
  refreshKey?: unknown
  onOpenSource: (intent: PilotIntent, task?: PilotObservation['tasks'][number]) => void
  /** 无任务时提供「新建任务/交给 AI 完成」入口（R-P1-01） */
  onCreateTask?: () => void
}): React.ReactElement {
  const [observation, setObservation] = useState<PilotObservation | null>(null)
  const [intents, setIntents] = useState<PilotIntent[]>([])
  const [inbox, setInbox] = useState<PilotInboxEntry[]>([])
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [answering, setAnswering] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const refreshVersion = useRef(0)
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current
    setLoading(true)
    try {
      const [snapshot, entries] = await Promise.all([
        window.electronAPI.paa.project.getPilotOverview(projectId),
        window.electronAPI.paa.project.listPilotInbox(projectId),
      ])
      if (version !== refreshVersion.current) return
      setObservation(snapshot.observation)
      setIntents(snapshot.intents)
      setInbox(entries)
      setAnswers((current) => Object.fromEntries(Object.entries(current).filter(([id]) => entries.some((entry) => entry.sourceId === id))))
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
    setInbox([])
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
  const resolveAnswer = async (entry: PilotInboxEntry, decision: 'approved' | 'rejected') => {
    setAnswering(entry.sourceId)
    try {
      await window.electronAPI.paa.project.resolvePilotApproval(projectId, entry.sourceId, decision, entry.sourceVersion, answers[entry.sourceId] ?? '')
      setAnswers((current) => { const next = { ...current }; delete next[entry.sourceId]; return next })
      await refresh()
    } catch (cause) {
      await refresh().catch(() => undefined)
      setError(cause instanceof Error ? cause.message : '答复失败，请刷新后重试')
    } finally {
      setAnswering(null)
    }
  }
  const counts = observation?.tasks.reduce<Record<string, number>>((result, task) => {
    result[task.state] = (result[task.state] ?? 0) + 1
    return result
  }, {}) ?? {}
  // R-P1-01：下一步行动（≤5 条，优先级在 project-user-language 内聚合）
  const nextSteps = observation ? buildNextStepItems(observation, intents) : []
  return (
    <section className="space-y-4" aria-label="项目进展" data-project-id={projectId}>
      <div className="flex items-start justify-between gap-4 rounded-xl bg-card p-5 shadow-sm">
        <div>
          <h2 className="text-lg font-semibold">项目进展</h2>
          <p className="text-sm text-muted-foreground">当前进展与下一步都在这里；执行授权与预算仍在后台严格把关，成果不会自动视为验收通过。</p>
        </div>
        <div className="flex items-center gap-2">
          {onCreateTask && (
            <button className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground" type="button" onClick={onCreateTask}>
              + 新建任务 / 交给 AI
            </button>
          )}
          <button className="rounded-md bg-muted px-3 py-1.5 text-sm" type="button" onClick={() => void refresh()} disabled={loading}>刷新</button>
        </div>
      </div>
      <details className="rounded-xl bg-card p-4 shadow-sm">
        <summary className="cursor-pointer text-sm font-medium text-muted-foreground">执行授权与预算（高级）</summary>
        <div className="mt-3"><ProjectPilotGrantControl projectId={projectId} refreshKey={refreshKey} /></div>
      </details>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {observation && <>
        {inbox.length > 0 && <div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-950" aria-label="项目待办收件箱">
          <h3 className="font-semibold">待办收件箱 · {inbox.length}</h3>
          <ul className="mt-2 space-y-3">{inbox.map((entry) => <li key={`${entry.sourceType}:${entry.sourceId}`} className="rounded-lg bg-card p-3 text-foreground shadow-sm">
            <p>{entry.reason}</p>
            {entry.sourceType === 'approval' ? <div className="mt-2 space-y-2">
              <label className="block text-xs" htmlFor={`pilot-answer-${entry.sourceId}`}>答复或已解决事项（必填；批准不会扩大已有 Pilot 授权或工具权限）</label>
              <textarea id={`pilot-answer-${entry.sourceId}`} className="w-full rounded-md border bg-background p-2 text-sm" maxLength={500}
                value={answers[entry.sourceId] ?? ''}
                onChange={(event) => setAnswers((current) => ({ ...current, [entry.sourceId]: event.target.value }))} placeholder="写明已解决的信息或拒绝原因" />
              <div className="flex gap-2">
                <button type="button" disabled={answering !== null || !answers[entry.sourceId]?.trim()} onClick={() => void resolveAnswer(entry, 'approved')}
                  className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50">批准并自动续跑</button>
                <button type="button" disabled={answering !== null} onClick={() => void resolveAnswer(entry, 'rejected')}
                  className="rounded-md bg-muted px-3 py-1.5 disabled:opacity-50">拒绝并取消任务</button>
              </div>
            </div> : <p className="mt-1 text-xs text-muted-foreground">请前往决策与协作链路核对权威记录后处理。</p>}
          </li>)}</ul>
        </div>}
        {observation.attention.length > 0 && <div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-950">
          <h3 className="font-semibold">需要人工处理 · {observation.attention.length}</h3>
          <ul className="mt-2 list-inside list-disc space-y-1">
            {observation.attention.map((item) => <li key={`${item.sourceType}:${item.sourceId}`}>{item.reason}（版本 {item.sourceVersion}）</li>)}
          </ul>
          <p className="mt-2">人工询问可在上方收件箱答复；交付与决策请到「治理与交付详情」核验后处理。</p>
        </div>}
        <div className="flex flex-wrap gap-2 text-sm" aria-label="项目状态汇总">
          {(observation.tasks.map((task) => task.state))
            .filter((state, index, all) => all.indexOf(state) === index)
            .map((state) => {
              const language = describeTaskState(state)
              return <span key={state} className="rounded-md bg-muted px-3 py-2">{language.label} {counts[state] ?? 0}</span>
            })}
        </div>
        <div className="rounded-xl bg-card p-4 shadow-sm" aria-label="下一步行动">
          <h3 className="font-semibold">下一步 · {nextSteps.length}</h3>
          {nextSteps.length === 0
            ? <p className="mt-1 text-sm text-muted-foreground">暂无待处理事项。</p>
            : <ul className="mt-3 space-y-2 text-sm">
              {nextSteps.map((step) => {
                const language = describeIntentKind(step.intent.kind)
                const isApproval = step.actionKind === 'open_inbox'
                return <li key={step.id}>
                  {isApproval ? <div className="rounded-lg bg-muted px-3 py-2">
                    <strong>{step.title}</strong> · {language.label}
                    <span className="ml-2 text-muted-foreground">{language.nextAction}</span>
                  </div> : <button type="button" onClick={() => onOpenSource(step.intent, step.task)} className="w-full rounded-lg bg-muted px-3 py-2 text-left hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                    <strong>{step.title}</strong> · {language.label}
                    <span className="ml-2 text-muted-foreground">{step.reason}</span>
                  </button>}
                </li>
              })}
            </ul>}
        </div>
        <div className="space-y-2">
          {observation.tasks.length === 0 && (
            <div className="rounded-xl bg-card p-4 shadow-sm text-sm">
              <p className="text-muted-foreground">这个项目还没有任务。</p>
              {onCreateTask && <button type="button" onClick={onCreateTask} className="mt-2 rounded-md bg-primary px-3 py-1.5 text-primary-foreground">+ 新建任务 / 交给 AI 完成</button>}
            </div>
          )}
          {observation.tasks.map((task) => {
            const language = describeTaskState(task.state)
            return <div key={task.taskId} className="rounded-xl bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2"><strong>{task.title}</strong><span className="text-xs text-muted-foreground">{language.label}</span></div>
              <p className="mt-1 text-sm text-muted-foreground">{language.nextAction}</p>
            </div>
          })}
        </div>
      </>}
    </section>
  )
}
