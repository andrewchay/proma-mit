/**
 * 工作模块 Atoms（项目管理 / 日程管家 / 日历同步）
 *
 * 由 ~/LLM/PAA 的 renderer/atoms/paa-atoms.ts 中 schedule / calendar 两个
 * 子模块的 atoms 迁移而来，用于跨组件状态共享。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

// ===== 日程管家 =====

export interface ScheduleEvent {
  id: string
  title: string
  description?: string
  startTime: string
  endTime: string
  allDay?: boolean
  location?: string
  category?: string
  tags?: string[]
  reminderMinutes?: number[]
  recurrence?: {
    frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
    interval?: number
    count?: number
    until?: string
    byDay?: string[]
  }
  source?: 'manual' | 'calendar-sync' | 'agent'
  createdAt: string
  updatedAt: string
}

export interface ScheduleTask {
  id: string
  title: string
  description?: string
  status: 'todo' | 'in-progress' | 'review' | 'done'
  priority: 'low' | 'medium' | 'high' | 'urgent'
  dueDate?: string
  dueTime?: string
  category?: string
  tags?: string[]
  eventId?: string
  createdAt: string
  updatedAt: string
}

export interface ScheduleViewState {
  viewMode: 'day' | 'week' | 'month' | 'list'
  selectedDate: string // YYYY-MM-DD
  selectedCategory?: string
  searchQuery?: string
  showTasks: boolean
}

export const scheduleViewStateAtom = atomWithStorage<ScheduleViewState>('paa-schedule-view', {
  viewMode: 'week',
  selectedDate: new Date().toISOString().slice(0, 10),
  showTasks: true,
})

/** 日程事件列表（从主进程加载） */
export const scheduleEventsAtom = atom<ScheduleEvent[]>([])

/** 日程任务列表（从主进程加载） */
export const scheduleTasksAtom = atom<ScheduleTask[]>([])

/** 冲突检测结果 */
export const scheduleConflictsAtom = atom<{
  hasConflict: boolean
  conflicts: Array<{
    eventId: string
    eventTitle: string
    startTime: string
    endTime: string
  }>
} | null>(null)

// ===== 日历同步 =====

export interface CalendarSource {
  id: string
  name: string
  provider: 'google' | 'apple' | 'outlook' | 'local' | 'other'
  enabled: boolean
  syncDirection: 'one-way-in' | 'one-way-out' | 'two-way'
  lastSyncAt?: string
  createdAt: string
}

export interface CalendarSyncEvent {
  id: string
  sourceId: string
  externalId: string
  title: string
  startTime: string
  endTime: string
  allDay?: boolean
  location?: string
  description?: string
  syncStatus: 'synced' | 'pending' | 'conflict' | 'error'
  syncError?: string
  lastSyncedAt?: string
  scheduleEventId?: string
}

export interface CalendarViewState {
  selectedSourceId?: string
  syncStatus: 'idle' | 'syncing' | 'error'
  viewMode?: 'sources' | 'events' | 'conflicts' | 'logs'
}

export const calendarViewStateAtom = atomWithStorage<CalendarViewState>('paa-calendar-view', { syncStatus: 'idle', viewMode: 'sources' })
export const calendarSourcesAtom = atom<CalendarSource[]>([])
export const calendarSyncEventsAtom = atom<CalendarSyncEvent[]>([])

// 同步日志
export interface CalendarSyncLog {
  id: string
  sourceId: string
  sourceName: string
  direction: 'import' | 'export' | 'two-way'
  status: 'success' | 'error' | 'partial'
  eventsProcessed: number
  eventsCreated: number
  eventsUpdated: number
  eventsSkipped: number
  errors: string[]
  startedAt: string
  completedAt?: string
}

export const calendarSyncLogsAtom = atom<CalendarSyncLog[]>([])
