/**
 * 日程管家服务 — Schedule Service
 *
 * 负责个人日程管理的核心逻辑：
 * - 日程事件 CRUD（JSONL 追加写入）
 * - 任务（Task）CRUD 与状态管理
 * - 重复事件展开（RecurrenceRule → 具体实例）
 * - 时间冲突检测
 * - 数据持久化到 ~/.paa/calendar/
 *
 * v0.1 实现：基础 CRUD + 冲突检测 + 重复事件展开
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getCalendarEventsPath, getTasksPath } from './config-paths'

// ===== 类型定义 =====

export type ScheduleCategory =
  | 'work'
  | 'personal'
  | 'family'
  | 'health'
  | 'learning'
  | 'social'
  | 'finance'
  | 'other'

export type TaskStatus = 'todo' | 'in-progress' | 'review' | 'done'
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'

export interface RecurrenceRule {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval?: number
  count?: number
  until?: string // ISO 8601
  byDay?: string[] // MO, TU, WE, TH, FR, SA, SU
}

export interface ScheduleEventInput {
  title: string
  description?: string
  startTime: string
  endTime: string
  allDay?: boolean
  location?: string
  category?: ScheduleCategory
  tags?: string[]
  reminderMinutes?: number[]
  recurrence?: RecurrenceRule
  source?: 'manual' | 'calendar-sync' | 'agent'
}

export interface ScheduleEvent {
  id: string
  title: string
  description?: string
  startTime: string // ISO 8601
  endTime: string // ISO 8601
  allDay?: boolean
  location?: string
  category?: ScheduleCategory
  tags?: string[]
  reminderMinutes?: number[]
  recurrence?: RecurrenceRule
  source?: 'manual' | 'calendar-sync' | 'agent'
  /** 软删除标记 */
  deleted?: boolean
  createdAt: string
  updatedAt: string
}

export interface ScheduleTask {
  id: string
  title: string
  description?: string
  status: TaskStatus
  priority: TaskPriority
  dueDate?: string // ISO 8601 date
  dueTime?: string // ISO 8601 time
  category?: ScheduleCategory
  tags?: string[]
  /** 关联的日程事件 ID */
  eventId?: string
  /** 预估耗时（分钟） */
  estimatedMinutes?: number
  /** 软删除标记 */
  deleted?: boolean
  createdAt: string
  updatedAt: string
}

export interface ScheduleFilter {
  startDate?: string // ISO 8601
  endDate?: string // ISO 8601
  category?: ScheduleCategory
  tags?: string[]
  source?: string
  searchQuery?: string
  includeDeleted?: boolean
}

export interface TaskFilter {
  status?: TaskStatus
  priority?: TaskPriority
  category?: ScheduleCategory
  tags?: string[]
  dueBefore?: string
  dueAfter?: string
  searchQuery?: string
  includeDeleted?: boolean
}

export interface ConflictResult {
  hasConflict: boolean
  conflicts: Array<{
    eventId: string
    eventTitle: string
    startTime: string
    endTime: string
  }>
}

// ===== JSONL 工具函数 =====

function readJsonlLines<T>(path: string): T[] {
  if (!existsSync(path)) return []
  try {
    const raw = readFileSync(path, 'utf-8').trim()
    if (!raw) return []
    return raw
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line) as T
        } catch {
          return null
        }
      })
      .filter((item): item is T => item !== null)
  } catch {
    return []
  }
}

function appendJsonlLine(path: string, item: unknown): void {
  const dir = join(path, '..')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  appendFileSync(path, JSON.stringify(item) + '\n', 'utf-8')
}

function rewriteJsonl(path: string, items: unknown[]): void {
  const dir = join(path, '..')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const lines = items.map((item) => JSON.stringify(item)).join('\n')
  writeFileSync(path, lines ? lines + '\n' : '', 'utf-8')
}

// ===== 事件 CRUD =====

function loadAllEvents(): ScheduleEvent[] {
  return readJsonlLines<ScheduleEvent>(getCalendarEventsPath())
}

function saveAllEvents(events: ScheduleEvent[]): void {
  rewriteJsonl(getCalendarEventsPath(), events)
}

export function listScheduleEvents(filter?: ScheduleFilter): ScheduleEvent[] {
  let events = loadAllEvents().filter((e) => !e.deleted)
  if (!filter) return events

  if (filter.startDate) {
    events = events.filter((e) => e.endTime >= filter.startDate!)
  }
  if (filter.endDate) {
    events = events.filter((e) => e.startTime <= filter.endDate!)
  }
  if (filter.category) {
    events = events.filter((e) => e.category === filter.category)
  }
  if (filter.tags && filter.tags.length > 0) {
    events = events.filter((e) => filter.tags!.some((t) => e.tags?.includes(t)))
  }
  if (filter.source) {
    events = events.filter((e) => e.source === filter.source)
  }
  if (filter.searchQuery) {
    const q = filter.searchQuery.toLowerCase()
    events = events.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.description?.toLowerCase().includes(q) ||
        e.location?.toLowerCase().includes(q),
    )
  }
  return events
}

