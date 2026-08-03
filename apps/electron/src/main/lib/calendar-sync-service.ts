/**
 * 日历同步服务 — Calendar Sync Service
 *
 * 负责与外部日历系统同步的核心逻辑：
 * - 多日历源配置（Google Calendar / Apple Calendar / Outlook / 本地日历）
 * - 双向同步（外部 → PAA，PAA → 外部）
 * - 冲突检测与解决策略
 * - 同步状态跟踪与增量同步
 * - 数据持久化到 ~/.paa/calendar/sync/
 *
 * v0.1 占位：定义接口和空实现，后续迭代填充业务逻辑。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getCalendarDir } from './config-paths'

// ===== 类型定义 =====

export interface CalendarSource {
  id: string
  name: string // 显示名称，如"Google 工作日历"
  provider: 'google' | 'apple' | 'outlook' | 'local' | 'other'
  // v0.1 占位：凭据配置
  config: CalendarSourceConfig
  enabled: boolean
  syncDirection: 'one-way-in' | 'one-way-out' | 'two-way'
  lastSyncAt?: string
  createdAt: string
}

export interface CalendarSourceConfig {
  // OAuth / API 相关配置
  clientId?: string
  // 敏感信息通过 Electron safeStorage 加密存储
  credentialsPath: string
  // 日历 ID（Google Calendar 等）
  calendarId?: string
  // 本地日历文件路径（.ics 等）
  localPath?: string
}

export interface CalendarSyncEvent {
  id: string
  sourceId: string
  externalId: string // 外部日历中的事件 ID
  title: string
  startTime: string
  endTime: string
  allDay?: boolean
  location?: string
  description?: string
  // 同步元数据
  syncStatus: 'synced' | 'pending' | 'conflict' | 'error'
  syncError?: string
  lastSyncedAt?: string
  // 与 PAA 日程的关联
  scheduleEventId?: string
}

export interface SyncResult {
  sourceId: string
  added: number
  updated: number
  deleted: number
  conflicts: number
  errors: string[]
  timestamp: string
}

// ===== 数据文件路径 =====

function getSourcesPath(): string {
  return join(getCalendarDir(), 'sync', 'sources.json')
}

function getSyncLogPath(): string {
  return join(getCalendarDir(), 'sync', 'sync-log.jsonl')
}

function ensureSources(): CalendarSource[] {
  const path = getSourcesPath()
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as CalendarSource[]
  } catch {
    return []
  }
}

function saveSources(sources: CalendarSource[]): void {
  const path = getSourcesPath()
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(sources, null, 2), 'utf-8')
}

// ===== 日历源管理 =====

export function listCalendarSources(): CalendarSource[] {
  return ensureSources()
}

export function getCalendarSource(id: string): CalendarSource | null {
  return ensureSources().find((s) => s.id === id) ?? null
}

export function createCalendarSource(
  input: Omit<CalendarSource, 'id' | 'createdAt' | 'lastSyncAt'>,
): CalendarSource {
  const source: CalendarSource = {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  }
  const sources = ensureSources()
  sources.push(source)
  saveSources(sources)
  return source
}

export function updateCalendarSource(id: string, patch: Partial<CalendarSource>): CalendarSource | null {
  const sources = ensureSources()
  const idx = sources.findIndex((s) => s.id === id)
  if (idx === -1) return null
  const updated = { ...sources[idx], ...patch } as CalendarSource
  sources[idx] = updated
  saveSources(sources)
  return sources[idx]!
}

export function deleteCalendarSource(id: string): boolean {
  const sources = ensureSources()
  const filtered = sources.filter((s) => s.id !== id)
  if (filtered.length === sources.length) return false
  saveSources(filtered)
  return true
}

// ===== 同步操作 =====

export async function syncCalendarSource(_sourceId: string): Promise<SyncResult> {
  // v0.1 占位：实际同步逻辑后续实现
  return {
    sourceId: _sourceId,
    added: 0,
    updated: 0,
    deleted: 0,
    conflicts: 0,
    errors: ['v0.1 占位：日历同步功能尚未实现'],
    timestamp: new Date().toISOString(),
  }
}

export async function syncAllCalendarSources(): Promise<SyncResult[]> {
  const sources = ensureSources().filter((s) => s.enabled)
  const results: SyncResult[] = []
  for (const source of sources) {
    results.push(await syncCalendarSource(source.id))
  }
  return results
}

// ===== 冲突解决 =====

export interface ConflictResolution {
  eventId: string
  strategy: 'use-external' | 'use-local' | 'merge' | 'manual'
  resolution?: string
}

export async function resolveSyncConflict(
  _eventId: string,
  _strategy: ConflictResolution['strategy'],
): Promise<boolean> {
  // v0.1 占位
  return false
}

// ===== 双向同步与冲突解决（Day 11 新增） =====

export interface SyncEventDiff {
  eventId: string
  externalEvent: CalendarBridgeEvent
  localEvent: {
    title: string
    startTime: string
    endTime: string
    allDay?: boolean
    location?: string
    description?: string
  }
  differences: Array<{ field: string; externalValue: unknown; localValue: unknown }>
  lastModifiedExternal: string
  lastModifiedLocal: string
}

/** 检测外部事件与本地事件的冲突 */
export function detectEventConflicts(
  externalEvents: CalendarBridgeEvent[],
  localEvents: Array<{
    id: string
    title: string
    startTime: string
    endTime: string
    allDay?: boolean
    location?: string
    description?: string
    updatedAt?: string
  }>,
): SyncEventDiff[] {
  const conflicts: SyncEventDiff[] = []

  for (const ext of externalEvents) {
    const local = localEvents.find((l) =>
      l.title === ext.title &&
      Math.abs(new Date(l.startTime).getTime() - new Date(ext.startTime).getTime()) < 60000,
    )

    if (!local) continue

    const differences: SyncEventDiff['differences'] = []

    if (local.title !== ext.title) {
      differences.push({ field: 'title', externalValue: ext.title, localValue: local.title })
    }
    if (local.startTime !== ext.startTime) {
      differences.push({ field: 'startTime', externalValue: ext.startTime, localValue: local.startTime })
    }
    if (local.endTime !== ext.endTime) {
      differences.push({ field: 'endTime', externalValue: ext.endTime, localValue: local.endTime })
    }
    if (local.location !== ext.location) {
      differences.push({ field: 'location', externalValue: ext.location, localValue: local.location })
    }
    if (local.description !== ext.description) {
      differences.push({ field: 'description', externalValue: ext.description, localValue: local.description })
    }

    if (differences.length > 0) {
      conflicts.push({
        eventId: local.id,
        externalEvent: ext,
        localEvent: {
          title: local.title,
          startTime: local.startTime,
          endTime: local.endTime,
          allDay: local.allDay,
          location: local.location,
          description: local.description,
        },
        differences,
        lastModifiedExternal: ext.startTime, // 简化：使用开始时间作为修改时间
        lastModifiedLocal: local.updatedAt || local.startTime,
      })
    }
  }

  return conflicts
}

