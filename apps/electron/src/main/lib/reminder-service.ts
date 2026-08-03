/**
 * 智能提醒系统服务
 *
 * 主动扫描日程和任务，生成分级提醒：
 * - 日程冲突检测（创建/更新日程时）
 * - Deadline 分级提醒：24h 前 / 15min 前 / 逾期
 * - 任务逾期提醒（高优先级）
 * - 提醒去重：同一事件 30 分钟内不重复提醒
 *
 * 优先级体系：
 * - P0 紧急：日程冲突、逾期紧急任务
 * - P1 重要：24h 内 deadline、高优先级任务逾期
 * - P2 一般：15min 前日程提醒、普通任务逾期
 * - P3 推荐：低优先级任务、非工作时段建议
 */

import {
  listScheduleEvents,
  listScheduleTasks,
  detectConflicts,
  type ScheduleEvent,
  type ScheduleTask,
  type ConflictResult,
} from './schedule-service'
import { getSettings } from './settings-service'

// ===== 类型定义 =====

export type ReminderPriority = 'P0' | 'P1' | 'P2' | 'P3'

export type ReminderType =
  | 'event-conflict'
  | 'event-upcoming'
  | 'event-starting-soon'
  | 'task-deadline-24h'
  | 'task-deadline-15min'
  | 'task-overdue'
  | 'focus-block-suggestion'

export interface Reminder {
  id: string
  type: ReminderType
  priority: ReminderPriority
  title: string
  description?: string
  /** 关联事件/任务 ID */
  targetId: string
  /** 触发时间 */
  triggerAt: number
  /** 是否已推送 */
  pushed: boolean
  /** 推送时间 */
  pushedAt?: number
  /** 用户是否已处理（点击/关闭） */
  dismissed: boolean
  /** 处理时间 */
  dismissedAt?: number
}

export interface ReminderCheckResult {
  newReminders: Reminder[]
  totalActive: number
  byPriority: Record<ReminderPriority, number>
}

// ===== 状态 =====

/** 内存中的提醒列表 */
const reminders: Reminder[] = []

/** 已提醒记录：targetId -> 最近提醒时间（用于去重） */
const lastReminderTime = new Map<string, number>()

/** 去重窗口：30 分钟 */
const DEDUP_WINDOW_MS = 30 * 60 * 1000

/** 扫描间隔：5 分钟 */
const SCAN_INTERVAL_MS = 5 * 60 * 1000

let scanTimer: ReturnType<typeof setInterval> | null = null

// ===== 核心 API =====

/**
 * 启动定时扫描
 */
export function startReminderScan(): void {
  if (scanTimer) return
  // 立即执行一次
  checkReminders()
  scanTimer = setInterval(() => checkReminders(), SCAN_INTERVAL_MS)
  console.log('[提醒系统] 定时扫描已启动')
}

/**
 * 停止定时扫描
 */
export function stopReminderScan(): void {
  if (scanTimer) {
    clearInterval(scanTimer)
    scanTimer = null
    console.log('[提醒系统] 定时扫描已停止')
  }
}

/**
 * 手动触发一次检查
 */
export function checkReminders(): ReminderCheckResult {
  const now = Date.now()
  const newReminders: Reminder[] = []

  // 1. 检查日程冲突（所有未来 7 天内的事件）
  const conflictReminders = checkEventConflicts()
  newReminders.push(...conflictReminders)

  // 2. 检查即将开始的日程（24h 内 / 15min 内）
  const upcomingReminders = checkUpcomingEvents(now)
  newReminders.push(...upcomingReminders)

  // 3. 检查任务 deadline（24h 内 / 15min 内 / 逾期）
  const taskReminders = checkTaskDeadlines(now)
  newReminders.push(...taskReminders)

  // 4. 添加到全局列表（去重）
  for (const r of newReminders) {
    if (!shouldDedup(r.targetId, r.type, now)) {
      reminders.push(r)
      lastReminderTime.set(`${r.targetId}:${r.type}`, now)
    }
  }

  // 清理已处理且超过 1 小时的提醒
  const cleanupCutoff = now - 60 * 60 * 1000
  for (let i = reminders.length - 1; i >= 0; i--) {
    const r = reminders[i]!
    if (r.dismissed && (r.dismissedAt ?? 0) < cleanupCutoff) {
      reminders.splice(i, 1)
    }
  }

  return {
    newReminders,
    totalActive: reminders.filter((r) => !r.dismissed).length,
    byPriority: countByPriority(reminders.filter((r) => !r.dismissed)),
  }
}

/**
 * 获取所有未处理的提醒（用于渲染进程拉取）
 */
export function getActiveReminders(): Reminder[] {
  return reminders
    .filter((r) => !r.dismissed)
    .sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority) || a.triggerAt - b.triggerAt)
}

/**
 * 标记提醒已处理
 */
export function dismissReminder(id: string): boolean {
  const r = reminders.find((x) => x.id === id)
  if (!r) return false
  r.dismissed = true
  r.dismissedAt = Date.now()
  return true
}

/**
 * 标记提醒已推送（渲染进程显示后回调）
 */
export function markReminderPushed(id: string): boolean {
  const r = reminders.find((x) => x.id === id)
  if (!r) return false
  r.pushed = true
  r.pushedAt = Date.now()
  return true
}

/**
 * 检测日程冲突（外部调用：创建/更新日程时）
 */
export function checkConflictForEvent(event: { startTime: string; endTime: string; id?: string }): ConflictResult {
  return detectConflicts(event, event.id)
}

/**
 * 获取提醒统计
 */
