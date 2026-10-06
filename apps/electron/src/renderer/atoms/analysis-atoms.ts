/**
 * 分析引擎渲染层状态
 *
 * 对应免费版基础能力 analysis-basic：时间使用、生产力与综合报告的生成与浏览。
 *
 * 数据源由主进程聚合（日程事件 + 任务表），本层不直接读取数据文件，
 * 只负责调用 IPC、维护选中的时间范围与报告列表。
 */
import { atom } from 'jotai'
import type { AnalysisReport } from '@gravitas/shared'

/** 报告类型过滤（null 表示全部） */
export type AnalysisTypeFilter = 'time' | 'productivity' | 'comprehensive' | null

/** 时间范围（ISO 日期字符串，YYYY-MM-DD） */
export interface AnalysisDateRange {
  startDate: string
  endDate: string
}

// ===== 状态 =====

/** 报告列表（按创建时间倒序，由主进程排序） */
export const analysisReportsAtom = atom<AnalysisReport[]>([])

/** 当前打开的报告 */
export const activeAnalysisReportAtom = atom<AnalysisReport | null>(null)

/** 列表类型过滤 */
export const analysisTypeFilterAtom = atom<AnalysisTypeFilter>(null)

/** 生成中（按钮 loading 与防重复提交） */
export const analysisGeneratingAtom = atom<boolean>(false)

/** 列表加载中 */
export const analysisLoadingAtom = atom<boolean>(false)

/** 错误信息（null 表示无错误） */
export const analysisErrorAtom = atom<string | null>(null)

/** 生成成功后的提示（自动用于顶部回显） */
export const analysisNoticeAtom = atom<string | null>(null)

// ===== 时间范围 =====

/** 本地日期转 YYYY-MM-DD（避免 toISOString 的 UTC 偏移） */
function toLocalDateString(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 本周（周一到周日） */
export function currentWeekRange(): AnalysisDateRange {
  const now = new Date()
  // JS 的 getDay()：0=周日。换算为「距本周一的天数」
  const offsetToMonday = (now.getDay() + 6) % 7
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetToMonday)
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)
  return { startDate: toLocalDateString(monday), endDate: toLocalDateString(sunday) }
}

/** 本月 */
export function currentMonthRange(): AnalysisDateRange {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth(), 1)
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  return { startDate: toLocalDateString(first), endDate: toLocalDateString(last) }
}

/** 最近 N 天（含今天） */
export function recentRange(days: number): AnalysisDateRange {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1))
  return { startDate: toLocalDateString(start), endDate: toLocalDateString(now) }
}

/** 默认范围：最近 30 天 */
export const analysisDateRangeAtom = atom<AnalysisDateRange>(recentRange(30))

// ===== 派生状态 =====

/** 按类型过滤后的报告（过滤在前端做，列表已在内存中） */
export const filteredAnalysisReportsAtom = atom<AnalysisReport[]>((get) => {
  const reports = get(analysisReportsAtom)
  const filter = get(analysisTypeFilterAtom)
  return filter ? reports.filter((r) => r.type === filter) : reports
})

/** 是否没有任何报告 */
export const analysisEmptyAtom = atom<boolean>((get) => get(analysisReportsAtom).length === 0)

// ===== 操作函数 =====

/** 拉取报告列表 */
export async function loadAnalysisReports(
  type?: 'time' | 'productivity' | 'comprehensive',
): Promise<AnalysisReport[]> {
  const api = window.electronAPI?.analysis
  if (!api) throw new Error('分析引擎 API 未初始化')
  return api.listReports(type)
}

/** 生成报告：按类型分发到对应 IPC */
export async function generateReport(
  type: 'time' | 'productivity' | 'comprehensive',
  range: AnalysisDateRange,
): Promise<AnalysisReport> {
  const api = window.electronAPI?.analysis
  if (!api) throw new Error('分析引擎 API 未初始化')

  switch (type) {
    case 'time':
      return api.generateTimeReport(range)
    case 'productivity':
      return api.generateProductivityReport(range)
    case 'comprehensive':
      return api.generateComprehensiveReport(range)
  }
}