/** 自动解决冲突（基于策略） */
export function autoResolveConflict(
  diff: SyncEventDiff,
  strategy: 'latest-wins' | 'external-priority' | 'local-priority',
): {
  resolved: boolean
  winner: 'external' | 'local'
  mergedEvent: CalendarBridgeEvent
} {
  let winner: 'external' | 'local'

  switch (strategy) {
    case 'latest-wins':
      winner = diff.lastModifiedExternal > diff.lastModifiedLocal ? 'external' : 'local'
      break
    case 'external-priority':
      winner = 'external'
      break
    case 'local-priority':
      winner = 'local'
      break
    default:
      winner = 'external'
  }

  const base = winner === 'external' ? diff.externalEvent : {
    ...diff.externalEvent,
    title: diff.localEvent.title,
    startTime: diff.localEvent.startTime,
    endTime: diff.localEvent.endTime,
    location: diff.localEvent.location,
    description: diff.localEvent.description,
    allDay: diff.localEvent.allDay,
  }

  return {
    resolved: true,
    winner,
    mergedEvent: base,
  }
}

/** 同步状态追踪 */
export interface SyncState {
  sourceId: string
  status: 'idle' | 'syncing' | 'error' | 'conflict'
  lastSyncAt?: string
  nextSyncAt?: string
  syncedEvents: number
  pendingEvents: number
  conflictEvents: number
  errorMessage?: string
}

