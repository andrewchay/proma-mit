import { describe, expect, test } from 'bun:test'
import type { TelemetryEvent } from '@gravitas/shared'
import {
  aggregateDaily,
  buildOverview,
  calculateStreak,
  daysBetween,
  pruneByRetention,
  shiftDateKey,
  staleCutoff,
  toLocalDateKey,
  todayKey,
} from './index'

/**
 * 采集聚合算法单测。
 *
 * 重点覆盖三类容易出错的地方：
 * 1. 时区：日期分桶必须用本地时间，不能用 UTC（东八区凌晨会错一天）
 * 2. 去重：同一笔记反复打开只算一次
 * 3. 边界：空数据、非法时间、跨月跨年、连续天数中断
 */

/** 构造一条事件（默认 knowledge/note_opened） */
function ev(partial: Partial<TelemetryEvent> & { at: string }): TelemetryEvent {
  return {
    id: partial.id ?? `e-${Math.random().toString(36).slice(2, 10)}`,
    category: partial.category ?? 'knowledge',
    type: partial.type ?? 'note_opened',
    at: partial.at,
    value: partial.value,
    meta: partial.meta,
  }
}

/** 本地时间构造 ISO 字符串（避免用 Z 后缀引入时区歧义） */
function localIso(
  y: number,
  m: number,
  d: number,
  hour = 12,
  minute = 0,
): string {
  return new Date(y, m - 1, d, hour, minute, 0).toISOString()
}

describe('本地日期键', () => {
  test('凌晨事件归属当天而非前一天（东八区回归）', () => {
    // 本地 2026-09-15 00:30：若用 toISOString().slice(0,10) 会得到 09-14
    const iso = localIso(2026, 9, 15, 0, 30)
    expect(toLocalDateKey(iso)).toBe('2026-09-15')
  })

  test('深夜事件归属当天', () => {
    const iso = localIso(2026, 9, 15, 23, 45)
    expect(toLocalDateKey(iso)).toBe('2026-09-15')
  })

  test('非法时间返回空串', () => {
    expect(toLocalDateKey('not-a-date')).toBe('')
  })

  test('todayKey 与本地日期一致', () => {
    const now = new Date(2026, 8, 15, 10, 0, 0)
    expect(todayKey(now)).toBe('2026-09-15')
  })
})

describe('日期加减', () => {
  test('跨月回退', () => {
    expect(shiftDateKey('2026-09-01', -1)).toBe('2026-08-31')
  })

  test('跨年前进', () => {
    expect(shiftDateKey('2026-12-31', 1)).toBe('2027-01-01')
  })

  test('闰年 2 月', () => {
    expect(shiftDateKey('2024-02-28', 1)).toBe('2024-02-29')
    expect(shiftDateKey('2024-02-29', 1)).toBe('2024-03-01')
  })

  test('平年 2 月', () => {
    expect(shiftDateKey('2026-02-28', 1)).toBe('2026-03-01')
  })

  test('daysBetween 跨月计算正确', () => {
    expect(daysBetween('2026-08-31', '2026-09-01')).toBe(1)
    expect(daysBetween('2026-09-15', '2026-09-15')).toBe(0)
    expect(daysBetween('2026-09-15', '2026-09-10')).toBe(-5)
  })
})