export function getScheduleEvent(id: string): ScheduleEvent | null {
  const events = loadAllEvents()
  return events.find((e) => e.id === id && !e.deleted) ?? null
}

export function createScheduleEvent(
  input: Omit<ScheduleEvent, 'id' | 'createdAt' | 'updatedAt' | 'deleted'>,
): ScheduleEvent {
  const now = new Date().toISOString()
  const event: ScheduleEvent = {
    ...input,
    id: randomUUID(),
    deleted: false,
    createdAt: now,
    updatedAt: now,
  }
  appendJsonlLine(getCalendarEventsPath(), event)
  return event
}

export function updateScheduleEvent(
  id: string,
  patch: Partial<Omit<ScheduleEvent, 'id' | 'createdAt'>>,
): ScheduleEvent | null {
  const events = loadAllEvents()
  const idx = events.findIndex((e) => e.id === id)
  if (idx === -1) return null

  const updated: ScheduleEvent = {
    ...events[idx]!,
    ...patch,
    updatedAt: new Date().toISOString(),
  }
  events[idx] = updated
  saveAllEvents(events)
  return updated
}

export function deleteScheduleEvent(id: string): boolean {
  const events = loadAllEvents()
  const idx = events.findIndex((e) => e.id === id)
  if (idx === -1) return false

  // 软删除
  events[idx]!.deleted = true
  events[idx]!.updatedAt = new Date().toISOString()
  saveAllEvents(events)
  return true
}

// ===== 批量操作 =====

export function bulkCreateScheduleEvents(
  inputs: Array<Omit<ScheduleEvent, 'id' | 'createdAt' | 'updatedAt' | 'deleted'>>,
): ScheduleEvent[] {
  const now = new Date().toISOString()
  const newEvents = inputs.map((input) => ({
    ...input,
    id: randomUUID(),
    deleted: false,
    createdAt: now,
    updatedAt: now,
  }))
  for (const event of newEvents) {
    appendJsonlLine(getCalendarEventsPath(), event)
  }
  return newEvents
}

// ===== 任务 CRUD =====

function loadAllTasks(): ScheduleTask[] {
  return readJsonlLines<ScheduleTask>(getTasksPath())
}

function saveAllTasks(tasks: ScheduleTask[]): void {
  rewriteJsonl(getTasksPath(), tasks)
}

export function listScheduleTasks(filter?: TaskFilter): ScheduleTask[] {
  let tasks = loadAllTasks().filter((t) => !t.deleted)
  if (!filter) return tasks

  if (filter.status) {
    tasks = tasks.filter((t) => t.status === filter.status)
  }
  if (filter.priority) {
    tasks = tasks.filter((t) => t.priority === filter.priority)
  }
  if (filter.category) {
    tasks = tasks.filter((t) => t.category === filter.category)
  }
  if (filter.tags && filter.tags.length > 0) {
    tasks = tasks.filter((t) => filter.tags!.some((tag) => t.tags?.includes(tag)))
  }
  if (filter.dueBefore) {
    tasks = tasks.filter((t) => t.dueDate && t.dueDate <= filter.dueBefore!)
  }
  if (filter.dueAfter) {
    tasks = tasks.filter((t) => t.dueDate && t.dueDate >= filter.dueAfter!)
  }
  if (filter.searchQuery) {
    const q = filter.searchQuery.toLowerCase()
    tasks = tasks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.description?.toLowerCase().includes(q),
    )
  }
  return tasks
}

export function getScheduleTask(id: string): ScheduleTask | null {
  const tasks = loadAllTasks()
  return tasks.find((t) => t.id === id && !t.deleted) ?? null
}

export function createScheduleTask(
  input: Omit<ScheduleTask, 'id' | 'createdAt' | 'updatedAt' | 'deleted'>,
): ScheduleTask {
  const now = new Date().toISOString()
  const task: ScheduleTask = {
    ...input,
    id: randomUUID(),
    deleted: false,
    createdAt: now,
    updatedAt: now,
  }
  appendJsonlLine(getTasksPath(), task)
  return task
}

