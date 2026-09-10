/**
 * 会话运行瀑布图面板。
 *
 * 从本机 JSONL 读取当前会话的运行 span，按 run 分组渲染时间条瀑布；
 * 纯 CSS 实现（无图表库），local-first。
 */

import * as React from 'react'
import type { RuntimeSpan } from '@gravitas/shared'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Activity, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { buildSpanTimeline, groupSpansByRun, type SpanRunGroup } from '@/lib/span-timeline'

/** 格式化耗时：<1s 用 ms，否则 s 保留 1 位。 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

/** 单个 run 的瀑布渲染。 */
function RunWaterfall({ run }: { run: SpanRunGroup }): React.ReactElement {
  const rows = buildSpanTimeline(run.spans)
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <ChevronRight className="size-3" />
        <span>{formatTime(run.startedAt)}</span>
        <span>·</span>
        <span>{run.spans.length} spans</span>
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((row) => (
          <Tooltip key={row.span.spanId}>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2 text-xs">
                <span
                  className={cn(
                    'w-40 shrink-0 truncate text-right font-mono',
                    row.depth === 0 ? 'font-semibold text-foreground' : 'text-muted-foreground',
                  )}
                  style={{ paddingLeft: row.depth * 12 }}
                >
                  {row.span.name}
                </span>
                <div className="relative h-3 flex-1 overflow-hidden rounded-sm bg-muted">
                  <div
                    className={cn(
                      'absolute h-full rounded-sm',
                      row.span.status === 'error'
                        ? 'bg-red-500/70'
                        : row.depth === 0
                          ? 'bg-primary/70'
                          : 'bg-primary/40',
                    )}
                    style={{ left: `${row.leftPct}%`, width: `${row.widthPct}%` }}
                  />
                </div>
                <span className="w-14 shrink-0 text-right font-mono text-muted-foreground">
                  {formatDuration(row.durationMs)}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="font-mono text-xs">{row.span.name}</p>
              <p className="text-xs">
                {formatTime(row.span.startedAt)} → {formatTime(row.span.endedAt)} ·{' '}
                {row.span.status === 'error' ? `失败: ${row.span.error ?? ''}` : '成功'}
              </p>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}

export function SpanWaterfallPanel({ sessionId }: { sessionId: string }): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [runs, setRuns] = React.useState<SpanRunGroup[]>([])
  const [loading, setLoading] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const spans: RuntimeSpan[] = await window.electronAPI.listAgentSpans({ sessionId, limit: 500 })
      setRuns(groupSpansByRun(spans))
    } catch (error) {
      console.error('[SpanWaterfall] 加载 span 失败:', error)
      setRuns([])
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  React.useEffect(() => {
    if (open) void load()
  }, [open, load])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="titlebar-no-drag h-7 w-7 flex-shrink-0"
              aria-label="运行瀑布图"
            >
              <Activity className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom"><p>运行瀑布图（工具调用耗时）</p></TooltipContent>
        </Tooltip>
      </DialogTrigger>
      <DialogContent className="max-h-[70vh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>运行瀑布图</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[52vh] pr-3">
          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>
          ) : runs.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              当前会话暂无运行记录（新会话首次运行后生成）
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {runs.map((run) => (
                <RunWaterfall key={run.taskId} run={run} />
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
