import { describe, expect, test } from 'bun:test'
import { calculateProjectFlowMetrics, ganttBarColor, dueDateUrgency, sortTasksByUrgency, type SortTask } from './project-flow-metrics'

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

  test('第 4 天跨出 amber 区间返回 gray', () => {
    expect(dueDateUrgency(day(4), false, now)?.tone).toBe('gray')
  })

  test('宽裕返回 gray', () => {
    const result = dueDateUrgency(day(10), false, now)
    expect(result?.tone).toBe('gray')
    expect(result?.text).toContain('剩 10 天')
    expect(dueDateUrgency(day(5), false, now)?.text).toBe('09-20 · 剩 5 天')
  })

  test('非法时间戳返回 null', () => {
    expect(dueDateUrgency(0, false, now)).toBeNull()
    expect(dueDateUrgency(-1, false, now)).toBeNull()
    expect(dueDateUrgency(Infinity, false, now)).toBeNull()
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

describe('任务列表紧迫度排序 sortTasksByUrgency', () => {
  // 固定"现在"：2026-09-15 12:00 本地时间
  const now = new Date(2026, 8, 15, 12, 0, 0).getTime()
  const at = (offsetDays: number, hour = 12) => new Date(2026, 8, 15 + offsetDays, hour, 0, 0).getTime()

  /** 最小任务构造器：只填排序所需字段，其余给合法默认 */
  const task = (overrides: Partial<SortTask> & { id: string }): SortTask => ({
    status: 'pending',
    priority: 'medium',
    createdAt: at(0),
    ...overrides,
  })

  test('逾期未完成排在最前，逾期越久越靠前', () => {
    const tasks = [
      task({ id: 'normal', priority: 'critical' }),
      task({ id: 'overdue-1', dueDate: at(-1) }),
      task({ id: 'overdue-5', dueDate: at(-5) }),
    ]
    const sorted = sortTasksByUrgency(tasks, [], now)
    expect(sorted.map((t) => t.id)).toEqual(['overdue-5', 'overdue-1', 'normal'])
  })

  test('未逾期任务按优先级 critical → high → medium → low', () => {
    const tasks = [
      task({ id: 'low', priority: 'low' }),
      task({ id: 'critical', priority: 'critical' }),
      task({ id: 'medium', priority: 'medium' }),
      task({ id: 'high', priority: 'high' }),
    ]
    const sorted = sortTasksByUrgency(tasks, [], now)
    expect(sorted.map((t) => t.id)).toEqual(['critical', 'high', 'medium', 'low'])
  })

  test('今天截止与 3 天内同属琥珀档：先按优先级，同级按 DDL 升序', () => {
    const tasks = [
      task({ id: 'soon-high', priority: 'high', dueDate: at(3) }),
      task({ id: 'today-medium', priority: 'medium', dueDate: at(0) }),
    ]
    const sorted = sortTasksByUrgency(tasks, [], now)
    // 今天截止（amber）优先于 3 天内（amber 但更远）——同分位下 DDL 更紧的在前
    expect(sorted.map((t) => t.id)).toEqual(['today-medium', 'soon-high'])
  })

  test('无截止日期排在同级之后（MAX_SAFE_INTEGER 兜底），同级按创建时间倒序', () => {
    const created = (hours: number) => now - hours * 3_600_000
    const tasks = [
      task({ id: 'older-undated', priority: 'medium', createdAt: created(48) }),
      task({ id: 'newer-undated', priority: 'medium', createdAt: created(1) }),
      task({ id: 'due-medium', priority: 'medium', dueDate: at(10) }),
    ]
    const sorted = sortTasksByUrgency(tasks, [], now)
    expect(sorted.map((t) => t.id)).toEqual(['due-medium', 'newer-undated', 'older-undated'])
  })

  test('已完成/已取消组沉底，按完成时间倒序', () => {
    const tasks = [
      task({ id: 'done-old', status: 'completed', completedAt: at(-10) }),
      task({ id: 'cancelled', status: 'cancelled' }),
      task({ id: 'done-recent', status: 'completed', completedAt: at(-1) }),
      task({ id: 'active', dueDate: at(-2) }),
    ]
    const sorted = sortTasksByUrgency(tasks, [], now)
    expect(sorted.map((t) => t.id)).toEqual(['active', 'done-recent', 'done-old', 'cancelled'])
  })

  test('传入状态定义时按语义组判定完成（自定义状态 id 不叫 completed）', () => {
    const statuses = [
      { id: 'shipped', stateGroup: 'completed' as const },
      { id: 'wontfix', stateGroup: 'cancelled' as const },
    ]
    const tasks = [
      task({ id: 'shipped-task', status: 'shipped', completedAt: at(-2) }),
      task({ id: 'open-task', dueDate: at(-1) }),
    ]
    const sorted = sortTasksByUrgency(tasks, statuses, now)
    expect(sorted.map((t) => t.id)).toEqual(['open-task', 'shipped-task'])
  })

  test('空列表与单元素列表安全', () => {
    expect(sortTasksByUrgency([], [], now)).toEqual([])
    expect(sortTasksByUrgency([task({ id: 'only' })], [], now).map((t) => t.id)).toEqual(['only'])
  })
})
