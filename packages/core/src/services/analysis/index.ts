/**
 * 分析引擎纯算法模块
 *
 * 从 PAA analysis-service.ts 提取的纯函数，无 Electron/Node 依赖。
 * 包含时间分析、生产力分析、报告生成等核心算法。
 */

// ===== 类型定义 =====

export interface TimeAnalysisInput {
  events: Array<{
    id: string
    title: string
    startTime: string
    endTime: string
    category?: string
  }>
  startDate: string
  endDate: string
}

export interface TimeAnalysisResult {
  categories: Array<{
    name: string
    minutes: number
    percentage: number
    color?: string
  }>
  dailyBreakdown: Array<{
    date: string
    totalMinutes: number
    categories: Record<string, number>
  }>
  trends: Array<{ date: string; value: number }>
  totalHours: number
  avgDailyHours: number
  busiestDay?: { date: string; minutes: number }
}

export interface ProductivityInput {
  tasks: Array<{
    id: string
    status: 'todo' | 'in-progress' | 'review' | 'done'
    priority: 'low' | 'medium' | 'high' | 'urgent'
    createdAt: string
    dueDate?: string
  }>
  startDate: string
  endDate: string
}

export interface ProductivityResult {
  completionRate: number
  tasksCompleted: number
  tasksTotal: number
  tasksByStatus: Record<string, number>
  tasksByPriority: Record<string, number>
  dailyRates: Array<{
    date: string
    completed: number
    total: number
    rate: number
  }>
  overdueTasks: number
  highPriorityCompletionRate: number
}

export interface AnalysisSection {
  id: string
  title: string
  type: 'chart' | 'text' | 'table' | 'comparison'
  chartType?: 'bar' | 'pie' | 'line' | 'stacked-bar' | 'radar'
  data: unknown
  insight?: string
}

export interface AnalysisReport {
  id: string
  type: 'time' | 'productivity' | 'comprehensive'
  title: string
  period: { start: string; end: string }
  summary: string
  sections: AnalysisSection[]
  recommendations: string[]
  createdAt: string
}

// ===== 工具函数 =====

function getEventDurationMinutes(event: {
  startTime: string
  endTime: string
}): number {
  const start = new Date(event.startTime).getTime()
  const end = new Date(event.endTime).getTime()
  return Math.max(0, Math.round((end - start) / 60000))
}

function formatDateKey(dateStr: string): string {
  return dateStr.slice(0, 10)
}

