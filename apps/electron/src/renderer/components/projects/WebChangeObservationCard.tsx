import * as React from 'react'
import type { ProjectWebChangeObservation } from '@gravitas/shared'

/** 主进程 API 调用（与 ProjectView.callProjectAPI 同一通道；就地声明避免循环引用） */
async function callProjectAPI<T>(method: string, ...args: unknown[]): Promise<T> {
  const api = (window as unknown as { electronAPI?: { paa?: { project?: Record<string, (...args: unknown[]) => Promise<unknown>> } } }).electronAPI?.paa?.project
  if (!api) throw new Error('Project API 未初始化')
  const fn = api[method]
  if (!fn) throw new Error(`Project API 方法不存在: ${method}`)
  return fn(...args) as Promise<T>
}

const JUDGMENT_TEXT: Record<string, string> = {
  attention: '值得你了解',
  decision_required: '需要你决定',
  record_only: '已记录',
  insufficient_evidence: '证据不足',
  duplicate: '与既有观察重复',
}

/** 外部变化观察卡片：事实、来源、影响与待决问题；全部只读，链接指向原始网页。 */
export function WebChangeObservationCard({ projectId, observationId, fallbackText }: { projectId: string; observationId: string; fallbackText: string }): React.ReactElement {
  const [observation, setObservation] = React.useState<ProjectWebChangeObservation | null>(null)
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    let cancelled = false
    callProjectAPI<ProjectWebChangeObservation | null>('getWebChangeObservation', projectId, observationId)
      .then((value) => { if (!cancelled) setObservation(value) })
      .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [projectId, observationId])

  if (!observation) {
    return <section className="mt-3 rounded-xl bg-background/80 p-3 shadow-sm" aria-label="外部变化观察">
      <p className="font-medium">外部信息观察</p>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm">{fallbackText}</p>
      <p className="mt-2 text-xs text-muted-foreground">{error ? `观察明细读取失败：${error}。以上为对话内摘要。` : '正在读取观察明细…'}</p>
    </section>
  }

  const [feedback, setFeedback] = React.useState<{ state: 'idle' | 'busy' | 'done' | 'error'; verdict?: string; error?: string }>({ state: 'idle' })
  const sendFeedback = async (verdict: 'helpful' | 'irrelevant' | 'snooze') => {
    setFeedback({ state: 'busy', verdict })
    try {
      await callProjectAPI('recordWebObservationFeedback', { projectId, observationId, verdict })
      setFeedback({ state: 'done', verdict })
    } catch (reason) {
      setFeedback({ state: 'error', verdict, error: reason instanceof Error ? reason.message : String(reason) })
    }
  }

  const facts = observation.facts.filter((fact) => !fact.isInference)
  const inferences = observation.facts.filter((fact) => fact.isInference)
  const unconfirmed = facts.filter((fact) => !fact.publishedAt).length

  return <section className="mt-3 space-y-2 rounded-xl bg-background/80 p-3 shadow-sm" aria-label="外部变化观察">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="font-medium">外部信息观察</p>
      <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{JUDGMENT_TEXT[observation.judgment] ?? observation.judgment}</span>
    </div>
    {facts.length > 0 && <ul className="space-y-2">
      {facts.map((fact) => <li key={`${fact.sourceId}-${fact.quote.slice(0, 24)}`} className="text-sm leading-6">
        <a className="text-primary underline" href={fact.url} target="_blank" rel="noreferrer">{fact.title}</a>
        <span className="ml-1 text-xs text-muted-foreground">{fact.publishedAt ?? '发布时间未确认'}</span>
        {fact.quote && <p className="mt-0.5 text-muted-foreground">“{fact.quote}”</p>}
      </li>)}
    </ul>}
    {inferences.length > 0 && <div className="text-sm leading-6">
      <p className="text-xs text-muted-foreground">推断（不是原文）：</p>
      {inferences.map((fact) => <p key={`${fact.sourceId}-inference`}>{fact.title}</p>)}
    </div>}
    {observation.impact && <p className="text-sm leading-6"><span className="text-muted-foreground">可能的影响：</span>{observation.impact}</p>}
    {observation.suggestion && <p className="text-sm leading-6"><span className="text-muted-foreground">建议（待你确认）：</span>{observation.suggestion}</p>}
    {observation.question && <p className="text-sm leading-6 font-medium"><span className="text-muted-foreground font-normal">需要你决定：</span>{observation.question}</p>}
    {observation.uncertainty && <p className="text-sm leading-6"><span className="text-muted-foreground">不确定之处：</span>{observation.uncertainty}</p>}
    <p className="text-xs leading-5 text-muted-foreground">
      以上来自公开网页，只作材料，不构成执行授权，也没有修改项目、任务或预算。
      {unconfirmed > 0 ? `其中 ${unconfirmed} 条发布时间无法确认，只能当背景参考。` : ''}
    </p>
    <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-2">
      <span className="text-xs text-muted-foreground">这条观察值得提醒吗？</span>
      {([['helpful', '有帮助'], ['irrelevant', '不相关'], ['snooze', '7 天内别再提醒']] as const).map(([verdict, label]) =>
        <button key={verdict} type="button" disabled={feedback.state === 'busy'}
          className="rounded-lg border border-border/60 px-2 py-1 text-xs disabled:opacity-50"
          onClick={() => void sendFeedback(verdict)}>{label}</button>)}
      {feedback.state === 'done' && <span role="status" className="text-xs text-emerald-700">已记录：{feedback.verdict === 'helpful' ? '有帮助' : feedback.verdict === 'irrelevant' ? '这类来源不再提醒' : '7 天内不提醒同类来源'}。这只是提醒偏好，不改项目或授权。</span>}
      {feedback.state === 'error' && <span role="alert" className="text-xs text-destructive">反馈未保存：{feedback.error}</span>}
    </div>
  </section>
}
