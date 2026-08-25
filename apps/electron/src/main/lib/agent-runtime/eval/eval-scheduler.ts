/**
 * 评测自动调度服务
 *
 * 为 Benchmark 提供定时自动跑 baseline 的能力：
 * - 在应用启动时恢复所有启用的自动评测任务
 * - 每个 benchmark 可独立配置自动评测开关和频率
 * - 默认每周跑一次 baseline，追踪能力退化
 *
 * 设计原则：
 * - 轻量：复用现有 ProactiveScheduler 基础设施
 * - 安全：自动评测只跑 baseline，不跑 improve（避免意外修改 prompt）
 * - 透明：运行记录写入 scoreboard，用户可在 EvalPanel 查看
 */

import { randomUUID } from 'node:crypto'
import { readJsonFileSafe, writeJsonFileAtomic } from '../../safe-file'
import { getEvalAutoSchedulePath } from '../../config-paths'
import { listBenchmarks } from './benchmark-store'
import { runEvalBaseline } from './eval-service'
import type { BenchmarkConfig } from './types'

/** 单个 benchmark 的自动评测配置 */
export interface BenchmarkAutoSchedule {
  benchmarkId: string
  enabled: boolean
  /** 间隔天数（默认 7 = 每周） */
  intervalDays: number
  /** 上次运行时间 */
  lastRunAt?: string
  /** 下次计划运行时间 */
  nextRunAt?: string
  /** 关联的 ProactiveSchedule ID（如使用 ProactiveScheduler） */
  proactiveScheduleId?: string
}

/** 自动评测配置存储 */
interface AutoScheduleStore {
  version: 1
  schedules: BenchmarkAutoSchedule[]
}

const STORE_PATH = getEvalAutoSchedulePath()
const DEFAULT_INTERVAL_DAYS = 7

/** 读取自动评测配置 */
function readStore(): AutoScheduleStore {
  return readJsonFileSafe<AutoScheduleStore>(STORE_PATH) ?? { version: 1, schedules: [] }
}

/** 写入自动评测配置 */
function writeStore(store: AutoScheduleStore): void {
  writeJsonFileAtomic(STORE_PATH, store)
}

/** 获取 benchmark 的自动评测配置（不存在则创建默认） */
export function getBenchmarkAutoSchedule(benchmarkId: string): BenchmarkAutoSchedule {
  const store = readStore()
  let schedule = store.schedules.find((s) => s.benchmarkId === benchmarkId)
  if (!schedule) {
    schedule = {
      benchmarkId,
      enabled: false,
      intervalDays: DEFAULT_INTERVAL_DAYS,
    }
    store.schedules.push(schedule)
    writeStore(store)
  }
  return schedule
}

/** 更新 benchmark 的自动评测配置 */
export function updateBenchmarkAutoSchedule(
  benchmarkId: string,
  updates: Partial<Pick<BenchmarkAutoSchedule, 'enabled' | 'intervalDays'>>,
): BenchmarkAutoSchedule {
  const store = readStore()
  let schedule = store.schedules.find((s) => s.benchmarkId === benchmarkId)
  if (!schedule) {
    schedule = {
      benchmarkId,
      enabled: updates.enabled ?? false,
      intervalDays: updates.intervalDays ?? DEFAULT_INTERVAL_DAYS,
    }
    store.schedules.push(schedule)
  } else {
    if (updates.enabled !== undefined) schedule.enabled = updates.enabled
    if (updates.intervalDays !== undefined) schedule.intervalDays = updates.intervalDays
  }

  // 重新计算下次运行时间
  if (schedule.enabled) {
    const lastRun = schedule.lastRunAt ? new Date(schedule.lastRunAt).getTime() : 0
    const now = Date.now()
    const intervalMs = schedule.intervalDays * 24 * 60 * 60 * 1000
    schedule.nextRunAt = new Date(Math.max(now, lastRun + intervalMs)).toISOString()
  } else {
    schedule.nextRunAt = undefined
  }

  writeStore(store)
  return schedule
}

/** 列出所有自动评测配置 */
export function listBenchmarkAutoSchedules(): BenchmarkAutoSchedule[] {
  const store = readStore()
  // 同步现有 benchmark，移除已不存在的
  const benchmarks = listBenchmarks()
  const benchmarkIds = new Set(benchmarks.map((b) => b.id))
  const filtered = store.schedules.filter((s) => benchmarkIds.has(s.benchmarkId))
  if (filtered.length !== store.schedules.length) {
    writeStore({ ...store, schedules: filtered })
  }
  return filtered
}

/** 检查并运行到期的自动评测任务 */
export async function runDueAutoEvaluations(): Promise<Array<{ benchmarkId: string; success: boolean; error?: string }>> {
  const schedules = listBenchmarkAutoSchedules()
  const now = Date.now()
  const due = schedules.filter((s) => s.enabled && s.nextRunAt && new Date(s.nextRunAt).getTime() <= now)

  const results: Array<{ benchmarkId: string; success: boolean; error?: string }> = []

  for (const schedule of due) {
    try {
      await runEvalBaseline(schedule.benchmarkId)
      // 更新上次运行时间
      updateBenchmarkAutoSchedule(schedule.benchmarkId, {})
      results.push({ benchmarkId: schedule.benchmarkId, success: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      results.push({ benchmarkId: schedule.benchmarkId, success: false, error: message })
    }
  }

  return results
}

/** 应用启动时调用：恢复所有到期的自动评测 */
export async function recoverAutoEvaluations(): Promise<void> {
  const results = await runDueAutoEvaluations()
  if (results.length > 0) {
    console.log('[EvalScheduler] 自动评测恢复完成:', results.map((r) => `${r.benchmarkId}=${r.success ? 'ok' : 'fail'}`).join(', '))
  }
}

/** 计算下次运行时间 */
export function calculateNextRunAt(lastRunAt: string | undefined, intervalDays: number): string {
  const lastRun = lastRunAt ? new Date(lastRunAt).getTime() : 0
  const now = Date.now()
  const intervalMs = intervalDays * 24 * 60 * 60 * 1000
  return new Date(Math.max(now, lastRun + intervalMs)).toISOString()
}