export function updateScheduleTask(
  id: string,
  patch: Partial<Omit<ScheduleTask, 'id' | 'createdAt'>>,
): ScheduleTask | null {
  const tasks = loadAllTasks()
  const idx = tasks.findIndex((t) => t.id === id)
  if (idx === -1) return null

  const updated: ScheduleTask = {
    ...tasks[idx]!,
    ...patch,
    updatedAt: new Date().toISOString(),
  }
  tasks[idx] = updated
  saveAllTasks(tasks)
  return updated
}

export function updateTaskStatus(id: string, status: TaskStatus): ScheduleTask | null {
  return updateScheduleTask(id, { status })
}

export function deleteScheduleTask(id: string): boolean {
  const tasks = loadAllTasks()
  const idx = tasks.findIndex((t) => t.id === id)
  if (idx === -1) return false

  tasks[idx]!.deleted = true
  tasks[idx]!.updatedAt = new Date().toISOString()
  saveAllTasks(tasks)
  return true
}

// ===== 即将到期事件 =====

export function getUpcomingEvents(minutesAhead: number = 30): ScheduleEvent[] {
  const now = new Date().toISOString()
  const cutoff = new Date(Date.now() + minutesAhead * 60000).toISOString()
  const events = listScheduleEvents()
  return events.filter((e) => {
    if (e.startTime > cutoff) return false
    if (e.endTime < now) return false
    return true
  })
}

// ===== 冲突检测 =====

/**
 * 检测两个时间区间是否重叠
 * 区间 A: [aStart, aEnd)，区间 B: [bStart, bEnd)
 * 重叠条件: aStart < bEnd && aEnd > bStart
 */
function intervalsOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  return aStart < bEnd && aEnd > bStart
}

/**
 * 检测给定事件与现有事件的冲突
 * @param event 待检测的事件（可以是新事件或更新后的事件）
 * @param excludeId 排除的事件 ID（用于更新时排除自身）
 */
export function detectConflicts(
  event: { startTime: string; endTime: string; id?: string },
  excludeId?: string,
): ConflictResult {
  const events = listScheduleEvents()
  const conflicts: ConflictResult['conflicts'] = []

  for (const e of events) {
    if (excludeId && e.id === excludeId) continue
    if (intervalsOverlap(event.startTime, event.endTime, e.startTime, e.endTime)) {
      conflicts.push({
        eventId: e.id,
        eventTitle: e.title,
        startTime: e.startTime,
        endTime: e.endTime,
      })
    }
  }

  return {
    hasConflict: conflicts.length > 0,
    conflicts,
  }
}

/**
 * 创建事件时自动检测冲突
 * 如果存在冲突，返回冲突信息但不阻止创建（由调用方决定）
 */
export function createEventWithConflictCheck(
  input: Omit<ScheduleEvent, 'id' | 'createdAt' | 'updatedAt' | 'deleted'>,
): { event: ScheduleEvent; conflict: ConflictResult } {
  const conflict = detectConflicts({
    startTime: input.startTime,
    endTime: input.endTime,
  })
  const event = createScheduleEvent(input)
  return { event, conflict }
}

// ===== 重复事件展开 =====

/**
 * 根据 RecurrenceRule 展开为具体日期列表
 * @param startTime 事件起始时间 ISO 8601
 * @param endTime 事件结束时间 ISO 8601
 * @param rule 重复规则
 * @param maxCount 最大展开数量（防止无限循环）
 * @returns 展开后的起始时间列表
 */
export function expandRecurrence(
  startTime: string,
  endTime: string,
  rule: RecurrenceRule,
  maxCount: number = 365,
): Array<{ startTime: string; endTime: string }> {
  const results: Array<{ startTime: string; endTime: string }> = []
  const start = new Date(startTime)
  const end = new Date(endTime)
  const durationMs = end.getTime() - start.getTime()

  const interval = rule.interval ?? 1
  const count = rule.count ?? maxCount
  const until = rule.until ? new Date(rule.until) : null
  const byDay = rule.byDay

  let current = new Date(start)
  let generated = 0

  while (generated < count && generated < maxCount) {
    if (until && current > until) break

    // 检查 byDay 限制
    if (byDay && byDay.length > 0) {
      const dayMap: Record<string, number> = {
        SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
      }
      const currentDay = current.getDay()
      const allowedDays = byDay.map((d) => dayMap[d]).filter((d) => d !== undefined)
      if (!allowedDays.includes(currentDay)) {
        // 跳到下一个可能的日子
        current.setDate(current.getDate() + 1)
        continue
      }
    }

    const instanceStart = current.toISOString()
    const instanceEnd = new Date(current.getTime() + durationMs).toISOString()
    results.push({ startTime: instanceStart, endTime: instanceEnd })
    generated++

    // 推进到下一个周期
    switch (rule.frequency) {
      case 'daily':
        current.setDate(current.getDate() + interval)
        break
      case 'weekly':
        current.setDate(current.getDate() + interval * 7)
        break
      case 'monthly':
        current.setMonth(current.getMonth() + interval)
        break
      case 'yearly':
        current.setFullYear(current.getFullYear() + interval)
        break
    }
  }

  return results
}

