/** Proactive Scheduler 本地 JSON 存储；索引原子替换，运行记录单独保存。 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { ProactiveSchedule, ProactiveTaskRun } from '@gravitas/shared'
import { getProactiveRunsPath, getProactiveSchedulesPath } from './config-paths'

interface ScheduleIndexFile { version: 1; schedules: ProactiveSchedule[] }
interface RunIndexFile { version: 1; runs: ProactiveTaskRun[] }

export class ProactiveSchedulerStore {
  listSchedules(): ProactiveSchedule[] { return this.readSchedules().schedules.map(clone) }
  listRuns(): ProactiveTaskRun[] { return this.readRuns().runs.map(clone) }

  getSchedule(id: string): ProactiveSchedule | undefined {
    const schedule = this.readSchedules().schedules.find((item) => item.id === id)
    return schedule ? clone(schedule) : undefined
  }

  deleteSchedule(id: string): boolean {
    const index = this.readSchedules()
    const schedules = index.schedules.filter((item) => item.id !== id)
    if (schedules.length === index.schedules.length) return false
    writeAtomic(getProactiveSchedulesPath(), { version: 1, schedules })
    return true
  }

  saveSchedule(schedule: ProactiveSchedule): ProactiveSchedule {
    const index = this.readSchedules()
    const next = clone(schedule)
    const position = index.schedules.findIndex((item) => item.id === next.id)
    if (position >= 0) index.schedules[position] = next
    else index.schedules.push(next)
    writeAtomic(getProactiveSchedulesPath(), index)
    return clone(next)
  }

  saveRun(run: ProactiveTaskRun): ProactiveTaskRun {
    const index = this.readRuns()
    const next = clone(run)
    const position = index.runs.findIndex((item) => item.id === next.id)
    if (position >= 0) index.runs[position] = next
    else index.runs.push(next)
    writeAtomic(getProactiveRunsPath(), { version: 1, runs: index.runs.slice(-1_000) })
    return clone(next)
  }

  private readSchedules(): ScheduleIndexFile {
    return readIndex(getProactiveSchedulesPath(), 'schedules') as ScheduleIndexFile
  }

  private readRuns(): RunIndexFile {
    return readIndex(getProactiveRunsPath(), 'runs') as RunIndexFile
  }
}

function readIndex(path: string, field: 'schedules' | 'runs'): ScheduleIndexFile | RunIndexFile {
  if (!existsSync(path)) return emptyIndex(field)
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isIndex(parsed, field)) throw new Error('格式无效')
    return parsed as ScheduleIndexFile | RunIndexFile
  } catch (error) {
    console.error(`[Proactive Scheduler] 读取 ${field} 失败，将使用空索引:`, error)
    return emptyIndex(field)
  }
}

function emptyIndex(field: 'schedules' | 'runs'): ScheduleIndexFile | RunIndexFile {
  return field === 'schedules' ? { version: 1, schedules: [] } : { version: 1, runs: [] }
}

function isIndex(value: unknown, field: 'schedules' | 'runs'): boolean {
  return typeof value === 'object' && value !== null && (value as { version?: unknown }).version === 1 && Array.isArray((value as Record<string, unknown>)[field])
}

function writeAtomic(path: string, value: ScheduleIndexFile | RunIndexFile): void {
  const tempPath = `${path}.tmp`
  writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tempPath, path)
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