describe('按日聚合', () => {
  test('空事件流返回空数组', () => {
    expect(aggregateDaily([])).toEqual([])
  })

  test('同一天多类事件归入同一桶并按日期升序', () => {
    const daily = aggregateDaily([
      ev({ at: localIso(2026, 9, 16), type: 'note_opened', meta: { noteId: 'n1' } }),
      ev({ at: localIso(2026, 9, 15), type: 'note_opened', meta: { noteId: 'n2' } }),
    ])
    expect(daily.map((d) => d.date)).toEqual(['2026-09-15', '2026-09-16'])
  })

  test('同一笔记反复打开只计一次 notesTouched', () => {
    const daily = aggregateDaily([
      ev({ at: localIso(2026, 9, 15), type: 'note_opened', meta: { noteId: 'n1' } }),
      ev({ at: localIso(2026, 9, 15), type: 'note_opened', meta: { noteId: 'n1' } }),
      ev({ at: localIso(2026, 9, 15), type: 'note_saved', meta: { noteId: 'n1' } }),
    ])
    expect(daily[0]?.notesTouched).toBe(1)
    // 但事件计数仍是 3
    expect(daily[0]?.counts.note_opened).toBe(2)
    expect(daily[0]?.counts.note_saved).toBe(1)
  })

  test('不同笔记分别计数', () => {
    const daily = aggregateDaily([
      ev({ at: localIso(2026, 9, 15), meta: { noteId: 'n1' } }),
      ev({ at: localIso(2026, 9, 15), meta: { noteId: 'n2' } }),
    ])
    expect(daily[0]?.notesTouched).toBe(2)
  })

  test('Agent 引用也计入 notesTouched（同为知识触达）', () => {
    const daily = aggregateDaily([
      ev({
        at: localIso(2026, 9, 15),
        type: 'note_referenced_by_agent',
        meta: { noteId: 'n9' },
      }),
    ])
    expect(daily[0]?.notesTouched).toBe(1)
  })

  test('缺 noteId 的事件不贡献 notesTouched 但仍在计数中', () => {
    const daily = aggregateDaily([ev({ at: localIso(2026, 9, 15) })])
    expect(daily[0]?.notesTouched).toBe(0)
    expect(daily[0]?.counts.note_opened).toBe(1)
  })

  test('会话时长累加到 focusSeconds', () => {
    const daily = aggregateDaily([
      ev({ at: localIso(2026, 9, 15), category: 'focus', type: 'session_finished', value: 600 }),
      ev({ at: localIso(2026, 9, 15), category: 'focus', type: 'session_finished', value: 300 }),
    ])
    expect(daily[0]?.focusSeconds).toBe(900)
  })

  test('负数或缺失时长的会话不计入', () => {
    const daily = aggregateDaily([
      ev({ at: localIso(2026, 9, 15), category: 'focus', type: 'session_finished', value: -10 }),
      ev({ at: localIso(2026, 9, 15), category: 'focus', type: 'session_finished' }),
    ])
    expect(daily[0]?.focusSeconds).toBe(0)
  })

  test('会议时长累加到 meetingMinutes', () => {
    const daily = aggregateDaily([
      ev({ at: localIso(2026, 9, 15), category: 'collaboration', type: 'meeting_attended', value: 30 }),
      ev({ at: localIso(2026, 9, 15), category: 'collaboration', type: 'meeting_attended', value: 45 }),
    ])
    expect(daily[0]?.meetingMinutes).toBe(75)
  })

  test('情绪打卡计算平均分并保留一位小数', () => {
    const daily = aggregateDaily([
      ev({ at: localIso(2026, 9, 15, 9), category: 'emotion', type: 'mood_logged', value: 4 }),
      ev({ at: localIso(2026, 9, 15, 21), category: 'emotion', type: 'mood_logged', value: 3 }),
    ])
    expect(daily[0]?.moodCheckins).toBe(2)
    expect(daily[0]?.moodAverage).toBe(3.5)
  })

  test('无打卡时 moodAverage 为 undefined 而非 0', () => {
    const daily = aggregateDaily([ev({ at: localIso(2026, 9, 15) })])
    expect(daily[0]?.moodAverage).toBeUndefined()
    expect(daily[0]?.moodCheckins).toBe(0)
  })

  test('非法时间的事件被忽略，不产生空桶', () => {
    const daily = aggregateDaily([
      ev({ at: 'garbage' }),
      ev({ at: localIso(2026, 9, 15) }),
    ])
    expect(daily).toHaveLength(1)
    expect(daily[0]?.date).toBe('2026-09-15')
  })

  test('凌晨事件与当天事件归入同一桶', () => {
    const daily = aggregateDaily([
      ev({ at: localIso(2026, 9, 15, 0, 10), meta: { noteId: 'n1' } }),
      ev({ at: localIso(2026, 9, 15, 23, 50), meta: { noteId: 'n2' } }),
    ])
    expect(daily).toHaveLength(1)
    expect(daily[0]?.notesTouched).toBe(2)
  })
})

