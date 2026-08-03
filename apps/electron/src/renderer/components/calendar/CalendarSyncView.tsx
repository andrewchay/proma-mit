/**
 * CalendarView - 日历同步视图
 *
 * v0.3 功能实现：日历源管理、同步状态展示、事件聚合、冲突检测、同步日志
 * 布局：顶部标签页导航 + 内容区动态切换
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import {
  CalendarDays,
  RefreshCw,
  Plus,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Clock,
  ArrowRightLeft,
  ArrowDown,
  ArrowUp,
  Cloud,
  Apple,
  HardDrive,
  List,
  GitMerge,
  History,
  Calendar,
  Filter,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  calendarViewStateAtom,
  calendarSourcesAtom,
  calendarSyncEventsAtom,
  calendarSyncLogsAtom,
  type CalendarSource,
  type CalendarViewState,
  type CalendarSyncEvent,
  type CalendarSyncLog,
} from '@/atoms/paa-atoms'

// ===== 常量配置 =====

const PROVIDER_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  google: { label: 'Google Calendar', icon: Cloud, color: 'text-blue-600' },
  apple: { label: 'Apple Calendar', icon: Apple, color: 'text-gray-800' },
  outlook: { label: 'Outlook', icon: Cloud, color: 'text-blue-500' },
  local: { label: '本地日历', icon: HardDrive, color: 'text-green-600' },
  other: { label: '其他', icon: CalendarDays, color: 'text-muted-foreground' },
}

const DIRECTION_LABELS: Record<string, string> = {
  'one-way-in': '单向导入',
  'one-way-out': '单向导出',
  'two-way': '双向同步',
}

const DIRECTION_ICONS: Record<string, React.ElementType> = {
  'one-way-in': ArrowDown,
  'one-way-out': ArrowUp,
  'two-way': ArrowRightLeft,
}

interface CalendarSyncResult {
  sourceId: string
  added: number
  updated: number
  deleted: number
  conflicts: number
  errors: string[]
  timestamp: string
}

interface SyncNotice {
  status: 'success' | 'error' | 'partial'
  message: string
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function summarizeSyncResults(results: CalendarSyncResult[]): SyncNotice {
  const errors = results.flatMap((result) => result.errors)
  const added = results.reduce((sum, result) => sum + result.added, 0)
  const updated = results.reduce((sum, result) => sum + result.updated, 0)
  const deleted = results.reduce((sum, result) => sum + result.deleted, 0)
  const conflicts = results.reduce((sum, result) => sum + result.conflicts, 0)
  const changed = added + updated + deleted

  if (errors.length > 0) {
    return {
      status: changed > 0 ? 'partial' : 'error',
      message: `同步完成但有 ${errors.length} 个问题：${errors[0]}`,
    }
  }

  return {
    status: 'success',
    message: `同步完成：新增 ${added}，更新 ${updated}，删除 ${deleted}，冲突 ${conflicts}`,
  }
}

const SYNC_STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  synced: { label: '已同步', color: 'text-green-600', bg: 'bg-green-50' },
  pending: { label: '待同步', color: 'text-yellow-600', bg: 'bg-yellow-50' },
  conflict: { label: '冲突', color: 'text-red-600', bg: 'bg-red-50' },
  error: { label: '错误', color: 'text-gray-600', bg: 'bg-gray-50' },
}

const LOG_STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  success: { label: '成功', color: 'text-green-600', icon: CheckCircle2 },
  error: { label: '失败', color: 'text-red-600', icon: AlertCircle },
  partial: { label: '部分', color: 'text-yellow-600', icon: Clock },
}

// ===== 工具函数 =====

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  if (isToday) return '今天'
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function groupEventsByDate(events: CalendarSyncEvent[]): Map<string, CalendarSyncEvent[]> {
  const grouped = new Map<string, CalendarSyncEvent[]>()
  for (const event of events) {
    const date = event.startTime.slice(0, 10)
    const list = grouped.get(date) || []
    list.push(event)
    grouped.set(date, list)
  }
  return grouped
}

// ===== 子组件：日历源列表 =====

function SourcesPanel({
  sources,
  syncingId,
  onToggle,
  onSync,
  onDelete,
}: {
  sources: CalendarSource[]
  syncingId: string | null
  onToggle: (id: string, enabled: boolean) => void
  onSync: (id: string) => void
  onDelete: (id: string) => void
}): React.ReactElement {
  if (sources.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <CalendarDays className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p className="text-sm">暂无日历源</p>
        <p className="text-xs mt-1 opacity-60">点击右上角添加第一个日历源</p>
      </div>
    )
  }

  return (
    <div className="space-y-3 max-w-2xl">
      {sources.map((source) => {
        const provider = (PROVIDER_CONFIG[source.provider] ?? PROVIDER_CONFIG.other)!
        const DirectionIcon = (DIRECTION_ICONS[source.syncDirection] ?? ArrowRightLeft)!
        const isSyncing = syncingId === source.id
        return (
          <div
            key={source.id}
            className={`border rounded-lg p-4 hover:shadow-sm transition-shadow ${!source.enabled ? 'opacity-60' : ''}`}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <div className={`w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0 ${provider.color}`}>
                  <provider.icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium text-sm">{source.name}</h3>
                    <Badge variant="secondary" className="text-[10px] h-4 px-1">
                      {provider.label}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground flex-wrap">
                    <span className="flex items-center gap-1">
                      <DirectionIcon className="w-3 h-3" />
                      {DIRECTION_LABELS[source.syncDirection]}
                    </span>
                    {source.lastSyncAt && (
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        上次同步: {new Date(source.lastSyncAt).toLocaleString('zh-CN')}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-3">
                <Switch
                  checked={source.enabled}
                  onCheckedChange={(v) => onToggle(source.id, v)}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  onClick={() => onSync(source.id)}
                  disabled={!source.enabled || isSyncing}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                  onClick={() => onDelete(source.id)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ===== 子组件：事件聚合 =====

function EventsPanel({
  events,
  sources,
}: {
  events: CalendarSyncEvent[]
  sources: CalendarSource[]
}): React.ReactElement {
  const [filterSource, setFilterSource] = React.useState<string>('all')

  const filtered = React.useMemo(() => {
    let result = [...events]
    if (filterSource !== 'all') {
      result = result.filter((e) => e.sourceId === filterSource)
    }
    return result.sort((a, b) => a.startTime.localeCompare(b.startTime))
  }, [events, filterSource])

  const grouped = groupEventsByDate(filtered)
  const sortedDates = Array.from(grouped.keys()).sort()

  if (events.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Calendar className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p className="text-sm">暂无同步事件</p>
        <p className="text-xs mt-1 opacity-60">同步日历源后，事件将显示在这里</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* 筛选器 */}
      <div className="flex items-center gap-2">
        <Filter className="w-4 h-4 text-muted-foreground" />
        <Select value={filterSource} onValueChange={setFilterSource}>
          <SelectTrigger className="h-7 text-xs w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部来源</SelectItem>
            {sources.map((s) => (
              <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Badge variant="secondary" className="text-[10px]">{filtered.length} 个事件</Badge>
      </div>

      {/* 事件列表 */}
      {sortedDates.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">没有符合条件的事件</p>
      ) : (
        sortedDates.map((date) => {
          const dayEvents = grouped.get(date)!
          const isToday = date === new Date().toISOString().slice(0, 10)
          return (
            <div key={date}>
              <h3 className="text-xs font-medium text-muted-foreground mb-2 sticky top-0 bg-background py-1">
                {isToday ? '今天' : new Date(date).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })}
              </h3>
              <div className="space-y-2">
                {dayEvents.map((event) => {
                  const source = sources.find((s) => s.id === event.sourceId)
                  const status = SYNC_STATUS_CONFIG[event.syncStatus] || { label: '未知', color: 'text-gray-600', bg: 'bg-gray-50' }
                  return (
                    <div key={event.id} className="border rounded-lg p-3 hover:bg-muted/30 transition-colors">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium">{event.title}</p>
                            {source && (
                              <Badge variant="secondary" className="text-[10px] h-4 px-1">
                                {source.name}
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                            <span className="flex items-center gap-0.5">
                              <Clock className="w-3 h-3" />
                              {event.startTime.slice(11, 16)} - {event.endTime.slice(11, 16)}
                            </span>
                            {event.location && <span>📍 {event.location}</span>}
                          </div>
                        </div>
                        <Badge variant="secondary" className={`text-[10px] h-4 px-1 ${status.bg} ${status.color}`}>
                          {status.label}
                        </Badge>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}

// ===== 子组件：冲突检测 =====

function ConflictsPanel({
  events,
  sources,
  onResolve,
}: {
  events: CalendarSyncEvent[]
  sources: CalendarSource[]
  onResolve: (id: string, strategy: string) => void
}): React.ReactElement {
  const conflicts = events.filter((e) => e.syncStatus === 'conflict')

  if (conflicts.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <GitMerge className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p className="text-sm">暂无冲突</p>
        <p className="text-xs mt-1 opacity-60">所有日历事件同步正常</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-4">
        <AlertCircle className="w-4 h-4 text-red-500" />
        <span className="text-sm font-medium">发现 {conflicts.length} 个冲突</span>
      </div>
      {conflicts.map((event) => {
        const source = sources.find((s) => s.id === event.sourceId)
        return (
          <div key={event.id} className="border rounded-lg p-4 border-red-200 bg-red-50/30">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{event.title}</p>
                  <Badge variant="secondary" className="text-[10px] h-4 px-1 bg-red-50 text-red-700">
                    冲突
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  来源: {source?.name || '未知'} · {formatDate(event.startTime)}
                </p>
                {event.syncError && (
                  <p className="text-xs text-red-600 mt-1">{event.syncError}</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 mt-3">
              <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => onResolve(event.id, 'local')}>
                保留本地
              </Button>
              <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => onResolve(event.id, 'remote')}>
                保留远程
              </Button>
              <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => onResolve(event.id, 'merge')}>
                合并
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ===== 子组件：同步日志 =====

function LogsPanel({
  logs,
  sources,
}: {
  logs: CalendarSyncLog[]
  sources: CalendarSource[]
}): React.ReactElement {
  if (logs.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <History className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p className="text-sm">暂无同步记录</p>
        <p className="text-xs mt-1 opacity-60">执行同步操作后，日志将显示在这里</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {logs.map((log) => {
        const source = sources.find((s) => s.id === log.sourceId)
        const status = LOG_STATUS_CONFIG[log.status] || { label: '未知', color: 'text-gray-600', icon: AlertCircle }
        const StatusIcon = status.icon
        return (
          <div key={log.id} className="border rounded-lg p-4 hover:bg-muted/30 transition-colors">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <StatusIcon className={`w-4 h-4 ${status.color}`} />
                  <p className="text-sm font-medium">{source?.name || '未知源'}</p>
                  <Badge variant="secondary" className={`text-[10px] h-4 px-1 ${status.color}`}>
                    {status.label}
                  </Badge>
                </div>
                <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                  <span>处理: {log.eventsProcessed}</span>
                  <span className="text-green-600">新增: {log.eventsCreated}</span>
                  <span className="text-blue-600">更新: {log.eventsUpdated}</span>
                  <span>跳过: {log.eventsSkipped}</span>
                </div>
                {log.errors.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {log.errors.map((err, i) => (
                      <p key={i} className="text-xs text-red-600">{err}</p>
                    ))}
                  </div>
                )}
              </div>
              <div className="text-right text-xs text-muted-foreground">
                <p>{log.startedAt.slice(0, 16).replace('T', ' ')}</p>
                {log.completedAt && (
                  <p>完成: {log.completedAt.slice(0, 16).replace('T', ' ')}</p>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ===== 主组件 =====

export function CalendarView(): React.ReactElement {
  const [viewState, setViewState] = useAtom(calendarViewStateAtom)
  const [sources, setSources] = useAtom(calendarSourcesAtom)
  const [events, setEvents] = useAtom(calendarSyncEventsAtom)
  const [logs, setLogs] = useAtom(calendarSyncLogsAtom)

  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [syncingId, setSyncingId] = React.useState<string | null>(null)
  const [syncNotice, setSyncNotice] = React.useState<SyncNotice | null>(null)
  const [newSource, setNewSource] = React.useState({
    name: '',
    provider: 'google' as CalendarSource['provider'],
    syncDirection: 'two-way' as CalendarSource['syncDirection'],
  })

  const handleCreate = async () => {
    if (!newSource.name.trim()) return
    try {
      const source = await window.electronAPI.paa.calendarSync.createSource({
        name: newSource.name.trim(),
        provider: newSource.provider,
        config: { credentialsPath: '' },
        enabled: true,
        syncDirection: newSource.syncDirection,
      })
      setSources((prev) => [...prev, source as CalendarSource])
      setNewSource({ name: '', provider: 'google', syncDirection: 'two-way' })
      setDialogOpen(false)
    } catch (err) {
      console.error('创建日历源失败:', err)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      const success = await window.electronAPI.paa.calendarSync.deleteSource(id)
      if (success) {
        setSources((prev) => prev.filter((s) => s.id !== id))
      }
    } catch (err) {
      console.error('删除日历源失败:', err)
    }
  }

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      const updated = await window.electronAPI.paa.calendarSync.updateSource(id, { enabled })
      if (updated) {
        setSources((prev) => prev.map((s) => (s.id === id ? (updated as CalendarSource) : s)))
      }
    } catch (err) {
      console.error('更新日历源失败:', err)
    }
  }

  const handleSync = async (id: string) => {
    setSyncingId(id)
    setSyncNotice(null)
    setViewState((s) => ({ ...s, syncStatus: 'syncing' }))
    try {
      const result = await window.electronAPI.paa.calendarSync.syncSource(id) as CalendarSyncResult
      const updatedSources = await window.electronAPI.paa.calendarSync.listSources()
      setSources(updatedSources as CalendarSource[])
      const notice = summarizeSyncResults([result])
      const sourceName = sources.find((source) => source.id === id)?.name || '日历源'
      setSyncNotice(notice)
      setLogs((prev) => [
        {
          id: `sync-${id}-${result.timestamp}`,
          sourceId: id,
          sourceName,
          direction: 'two-way',
          status: notice.status,
          eventsProcessed: result.added + result.updated + result.deleted + result.conflicts,
          eventsCreated: result.added,
          eventsUpdated: result.updated,
          eventsSkipped: result.deleted,
          errors: result.errors,
          startedAt: result.timestamp,
          completedAt: new Date().toISOString(),
        },
        ...prev,
      ])
      setViewState((s) => ({ ...s, syncStatus: notice.status === 'error' ? 'error' : 'idle' }))
    } catch (err) {
      console.error('同步失败:', err)
      setSyncNotice({ status: 'error', message: `同步失败：${getErrorMessage(err)}` })
      setViewState((s) => ({ ...s, syncStatus: 'error' }))
    } finally {
      setSyncingId(null)
    }
  }

  const handleSyncAll = async () => {
    setSyncNotice(null)
    if (enabledCount === 0) {
      setSyncNotice({
        status: 'error',
        message: sources.length === 0
          ? '还没有日历源，请先点击右上角“添加源”创建一个日历源'
          : '没有启用的日历源，请先打开至少一个日历源的开关',
      })
      setViewState((s) => ({ ...s, syncStatus: 'idle' }))
      return
    }
    setViewState((s) => ({ ...s, syncStatus: 'syncing' }))
    try {
      const results = await window.electronAPI.paa.calendarSync.syncAll() as CalendarSyncResult[]
      const updatedSources = await window.electronAPI.paa.calendarSync.listSources()
      setSources(updatedSources as CalendarSource[])
      const notice = summarizeSyncResults(results)
      setSyncNotice(notice)
      setLogs((prev) => [
        ...results.map((result) => {
          const source = sources.find((item) => item.id === result.sourceId)
          const sourceNotice = summarizeSyncResults([result])
          return {
            id: `sync-${result.sourceId}-${result.timestamp}`,
            sourceId: result.sourceId,
            sourceName: source?.name || '日历源',
            direction: 'two-way' as const,
            status: sourceNotice.status,
            eventsProcessed: result.added + result.updated + result.deleted + result.conflicts,
            eventsCreated: result.added,
            eventsUpdated: result.updated,
            eventsSkipped: result.deleted,
            errors: result.errors,
            startedAt: result.timestamp,
            completedAt: new Date().toISOString(),
          }
        }),
        ...prev,
      ])
      setViewState((s) => ({ ...s, syncStatus: notice.status === 'error' ? 'error' : 'idle' }))
    } catch (err) {
      console.error('全部同步失败:', err)
      setSyncNotice({ status: 'error', message: `全部同步失败：${getErrorMessage(err)}` })
      setViewState((s) => ({ ...s, syncStatus: 'error' }))
    }
  }

  const handleResolveConflict = async (eventId: string, strategy: string) => {
    try {
      await window.electronAPI.paa.calendarSync.resolveConflict(eventId, strategy)
      setEvents((prev) =>
        prev.map((e) => (e.id === eventId ? { ...e, syncStatus: 'synced' as const, syncError: undefined } : e))
      )
    } catch (err) {
      console.error('解决冲突失败:', err)
    }
  }

  const enabledCount = sources.filter((s) => s.enabled).length
  const viewMode = viewState.viewMode || 'sources'

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 头部 */}
      <div className="relative z-[51] titlebar-no-drag flex items-center justify-between px-6 py-3 border-b shrink-0">
        <div className="flex items-center gap-3">
          <CalendarDays className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-semibold">日历同步</h1>
          <Badge variant="secondary" className="text-[10px] h-4">
            {enabledCount}/{sources.length} 启用
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            onClick={handleSyncAll}
            disabled={viewState.syncStatus === 'syncing'}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${viewState.syncStatus === 'syncing' ? 'animate-spin' : ''}`} />
            全部同步
          </Button>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="h-7 text-xs">
                <Plus className="w-3.5 h-3.5 mr-1" />
                添加源
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>添加日历源</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 pt-2">
                <div>
                  <label className="text-xs font-medium mb-1 block">名称</label>
                  <Input
                    value={newSource.name}
                    onChange={(e) => setNewSource((s) => ({ ...s, name: e.target.value }))}
                    placeholder="例如：Google 工作日历"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block">提供商</label>
                  <Select
                    value={newSource.provider}
                    onValueChange={(v) => setNewSource((s) => ({ ...s, provider: v as CalendarSource['provider'] }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(PROVIDER_CONFIG).map(([key, config]) => (
                        <SelectItem key={key} value={key}>
                          {config.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block">同步方向</label>
                  <Select
                    value={newSource.syncDirection}
                    onValueChange={(v) => setNewSource((s) => ({ ...s, syncDirection: v as CalendarSource['syncDirection'] }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(DIRECTION_LABELS).map(([key, label]) => (
                        <SelectItem key={key} value={key}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={handleCreate} className="w-full" disabled={!newSource.name.trim()}>
                  确认添加
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* 标签页导航 */}
      <div className="px-6 py-2 border-b shrink-0">
        <Tabs
          value={viewMode}
          onValueChange={(v) => setViewState((s) => ({ ...s, viewMode: v as CalendarViewState['viewMode'] }))}
        >
          <TabsList className="h-7">
            <TabsTrigger value="sources" className="text-xs px-3 py-1 flex items-center gap-1.5">
              <Cloud className="w-3 h-3" />
              日历源
            </TabsTrigger>
            <TabsTrigger value="events" className="text-xs px-3 py-1 flex items-center gap-1.5">
              <Calendar className="w-3 h-3" />
              事件聚合
            </TabsTrigger>
            <TabsTrigger value="conflicts" className="text-xs px-3 py-1 flex items-center gap-1.5">
              <GitMerge className="w-3 h-3" />
              冲突
              {events.filter((e) => e.syncStatus === 'conflict').length > 0 && (
                <Badge variant="destructive" className="text-[10px] h-4 px-1 ml-1">
                  {events.filter((e) => e.syncStatus === 'conflict').length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="logs" className="text-xs px-3 py-1 flex items-center gap-1.5">
              <History className="w-3 h-3" />
              同步日志
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {syncNotice && (
        <div className={`px-6 py-2 text-xs border-b flex items-center gap-2 ${
          syncNotice.status === 'success'
            ? 'bg-green-50 text-green-700 border-green-200'
            : syncNotice.status === 'partial'
              ? 'bg-amber-50 text-amber-700 border-amber-200'
              : 'bg-red-50 text-red-700 border-red-200'
        }`}>
          {syncNotice.status === 'success' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
          <span>{syncNotice.message}</span>
          <button
            type="button"
            onClick={() => setSyncNotice(null)}
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            关闭
          </button>
        </div>
      )}

      <ScrollArea className="flex-1">
        <div className="p-6">
          {viewMode === 'sources' && (
            <SourcesPanel
              sources={sources}
              syncingId={syncingId}
              onToggle={handleToggle}
              onSync={handleSync}
              onDelete={handleDelete}
            />
          )}
          {viewMode === 'events' && (
            <EventsPanel events={events} sources={sources} />
          )}
          {viewMode === 'conflicts' && (
            <ConflictsPanel events={events} sources={sources} onResolve={handleResolveConflict} />
          )}
          {viewMode === 'logs' && (
            <LogsPanel logs={logs} sources={sources} />
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
