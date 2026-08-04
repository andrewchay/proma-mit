/**
 * ScheduleView - 日程管家主视图
 *
 * 布局：Header（月份导航 + 视图切换 + 新建按钮）
 *       ├── 左侧：月视图日历网格（7x6）
 *       └── 右侧：任务看板（Kanban）+ 选中日期详情
 *
 * Day 12 实现：日历视图 + 任务看板
 * Day 13 实现：自然语言创建 + 冲突检测
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Plus,
  LayoutGrid,
  List,
  Clock,
  CheckCircle2,
  Circle,
  AlertCircle,
  RotateCcw,
  RefreshCw,
  Monitor,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  scheduleViewStateAtom,
  scheduleEventsAtom,
  scheduleTasksAtom,
  type ScheduleEvent,
  type ScheduleTask,
} from '@/atoms/paa-atoms'
import { EventCreatePanel } from './EventCreatePanel'

// ===== 工具函数 =====

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay()
}

function formatMonthLabel(year: number, month: number): string {
  return `${year}年${month + 1}月`
}

function isSameDay(a: string, b: string): boolean {
  return a.slice(0, 10) === b.slice(0, 10)
}

function getDateKey(date: Date): string {
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-')
}

function getLocalDateFromIso(isoString: string): string {
  const d = new Date(isoString)
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-')
}

function formatLocalTime(isoString: string): string {
  const d = new Date(isoString)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function getEventsForDate(events: ScheduleEvent[], dateKey: string): ScheduleEvent[] {
  return events.filter((e) => {
    const start = getLocalDateFromIso(e.startTime)
    const end = getLocalDateFromIso(e.endTime)
    return dateKey >= start && dateKey <= end
  })
}

function getTasksForDate(tasks: ScheduleTask[], dateKey: string): ScheduleTask[] {
  return tasks.filter((t) => t.dueDate === dateKey)
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']

const CATEGORY_COLORS: Record<string, string> = {
  work: 'bg-blue-500',
  personal: 'bg-green-500',
  family: 'bg-pink-500',
  health: 'bg-red-500',
  learning: 'bg-purple-500',
  social: 'bg-yellow-500',
  finance: 'bg-emerald-500',
  other: 'bg-gray-500',
}

const STATUS_CONFIG: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  todo: { label: '待办', icon: <Circle size={14} />, color: 'text-muted-foreground' },
  'in-progress': { label: '进行中', icon: <Clock size={14} />, color: 'text-blue-500' },
  review: { label: '待审核', icon: <AlertCircle size={14} />, color: 'text-orange-500' },
  done: { label: '已完成', icon: <CheckCircle2 size={14} />, color: 'text-green-500' },
}

const PRIORITY_COLORS: Record<string, string> = {
  low: 'border-l-gray-400',
  medium: 'border-l-blue-400',
  high: 'border-l-orange-400',
  urgent: 'border-l-red-500',
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ===== 子组件：日历网格 =====

interface CalendarGridProps {
  year: number
  month: number
  selectedDate: string
  events: ScheduleEvent[]
  tasks: ScheduleTask[]
  onSelectDate: (date: string) => void
}

function CalendarGrid({ year, month, selectedDate, events, tasks, onSelectDate }: CalendarGridProps): React.ReactElement {
  const daysInMonth = getDaysInMonth(year, month)
  const firstDay = getFirstDayOfMonth(year, month)
  const today = getDateKey(new Date())

  // 计算需要显示的上月天数
  const prevMonthDays = firstDay === 0 ? 6 : firstDay - 1 // 周一开头调整为周日开头
  const totalCells = Math.ceil((daysInMonth + prevMonthDays) / 7) * 7

  const cells: Array<{
    dateKey: string | null
    day: number | null
    isCurrentMonth: boolean
    isToday: boolean
    isSelected: boolean
    dayEvents: ScheduleEvent[]
    dayTasks: ScheduleTask[]
  }> = []

  // 上月填充
  const prevMonth = month === 0 ? 11 : month - 1
  const prevYear = month === 0 ? year - 1 : year
  const daysInPrevMonth = getDaysInMonth(prevYear, prevMonth)
  for (let i = prevMonthDays - 1; i >= 0; i--) {
    const day = daysInPrevMonth - i
    const date = new Date(prevYear, prevMonth, day)
    const dateKey = getDateKey(date)
    cells.push({
      dateKey,
      day,
      isCurrentMonth: false,
      isToday: dateKey === today,
      isSelected: dateKey === selectedDate,
      dayEvents: getEventsForDate(events, dateKey),
      dayTasks: getTasksForDate(tasks, dateKey),
    })
  }

  // 当月
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day)
    const dateKey = getDateKey(date)
    cells.push({
      dateKey,
      day,
      isCurrentMonth: true,
      isToday: dateKey === today,
      isSelected: dateKey === selectedDate,
      dayEvents: getEventsForDate(events, dateKey),
      dayTasks: getTasksForDate(tasks, dateKey),
    })
  }

  // 下月填充
  const remaining = totalCells - cells.length
  const nextMonth = month === 11 ? 0 : month + 1
  const nextYear = month === 11 ? year + 1 : year
  for (let day = 1; day <= remaining; day++) {
    const date = new Date(nextYear, nextMonth, day)
    const dateKey = getDateKey(date)
    cells.push({
      dateKey,
      day,
      isCurrentMonth: false,
      isToday: dateKey === today,
      isSelected: dateKey === selectedDate,
      dayEvents: getEventsForDate(events, dateKey),
      dayTasks: getTasksForDate(tasks, dateKey),
    })
  }

  return (
    <div className="flex flex-col h-full">
      {/* 星期标题 */}
      <div className="grid grid-cols-7 border-b">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="py-2 text-center text-xs font-medium text-muted-foreground">
            {label}
          </div>
        ))}
      </div>

      {/* 日期网格 */}
      <div className="grid grid-cols-7 flex-1">
        {cells.map((cell, idx) => (
          <button
            key={idx}
            onClick={() => cell.dateKey && onSelectDate(cell.dateKey)}
            className={cn(
              'relative flex flex-col items-start p-1.5 border-b border-r min-h-[80px] transition-colors',
              cell.isCurrentMonth ? 'bg-background' : 'bg-muted/30',
              cell.isSelected && 'bg-primary/5',
              !cell.isCurrentMonth && 'text-muted-foreground/50',
              'hover:bg-primary/[0.03]',
            )}
          >
            {/* 日期数字 */}
            <span
              className={cn(
                'text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full',
                cell.isToday && 'bg-primary text-primary-foreground',
                !cell.isToday && cell.isCurrentMonth && 'text-foreground',
              )}
            >
              {cell.day}
            </span>

            {/* 事件条 */}
            <div className="flex flex-col gap-0.5 mt-1 w-full">
              {cell.dayEvents.slice(0, 3).map((event) => (
                <div
                  key={event.id}
                  className={cn(
                    'text-[10px] px-1 py-0.5 rounded truncate w-full',
                    'bg-primary/10 text-primary',
                    event.category && `bg-opacity-20 ${CATEGORY_COLORS[event.category]?.replace('bg-', 'bg-')?.replace('500', '100') || 'bg-primary/10'}`,
                  )}
                  title={event.title}
                >
                  {event.allDay ? '' : `${formatLocalTime(event.startTime)} `}
                  {event.title}
                </div>
              ))}
              {cell.dayEvents.length > 3 && (
                <span className="text-[10px] text-muted-foreground px-1">
                  +{cell.dayEvents.length - 3}
                </span>
              )}
            </div>

            {/* 任务指示点 */}
            {cell.dayTasks.length > 0 && (
              <div className="absolute bottom-1 right-1 flex gap-0.5">
                {cell.dayTasks.slice(0, 3).map((task) => (
                  <span
                    key={task.id}
                    className={cn(
                      'w-1.5 h-1.5 rounded-full',
                      task.status === 'done' ? 'bg-green-400' : 'bg-orange-400',
                    )}
                  />
                ))}
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

// ===== 子组件：事件列表视图 =====

interface EventsListViewProps {
  events: ScheduleEvent[]
  tasks: ScheduleTask[]
  selectedDate: string
  onSelectDate: (date: string) => void
}

function EventsListView({ events, tasks, selectedDate, onSelectDate }: EventsListViewProps): React.ReactElement {
  const today = getDateKey(new Date())

  // 按日期分组
  const grouped = React.useMemo(() => {
    const map = new Map<string, { events: ScheduleEvent[]; tasks: ScheduleTask[] }>()
    // 收集所有有事件的日期
    for (const e of events) {
      const date = getLocalDateFromIso(e.startTime)
      const entry = map.get(date) || { events: [], tasks: [] }
      entry.events.push(e)
      map.set(date, entry)
    }
    // 收集所有有任务的日期
    for (const t of tasks) {
      if (!t.dueDate) continue
      const entry = map.get(t.dueDate) || { events: [], tasks: [] }
      entry.tasks.push(t)
      map.set(t.dueDate, entry)
    }
    // 排序日期
    const sortedDates = Array.from(map.keys()).sort()
    return sortedDates.map((date) => ({ date, ...map.get(date)! }))
  }, [events, tasks])

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b flex items-center justify-between">
        <h3 className="text-sm font-semibold">事件列表</h3>
        <span className="text-xs text-muted-foreground">
          {events.length} 事件 · {tasks.length} 任务
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {grouped.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <p className="text-sm">暂无事件</p>
          </div>
        ) : (
          grouped.map(({ date, events: dayEvents, tasks: dayTasks }) => {
            const isToday = date === today
            const isSelected = date === selectedDate
            const dateObj = new Date(date + 'T00:00:00')
            return (
              <div
                key={date}
                onClick={() => onSelectDate(date)}
                className={cn(
                  'rounded-lg border p-3 cursor-pointer transition-colors',
                  isSelected ? 'bg-primary/5 border-primary/20' : 'hover:bg-muted/30',
                )}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className={cn('text-sm font-medium', isToday && 'text-primary')}>
                    {isToday ? '今天' : dateObj.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', weekday: 'short' })}
                  </span>
                  {isToday && <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">今天</span>}
                </div>
                <div className="space-y-1.5">
                  {dayEvents.map((e) => (
                    <div key={e.id} className="flex items-center gap-2">
                      <span className={cn('w-2 h-2 rounded-full shrink-0', CATEGORY_COLORS[e.category || 'other'])} />
                      <span className="text-sm flex-1 truncate">{e.title}</span>
                      {!e.allDay && (
                        <span className="text-xs text-muted-foreground">
                          {formatLocalTime(e.startTime)} - {formatLocalTime(e.endTime)}
                        </span>
                      )}
                      {e.allDay && <span className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground">全天</span>}
                    </div>
                  ))}
                  {dayTasks.map((t) => (
                    <div key={t.id} className="flex items-center gap-2">
                      <span className={cn('w-2 h-2 rounded-full shrink-0', t.status === 'done' ? 'bg-green-400' : 'bg-orange-400')} />
                      <span className={cn('text-sm flex-1 truncate', t.status === 'done' && 'line-through text-muted-foreground')}>{t.title}</span>
                      <span className="text-xs text-muted-foreground">{STATUS_CONFIG[t.status]?.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ===== 子组件：任务看板 =====

interface TaskBoardProps {
  tasks: ScheduleTask[]
  selectedDate: string
  onUpdateStatus: (id: string, status: ScheduleTask['status']) => void
}

const BOARD_COLUMNS = [
  { key: 'todo', title: '待办' },
  { key: 'in-progress', title: '进行中' },
  { key: 'review', title: '待审核' },
  { key: 'done', title: '已完成' },
] as const

function TaskBoard({ tasks, selectedDate, onUpdateStatus }: TaskBoardProps): React.ReactElement {
  // 筛选选中日期及之前的未完成任务 + 所有已完成任务（最近7天）
  const filteredTasks = React.useMemo(() => {
    return tasks.filter((t) => {
      if (!t.dueDate) return true
      if (t.status === 'done') {
        // 已完成任务显示最近7天的
        const doneDate = t.updatedAt ? getLocalDateFromIso(t.updatedAt) : undefined
        if (!doneDate) return false
        const daysDiff = (new Date(selectedDate + 'T00:00:00').getTime() - new Date(doneDate + 'T00:00:00').getTime()) / 86400000
        return daysDiff <= 7 && daysDiff >= -7
      }
      // 未完成任务：显示选中日期及之前的
      return t.dueDate <= selectedDate
    })
  }, [tasks, selectedDate])

  const columns = BOARD_COLUMNS.map((col) => ({
    ...col,
    items: filteredTasks.filter((t) => t.status === col.key),
  }))

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b flex items-center justify-between">
        <h3 className="text-sm font-semibold">任务看板</h3>
        <span className="text-xs text-muted-foreground">
          {filteredTasks.filter((t) => t.status !== 'done').length} 待处理
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="grid grid-cols-2 gap-2">
          {columns.map((col) => (
            <div key={col.key} className="flex flex-col gap-2">
              {/* 列标题 */}
              <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-muted/50">
                {STATUS_CONFIG[col.key]?.icon}
                <span className="text-xs font-medium">{col.title}</span>
                <span className="text-xs text-muted-foreground ml-auto">{col.items.length}</span>
              </div>

              {/* 任务卡片 */}
              <div className="flex flex-col gap-1.5">
                {col.items.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    selectedDate={selectedDate}
                    onUpdateStatus={onUpdateStatus}
                  />
                ))}
                {col.items.length === 0 && (
                  <div className="text-center py-4 text-xs text-muted-foreground/50">
                    无任务
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ===== 子组件：任务卡片 =====

interface TaskCardProps {
  task: ScheduleTask
  selectedDate: string
  onUpdateStatus: (id: string, status: ScheduleTask['status']) => void
}

function TaskCard({ task, selectedDate, onUpdateStatus }: TaskCardProps): React.ReactElement {
  const isOverdue = task.dueDate && task.dueDate < selectedDate && task.status !== 'done'
  const statusCfg = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.todo

  return (
    <div
      className={cn(
        'group relative p-2.5 rounded-lg border bg-background shadow-sm hover:shadow-md transition-shadow',
        'border-l-[3px]',
        PRIORITY_COLORS[task.priority] || 'border-l-gray-400',
        isOverdue && 'bg-red-50/50 border-red-200',
      )}
    >
      <div className="flex items-start gap-2">
        {/* 状态按钮 */}
        <button
          onClick={() => {
            const nextStatus = task.status === 'todo' ? 'in-progress'
              : task.status === 'in-progress' ? 'review'
                : task.status === 'review' ? 'done'
                  : 'todo'
            onUpdateStatus(task.id, nextStatus)
          }}
          className={cn('mt-0.5 flex-shrink-0', statusCfg!.color)}
          title={`点击切换状态: ${statusCfg!.label}`}
        >
          {statusCfg!.icon}
        </button>

        <div className="flex-1 min-w-0">
          <p className={cn('text-xs font-medium truncate', task.status === 'done' && 'line-through text-muted-foreground')}>
            {task.title}
          </p>
          {task.description && (
            <p className="text-[10px] text-muted-foreground truncate mt-0.5">{task.description}</p>
          )}
          <div className="flex items-center gap-1.5 mt-1">
            {isOverdue && (
              <span className="text-[10px] text-red-500 font-medium">逾期</span>
            )}
            {task.dueDate && (
              <span className="text-[10px] text-muted-foreground">{task.dueDate.slice(5)}</span>
            )}
            {task.category && (
              <span className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground">
                {task.category}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ===== 子组件：日期详情面板 =====

interface DateDetailPanelProps {
  date: string
  events: ScheduleEvent[]
  tasks: ScheduleTask[]
}

function DateDetailPanel({ date, events, tasks }: DateDetailPanelProps): React.ReactElement {
  const dayEvents = getEventsForDate(events, date)
  const dayTasks = getTasksForDate(tasks, date)
  const dateObj = new Date(date + 'T00:00:00')
  const label = `${dateObj.getMonth() + 1}月${dateObj.getDate()}日`
  const weekday = WEEKDAY_LABELS[dateObj.getDay()]

  return (
    <div className="flex flex-col h-full border-l">
      <div className="px-4 py-3 border-b">
        <h3 className="text-sm font-semibold">{label} 周{weekday}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          {dayEvents.length} 个事件 · {dayTasks.length} 个任务
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* 事件列表 */}
        {dayEvents.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">日程</h4>
            {dayEvents.map((event) => (
              <div
                key={event.id}
                className={cn(
                  'p-2.5 rounded-lg border bg-background',
                  'border-l-[3px]',
                  CATEGORY_COLORS[event.category || 'other']?.replace('bg-', 'border-l-') || 'border-l-gray-400',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{event.title}</span>
                  {event.allDay ? (
                    <span className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground">全天</span>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">
                      {formatLocalTime(event.startTime)} - {formatLocalTime(event.endTime)}
                    </span>
                  )}
                </div>
                {event.location && (
                  <p className="text-[10px] text-muted-foreground mt-1">📍 {event.location}</p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 任务列表 */}
        {dayTasks.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">任务</h4>
            {dayTasks.map((task) => (
              <div
                key={task.id}
                className={cn(
                  'flex items-center gap-2 p-2 rounded-md bg-muted/50',
                  task.status === 'done' && 'opacity-60',
                )}
              >
                <span className={cn('flex-shrink-0', STATUS_CONFIG[task.status]?.color)}>
                  {STATUS_CONFIG[task.status]?.icon}
                </span>
                <span className={cn('text-xs', task.status === 'done' && 'line-through text-muted-foreground')}>
                  {task.title}
                </span>
                <span className={cn(
                  'text-[10px] px-1 py-0.5 rounded ml-auto',
                  task.priority === 'urgent' ? 'bg-red-100 text-red-600'
                    : task.priority === 'high' ? 'bg-orange-100 text-orange-600'
                      : 'bg-muted text-muted-foreground',
                )}>
                  {task.priority}
                </span>
              </div>
            ))}
          </div>
        )}

        {dayEvents.length === 0 && dayTasks.length === 0 && (
          <div className="text-center py-8 text-muted-foreground/50">
            <CalendarIcon size={24} className="mx-auto mb-2 opacity-40" />
            <p className="text-xs">该日期无日程</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ===== 主组件 =====

export function ScheduleView(): React.ReactElement {
  const [viewState, setViewState] = useAtom(scheduleViewStateAtom)
  const events = useAtomValue(scheduleEventsAtom)
  const setScheduleEvents = useSetAtom(scheduleEventsAtom)
  const [tasks, setTasks] = useAtom(scheduleTasksAtom)

  const { selectedDate, viewMode } = viewState
  const selectedYear = parseInt(selectedDate.slice(0, 4))
  const selectedMonth = parseInt(selectedDate.slice(5, 7)) - 1

  // 月份导航
  const goToPrevMonth = React.useCallback(() => {
    const newMonth = selectedMonth === 0 ? 11 : selectedMonth - 1
    const newYear = selectedMonth === 0 ? selectedYear - 1 : selectedYear
    const newDate = new Date(newYear, newMonth, 1)
    setViewState((prev) => ({ ...prev, selectedDate: getDateKey(newDate) }))
  }, [selectedMonth, selectedYear, setViewState])

  const goToNextMonth = React.useCallback(() => {
    const newMonth = selectedMonth === 11 ? 0 : selectedMonth + 1
    const newYear = selectedMonth === 11 ? selectedYear + 1 : selectedYear
    const newDate = new Date(newYear, newMonth, 1)
    setViewState((prev) => ({ ...prev, selectedDate: getDateKey(newDate) }))
  }, [selectedMonth, selectedYear, setViewState])

  const goToToday = React.useCallback(() => {
    setViewState((prev) => ({ ...prev, selectedDate: getDateKey(new Date()) }))
  }, [setViewState])

  const handleSelectDate = React.useCallback((date: string) => {
    setViewState((prev) => ({ ...prev, selectedDate: date }))
  }, [setViewState])

  const handleUpdateTaskStatus = React.useCallback((id: string, status: ScheduleTask['status']) => {
    setTasks((prev) =>
      prev.map((task) =>
        task.id === id
          ? { ...task, status, updatedAt: new Date().toISOString() }
          : task
      )
    )
  }, [setTasks])

  // 创建面板状态
  const [showCreatePanel, setShowCreatePanel] = React.useState(false)

  // 系统日历同步状态
  const [syncState, setSyncState] = React.useState<{
    isSyncing: boolean
    lastSyncResult: { success: boolean; imported: number; message: string } | null
  }>({ isSyncing: false, lastSyncResult: null })

  // 同步 macOS 系统日历
  const handleSyncFromSystem = React.useCallback(async () => {
    if (syncState.isSyncing) return
    setSyncState({ isSyncing: true, lastSyncResult: null })

    try {
      // 1. 检查权限
      const permission = await window.electronAPI.paa.calendarSync.checkPermission()
      if (permission !== 'authorized') {
        // 2. 请求权限
        const granted = await window.electronAPI.paa.calendarSync.requestPermission()
        if (!granted) {
          setSyncState({
            isSyncing: false,
            lastSyncResult: { success: false, imported: 0, message: '日历权限未授权。请打开 系统设置 > 隐私与安全性 > 日历，勾选 Proma MIT 后重试。' },
          })
          return
        }
      }

      // 3. 读取系统日历
      interface SystemCalendarEvent {
        id: string
        title: string
        startTime: string
        endTime: string
        allDay: boolean
        location?: string
        calendarName: string
        notes?: string
      }
      interface ReadSuccessResult {
        success: true
        events: SystemCalendarEvent[]
      }
      interface ReadErrorResult {
        success: false
        error: string
      }

      const readResult = (await window.electronAPI.paa.calendarSync.readSystemCalendar({
        daysBack: 30,
        daysForward: 90,
      })) as ReadSuccessResult | ReadErrorResult

      if (!readResult.success) {
        setSyncState({
          isSyncing: false,
          lastSyncResult: { success: false, imported: 0, message: '读取系统日历失败: ' + readResult.error },
        })
        return
      }

      const systemEvents = readResult.events
      if (systemEvents.length === 0) {
        setSyncState({
          isSyncing: false,
          lastSyncResult: { success: true, imported: 0, message: '系统日历中未找到事件' },
        })
        return
      }

      // 4. 转换为 Proma MIT 日程格式并批量创建（去重：按标题+开始时间+结束时间）
      const existingEvents = await window.electronAPI.paa.schedule.listEvents()
      const existingKeys = new Set(existingEvents.map((e: any) => `${e.title}|${e.startTime}|${e.endTime}`))
      
      const newInputs = systemEvents
        .filter((e) => !existingKeys.has(`${e.title}|${e.startTime}|${e.endTime}`))
        .map((e) => ({
          title: e.title,
          startTime: e.startTime,
          endTime: e.endTime,
          allDay: e.allDay,
          location: e.location,
          category: inferCategoryFromCalendarName(e.calendarName),
          source: 'calendar-sync' as const,
        }))

      if (newInputs.length === 0) {
        setSyncState({
          isSyncing: false,
          lastSyncResult: { success: true, imported: 0, message: '所有系统日历事件已存在，无需重复导入' },
        })
        return
      }

      // 批量创建
      const created = await window.electronAPI.paa.schedule.bulkCreateEvents(newInputs)

      // 5. 刷新事件列表
      const refreshed = await window.electronAPI.paa.schedule.listEvents()
      setScheduleEvents(refreshed as ScheduleEvent[])

      setSyncState({
        isSyncing: false,
        lastSyncResult: {
          success: true,
          imported: Array.isArray(created) ? created.length : 0,
          message: `成功导入 ${Array.isArray(created) ? created.length : 0} 个系统日历事件`,
        },
      })
    } catch (err: unknown) {
      console.error('[ScheduleView] 同步系统日历失败:', err)
      setSyncState({
        isSyncing: false,
        lastSyncResult: { success: false, imported: 0, message: '同步失败: ' + getErrorMessage(err) },
      })
    }
  }, [syncState.isSyncing, setScheduleEvents])

  // 根据日历名称推断分类
  function inferCategoryFromCalendarName(calendarName: string): string {
    const name = calendarName.toLowerCase()
    if (name.includes('work') || name.includes('工作') || name.includes('business')) return 'work'
    if (name.includes('family') || name.includes('家庭') || name.includes('home')) return 'family'
    if (name.includes('health') || name.includes('健康') || name.includes('fitness')) return 'health'
    if (name.includes('learn') || name.includes('学习') || name.includes('study')) return 'learning'
    if (name.includes('social') || name.includes('社交') || name.includes('friend')) return 'social'
    if (name.includes('finance') || name.includes('财务') || name.includes('money')) return 'finance'
    return 'personal'
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="relative z-[51] titlebar-no-drag flex items-center justify-between px-4 py-3 border-b flex-shrink-0">
        <div className="flex items-center gap-3">
          <CalendarIcon className="w-5 h-5 text-primary" />
          <h1 className="text-base font-semibold">日程管家</h1>
        </div>

        <div className="flex items-center gap-2">
          {/* 月份导航 */}
          <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
            <button
              onClick={goToPrevMonth}
              className="p-1.5 rounded-md hover:bg-background transition-colors"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm font-medium px-2 min-w-[100px] text-center">
              {formatMonthLabel(selectedYear, selectedMonth)}
            </span>
            <button
              onClick={goToNextMonth}
              className="p-1.5 rounded-md hover:bg-background transition-colors"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          <Button variant="outline" size="sm" onClick={goToToday} className="text-xs h-8">
            今天
          </Button>

          {/* 视图切换 */}
          <div className="flex items-center bg-muted rounded-lg p-0.5">
            <button
              onClick={() => setViewState((prev) => ({ ...prev, viewMode: 'week' }))}
              className={cn(
                'p-1.5 rounded-md transition-colors',
                viewMode === 'week' ? 'bg-background shadow-sm' : 'hover:bg-background/50',
              )}
              title="月视图"
            >
              <LayoutGrid size={14} />
            </button>
            <button
              onClick={() => setViewState((prev) => ({ ...prev, viewMode: 'list' }))}
              className={cn(
                'p-1.5 rounded-md transition-colors',
                viewMode === 'list' ? 'bg-background shadow-sm' : 'hover:bg-background/50',
              )}
              title="列表视图"
            >
              <List size={14} />
            </button>
          </div>

          <Button size="sm" className="gap-1.5 h-8" onClick={() => setShowCreatePanel(true)}>
            <Plus className="w-3.5 h-3.5" />
            新建
          </Button>

          {/* 同步 macOS 日历 */}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 h-8"
            onClick={handleSyncFromSystem}
            disabled={syncState.isSyncing}
            title="从 macOS 日历同步事件"
          >
            <Monitor className="w-3.5 h-3.5" />
            {syncState.isSyncing ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              '同步日历'
            )}
          </Button>
        </div>
      </div>

      {/* 同步结果提示 */}
      {syncState.lastSyncResult && (
        <div className={cn(
          'px-4 py-2 text-xs border-b flex items-center gap-2',
          syncState.lastSyncResult.success ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200',
        )}>
          {syncState.lastSyncResult.success ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
          {syncState.lastSyncResult.message}
          <button
            onClick={() => setSyncState((prev) => ({ ...prev, lastSyncResult: null }))}
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>
      )}

      {/* 创建面板 */}
      {showCreatePanel && (
        <EventCreatePanel
          onClose={() => setShowCreatePanel(false)}
          initialDate={selectedDate}
        />
      )}

      {/* 主内容区 */}
      <div className="flex-1 flex min-h-0">
        {/* 左侧：日历或列表 */}
        <div className="flex-1 min-w-0">
          {viewMode === 'list' ? (
            <EventsListView
              events={events}
              tasks={tasks}
              selectedDate={selectedDate}
              onSelectDate={handleSelectDate}
            />
          ) : (
            <CalendarGrid
              year={selectedYear}
              month={selectedMonth}
              selectedDate={selectedDate}
              events={events}
              tasks={tasks}
              onSelectDate={handleSelectDate}
            />
          )}
        </div>

        {/* 右侧：任务看板 + 日期详情 */}
        <div className="w-[360px] flex-shrink-0 flex flex-col border-l">
          {/* 上半：选中日期详情 */}
          <div className="h-[45%] flex-shrink-0">
            <DateDetailPanel
              date={selectedDate}
              events={events}
              tasks={tasks}
            />
          </div>

          {/* 下半：任务看板 */}
          <div className="flex-1 border-t">
            <TaskBoard
              tasks={tasks}
              selectedDate={selectedDate}
              onUpdateStatus={handleUpdateTaskStatus}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