/**
 * 获取指定时间范围内的所有事件（含重复事件展开）
 */
export function listScheduleEventsExpanded(
  filter?: ScheduleFilter,
  maxRecurrenceInstances: number = 365,
): Array<ScheduleEvent & { isRecurringInstance?: boolean; originalEventId?: string }> {
  const events = listScheduleEvents(filter)
  const results: Array<ScheduleEvent & { isRecurringInstance?: boolean; originalEventId?: string }> = []

  for (const event of events) {
    if (!event.recurrence) {
      results.push(event)
      continue
    }

    // 有重复规则：展开
    const instances = expandRecurrence(
      event.startTime,
      event.endTime,
      event.recurrence,
      maxRecurrenceInstances,
    )

    for (const instance of instances) {
      results.push({
        ...event,
        startTime: instance.startTime,
        endTime: instance.endTime,
        isRecurringInstance: true,
        originalEventId: event.id,
      })
    }
  }

  // 按时间排序
  results.sort((a, b) => a.startTime.localeCompare(b.startTime))
  return results
}

// ===== v0.1 占位：Agent 工具接口 =====

export interface ScheduleToolContext {
  userTimezone: string
  workHoursStart?: string
  workHoursEnd?: string
}

export async function scheduleAgentQuery(
  _query: string,
  _context: ScheduleToolContext,
): Promise<string> {
  // v0.1 占位：返回提示信息
  return '[日程服务] v0.1 占位实现，后续版本将支持自然语言查询日程'
}

// ===== 智能提醒（Day 5 新增） =====

export interface SmartReminder {
  eventId: string
  eventTitle: string
  eventTime: string
  reminderTime: string
  minutesBefore: number
  priority: 'critical' | 'high' | 'normal' | 'low'
  reason: string
}

/** 根据事件特征计算智能提醒时间 */
export function calculateSmartReminders(event: ScheduleEvent): SmartReminder[] {
  const reminders: SmartReminder[] = []
  const eventStart = new Date(event.startTime)
  const now = new Date()

  // 如果事件已过期，不生成提醒
  if (eventStart < now) return reminders

  // 基础提醒时间（根据事件类型）
  const baseReminders: number[] = []

  switch (event.category) {
    case 'work':
      baseReminders.push(15, 60, 1440) // 15min, 1h, 1d
      break
    case 'health':
      baseReminders.push(30, 120) // 30min, 2h
      break
    case 'learning':
      baseReminders.push(60, 180) // 1h, 3h
      break
    case 'social':
      baseReminders.push(60, 180, 1440) // 1h, 3h, 1d
      break
    case 'family':
      baseReminders.push(30, 120) // 30min, 2h
      break
    case 'finance':
      baseReminders.push(1440, 10080) // 1d, 7d
      break
    default:
      baseReminders.push(15, 60) // 15min, 1h
  }

  // 根据标题关键词调整
  const titleLower = event.title.toLowerCase()
  if (/面试|面试|interview/.test(titleLower)) {
    baseReminders.push(30, 120, 1440) // 面试需要更多准备时间
  }
  if (/航班|飞机|flight|机场/.test(titleLower)) {
    baseReminders.unshift(180, 240) // 航班提前 3-4 小时
  }
  if (/ deadline|截止|到期|ddl/.test(titleLower)) {
    baseReminders.push(2880, 4320) // deadline 提前 2-3 天
  }
  if (/生日|birthday|纪念日/.test(titleLower)) {
    baseReminders.push(10080, 20160) // 生日提前 1-2 周
  }

  // 去重并排序
  const uniqueReminders = [...new Set(baseReminders)].sort((a, b) => a - b)

  for (const minutes of uniqueReminders) {
    const reminderTime = new Date(eventStart.getTime() - minutes * 60000)
    if (reminderTime < now) continue // 跳过已过期提醒

    let priority: SmartReminder['priority'] = 'normal'
    if (minutes <= 15) priority = 'critical'
    else if (minutes <= 60) priority = 'high'
    else if (minutes >= 1440) priority = 'low'

    let reason = ''
    if (minutes <= 15) reason = '即将开始'
    else if (minutes <= 60) reason = '需要准备出发'
    else if (minutes <= 180) reason = '建议提前准备材料'
    else if (minutes <= 1440) reason = '明日事项提醒'
    else reason = '远期规划提醒'

    reminders.push({
      eventId: event.id,
      eventTitle: event.title,
      eventTime: event.startTime,
      reminderTime: reminderTime.toISOString(),
      minutesBefore: minutes,
      priority,
      reason,
    })
  }

  return reminders
}

