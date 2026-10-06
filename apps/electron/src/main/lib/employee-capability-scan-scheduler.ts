/**
 * 员工能力建议的周期扫描调度。
 *
 * 默认关闭：只有用户显式启用后才注册周期任务。
 * 每次只运行本地只读扫描（不调用模型、不创建候选），且复用治理配置中的阈值与预算。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import { getProactiveConfigPath } from './config-paths'

const SCHEDULE_FILE = 'employee-capability-scan-schedule.json'
const HOUR_MS = 60 * 60 * 1000

export interface EmployeeCapabilityScanSchedule {
  enabled: boolean
  /** 扫描间隔（小时），最小 6 小时，避免频繁打扰。 */
  intervalHours: number
  lastRunAt?: number
  updatedAt: number
}

const DEFAULT_SCHEDULE: EmployeeCapabilityScanSchedule = { enabled: false, intervalHours: 24, updatedAt: 0 }

function filePath(): string {
  return join(getProactiveConfigPath(), SCHEDULE_FILE)
}

function readSchedule(): EmployeeCapabilityScanSchedule {
  if (!existsSync(filePath())) return { ...DEFAULT_SCHEDULE }
  const parsed = readJsonFileSafe<EmployeeCapabilityScanSchedule>(filePath())
  if (!parsed || typeof parsed.enabled !== 'boolean' || typeof parsed.intervalHours !== 'number') return { ...DEFAULT_SCHEDULE }
  return { ...DEFAULT_SCHEDULE, ...parsed }
}

export function getEmployeeCapabilityScanSchedule(): EmployeeCapabilityScanSchedule {
  return readSchedule()
}

/** 显式启用或关闭周期扫描；间隔低于下限时拒绝。 */
export function updateEmployeeCapabilityScanSchedule(input: { enabled: boolean; intervalHours?: number }, now = Date.now()): EmployeeCapabilityScanSchedule {
  const current = readSchedule()
  const intervalHours = input.intervalHours ?? current.intervalHours
  if (!Number.isInteger(intervalHours) || intervalHours < 6 || intervalHours > 24 * 14) throw new Error('扫描间隔必须是 6-336 小时的整数')
  const next: EmployeeCapabilityScanSchedule = { enabled: input.enabled, intervalHours, lastRunAt: current.lastRunAt, updatedAt: now }
  writeJsonFileAtomic(filePath(), next)
  return next
}

/** 是否到点该扫描；关闭时始终返回 false。 */
export function isScanDue(schedule: EmployeeCapabilityScanSchedule, now = Date.now()): boolean {
  if (!schedule.enabled) return false
  if (!schedule.lastRunAt) return true
  return now - schedule.lastRunAt >= schedule.intervalHours * HOUR_MS
}

/**
 * 执行一次到点扫描。只调用本地只读扫描服务，不触发模型调用。
 * 返回本次创建的建议数量与跳过原因，便于界面解释。
 */
export function runEmployeeCapabilityScanIfDue(now = Date.now()): { ran: boolean; created: number; skipped: number } {
  const schedule = readSchedule()
  if (!isScanDue(schedule, now)) return { ran: false, created: 0, skipped: 0 }
  const { scanAllEmployeeCapabilityScopes } = require('./employee-capability-recommendation-service') as typeof import('./employee-capability-recommendation-service')
  const outcomes = scanAllEmployeeCapabilityScopes({ now })
  writeJsonFileAtomic(filePath(), { ...schedule, lastRunAt: now, updatedAt: now })
  return { ran: true, created: outcomes.filter((item) => item.recommendationId).length, skipped: outcomes.filter((item) => item.skipped).length }
}
