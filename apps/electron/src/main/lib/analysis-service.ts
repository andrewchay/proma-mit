/**
 * 分析引擎服务 — Analysis Service（基础版）
 *
 * 免费版可用的分析引擎基础能力：
 * - 时间使用分析（工作/学习/休息/家庭时间分配）
 * - 生产力趋势分析（完成率、效率变化）
 * - 月度报告生成
 * - 基础图表数据生成
 *
 * 纯算法逻辑在 @gravitas/core/services/analysis，此处负责 Electron 层数据聚合和持久化。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getAnalysisReportsPath } from './config-paths'
import {
  listScheduleEventsExpanded,
  listScheduleTasks,
  type ScheduleEvent,
  type ScheduleTask,
} from './schedule-service'
import {
  generateTimeAnalysisReport,
  generateProductivityReport,
  generateComprehensiveReport,
  type AnalysisReport,
  type TimeAnalysisInput,
  type ProductivityInput,
} from '@gravitas/core/services/analysis'

// ===== 类型定义 =====

export type AnalysisType = 'time' | 'productivity' | 'comprehensive'

export interface DateRange {
  startDate: string
  endDate: string
}

// ===== 数据文件路径 =====

function getReportsPath(): string {
  return getAnalysisReportsPath()
}

function ensureReports(): AnalysisReport[] {
  const path = getReportsPath()
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AnalysisReport[]
  } catch {
    return []
  }
}

function saveReports(reports: AnalysisReport[]): void {
  const path = getReportsPath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(reports, null, 2), 'utf-8')
}

// ===== 报告管理 =====

export function listAnalysisReports(type?: AnalysisType): AnalysisReport[] {
  const reports = ensureReports()
  const sorted = reports.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
  return type ? sorted.filter((r) => r.type === type) : sorted
}

export function getAnalysisReport(id: string): AnalysisReport | null {
  return ensureReports().find((r) => r.id === id) ?? null
}

export function deleteAnalysisReport(id: string): boolean {
  const reports = ensureReports()
  const filtered = reports.filter((r) => r.id !== id)
  if (filtered.length === reports.length) return false
  saveReports(filtered)
  return true
}

// ===== 数据聚合 =====

function collectTimeAnalysisInput(range: DateRange): TimeAnalysisInput {
  const events = listScheduleEventsExpanded({
    startDate: `${range.startDate}T00:00:00`,
    endDate: `${range.endDate}T23:59:59`,
  })

  return {
    events: events.map((e) => ({
      id: e.id,
      title: e.title,
      startTime: e.startTime,
      endTime: e.endTime,
      category: e.category,
    })),
    startDate: range.startDate,
    endDate: range.endDate,
  }
}

function collectProductivityInput(range: DateRange): ProductivityInput {
  const tasks = listScheduleTasks()

  return {
    tasks: tasks.map((t) => ({
      id: t.id,
      status: t.status,
      priority: t.priority,
      createdAt: t.createdAt,
      dueDate: t.dueDate,
    })),
    startDate: range.startDate,
    endDate: range.endDate,
  }
}

// ===== 分析报告生成 =====

export async function generateTimeReport(range: DateRange): Promise<AnalysisReport> {
  const input = collectTimeAnalysisInput(range)
  const report = generateTimeAnalysisReport(input)
  saveReports([...ensureReports(), report])
  return report
}

export async function generateProductivityReportService(
  range: DateRange,
): Promise<AnalysisReport> {
  const input = collectProductivityInput(range)
  const report = generateProductivityReport(input)
  saveReports([...ensureReports(), report])
  return report
}

export async function generateComprehensiveReportService(
  range: DateRange,
): Promise<AnalysisReport> {
  const timeInput = collectTimeAnalysisInput(range)
  const prodInput = collectProductivityInput(range)
  const report = generateComprehensiveReport(timeInput, prodInput)
  saveReports([...ensureReports(), report])
  return report
}

// ===== 快捷查询 =====

export async function generateMonthlyReport(month: string): Promise<AnalysisReport> {
  // month 格式: YYYY-MM
  const [year, monthNum] = month.split('-').map(Number)
  const startDate = `${month}-01`
  const lastDay = new Date(year!, monthNum!, 0).getDate()
  const endDate = `${month}-${String(lastDay).padStart(2, '0')}`

  return generateComprehensiveReportService({ startDate, endDate })
}

export async function generateWeeklyReport(weekStart?: string): Promise<AnalysisReport> {
  const now = new Date()
  const start = weekStart
    ? new Date(weekStart)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay())
  const end = new Date(start.getTime() + 6 * 86400000)

  return generateComprehensiveReportService({
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  })
}
