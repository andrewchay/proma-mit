import { describe, expect, test } from 'bun:test'
import { calculateProjectFlowMetrics, ganttBarColor, dueDateUrgency } from './project-flow-metrics'

test('流动指标只用权威任务时间戳计算在制品、吞吐、周期和 SLE 超时', () => {
  const day = 86_400_000
  const now = 20 * day
  const metrics = calculateProjectFlowMetrics(
    [
      { id: 'active', status: 'in_progress', createdAt: 10 * day, startDate: 11 * day },
      { id: 'waiting', status: 'pending', createdAt: 18 * day },
      { id: 'done', status: 'completed', createdAt: day, startDate: 2 * day, completedAt: 7 * day },
      { id: 'draft', status: 'draft', createdAt: day },
    ],
    new Set(['waiting']),
    5,
    now,
  )
  expect(metrics).toEqual({
    workInProgress: 1,
    waiting: 1,
    throughput30Days: 1,
    averageCycleTimeDays: 5,
    oldestWorkItemAgeDays: 9,
    serviceLevelBreaches: 1,
  })
})

test('Given 项目自定义状态 When 按语义组计算 Then WIP/完成跟随组而非字面 id', () => {
  const day = 86_400_000
  const now = 20 * day
  const statuses = [
    { id: 'sts_todo', stateGroup: 'unstarted' as const },
    { id: 'sts_doing', stateGroup: 'started' as const },
    { id: 'sts_accept', stateGroup: 'completed' as const },
  ]
  const metrics = calculateProjectFlowMetrics(
    [
      { id: 'wip', status: 'sts_doing', createdAt: 10 * day, startDate: 12 * day },
      { id: 'queue', status: 'sts_todo', createdAt: 18 * day },
      { id: 'accepted', status: 'sts_accept', createdAt: day, startDate: 2 * day, completedAt: 8 * day },
    ],
    new Set(),
    30,
    now,
    statuses,
  )
  expect(metrics.workInProgress).toBe(1)
  expect(metrics.waiting).toBe(1)
  expect(metrics.throughput30Days).toBe(1)
  expect(metrics.serviceLevelBreaches).toBe(0)
})

describe('甘特时间条状态组着色', () => {
  const now = 100 * 86_400_000

  test('Given 预置五态 When 着色 Then 跟随语义组而非字面 completed 判断', () => {
    const day = 86_400_000
    expect(ganttBarColor({ status: 'completed' }, { blocked: false, now })).toBe('bg-emerald-500')
    expect(ganttBarColor({ status: 'in_progress' }, { blocked: false, now })).toBe('bg-blue-500')
    expect(ganttBarColor({ status: 'paused' }, { blocked: false, now })).toBe('bg-blue-500')
    expect(ganttBarColor({ status: 'pending' }, { blocked: false, now })).toBe('bg-primary')
    expect(ganttBarColor({ status: 'draft' }, { blocked: false, now })).toBe('bg-stone-400')
  })

  test('Given 项目自定义完成态 When 着色 Then 同样落完成组绿色', () => {
    const statuses = [{ id: 'sts_accept', stateGroup: 'completed' as const }]
    expect(ganttBarColor({ status: 'sts_accept' }, { blocked: false, now, statuses })).toBe('bg-emerald-500')
  })

  test('Given 未完成且已超期 When 着色 Then 覆盖为红色', () => {
    const result = ganttBarColor(
      { status: 'in_progress', dueDate: now - 86_400_000 },
      { blocked: false, now },
    )
    expect(result).toBe('bg-red-500')
  })

  test('Given 已完成但超期 When 着色 Then 保持完成组绿色（完成组不被异常覆盖）', () => {
    const result = ganttBarColor(
      { status: 'completed', dueDate: now - 86_400_000 },
      { blocked: false, now },
    )
    expect(result).toBe('bg-emerald-500')
  })

  test('Given 未完成且被阻塞/高风险 When 着色 Then 覆盖为琥珀/橙', () => {
    expect(ganttBarColor({ status: 'pending' }, { blocked: true, now })).toBe('bg-amber-500')
    expect(ganttBarColor({ status: 'pending', riskLevel: 'high' }, { blocked: false, now })).toBe('bg-orange-400')
    expect(ganttBarColor({ status: 'pending', riskLevel: 'critical' }, { blocked: false, now })).toBe('bg-red-400')
  })
})

describe('截止日期紧迫感 dueDateUrgency', () => {
  // 固定"现在"：2026-09-15 12:00 本地时间
  const now = new Date(2026, 8, 15, 12, 0, 0).getTime()
  const day = (offset: number, hour = 12) => new Date(2026, 8, 15 + offset, hour, 0, 0).getTime()

  test('无 DDL 返回 null', () => {
    expect(dueDateUrgency(undefined, false, now)).toBeNull()
    expect(dueDateUrgency(NaN, false, now)).toBeNull()
  })

  test('已完成任务不展示（即使已逾期）', () => {
    expect(dueDateUrgency(day(-3), true, now)).toBeNull()
  })

  test('逾期返回 red + 逾期文案', () => {
    const result = dueDateUrgency(day(-2), false, now)
    expect(result?.tone).toBe('red')
    expect(result?.text).toContain('逾期 2 天')
  })

  test('今天截止返回 amber + 今天文案', () => {
    const result = dueDateUrgency(day(0), false, now)
    expect(result?.tone).toBe('amber')
    expect(result?.text).toContain('今天')
  })

  test('3 天内返回 amber', () => {
    const result = dueDateUrgency(day(3), false, now)
    expect(result?.tone).toBe('amber')
    expect(result?.text).toContain('剩 3 天')
  })

  test('宽裕返回 gray', () => {
    const result = dueDateUrgency(day(10), false, now)
    expect(result?.tone).toBe('gray')
    expect(result?.text).toContain('剩 10 天')
  })

  test('半夜边界：23:59 与 00:01 同日天数差一致', () => {
    const lateNight = new Date(2026, 8, 15, 23, 59, 0).getTime()
    const earlyMorning = new Date(2026, 8, 15, 0, 1, 0).getTime()
    const a = dueDateUrgency(day(5), false, lateNight)
    const b = dueDateUrgency(day(5), false, earlyMorning)
    expect(a?.tone).toBe(b?.tone)
    expect(a?.text).toBe(b?.text)
  })
})