const syncStates: Map<string, SyncState> = new Map()

export function getSyncState(sourceId: string): SyncState {
  return syncStates.get(sourceId) || {
    sourceId,
    status: 'idle',
    syncedEvents: 0,
    pendingEvents: 0,
    conflictEvents: 0,
  }
}

export function updateSyncState(sourceId: string, patch: Partial<SyncState>): SyncState {
  const current = getSyncState(sourceId)
  const updated = { ...current, ...patch }
  syncStates.set(sourceId, updated)
  return updated
}

/** 执行双向同步 */
export async function performTwoWaySync(
  sourceId: string,
  externalEvents: CalendarBridgeEvent[],
  localEvents: Array<{
    id: string
    title: string
    startTime: string
    endTime: string
    allDay?: boolean
    location?: string
    description?: string
    updatedAt?: string
  }>,
  strategy: 'latest-wins' | 'external-priority' | 'local-priority' = 'latest-wins',
): Promise<{
  toAdd: CalendarBridgeEvent[]
  toUpdate: Array<{ external: CalendarBridgeEvent; localId: string }>
  toDelete: string[]
  conflicts: SyncEventDiff[]
  resolved: Array<{ localId: string; winner: 'external' | 'local' }>
}> {
  updateSyncState(sourceId, { status: 'syncing' })

  const source = getCalendarSource(sourceId)
  const direction = source?.syncDirection || 'two-way'

  // 找出需要添加的外部事件（本地不存在）
  const toAdd = externalEvents.filter((ext) =>
    !localEvents.some((l) =>
      l.title === ext.title &&
      Math.abs(new Date(l.startTime).getTime() - new Date(ext.startTime).getTime()) < 60000,
    ),
  )

  // 找出冲突
  const conflicts = detectEventConflicts(externalEvents, localEvents)

  // 自动解决冲突
  const resolved: Array<{ localId: string; winner: 'external' | 'local' }> = []
  for (const conflict of conflicts) {
    if (direction === 'two-way') {
      const result = autoResolveConflict(conflict, strategy)
      resolved.push({ localId: conflict.eventId, winner: result.winner })
    }
  }

  // 找出需要更新的外部事件（本地存在但无冲突）
  const toUpdate = externalEvents
    .filter((ext) =>
      localEvents.some((l) =>
        l.title === ext.title &&
        Math.abs(new Date(l.startTime).getTime() - new Date(ext.startTime).getTime()) < 60000,
      ) &&
      !conflicts.some((c) => c.externalEvent.id === ext.id),
    )
    .map((ext) => ({
      external: ext,
      localId: localEvents.find((l) =>
        l.title === ext.title &&
        Math.abs(new Date(l.startTime).getTime() - new Date(ext.startTime).getTime()) < 60000,
      )!.id,
    }))

  // 找出需要删除的本地事件（外部已删除）
  const toDelete = localEvents
    .filter((l) =>
      !externalEvents.some((ext) =>
        l.title === ext.title &&
        Math.abs(new Date(l.startTime).getTime() - new Date(ext.startTime).getTime()) < 60000,
      ),
    )
    .map((l) => l.id)

  updateSyncState(sourceId, {
    status: conflicts.length > 0 ? 'conflict' : 'idle',
    lastSyncAt: new Date().toISOString(),
    syncedEvents: toAdd.length + toUpdate.length,
    pendingEvents: toAdd.length,
    conflictEvents: conflicts.length,
  })

  return { toAdd, toUpdate, toDelete, conflicts, resolved }
}

// ===== 工具函数 =====

export function getLastSyncTime(sourceId: string): string | null {
  const source = getCalendarSource(sourceId)
  return source?.lastSyncAt ?? null
}

export function isSyncNeeded(sourceId: string, intervalMinutes: number = 15): boolean {
  const lastSync = getLastSyncTime(sourceId)
  if (!lastSync) return true
  const last = new Date(lastSync).getTime()
  const now = Date.now()
  return now - last > intervalMinutes * 60000
}