function getDaysBetween(start: string, end: string): string[] {
  const days: string[] = []
  const startDate = new Date(start)
  const endDate = new Date(end)
  const current = new Date(startDate)
  while (current <= endDate) {
    days.push(current.toISOString().slice(0, 10))
    current.setDate(current.getDate() + 1)
  }
  return days
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

// ===== 时间分析 =====

const CATEGORY_COLORS: Record<string, string> = {
  work: '#f59e0b',
  personal: '#10b981',
  family: '#ec4899',
  health: '#22c55e',
  learning: '#3b82f6',
  social: '#8b5cf6',
  finance: '#14b8a6',
  other: '#9ca3af',
}

/**
 * 生成时间使用分析
 */
export function generateTimeAnalysis(input: TimeAnalysisInput): TimeAnalysisResult {
  const { events, startDate, endDate } = input

  const categoryMinutes: Record<string, number> = {}
  const dailyData: Record<string, { total: number; categories: Record<string, number> }> = {}

  for (const event of events) {
    const duration = getEventDurationMinutes(event)
    const cat = event.category || 'other'
    const day = formatDateKey(event.startTime)

    categoryMinutes[cat] = (categoryMinutes[cat] || 0) + duration

    if (!dailyData[day]) {
      dailyData[day] = { total: 0, categories: {} }
    }
    dailyData[day].total += duration
    dailyData[day].categories[cat] = (dailyData[day].categories[cat] || 0) + duration
  }

  const totalMinutes = Object.values(categoryMinutes).reduce((a, b) => a + b, 0)
  const days = getDaysBetween(startDate, endDate)
  const avgDailyMinutes = days.length > 0 ? totalMinutes / days.length : 0

  const categories = Object.entries(categoryMinutes)
    .map(([name, minutes]) => ({
      name,
      minutes,
      percentage: totalMinutes > 0 ? Math.round((minutes / totalMinutes) * 1000) / 10 : 0,
      color: CATEGORY_COLORS[name] || '#9ca3af',
    }))
    .sort((a, b) => b.minutes - a.minutes)

  const dailyBreakdown = days.map((date) => ({
    date,
    totalMinutes: dailyData[date]?.total || 0,
    categories: dailyData[date]?.categories || {},
  }))

  const trends = dailyBreakdown.map((d) => ({
    date: d.date,
    value: Math.round((d.totalMinutes / 60) * 10) / 10,
  }))

  const busiestDay = dailyBreakdown.length > 0
    ? dailyBreakdown.reduce((max, d) => (d.totalMinutes > max.totalMinutes ? d : max), dailyBreakdown[0]!)
    : undefined

  return {
    categories,
    dailyBreakdown,
    trends,
    totalHours: Math.round((totalMinutes / 60) * 10) / 10,
    avgDailyHours: Math.round((avgDailyMinutes / 60) * 10) / 10,
    busiestDay: busiestDay && busiestDay.totalMinutes > 0
      ? { date: busiestDay.date, minutes: busiestDay.totalMinutes }
      : undefined,
  }
}

/**
 * 生成时间分析报告
 */
export function generateTimeAnalysisReport(
  input: TimeAnalysisInput,
): AnalysisReport {
  const result = generateTimeAnalysis(input)
  const { startDate, endDate } = input

  const summary =
    result.totalHours > 0
      ? `统计期间共记录 ${result.totalHours} 小时活动，日均 ${result.avgDailyHours} 小时。${
          result.categories[0]?.name || '其他'
        } 占比最高（${result.categories[0]?.percentage || 0}%）。`
      : '统计期间暂无日程记录，建议开始记录每日活动以获取时间分析。'

  const recommendations: string[] = []
  const workPct = result.categories.find((c) => c.name === 'work')?.percentage || 0
  const personalPct = result.categories.find((c) => c.name === 'personal')?.percentage || 0
  const healthPct = result.categories.find((c) => c.name === 'health')?.percentage || 0

  if (workPct > 50) recommendations.push('工作时间占比过高，建议增加休息和个人时间')
  if (healthPct < 5) recommendations.push('健康活动时间不足，建议每天安排至少 30 分钟运动')
  if (personalPct < 10) recommendations.push('个人时间较少，建议留出时间用于兴趣爱好')
  if (result.avgDailyHours > 10) recommendations.push('日均活动强度较大，注意劳逸结合')
  if (result.avgDailyHours < 3) recommendations.push('日程记录较少，建议更完整地记录每日活动')
  if (recommendations.length === 0) recommendations.push('整体时间分配合理，继续保持')

  return {
    id: generateId(),
    type: 'time',
    title: `时间使用分析 (${startDate} ~ ${endDate})`,
    period: { start: startDate, end: endDate },
    summary,
    sections: [
      {
        id: generateId(),
        title: '时间分配概览',
        type: 'chart',
        chartType: 'pie',
        data: { categories: result.categories },
        insight:
          result.categories.length > 0 && result.categories[0]
            ? `${result.categories[0].name} 占用了最多时间（${result.categories[0].percentage}%）`
            : '暂无数据',
      },
      {
        id: generateId(),
        title: '每日时间趋势',
        type: 'chart',
        chartType: 'bar',
        data: { daily: result.dailyBreakdown },
        insight: result.busiestDay
          ? `${result.busiestDay.date} 是最忙碌的一天，共 ${
              Math.round((result.busiestDay.minutes / 60) * 10) / 10
            } 小时`
          : '暂无数据',
      },
      {
        id: generateId(),
        title: '分类详情',
        type: 'table',
        data: { categories: result.categories },
      },
    ],
    recommendations,
    createdAt: new Date().toISOString(),
  }
}

// ===== 生产力分析 =====

/**
 * 生成生产力分析
 */
export function generateProductivityAnalysis(
  input: ProductivityInput,
): ProductivityResult {
  const { tasks, startDate, endDate } = input

  const completed = tasks.filter((t) => t.status === 'done')
  const total = tasks.length
  const completionRate = total > 0 ? completed.length / total : 0

  const statusCount: Record<string, number> = {
    todo: 0,
    'in-progress': 0,
    review: 0,
    done: 0,
  }
  for (const t of tasks) {
    statusCount[t.status] = (statusCount[t.status] || 0) + 1
  }

  const priorityCount: Record<string, number> = {
    low: 0,
    medium: 0,
    high: 0,
    urgent: 0,
  }
  for (const t of tasks) {
    priorityCount[t.priority] = (priorityCount[t.priority] || 0) + 1
  }

  const highPriority = tasks.filter((t) => t.priority === 'high' || t.priority === 'urgent')
  const highPriorityCompleted = highPriority.filter((t) => t.status === 'done')
  const highPriorityRate = highPriority.length > 0 ? highPriorityCompleted.length / highPriority.length : 0

  // 按创建日期统计每日完成率
  const dailyMap: Record<string, { completed: number; total: number }> = {}
  for (const t of tasks) {
    const day = t.createdAt.slice(0, 10)
    if (!dailyMap[day]) dailyMap[day] = { completed: 0, total: 0 }
    dailyMap[day].total++
    if (t.status === 'done') dailyMap[day].completed++
  }

  const dailyRates = Object.entries(dailyMap)
    .map(([date, { completed, total }]) => ({
      date,
      completed,
      total,
      rate: total > 0 ? Math.round((completed / total) * 1000) / 1000 : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))

  const overdueTasks = tasks.filter((t) => {
    if (t.status === 'done' || !t.dueDate) return false
    return new Date(t.dueDate) < new Date()
  }).length

  return {
    completionRate: Math.round(completionRate * 1000) / 1000,
    tasksCompleted: completed.length,
    tasksTotal: total,
    tasksByStatus: statusCount,
    tasksByPriority: priorityCount,
    dailyRates,
    overdueTasks,
    highPriorityCompletionRate: Math.round(highPriorityRate * 1000) / 1000,
  }
}

/**
 * 生成生产力分析报告
 */
export function generateProductivityReport(
  input: ProductivityInput,
): AnalysisReport {
  const result = generateProductivityAnalysis(input)
  const { startDate, endDate } = input

  const summary =
    result.tasksTotal > 0
      ? `共 ${result.tasksTotal} 个任务，完成 ${result.tasksCompleted} 个（完成率 ${Math.round(
          result.completionRate * 100,
        )}%）。高优先级任务完成率 ${Math.round(result.highPriorityCompletionRate * 100)}%。${
          result.overdueTasks > 0 ? `有 ${result.overdueTasks} 个逾期任务。` : ''
        }`
      : '暂无任务数据，建议创建任务以追踪生产力。'

  const recommendations: string[] = []
  if (result.completionRate < 0.5) recommendations.push('任务完成率偏低，建议减少并行任务数量，聚焦高优先级事项')
  if (result.overdueTasks > 0) recommendations.push(`有 ${result.overdueTasks} 个逾期任务，建议重新评估截止日期或拆分任务`)
  if (result.highPriorityCompletionRate < 0.7) recommendations.push('高优先级任务完成率不足，建议使用番茄工作法提升专注力')
  if ((result.tasksByPriority['urgent'] ?? 0) > 3) recommendations.push('紧急任务较多，建议提前规划以避免临时救火')
  if (recommendations.length === 0) recommendations.push('整体生产力表现良好，继续保持')

  return {
    id: generateId(),
    type: 'productivity',
    title: `生产力分析 (${startDate} ~ ${endDate})`,
    period: { start: startDate, end: endDate },
    summary,
    sections: [
      {
        id: generateId(),
        title: '任务状态分布',
        type: 'chart',
        chartType: 'pie',
        data: {
          statusDistribution: Object.entries(result.tasksByStatus).map(([name, value]) => ({
            name,
            value,
          })),
        },
        insight: `完成率 ${Math.round(result.completionRate * 100)}%，${result.tasksByStatus['in-progress'] || 0} 个任务进行中`,
      },
      {
        id: generateId(),
        title: '优先级分布',
        type: 'chart',
        chartType: 'bar',
        data: {
          priorityDistribution: Object.entries(result.tasksByPriority).map(([name, value]) => ({
            name,
            value,
          })),
        },
        insight: `高/紧急优先级任务完成率 ${Math.round(result.highPriorityCompletionRate * 100)}%`,
      },
      {
        id: generateId(),
        title: '每日完成趋势',
        type: 'chart',
        chartType: 'line',
        data: { dailyRates: result.dailyRates },
      },
      {
        id: generateId(),
        title: '任务统计',
        type: 'table',
        data: {
          total: result.tasksTotal,
          completed: result.tasksCompleted,
          completionRate: Math.round(result.completionRate * 100),
          overdue: result.overdueTasks,
          highPriorityTotal: result.tasksByPriority['high'] || 0,
          highPriorityCompleted: Math.round(
            (result.tasksByPriority['high'] || 0) * result.highPriorityCompletionRate,
          ),
        },
      },
    ],
    recommendations,
    createdAt: new Date().toISOString(),
  }
}

// ===== 综合报告 =====

/**
 * 生成综合分析报告（时间 + 生产力）
 */
export function generateComprehensiveReport(
  timeInput: TimeAnalysisInput,
  productivityInput: ProductivityInput,
): AnalysisReport {
  const timeReport = generateTimeAnalysisReport(timeInput)
  const prodReport = generateProductivityReport(productivityInput)

  const sections: AnalysisSection[] = [
    ...timeReport.sections.map((s) => ({ ...s, title: `[时间] ${s.title}` })),
    ...prodReport.sections.map((s) => ({ ...s, title: `[生产力] ${s.title}` })),
  ]

  const recommendations = [...timeReport.recommendations, ...prodReport.recommendations]

  const summary = `${timeReport.summary}\n${prodReport.summary}`

  return {
    id: generateId(),
    type: 'comprehensive',
    title: `综合分析报告 (${timeInput.startDate} ~ ${timeInput.endDate})`,
    period: { start: timeInput.startDate, end: timeInput.endDate },
    summary,
    sections,
    recommendations,
    createdAt: new Date().toISOString(),
  }
}
