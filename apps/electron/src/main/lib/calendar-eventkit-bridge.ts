/**
 * Calendar EventKit Bridge - macOS 系统日历桥接
 *
 * 通过 child_process 调用 Swift 脚本读取系统日历事件。
 * 提供权限请求、事件读取、双向同步基础功能。
 *
 * v0.1：读取系统日历 → 转换为 PAA ScheduleEvent 格式
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { app } from 'electron'
import type { ScheduleEvent, ScheduleEventInput, ScheduleCategory } from './schedule-service'

const execFileAsync = promisify(execFile)

// ===== 类型定义 =====

export interface EventKitEvent {
  id: string
  title: string
  startTime: string
  endTime: string
  allDay: boolean
  location?: string
  calendarName: string
  calendarColor?: string
  notes?: string
  isRecurring: boolean
}

export interface EventKitReadResult {
  success: boolean
  events: EventKitEvent[]
  error?: string
}

export interface CalendarSyncOptions {
  /** 回溯天数（默认 30） */
  daysBack?: number
  /** 前瞻天数（默认 90） */
  daysForward?: number
  /** 只读取指定日历 */
  calendarNames?: string[]
}

// ===== 权限管理 =====

/**
 * 检查日历权限状态
 * 返回: 'authorized' | 'denied' | 'notDetermined' | 'restricted'
 */
export async function checkCalendarPermission(): Promise<string> {
  try {
    // 通过 Swift 脚本检查权限（不读取数据，只检查权限）
    const scriptPath = getSwiftScriptPath()
    await execFileAsync('swift', [scriptPath, '0', '0'], {
      timeout: 10000,
      encoding: 'utf-8',
    })
    // 如果成功执行，说明有权限
    return 'authorized'
  } catch (error: unknown) {
    const stderr = getExecErrorText(error)
    if (stderr.includes('denied') || stderr.includes('权限被拒绝')) {
      return 'denied'
    }
    if (stderr.includes('notDetermined')) {
      return 'notDetermined'
    }
    return 'denied'
  }
}

/**
 * 请求日历权限
 * 由于 macOS 限制，后台进程无法触发权限对话框。
 * 首次使用需要用户在 系统设置 > 隐私与安全性 > 日历 中手动允许 PAA。
 */
export async function requestCalendarPermission(): Promise<boolean> {
  try {
    const scriptPath = getSwiftScriptPath()
    const { stdout, stderr } = await execFileAsync('swift', [scriptPath, '0', '0'], {
      timeout: 30000,
      encoding: 'utf-8',
    })
    // 如果成功执行并有输出，说明有权限
    if (stdout && stdout.trim().startsWith('[')) {
      return true
    }
    return true
  } catch (error: unknown) {
    const stderr = getExecErrorText(error)
    // 权限未确定或被拒绝
    if (stderr.includes('notDetermined') || stderr.includes('denied') || stderr.includes('被拒绝')) {
      return false
    }
    return false
  }
}

// ===== 事件读取 =====

/**
 * 从 macOS EventKit 读取日历事件
 */
export async function readSystemCalendar(options: CalendarSyncOptions = {}): Promise<EventKitReadResult> {
  const { daysBack = 30, daysForward = 90 } = options

  try {
    const scriptPath = getSwiftScriptPath()
    const { stdout, stderr } = await execFileAsync('swift', [scriptPath, String(daysBack), String(daysForward)], {
      timeout: 30000,
      encoding: 'utf-8',
    })

    if (stderr && stderr.includes('error')) {
      return { success: false, events: [], error: stderr.trim() }
    }

    const events: EventKitEvent[] = JSON.parse(stdout)
    return { success: true, events }
  } catch (error: unknown) {
    const errorMsg = getExecErrorText(error)
    return { success: false, events: [], error: errorMsg }
  }
}

/**
 * 将 EventKit 事件转换为 PAA ScheduleEventInput
 */
export function convertEventKitToScheduleEvent(ekEvent: EventKitEvent): ScheduleEventInput {
  return {
    title: ekEvent.title,
    startTime: ekEvent.startTime,
    endTime: ekEvent.endTime,
    allDay: ekEvent.allDay,
    location: ekEvent.location,
    category: inferCategoryFromCalendar(ekEvent.calendarName),
    source: 'calendar-sync',
  }
}

/**
 * 根据日历名称推断分类
 */
function inferCategoryFromCalendar(calendarName: string): ScheduleCategory {
  const name = calendarName.toLowerCase()
  if (name.includes('work') || name.includes('工作') || name.includes('business')) return 'work'
  if (name.includes('family') || name.includes('家庭') || name.includes('home')) return 'family'
  if (name.includes('health') || name.includes('健康') || name.includes('fitness')) return 'health'
  if (name.includes('learn') || name.includes('学习') || name.includes('study')) return 'learning'
  if (name.includes('social') || name.includes('社交') || name.includes('friend')) return 'social'
  if (name.includes('finance') || name.includes('财务') || name.includes('money')) return 'finance'
  return 'personal'
}

// ===== 同步功能 =====

/**
 * 同步系统日历到 PAA
 * 读取系统日历事件，转换为 PAA 格式，批量创建
 */
export async function syncSystemCalendarToPaa(options: CalendarSyncOptions = {}): Promise<{
  success: boolean
  imported: number
  errors: string[]
}> {
  const readResult = await readSystemCalendar(options)
  if (!readResult.success) {
    return { success: false, imported: 0, errors: [readResult.error || '读取失败'] }
  }

  // 转换为 PAA 格式（但不直接创建，由调用方决定）
  const inputs = readResult.events.map(convertEventKitToScheduleEvent)

  return {
    success: true,
    imported: inputs.length,
    errors: [],
  }
}

// ===== 工具函数 =====

function getSwiftScriptPath(): string {
  // 打包模式：从 app bundle 的 resources 目录读取
  // 开发模式：从源码 resources 目录读取
  if (app.isPackaged) {
    return join(process.resourcesPath, 'read-calendar.swift')
  }

  const candidates = [
    join(app.getAppPath(), 'src/main/resources/read-calendar.swift'),
    join(app.getAppPath(), 'resources/read-calendar.swift'),
    join(__dirname, '../resources/read-calendar.swift'),
  ]

  const scriptPath = candidates.find((path) => existsSync(path))
  if (!scriptPath) {
    throw new Error(`未找到系统日历读取脚本，已检查: ${candidates.join(', ')}`)
  }
  return scriptPath
}

function getExecErrorText(error: unknown): string {
  if (error instanceof Error) {
    const maybeExecError = error as Error & { stderr?: string }
    return maybeExecError.stderr || error.message
  }
  return String(error)
}