/** 获取所有待发送的智能提醒 */
export function getPendingReminders(): SmartReminder[] {
  const events = listScheduleEvents()
  const allReminders: SmartReminder[] = []

  for (const event of events) {
    const reminders = calculateSmartReminders(event)
    allReminders.push(...reminders)
  }

  // 按提醒时间排序
  return allReminders.sort((a, b) => a.reminderTime.localeCompare(b.reminderTime))
}

/** 获取即将触发的提醒（未来 N 分钟内） */
export function getRemindersAboutToTrigger(minutesWindow: number = 5): SmartReminder[] {
  const now = new Date()
  const cutoff = new Date(now.getTime() + minutesWindow * 60000)
  const pending = getPendingReminders()

  return pending.filter((r) => {
    const reminderTime = new Date(r.reminderTime)
    return reminderTime >= now && reminderTime <= cutoff
  })
}

// ===== 增强冲突检测（Day 5 新增） =====

export interface EnhancedConflictResult extends ConflictResult {
  /** 建议的替代时间段 */
  suggestedSlots?: Array<{ startTime: string; endTime: string; reason: string }>
  /** 冲突严重程度 */
  severity: 'minor' | 'moderate' | 'severe'
  /** 缓冲时间是否充足 */
  bufferSufficient: boolean
}

/** 增强冲突检测：包含缓冲时间评估和替代时间建议 */
export function detectConflictsEnhanced(
  event: { startTime: string; endTime: string; id?: string; title?: string; category?: string },
  excludeId?: string,
): EnhancedConflictResult {
  const baseResult = detectConflicts(event, excludeId)

  // 计算冲突严重程度
  let severity: EnhancedConflictResult['severity'] = 'minor'
  if (baseResult.conflicts.length > 1) severity = 'severe'
  else if (baseResult.conflicts.length === 1) {
    const conflict = baseResult.conflicts[0]!
    const overlapMinutes = calculateOverlapMinutes(
      event.startTime, event.endTime,
      conflict.startTime, conflict.endTime,
    )
    if (overlapMinutes > 60) severity = 'severe'
    else if (overlapMinutes > 15) severity = 'moderate'
  }

  // 评估缓冲时间（会议间建议 15min 缓冲）
  const bufferSufficient = checkBufferTime(event, excludeId)

  // 生成替代时间建议
  const suggestedSlots = baseResult.hasConflict
    ? suggestAlternativeSlots(event, excludeId)
    : undefined

  return {
    ...baseResult,
    severity,
    bufferSufficient,
    suggestedSlots,
  }
}

/** 计算两个事件的重叠分钟数 */
function calculateOverlapMinutes(
  aStart: string, aEnd: string,
  bStart: string, bEnd: string,
): number {
  const start = new Date(Math.max(new Date(aStart).getTime(), new Date(bStart).getTime()))
  const end = new Date(Math.min(new Date(aEnd).getTime(), new Date(bEnd).getTime()))
  const overlap = (end.getTime() - start.getTime()) / 60000
  return Math.max(0, overlap)
}

/** 检查事件前后是否有足够缓冲时间（15分钟） */
function checkBufferTime(
  event: { startTime: string; endTime: string; id?: string },
  excludeId?: string,
): boolean {
  const events = listScheduleEvents()
  const bufferMs = 15 * 60000
  const eventStart = new Date(event.startTime).getTime()
  const eventEnd = new Date(event.endTime).getTime()

  for (const e of events) {
    if (excludeId && e.id === excludeId) continue
    const eStart = new Date(e.startTime).getTime()
    const eEnd = new Date(e.endTime).getTime()

    // 检查前面事件结束到当前事件开始
    if (eEnd <= eventStart && eventStart - eEnd < bufferMs) return false
    // 检查当前事件结束到后面事件开始
    if (eStart >= eventEnd && eStart - eventEnd < bufferMs) return false
  }

  return true
}

