import type { ReactElement } from 'react'
import { ChevronDown } from 'lucide-react'

export interface ProjectWebWatchRunView {
  id: string
  startedAt: number
  coverageFrom: number
  coverageTo: number
  status: 'success' | 'failed' | 'skipped'
  judgment?: string
  skipReason?: 'budget_exhausted'
  newSources: Array<{
    title: string
    url: string
    snippet: string
    publishedAt?: string
    /** 采集来源；缺省为通用网页搜索。 */
    origin?: { type: 'websearch' } | { type: 'agent-reach'; channel: string; action: string; backend?: string }
  }>
  /** 单源失败明细；存在时展示可折叠的失败列表。 */
  sourceErrors?: Array<{ sourceId: string; channel: string; code: string; message: string }>
  analysis?: string
  error?: string
}

const judgmentLabels = new Map([
  ['record_only', '已记录，无需处理'],
  ['attention', '值得了解'],
  ['decision_required', '需要决定'],
  ['insufficient_evidence', '证据不足'],
  ['duplicate', '重复观察'],
])

const statusLabels = {
  success: '扫描成功',
  failed: '扫描失败',
  skipped: '已跳过',
}

export function ProjectWebWatchHistory({ runs }: { runs: ProjectWebWatchRunView[] }): ReactElement {
  return (
    <section aria-label="扫描历史" className="space-y-3">
      <h3 className="font-medium">扫描历史</h3>
      {runs.length === 0 && <p className="text-sm text-muted-foreground">还没有扫描记录。</p>}
      {runs.map((run) => {
        const date = new Date(run.startedAt)
        const skipReason = run.skipReason === 'budget_exhausted' ? 'Owner 模型额度不足，未做任何外部请求' : null
        const analysis = run.analysis || (run.judgment && (judgmentLabels.get(run.judgment) ?? run.judgment))
        const preview = run.error || skipReason || analysis
        return (
          <details
            key={run.id}
            className="group rounded-xl bg-card shadow-sm"
            onKeyDown={(event) => {
              const details = event.currentTarget
              if (event.key !== 'Escape' || !details.open || event.defaultPrevented) return
              event.preventDefault()
              event.stopPropagation()
              details.open = false
              details.querySelector('summary')?.focus()
            }}
          >
            <summary className="flex cursor-pointer list-none items-start gap-3 rounded-xl px-4 py-3 hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                  <span className="font-medium">{statusLabels[run.status]}</span>
                  <time dateTime={date.toJSON() ?? undefined} className="text-xs tabular-nums text-muted-foreground">{date.toLocaleString()}</time>
                  {run.status === 'success' && (
                    <span className="text-xs text-muted-foreground">
                      {run.newSources.length ? `${run.newSources.length} 条新来源` : '无新来源'}
                    </span>
                  )}
                </span>
                {preview && <span className="mt-1 line-clamp-1 break-words text-sm text-muted-foreground group-open:hidden">{preview}</span>}
              </span>
              <ChevronDown aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground group-open:rotate-180" />
            </summary>
            <div className="space-y-3 px-4 pb-4 text-sm">
              {skipReason && <p>{skipReason}</p>}
              {run.error && <p className="break-words">{run.error}</p>}
              {analysis && (
                <div>
                  <h4 className="font-medium">扫描分析</h4>
                  <p className="mt-1 whitespace-pre-wrap break-words leading-6">{analysis}</p>
                </div>
              )}
              {run.newSources.length > 0 && (
                <div>
                  <h4 className="font-medium">新来源</h4>
                  <ul className="mt-1 space-y-2">
                    {run.newSources.map((source) => (
                      <li key={source.url} className="break-words">
                        <span className="flex flex-wrap items-center gap-2">
                          <a className="text-primary underline underline-offset-2" href={source.url} target="_blank" rel="noreferrer">{source.title}</a>
                          {source.origin?.type === 'agent-reach' && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{source.origin.channel}</span>
                          )}
                        </span>
                        <p className="mt-0.5 text-xs text-muted-foreground">{source.publishedAt ? `${source.publishedAt} · ` : ''}{source.snippet}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(run.sourceErrors?.length ?? 0) > 0 && (
                <details className="rounded-md border border-dashed px-3 py-2">
                  <summary className="cursor-pointer text-sm text-muted-foreground">本次 {run.sourceErrors!.length} 个采集源未成功（不影响其余来源）</summary>
                  <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                    {run.sourceErrors!.map((error, index) => (
                      <li key={`${error.sourceId}-${index}`} className="break-words">{error.channel} · {error.code}：{error.message}</li>
                    ))}
                  </ul>
                </details>
              )}
              <p className="text-xs text-muted-foreground">
                扫描范围：{new Date(run.coverageFrom).toLocaleString()} 至 {new Date(run.coverageTo).toLocaleString()}
              </p>
            </div>
          </details>
        )
      })}
    </section>
  )
}