describe('连续记录天数', () => {
  const now = new Date(2026, 8, 15, 12, 0, 0)

  test('无数据时为 0', () => {
    expect(calculateStreak([], now)).toBe(0)
  })

  test('仅今天有数据为 1', () => {
    const daily = aggregateDaily([ev({ at: localIso(2026, 9, 15) })])
    expect(calculateStreak(daily, now)).toBe(1)
  })

  test('连续三天为 3', () => {
    const daily = aggregateDaily([
      ev({ at: localIso(2026, 9, 13), meta: { noteId: 'a' } }),
      ev({ at: localIso(2026, 9, 14), meta: { noteId: 'b' } }),
      ev({ at: localIso(2026, 9, 15), meta: { noteId: 'c' } }),
    ])
    expect(calculateStreak(daily, now)).toBe(3)
  })

  test('今天无数据时从昨天起算（当天未用不清零）', () => {
    const daily = aggregateDaily([
      ev({ at: localIso(2026, 9, 13), meta: { noteId: 'a' } }),
      ev({ at: localIso(2026, 9, 14), meta: { noteId: 'b' } }),
    ])
    expect(calculateStreak(daily, now)).toBe(2)
  })

  test('中断后只算到断点', () => {
    const daily = aggregateDaily([
      ev({ at: localIso(2026, 9, 10), meta: { noteId: 'a' } }),
      ev({ at: localIso(2026, 9, 14), meta: { noteId: 'b' } }),
      ev({ at: localIso(2026, 9, 15), meta: { noteId: 'c' } }),
    ])
    expect(calculateStreak(daily, now)).toBe(2)
  })

  test('今天与昨天都无数据则连续为 0', () => {
    const daily = aggregateDaily([ev({ at: localIso(2026, 9, 10), meta: { noteId: 'a' } })])
    expect(calculateStreak(daily, now)).toBe(0)
  })

  test('跨月连续正确', () => {
    const monthEnd = new Date(2026, 8, 1, 12, 0, 0)
    const daily = aggregateDaily([
      ev({ at: localIso(2026, 8, 30), meta: { noteId: 'a' } }),
      ev({ at: localIso(2026, 8, 31), meta: { noteId: 'b' } }),
      ev({ at: localIso(2026, 9, 1), meta: { noteId: 'c' } }),
    ])
    expect(calculateStreak(daily, monthEnd)).toBe(3)
  })
})

describe('采集总览', () => {
  const now = new Date(2026, 8, 15, 12, 0, 0)

  test('空事件流的总览结构完整', () => {
    const overview = buildOverview([], now)
    expect(overview.totalEvents).toBe(0)
    expect(overview.daily).toEqual([])
    expect(overview.currentStreak).toBe(0)
    expect(overview.range).toBeUndefined()
    expect(overview.categoryTotals).toEqual({
      knowledge: 0,
      focus: 0,
      collaboration: 0,
      emotion: 0,
    })
  })

  test('类别计数与时间范围正确', () => {
    const overview = buildOverview(
      [
        ev({ at: localIso(2026, 9, 14), category: 'knowledge' }),
        ev({ at: localIso(2026, 9, 15), category: 'knowledge' }),
        ev({ at: localIso(2026, 9, 15), category: 'focus', type: 'tool_invoked' }),
      ],
      now,
    )
    expect(overview.totalEvents).toBe(3)
    expect(overview.categoryTotals.knowledge).toBe(2)
    expect(overview.categoryTotals.focus).toBe(1)
    expect(overview.range).toEqual({ start: '2026-09-14', end: '2026-09-15' })
    expect(overview.currentStreak).toBe(2)
  })
})

describe('保留期裁剪', () => {
  const now = new Date(2026, 8, 15, 12, 0, 0)

  test('retentionDays<=0 时原样返回', () => {
    const events = [ev({ at: localIso(2020, 1, 1) })]
    expect(pruneByRetention(events, 0, now)).toHaveLength(1)
    expect(pruneByRetention(events, -5, now)).toHaveLength(1)
  })

  test('保留 7 天时移除更早事件', () => {
    const events = [
      ev({ at: localIso(2026, 9, 15) }),
      ev({ at: localIso(2026, 9, 9) }), // 7 天窗口是 09-09 ~ 09-15，保留
      ev({ at: localIso(2026, 9, 8) }), // 超出窗口
    ]
    const kept = pruneByRetention(events, 7, now)
    expect(kept).toHaveLength(2)
  })

  test('边界：窗口第一天保留、前一天移除', () => {
    const events = [
      ev({ at: localIso(2026, 9, 9) }),
      ev({ at: localIso(2026, 9, 8) }),
    ]
    const kept = pruneByRetention(events, 7, now)
    expect(kept).toHaveLength(1)
    expect(toLocalDateKey(kept[0]!.at)).toBe('2026-09-09')
  })

  test('非法时间的事件被裁剪掉', () => {
    const events = [ev({ at: 'garbage' })]
    expect(pruneByRetention(events, 7, now)).toHaveLength(0)
  })
})

describe('长期未复习阈值', () => {
  test('staleCutoff 返回 N 天前', () => {
    expect(staleCutoff('2026-09-15', 30)).toBe('2026-08-16')
  })

  test('零天为当天', () => {
    expect(staleCutoff('2026-09-15', 0)).toBe('2026-09-15')
  })
})