/** 建议替代时间段 */
function suggestAlternativeSlots(
  event: { startTime: string; endTime: string; id?: string; title?: string },
  excludeId?: string,
): Array<{ startTime: string; endTime: string; reason: string }> {
  const slots: Array<{ startTime: string; endTime: string; reason: string }> = []
  const duration = new Date(event.endTime).getTime() - new Date(event.startTime).getTime()
  const baseDate = new Date(event.startTime)
  baseDate.setHours(9, 0, 0, 0) // 从上午9点开始尝试

  // 尝试当天其他时段
  for (let hour = 9; hour <= 17; hour++) {
    const candidateStart = new Date(baseDate)
    candidateStart.setHours(hour, 0, 0, 0)
    const candidateEnd = new Date(candidateStart.getTime() + duration)

    const testEvent = {
      startTime: candidateStart.toISOString(),
      endTime: candidateEnd.toISOString(),
      id: excludeId,
    }

    const conflict = detectConflicts(testEvent, excludeId)
    if (!conflict.hasConflict) {
      slots.push({
        startTime: candidateStart.toISOString(),
        endTime: candidateEnd.toISOString(),
        reason: `当天 ${hour}:00 时段空闲`,
      })
      if (slots.length >= 3) break
    }
  }

  // 尝试次日相同时段
  if (slots.length < 3) {
    const nextDay = new Date(baseDate)
    nextDay.setDate(nextDay.getDate() + 1)
    const originalHour = new Date(event.startTime).getHours()
    nextDay.setHours(originalHour, 0, 0, 0)
    const nextDayEnd = new Date(nextDay.getTime() + duration)

    const testEvent = {
      startTime: nextDay.toISOString(),
      endTime: nextDayEnd.toISOString(),
      id: excludeId,
    }

    const conflict = detectConflicts(testEvent, excludeId)
    if (!conflict.hasConflict) {
      slots.push({
        startTime: nextDay.toISOString(),
        endTime: nextDayEnd.toISOString(),
        reason: '次日相同时段空闲',
      })
    }
  }

  return slots
}

// ===== 自然语言解析（Day 4 新增） =====

export interface ParsedScheduleIntent {
  /** 解析是否成功 */
  success: boolean
  /** 原始文本 */
  originalText: string
  /** 解析出的标题 */
  title?: string
  /** 开始时间 ISO 8601 */
  startTime?: string
  /** 结束时间 ISO 8601 */
  endTime?: string
  /** 是否全天 */
  allDay?: boolean
  /** 地点 */
  location?: string
  /** 参与者 */
  participants?: string[]
  /** 任务类型：event | task | reminder */
  intentType: 'event' | 'task' | 'reminder' | 'unknown'
  /** 分类 */
  category?: ScheduleCategory
  /** 优先级（任务） */
  priority?: TaskPriority
  /** 提醒时间（分钟前） */
  reminderMinutes?: number[]
  /** 解析置信度 0-1 */
  confidence: number
  /** 未解析的部分 */
  unresolved?: string
}

/** 基于规则的中文自然语言日程解析 */
export function parseScheduleIntent(
  text: string,
  referenceDate: Date = new Date(),
): ParsedScheduleIntent {
  const normalized = text.trim()
  const result: ParsedScheduleIntent = {
    success: false,
    originalText: normalized,
    intentType: 'unknown',
    confidence: 0,
  }

  if (!normalized) return result

  // 1. 识别意图类型
  const eventKeywords = ['会议', '约会', '聚餐', '活动', '面试', '评审', '讨论', '约', '见']
  const taskKeywords = ['任务', 'todo', '待办', '完成', '提交', '写', '整理', '准备', '做']
  const reminderKeywords = ['提醒', '记得', '别忘了', '注意', '到期']

  if (eventKeywords.some((k) => normalized.includes(k))) result.intentType = 'event'
  else if (taskKeywords.some((k) => normalized.includes(k))) result.intentType = 'task'
  else if (reminderKeywords.some((k) => normalized.includes(k))) result.intentType = 'reminder'
  else result.intentType = 'event' // default

  // 2. 解析时间
  const timeParse = parseNaturalLanguageTime(normalized, referenceDate)
  if (timeParse.startTime) {
    result.startTime = timeParse.startTime
    result.endTime = timeParse.endTime
    result.allDay = timeParse.allDay
    result.confidence += 0.4
  }

  // 3. 提取标题（去掉时间表达后的剩余部分）
  const title = extractTitle(normalized, timeParse.matchedText)
  if (title) {
    result.title = title
    result.confidence += 0.3
  }

  // 4. 提取地点
  const location = extractLocation(normalized)
  if (location) {
    result.location = location
    result.confidence += 0.1
  }

  // 5. 提取参与者
  const participants = extractParticipants(normalized)
  if (participants.length > 0) {
    result.participants = participants
    result.confidence += 0.1
  }

  // 6. 提取优先级
  if (normalized.includes('紧急') || normalized.includes(' urgent')) result.priority = 'urgent'
  else if (normalized.includes('重要') || normalized.includes('高优先级')) result.priority = 'high'
  else if (normalized.includes('低优先级')) result.priority = 'low'

  // 7. 提取分类
  const categoryMap: Record<string, ScheduleCategory> = {
    '工作': 'work', '会议': 'work', '项目': 'work',
    '学习': 'learning', '读书': 'learning', '课程': 'learning',
    '运动': 'health', '健身': 'health', '跑步': 'health',
    '家庭': 'family', '孩子': 'family', '家人': 'family',
    '社交': 'social', '朋友': 'social', '聚餐': 'social',
    '财务': 'finance', '理财': 'finance',
  }
  for (const [key, cat] of Object.entries(categoryMap)) {
    if (normalized.includes(key)) {
      result.category = cat
      break
    }
  }

  result.success = result.confidence > 0.3 && !!result.title && !!result.startTime
  return result
}

