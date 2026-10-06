/**
 * 行为采集聚合算法（纯函数，无 Electron/Node 依赖）
 *
 * 输入是事件流，输出是日汇总与总览。刻意不含任何 I/O：
 * 读写由 electron 层 telemetry-service 负责，这里只做确定性计算，
 * 便于单测覆盖边界（跨天、跨时区、缺字段、乱序事件）。
 *
 * 时区约定：日期分桶用**本地时间**。事件 at 是 ISO 字符串，按本地
 * 时区取 YYYY-MM-DD，而不是 UTC —— 否则东八区凌晨的事件会被算到前一天。
 */

import type {
  TelemetryCategory,
  TelemetryDailySummary,
  TelemetryEvent,
  TelemetryEventType,
  TelemetryOverview,
} from '@gravitas/shared'

/** 本地日期字符串（YYYY-MM-DD） */
export function toLocalDateKey(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 今天的本地日期字符串 */
export function todayKey(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 日期字符串加减天数（本地时区，避免 UTC 偏移） */
export function shiftDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  if (!y || !m || !d) return dateKey
  const date = new Date(y, m - 1, d + days)
  return todayKey(date)
}

/** 两个日期键相差的天数（b - a） */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  if (!ay || !am || !ad || !by || !bm || !bd) return 0
  const first = new Date(ay, am - 1, ad).getTime()
  const second = new Date(by, bm - 1, bd).getTime()
  return Math.round((second - first) / 86_400_000)
}

/** 按日聚合事件流 */
export function aggregateDaily(events: TelemetryEvent[]): TelemetryDailySummary[] {
  // 先按日期分桶，桶内再按类型累计
  const buckets = new Map<
    string,
    {
      counts: Partial<Record<TelemetryEventType, number>>
      noteIds: Set<string>
      focusSeconds: number
      meetingMinutes: number
      moodScores: number[]
    }
  >()

  for (const event of events) {
    const dateKey = toLocalDateKey(event.at)
    if (!dateKey) continue // 时间非法的事件直接忽略，不污染统计

    let bucket = buckets.get(dateKey)
    if (!bucket) {
      bucket = { counts: {}, noteIds: new Set(), focusSeconds: 0, meetingMinutes: 0, moodScores: [] }
      buckets.set(dateKey, bucket)
    }

    bucket.counts[event.type] = (bucket.counts[event.type] ?? 0) + 1

    switch (event.type) {
      case 'note_opened':
      case 'note_saved':
      case 'note_referenced_by_agent': {
        // 笔记数按去重算：同一篇笔记反复打开不应重复计数
        const noteId = event.meta?.noteId
        if (typeof noteId === 'string' && noteId) bucket.noteIds.add(noteId)
        break
      }
      case 'session_finished': {
        if (typeof event.value === 'number' && event.value > 0) {
          bucket.focusSeconds += event.value
        }
        break
      }
      case 'meeting_attended': {
        if (typeof event.value === 'number' && event.value > 0) {
          bucket.meetingMinutes += event.value
        }
        break
      }
      case 'mood_logged': {
        if (typeof event.value === 'number' && event.value > 0) {
          bucket.moodScores.push(event.value)
        }
        break
      }
      default:
        break
    }
  }

  return [...buckets.entries()]
    .map(([date, bucket]): TelemetryDailySummary => {
      const summary: TelemetryDailySummary = {
        date,
        counts: bucket.counts,
        notesTouched: bucket.noteIds.size,
        focusSeconds: bucket.focusSeconds,
        meetingMinutes: bucket.meetingMinutes,
        moodCheckins: bucket.moodScores.length,
      }
      if (bucket.moodScores.length > 0) {
        const sum = bucket.moodScores.reduce((acc, v) => acc + v, 0)
        summary.moodAverage = Math.round((sum / bucket.moodScores.length) * 10) / 10
      }
      return summary
    })
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * 计算连续记录天数。
 *
 * 从「今天」倒推：若今天无数据，则允许从昨天起算（今天还没产生事件不算断），
 * 再往前的每一天都必须有数据才算连续。这样用户当天尚未使用时不会看到
 * 连续天数被清零。
 */
export function calculateStreak(
  daily: TelemetryDailySummary[],
  now: Date = new Date(),
): number {
  if (daily.length === 0) return 0

  const dateSet = new Set(daily.map((d) => d.date))
  const today = todayKey(now)

  // 今天无数据则从昨天开始检查
  let cursor = dateSet.has(today) ? today : shiftDateKey(today, -1)
  let streak = 0
  while (dateSet.has(cursor)) {
    streak += 1
    cursor = shiftDateKey(cursor, -1)
  }
  return streak
}

/** 生成采集总览 */
export function buildOverview(
  events: TelemetryEvent[],
  now: Date = new Date(),
): TelemetryOverview {
  const daily = aggregateDaily(events)

  const categoryTotals: Record<TelemetryCategory, number> = {
    knowledge: 0,
    focus: 0,
    collaboration: 0,
    emotion: 0,
  }
  for (const event of events) {
    categoryTotals[event.category] = (categoryTotals[event.category] ?? 0) + 1
  }

  const overview: TelemetryOverview = {
    totalEvents: events.length,
    daily,
    currentStreak: calculateStreak(daily, now),
    categoryTotals,
  }

  const first = daily[0]
  const last = daily[daily.length - 1]
  if (first && last) {
    overview.range = { start: first.date, end: last.date }
  }
  return overview
}

/**
 * 按保留期裁剪事件。
 *
 * retentionDays <= 0 表示不清理（返回原数组）。裁剪基于本地日期，
 * 与分桶保持同一时区口径。
 */
export function pruneByRetention(
  events: TelemetryEvent[],
  retentionDays: number,
  now: Date = new Date(),
): TelemetryEvent[] {
  if (retentionDays <= 0) return events

  const cutoff = shiftDateKey(todayKey(now), -(retentionDays - 1))
  return events.filter((event) => {
    const dateKey = toLocalDateKey(event.at)
    if (!dateKey) return false
    return dateKey >= cutoff
  })
}

/** 某个日期是否落在指定范围内（含端点） */
export function isWithinRange(dateKey: string, start: string, end: string): boolean {
  return dateKey >= start && dateKey <= end
}

/**
 * 计算「长期未复习」的日期阈值。
 *
 * 遗忘曲线需要「多久没复习」这个量，而当前没有记忆强度模型。
 * 这里只做可解释的近似：返回 N 天前的日期键，调用方用它筛选出
 * 早于该日期最后被触碰的条目。不使用指数衰减等未经校准的公式，
 * 避免给出看似精确但无依据的结论。
 */
export function staleCutoff(referenceDate: string, staleAfterDays: number): string {
  return shiftDateKey(referenceDate, -staleAfterDays)
}
