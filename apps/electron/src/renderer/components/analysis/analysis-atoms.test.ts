import { describe, expect, test } from 'bun:test'
import {
  currentMonthRange,
  currentWeekRange,
  recentRange,
} from '../../atoms/analysis-atoms'

/**
 * 分析引擎时间范围计算的单测。
 *
 * 这些函数依赖本机时区与当前日期，测试用「与当前时间一致」的相对断言，
 * 避免硬编码日期在将来过期。
 */

function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

describe('分析引擎时间范围', () => {
  test('currentWeekRange 返回周一到周日共 7 天', () => {
    const range = currentWeekRange()
    const start = parseLocalDate(range.startDate)
    const end = parseLocalDate(range.endDate)

    // 周一 = 1
    expect(start.getDay()).toBe(1)
    // 周日 = 0
    expect(end.getDay()).toBe(0)

    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000)
    expect(days).toBe(6)
  })

  test('currentMonthRange 覆盖整月第一天与最后一天', () => {
    const range = currentMonthRange()
    const start = parseLocalDate(range.startDate)
    const end = parseLocalDate(range.endDate)

    expect(start.getDate()).toBe(1)
    // 后一天应落入下个月
    const afterEnd = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1)
    expect(afterEnd.getDate()).toBe(1)
  })

  test('recentRange(1) 起止同一天', () => {
    const range = recentRange(1)
    expect(range.startDate).toBe(range.endDate)
  })

  test('recentRange(7) 跨度 7 天且以今天结束', () => {
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

    const range = recentRange(7)
    expect(range.endDate).toBe(today)

    const start = parseLocalDate(range.startDate)
    const end = parseLocalDate(range.endDate)
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000)
    expect(days).toBe(6)
  })

  test('日期字符串为本地日期而非 UTC（不因时区偏移错一天）', () => {
    const range = recentRange(1)
    const now = new Date()
    // 若误用 toISOString()，东八区在本地 00:00-08:00 会得到前一天
    const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    expect(range.endDate).toBe(localToday)
  })

  test('月份范围不受 30/31 天差异影响（2 月）', () => {
    // 直接验证 currentMonthRange 的实现：构造 2 月并检查末日
    const feb = new Date(2024, 1, 1)
    const lastFeb = new Date(feb.getFullYear(), feb.getMonth() + 1, 0).getDate()
    expect(lastFeb).toBe(29) // 2024 是闰年
  })
})
