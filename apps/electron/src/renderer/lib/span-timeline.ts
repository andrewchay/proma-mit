/**
 * Span 瀑布图布局纯函数。
 *
 * 输入一次 run 的 RuntimeSpan 列表，输出时间条布局（百分比）；
 * 与渲染解耦，便于独立测试。
 */

import type { RuntimeSpan } from '@gravitas/shared'

/** 一次 run（同 taskId）的分组。 */
export interface SpanRunGroup {
  taskId: string
  /** 组内按 startedAt 升序。 */
  spans: RuntimeSpan[]
  /** run 起止（组内最早 start / 最晚 end）。 */
  startedAt: number
  endedAt: number
}

/** 单行瀑布布局。 */
export interface SpanTimelineRow {
  span: RuntimeSpan
  /** 时间条左偏移百分比（相对 run 总时长）。 */
  leftPct: number
  /** 时间条宽度百分比；最小 0.5 防止零宽不可见。 */
  widthPct: number
  /** 层级：task 行 0，tool 行 1。 */
  depth: number
  /** 耗时毫秒。 */
  durationMs: number
}

/** 按 taskId 分组；run 按开始时间倒序（最近在前），组内升序。 */
export function groupSpansByRun(spans: RuntimeSpan[]): SpanRunGroup[] {
  const byTask = new Map<string, RuntimeSpan[]>()
  for (const span of spans) {
    const list = byTask.get(span.taskId) ?? []
    list.push(span)
    byTask.set(span.taskId, list)
  }
  const groups: SpanRunGroup[] = []
  for (const [taskId, list] of byTask) {
    const sorted = [...list].sort((a, b) => a.startedAt - b.startedAt)
    const startedAt = sorted[0]?.startedAt ?? 0
    const endedAt = sorted.reduce((max, s) => Math.max(max, s.endedAt), startedAt)
    groups.push({ taskId, spans: sorted, startedAt, endedAt })
  }
  return groups.sort((a, b) => b.startedAt - a.startedAt)
}

/** 计算一次 run 内所有 span 的时间条布局。 */
export function buildSpanTimeline(run: RuntimeSpan[]): SpanTimelineRow[] {
  if (run.length === 0) return []
  const runStart = Math.min(...run.map((s) => s.startedAt))
  const runEnd = Math.max(...run.map((s) => s.endedAt), runStart)
  const total = Math.max(runEnd - runStart, 1)
  return [...run]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((span) => {
      const durationMs = Math.max(span.endedAt - span.startedAt, 0)
      const widthPct = Math.max((durationMs / total) * 100, 0.5)
      const leftPct = Math.min(((span.startedAt - runStart) / total) * 100, 100 - widthPct)
      return {
        span,
        leftPct,
        widthPct,
        depth: span.kind === 'task' ? 0 : 1,
        durationMs,
      }
    })
}