// ===== EventKit / 日历桥接（Day 10 新增） =====

export interface CalendarBridgeEvent {
  id: string
  title: string
  startTime: string
  endTime: string
  allDay?: boolean
  location?: string
  description?: string
  calendarName?: string
  isRecurring?: boolean
}

export interface CalendarBridge {
  name: string
  isAvailable: boolean
  listCalendars(): Promise<Array<{ id: string; name: string; color?: string }>>
  listEvents(calendarId: string, startDate: string, endDate: string): Promise<CalendarBridgeEvent[]>
}

/** macOS EventKit 桥接（占位实现） */
export const macOSCalendarBridge: CalendarBridge = {
  name: 'macOS EventKit',
  isAvailable: process.platform === 'darwin',
  async listCalendars() {
    // v0.1 占位：实际实现需要 N-API 绑定或 node-calendar-kit
    // 返回模拟数据用于测试
    if (process.platform !== 'darwin') return []
    return [
      { id: 'home', name: '家庭', color: '#FF9500' },
      { id: 'work', name: '工作', color: '#007AFF' },
    ]
  },
  async listEvents(_calendarId: string, _startDate: string, _endDate: string) {
    // v0.1 占位
    return []
  },
}

/** .ics 文件解析器 */
export function parseICSContent(icsContent: string): CalendarBridgeEvent[] {
  const events: CalendarBridgeEvent[] = []
  const vevents = icsContent.split('BEGIN:VEVENT').slice(1)

  for (const vevent of vevents) {
    const endIdx = vevent.indexOf('END:VEVENT')
    if (endIdx === -1) continue
    const content = vevent.slice(0, endIdx)

    const getField = (name: string): string | undefined => {
      const match = content.match(new RegExp(`${name}[^:]*:(.+?)(?:\\r?\\n|$)`, 'm'))
      return match?.[1]?.trim()
    }

    const uid = getField('UID') || randomUUID()
    const summary = getField('SUMMARY') || '(无标题)'
    const dtstart = getField('DTSTART')
    const dtend = getField('DTEND')
    const location = getField('LOCATION')
    const description = getField('DESCRIPTION')

    if (!dtstart) continue

    // 解析 ICS 日期格式
    const parseDate = (d: string): string => {
      if (d.includes('T')) {
        // 20240115T100000Z
        const year = d.slice(0, 4)
        const month = d.slice(4, 6)
        const day = d.slice(6, 8)
        const hour = d.slice(9, 11)
        const min = d.slice(11, 13)
        const sec = d.slice(13, 15)
        return `${year}-${month}-${day}T${hour}:${min}:${sec}${d.endsWith('Z') ? 'Z' : ''}`
      } else {
        // 20240115 (all-day)
        const year = d.slice(0, 4)
        const month = d.slice(4, 6)
        const day = d.slice(6, 8)
        return `${year}-${month}-${day}T00:00:00`
      }
    }

    const allDay = !dtstart.includes('T')
    const startTime = parseDate(dtstart)
    const endTime = dtend ? parseDate(dtend) : startTime

    events.push({
      id: uid,
      title: summary,
      startTime,
      endTime,
      allDay,
      location,
      description,
    })
  }

  return events
}

/** 从 .ics 文件读取日历事件 */
export function readICSFile(filePath: string): CalendarBridgeEvent[] {
  if (!existsSync(filePath)) return []
  try {
    const content = readFileSync(filePath, 'utf-8')
    return parseICSContent(content)
  } catch {
    return []
  }
}

/** 获取所有可用的日历桥接 */
export function getAvailableCalendarBridges(): CalendarBridge[] {
  return [macOSCalendarBridge]
}

/** 将外部日历事件转换为 PAA 日程事件格式 */
export function convertToScheduleEvent(event: CalendarBridgeEvent): {
  title: string
  startTime: string
  endTime: string
  allDay?: boolean
  location?: string
  description?: string
} {
  return {
    title: event.title,
    startTime: event.startTime,
    endTime: event.endTime,
    allDay: event.allDay,
    location: event.location,
    description: event.description,
  }
}