interface TimeParseResult {
  startTime?: string
  endTime?: string
  allDay?: boolean
  matchedText: string[]
}

/** 解析中文自然语言时间 */
function parseNaturalLanguageTime(text: string, ref: Date): TimeParseResult {
  const matchedText: string[] = []
  let targetDate = new Date(ref)
  let hour: number | undefined
  let minute: number | undefined
  let durationMinutes = 60 // default event duration
  let allDay = false

  // 日期解析
  const datePatterns: Array<
    { pattern: RegExp; days: number } | { pattern: RegExp; handler: (m: RegExpMatchArray) => number }
  > = [
    { pattern: /今天/, days: 0 },
    { pattern: /明天/, days: 1 },
    { pattern: /后天/, days: 2 },
    { pattern: /大后天/, days: 3 },
    { pattern: /(\d+)天后/, handler: (m: RegExpMatchArray) => parseInt(m[1]!) },
  ]

  for (const dp of datePatterns) {
    if ('days' in dp) {
      const match = text.match(dp.pattern)
      if (match) {
        targetDate = new Date(ref)
        targetDate.setDate(targetDate.getDate() + dp.days)
        matchedText.push(match[0]!)
        break
      }
    } else {
      const match = text.match(dp.pattern)
      if (match) {
        targetDate = new Date(ref)
        targetDate.setDate(targetDate.getDate() + dp.handler(match))
        matchedText.push(match[0]!)
        break
      }
    }
  }

  // 星期解析
  const weekdayMap: Record<string, number> = { '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 }
  const weekMatch = text.match(/(本|下|上)周([一二三四五六日天])/)
  if (weekMatch) {
    const modifier = weekMatch[1]!
    const targetDay = weekdayMap[weekMatch[2]!]
    if (targetDay !== undefined) {
      const currentDay = ref.getDay()
      let daysDiff = targetDay - currentDay
      if (modifier === '下') daysDiff += 7
      else if (modifier === '上') daysDiff -= 7
      targetDate = new Date(ref)
      targetDate.setDate(targetDate.getDate() + daysDiff)
      matchedText.push(weekMatch[0]!)
    }
  }

  // 下下周
  const nextNextWeekMatch = text.match(/下下周([一二三四五六日天])/)
  if (nextNextWeekMatch) {
    const targetDay = weekdayMap[nextNextWeekMatch[1]!]
    if (targetDay !== undefined) {
      const currentDay = ref.getDay()
      targetDate = new Date(ref)
      targetDate.setDate(targetDate.getDate() + (targetDay - currentDay) + 14)
      matchedText.push(nextNextWeekMatch[0]!)
    }
  }

  // 时间解析 — 带修饰符的优先于纯数字
  const timePatterns = [
    { regex: /(上午|早上|早晨)(\d{1,2})点?(\d{1,2})?分?/, parse: (m: RegExpMatchArray) => ({ h: parseInt(m[2]!), m: m[3] ? parseInt(m[3]) : 0 }) },
    { regex: /(下午|晚上)(\d{1,2})点?(\d{1,2})?分?/, parse: (m: RegExpMatchArray) => ({ h: parseInt(m[2]!) + 12, m: m[3] ? parseInt(m[3]) : 0 }) },
    { regex: /(\d{1,2}):(\d{2})/, parse: (m: RegExpMatchArray) => ({ h: parseInt(m[1]!), m: parseInt(m[2]!) }) },
    { regex: /(\d{1,2})点(\d{1,2})?分?/, parse: (m: RegExpMatchArray) => ({ h: parseInt(m[1]!), m: m[2] ? parseInt(m[2]) : 0 }) },
    { regex: /中午/, parse: () => ({ h: 12, m: 0 }) },
    { regex: /晚上/, parse: () => ({ h: 20, m: 0 }) },
    { regex: /凌晨/, parse: () => ({ h: 3, m: 0 }) },
  ]

  for (const tp of timePatterns) {
    const match = text.match(tp.regex)
    if (match) {
      const parsed = tp.parse(match)
      hour = parsed.h
      minute = parsed.m
      matchedText.push(match[0]!)
      break
    }
  }

  // 全天事件
  if (text.includes('全天') || text.includes('整天')) {
    allDay = true
    matchedText.push('全天')
  }

  // 持续时间
  const durationMatch = text.match(/(\d+)小时/)
  if (durationMatch) {
    durationMinutes = parseInt(durationMatch[1]!) * 60
    matchedText.push(durationMatch[0]!)
  }
  const durationMinMatch = text.match(/(\d+)分钟/)
  if (durationMinMatch) {
    durationMinutes = parseInt(durationMinMatch[1]!)
    matchedText.push(durationMinMatch[0]!)
  }

  // 构建 ISO 时间
  const year = targetDate.getFullYear()
  const month = String(targetDate.getMonth() + 1).padStart(2, '0')
  const day = String(targetDate.getDate()).padStart(2, '0')

  if (allDay) {
    return {
      startTime: `${year}-${month}-${day}T00:00:00`,
      endTime: `${year}-${month}-${day}T23:59:59`,
      allDay: true,
      matchedText,
    }
  }

  if (hour === undefined) {
    // 没有具体时间，默认上午9点或根据上下文推断
    hour = 9
    minute = 0
  }

  const safeMinute = minute ?? 0
  const startTime = `${year}-${month}-${day}T${String(hour).padStart(2, '0')}:${String(safeMinute).padStart(2, '0')}:00`

  // 计算结束时间
  const endDate = new Date(targetDate)
  endDate.setHours(hour, safeMinute + durationMinutes)
  const endYear = endDate.getFullYear()
  const endMonth = String(endDate.getMonth() + 1).padStart(2, '0')
  const endDay = String(endDate.getDate()).padStart(2, '0')
  const endHour = String(endDate.getHours()).padStart(2, '0')
  const endMin = String(endDate.getMinutes()).padStart(2, '0')
  const endTime = `${endYear}-${endMonth}-${endDay}T${endHour}:${endMin}:00`

  return { startTime, endTime, matchedText }
}

/** 从文本中提取标题 */
function extractTitle(text: string, matchedTimeText: string[]): string {
  let title = text
  // 移除已匹配的时间表达
  for (const mt of matchedTimeText) {
    title = title.replace(mt, '')
  }
  // 移除常见前缀/后缀词
  const noiseWords = ['记得', '别忘了', '提醒', '我要', '需要', '准备', '去', '在', '到', '和', '跟']
  for (const word of noiseWords) {
    title = title.replace(new RegExp(word, 'g'), '')
  }
  // 清理
  title = title.replace(/[，,、]/g, ' ').trim()
  // 如果标题为空，使用原始文本的前20字
  if (!title) {
    title = text.replace(/[，,、]/g, ' ').trim().slice(0, 30)
  }
  return title
}

/** 提取地点 */
function extractLocation(text: string): string | undefined {
  const locationPatterns = [
    /在([\u4e00-\u9fa5\w\s]+?)(?:会议室|办公室|家里|家|公司|学校|酒店|餐厅|饭店|咖啡馆|咖啡厅|机场|车站|医院)/,
    /在([\u4e00-\u9fa5\w\s]{2,20})(?:见|等|集合|开会|吃饭|聚餐)/,
    /(?:去|到|在)([\u4e00-\u9fa5\w\s]{2,20})(?:见|等|开会|吃饭|聚餐)/,
  ]
  for (const pattern of locationPatterns) {
    const match = text.match(pattern)
    if (match) return match[1]!.trim()
  }
  return undefined
}

/** 提取参与者 */
function extractParticipants(text: string): string[] {
  const participants: string[] = []
  // 匹配 "和XXX"、"跟XXX"、"与XXX"
  const patterns = [
    /和([\u4e00-\u9fa5\w]{1,10})(?:一起|见面|讨论|吃饭|聚餐|开会)/g,
    /跟([\u4e00-\u9fa5\w]{1,10})(?:一起|见面|讨论|吃饭|聚餐|开会)/g,
    /与([\u4e00-\u9fa5\w]{1,10})(?:一起|见面|讨论|吃饭|聚餐|开会)/g,
    /@([\u4e00-\u9fa5\w]{1,10})/g,
  ]
  for (const pattern of patterns) {
    const matches = text.matchAll(pattern)
    for (const match of matches) {
      const name = match[1]!.trim()
      if (name && !participants.includes(name)) participants.push(name)
    }
  }
  return participants
}