export function getReminderStats(): {
  total: number
  active: number
  pushed: number
  byPriority: Record<ReminderPriority, number>
} {
  return {
    total: reminders.length,
    active: reminders.filter((r) => !r.dismissed).length,
    pushed: reminders.filter((r) => r.pushed).length,
    byPriority: countByPriority(reminders.filter((r) => !r.dismissed)),
  }
}

// ===== 内部扫描逻辑 =====

function checkEventConflicts(): Reminder[] {
  const results: Reminder[] = []
  const events = listScheduleEvents()
  const now = new Date().toISOString()

  // 只检查未来 7 天内的事件
  const cutoff = new Date(Date.now() + 7 * 86400000).toISOString()
  const futureEvents = events.filter((e) => e.startTime > now && e.startTime < cutoff)

  for (const event of futureEvents) {
    const conflict = detectConflicts(event, event.id)
    if (conflict.hasConflict) {
      results.push({
        id: `conflict:${event.id}:${Date.now()}`,
        type: 'event-conflict',
        priority: 'P0',
        title: `日程冲突：${event.title}`,
        description: `与 ${conflict.conflicts.map((c) => c.eventTitle).join('、')} 时间重叠`,
        targetId: event.id,
        triggerAt: Date.now(),
        pushed: false,
        dismissed: false,
      })
    }
  }

  return results
}

function checkUpcomingEvents(now: number): Reminder[] {
  const results: Reminder[] = []
  const events = listScheduleEvents()
  const isoNow = new Date(now).toISOString()

  for (const event of events) {
    const startTime = new Date(event.startTime).getTime()
    const timeUntil = startTime - now

    // 跳过已结束的事件
    if (timeUntil < 0) continue

    // 15 分钟内开始 → P1 提醒
    if (timeUntil <= 15 * 60 * 1000 && timeUntil > 0) {
      results.push({
        id: `soon:${event.id}`,
        type: 'event-starting-soon',
        priority: 'P1',
        title: `即将开始：${event.title}`,
        description: event.allDay ? '全天事件' : `还有 ${Math.ceil(timeUntil / 60000)} 分钟开始`,
        targetId: event.id,
        triggerAt: now,
        pushed: false,
        dismissed: false,
      })
      continue
    }

    // 24h 内开始 → P2 提醒（只提醒一次，15min 的会覆盖）
    if (timeUntil <= 24 * 3600 * 1000 && timeUntil > 15 * 60 * 1000) {
      results.push({
        id: `upcoming:${event.id}`,
        type: 'event-upcoming',
        priority: 'P2',
        title: `明日日程：${event.title}`,
        description: `${new Date(event.startTime).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
        targetId: event.id,
        triggerAt: now,
        pushed: false,
        dismissed: false,
      })
    }
  }

  return results
}

function checkTaskDeadlines(now: number): Reminder[] {
  const results: Reminder[] = []
  const tasks = listScheduleTasks()
  const todayStr = new Date(now).toISOString().slice(0, 10)
  const settings = getSettings()

  for (const task of tasks) {
    if (task.status === 'done') continue
    if (!task.dueDate) continue

    const dueTime = task.dueTime
      ? new Date(`${task.dueDate}T${task.dueTime}`).getTime()
      : new Date(`${task.dueDate}T23:59:59`).getTime()

    const timeUntil = dueTime - now

    // 已逾期
    if (timeUntil < 0) {
      const priority: ReminderPriority = task.priority === 'urgent' ? 'P0' : task.priority === 'high' ? 'P1' : 'P2'
      results.push({
        id: `overdue:${task.id}`,
        type: 'task-overdue',
        priority,
        title: `任务逾期：${task.title}`,
        description: `截止于 ${task.dueDate}${task.dueTime ? ' ' + task.dueTime : ''}`,
        targetId: task.id,
        triggerAt: now,
        pushed: false,
        dismissed: false,
      })
      continue
    }

    // 15min 内截止 → P0/P1
    if (timeUntil <= 15 * 60 * 1000) {
      const priority: ReminderPriority = task.priority === 'urgent' ? 'P0' : 'P1'
      results.push({
        id: `deadline-15min:${task.id}`,
        type: 'task-deadline-15min',
        priority,
        title: `即将截止：${task.title}`,
        description: `还有 ${Math.ceil(timeUntil / 60000)} 分钟`,
        targetId: task.id,
        triggerAt: now,
        pushed: false,
        dismissed: false,
      })
      continue
    }

    // 24h 内截止 → P1/P2
    if (timeUntil <= 24 * 3600 * 1000) {
      const priority: ReminderPriority = task.priority === 'urgent' ? 'P1' : task.priority === 'high' ? 'P1' : 'P2'
      results.push({
        id: `deadline-24h:${task.id}`,
        type: 'task-deadline-24h',
        priority,
        title: `24h 内截止：${task.title}`,
        description: `截止于 ${new Date(dueTime).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
        targetId: task.id,
        triggerAt: now,
        pushed: false,
        dismissed: false,
      })
    }
  }

  return results
}

// ===== 工具函数 =====

function shouldDedup(targetId: string, type: ReminderType, now: number): boolean {
  const key = `${targetId}:${type}`
  const last = lastReminderTime.get(key)
  if (!last) return false
  return now - last < DEDUP_WINDOW_MS
}

function priorityWeight(p: ReminderPriority): number {
  return { P0: 4, P1: 3, P2: 2, P3: 1 }[p]
}

function countByPriority(items: Reminder[]): Record<ReminderPriority, number> {
  return {
    P0: items.filter((i) => i.priority === 'P0').length,
    P1: items.filter((i) => i.priority === 'P1').length,
    P2: items.filter((i) => i.priority === 'P2').length,
    P3: items.filter((i) => i.priority === 'P3').length,
  }
}
