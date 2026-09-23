/**
 * Proactive Scheduler 本地 JSON 存储；索引原子替换，运行记录单独保存。
 *
 * 读取保护：索引文件损坏/格式无效时，绝不用空索引覆盖原文件——
 * 保留最后一次成功读取的内存快照用于展示，写操作直接拒绝并给出明确错误。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { ProactiveSchedule, ProactiveTaskRun } from '@gravitas/shared'
import { getProactiveRunsPath, getProactiveSchedulesPath } from './config-paths'

interface ScheduleIndexFile { version: 1; schedules: ProactiveSchedule[] }
interface RunIndexFile { version: 1; runs: ProactiveTaskRun[] }

type IndexFile = ScheduleIndexFile | RunIndexFile

interface ReadResult {
  index: IndexFile
  error: string | null
}

export class ProactiveSchedulerStore {
  /** 最后一次成功读取的内存快照；文件损坏时用于只读展示，禁止作为写入基础 */
  private lastGoodSchedules: ScheduleIndexFile | null = null
  private lastGoodRuns: RunIndexFile | null = null
  private schedulesReadError: string | null = null
  private runsReadError: string | null = null

  /** 调度索引当前是否处于读取损坏状态（供 UI 展示与测试断言）。 */
  getSchedulesReadError(): string | null { return this.schedulesReadError }
  /** 运行索引当前是否处于读取损坏状态。 */
  getRunsReadError(): string | null { return this.runsReadError }

  listSchedules(): ProactiveSchedule[] { return this.readSchedules().map(clone) }
  listRuns(): ProactiveTaskRun[] { return this.readRuns().map(clone) }

  getSchedule(id: string): ProactiveSchedule | undefined {
    const schedule = this.readSchedules().find((item) => item.id === id)
    return schedule ? clone(schedule) : undefined
  }

  deleteSchedule(id: string): boolean {
    this.assertSchedulesWritable()
    const current = this.readSchedules()
    const schedules = current.filter((item) => item.id !== id)
    if (schedules.length === current.length) return false
    this.writeSchedules(schedules)
    return true
  }

  saveSchedule(schedule: ProactiveSchedule): ProactiveSchedule {
    this.assertSchedulesWritable()
    const next = clone(schedule)
    const schedules = this.readSchedules()
    const position = schedules.findIndex((item) => item.id === next.id)
    if (position >= 0) schedules[position] = next
    else schedules.push(next)
    this.writeSchedules(schedules)
    return clone(next)
  }

  saveRun(run: ProactiveTaskRun): ProactiveTaskRun {
    this.assertRunsWritable()
    const next = clone(run)
    const runs = this.readRuns()
    const position = runs.findIndex((item) => item.id === next.id)
    if (position >= 0) runs[position] = next
    else runs.push(next)
    writeAtomic(getProactiveRunsPath(), { version: 1, runs: runs.slice(-1_000) })
    return clone(next)
  }

  /** 文件损坏时拒绝写入，避免用空索引/快照覆盖用户的原始数据。 */
  private assertSchedulesWritable(): void {
    this.readSchedules()
    if (this.schedulesReadError) {
      throw new Error(`定时任务索引文件无法读取，已拒绝写入以避免覆盖原数据：${this.schedulesReadError}`)
    }
  }

  private assertRunsWritable(): void {
    this.readRuns()
    if (this.runsReadError) {
      throw new Error(`运行记录索引文件无法读取，已拒绝写入以避免覆盖原数据：${this.runsReadError}`)
    }
  }

  private readSchedules(): ProactiveSchedule[] {
    const result = readIndex(getProactiveSchedulesPath(), 'schedules')
    if (result.error) {
      this.schedulesReadError = result.error
      // 有上次成功快照则继续展示旧数据；没有则展示空列表（只读，不写回）。
      return this.lastGoodSchedules?.schedules ?? []
    }
    this.schedulesReadError = null
    this.lastGoodSchedules = result.index as ScheduleIndexFile
    return this.lastGoodSchedules.schedules
  }

  private readRuns(): ProactiveTaskRun[] {
    const result = readIndex(getProactiveRunsPath(), 'runs')
    if (result.error) {
      this.runsReadError = result.error
      return this.lastGoodRuns?.runs ?? []
    }
    this.runsReadError = null
    this.lastGoodRuns = result.index as RunIndexFile
    return this.lastGoodRuns.runs
  }

  private writeSchedules(schedules: ProactiveSchedule[]): void {
    writeAtomic(getProactiveSchedulesPath(), { version: 1, schedules })
    this.lastGoodSchedules = { version: 1, schedules }
  }
}

function emptyIndex(field: 'schedules' | 'runs'): IndexFile {
  return field === 'schedules' ? { version: 1, schedules: [] } : { version: 1, runs: [] }
}

function readIndex(path: string, field: 'schedules' | 'runs'): ReadResult {
  if (!existsSync(path)) return { index: emptyIndex(field), error: null }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isIndex(parsed, field)) throw new Error('格式无效')
    return { index: parsed as IndexFile, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[Proactive Scheduler] 读取 ${field} 失败，将使用空索引（只读，不写回）:`, error)
    return { index: emptyIndex(field), error: message }
  }
}

function isIndex(value: unknown, field: 'schedules' | 'runs'): boolean {
  return typeof value === 'object' && value !== null && (value as { version?: unknown }).version === 1 && Array.isArray((value as Record<string, unknown>)[field])
}

function writeAtomic(path: string, value: IndexFile): void {
  const tempPath = `${path}.tmp`
  writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tempPath, path)
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
