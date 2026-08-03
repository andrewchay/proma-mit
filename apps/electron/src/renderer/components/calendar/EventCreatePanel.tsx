/**
 * EventCreatePanel - 事件创建面板
 *
 * 支持两种模式：
 * 1. 自然语言模式：输入自然语言描述，自动解析为结构化事件
 * 2. 表单模式：手动填写事件字段
 *
 * 包含冲突检测提示和智能建议。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  X,
  Wand2,
  FormInput,
  AlertTriangle,
  Clock,
  MapPin,
  Tag,
  Repeat,
  CheckCircle2,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { scheduleEventsAtom, scheduleConflictsAtom, type ScheduleEvent } from '@/atoms/paa-atoms'

// ===== 工具函数：本地时区格式化 =====

function getDateKey(date: Date): string {
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-')
}

function formatLocalTime(isoString: string): string {
  const d = new Date(isoString)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function formatLocalDateTime(isoString: string): string {
  const d = new Date(isoString)
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(/\//g, '-')
}

interface EventCreatePanelProps {
  onClose: () => void
  initialDate?: string
}

const CATEGORY_OPTIONS = [
  { value: 'work', label: '工作', color: 'bg-blue-500' },
  { value: 'personal', label: '个人', color: 'bg-green-500' },
  { value: 'family', label: '家庭', color: 'bg-pink-500' },
  { value: 'health', label: '健康', color: 'bg-red-500' },
  { value: 'learning', label: '学习', color: 'bg-purple-500' },
  { value: 'social', label: '社交', color: 'bg-yellow-500' },
  { value: 'finance', label: '财务', color: 'bg-emerald-500' },
  { value: 'other', label: '其他', color: 'bg-gray-500' },
]

export function EventCreatePanel({ onClose, initialDate }: EventCreatePanelProps): React.ReactElement {
  const [mode, setMode] = React.useState<'nlp' | 'form'>('nlp')
  const [nlpText, setNlpText] = React.useState('')
  const [isParsing, setIsParsing] = React.useState(false)
  const [parsedResult, setParsedResult] = React.useState<{
    title: string
    startTime: string
    endTime: string
    allDay?: boolean
    location?: string
    category?: string
    recurrence?: unknown
    confidence: number
  } | null>(null)
  const [conflicts, setConflicts] = React.useState<Array<{
    eventId: string
    eventTitle: string
    startTime: string
    endTime: string
  }>>([])
  const [isCreating, setIsCreating] = React.useState(false)

  // 表单状态
  const [formTitle, setFormTitle] = React.useState('')
  const [formDate, setFormDate] = React.useState(initialDate || getDateKey(new Date()))
  const [formStartTime, setFormStartTime] = React.useState('09:00')
  const [formEndTime, setFormEndTime] = React.useState('10:00')
  const [formAllDay, setFormAllDay] = React.useState(false)
  const [formLocation, setFormLocation] = React.useState('')
  const [formCategory, setFormCategory] = React.useState('work')
  const [formDescription, setFormDescription] = React.useState('')

  const setScheduleEvents = useSetAtom(scheduleEventsAtom)
  const setScheduleConflicts = useSetAtom(scheduleConflictsAtom)

  // NLP 解析
  const handleParseNlp = React.useCallback(async () => {
    if (!nlpText.trim()) return
    setIsParsing(true)
    try {
      const result = await window.electronAPI.paa.schedule.parseNlp(nlpText) as {
        success: boolean
        title: string
        startTime: string
        endTime: string
        allDay?: boolean
        location?: string
        category?: string
        recurrence?: unknown
        confidence: number
        error?: string
      }
      if (result.success) {
        setParsedResult(result)
        // 检测冲突
        const conflictResult = await window.electronAPI.paa.schedule.detectConflicts({
          startTime: result.startTime,
          endTime: result.endTime,
        }) as { hasConflict: boolean; conflicts: typeof conflicts }
        setConflicts(conflictResult.conflicts)
        setScheduleConflicts(conflictResult)
      } else {
        setParsedResult(null)
        setConflicts([])
      }
    } catch (err) {
      console.error('[NLP] 解析失败:', err)
    } finally {
      setIsParsing(false)
    }
  }, [nlpText, setScheduleConflicts])

  // 创建事件
  const handleCreateEvent = React.useCallback(async () => {
    setIsCreating(true)
    try {
      let input: Record<string, unknown>

      if (mode === 'nlp' && parsedResult) {
        input = {
          title: parsedResult.title,
          startTime: parsedResult.startTime,
          endTime: parsedResult.endTime,
          allDay: parsedResult.allDay,
          location: parsedResult.location,
          category: parsedResult.category,
          recurrence: parsedResult.recurrence,
        }
      } else {
        const startDateTime = `${formDate}T${formStartTime}:00`
        const endDateTime = formAllDay
          ? `${formDate}T23:59:59`
          : `${formDate}T${formEndTime}:00`
        input = {
          title: formTitle,
          startTime: startDateTime,
          endTime: endDateTime,
          allDay: formAllDay,
          location: formLocation || undefined,
          category: formCategory,
          description: formDescription || undefined,
        }
      }

      const event = await window.electronAPI.paa.schedule.createEvent(input)
      setScheduleEvents((prev) => [...prev, event as ScheduleEvent])
      onClose()
    } catch (err) {
      console.error('[创建事件] 失败:', err)
    } finally {
      setIsCreating(false)
    }
  }, [mode, parsedResult, formTitle, formDate, formStartTime, formEndTime, formAllDay, formLocation, formCategory, formDescription, onClose, setScheduleEvents])

  // 键盘快捷键
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        handleCreateEvent()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, handleCreateEvent])

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40">
      <div className="bg-background rounded-2xl shadow-2xl w-[560px] max-h-[85vh] flex flex-col overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="text-base font-semibold">新建日程</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-muted transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* 模式切换 */}
        <div className="flex items-center gap-1 px-5 py-3 border-b">
          <button
            onClick={() => setMode('nlp')}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors',
              mode === 'nlp'
                ? 'bg-primary/10 text-primary font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Wand2 size={14} />
            自然语言
          </button>
          <button
            onClick={() => setMode('form')}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors',
              mode === 'form'
                ? 'bg-primary/10 text-primary font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <FormInput size={14} />
            表单
          </button>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {mode === 'nlp' ? (
            <>
              {/* NLP 输入 */}
              <div className="space-y-2">
                <label className="text-sm font-medium">描述你的日程</label>
                <textarea
                  value={nlpText}
                  onChange={(e) => setNlpText(e.target.value)}
                  placeholder="例如：下周三下午2点客户过方案，2小时，会议室A"
                  className="w-full h-24 px-3 py-2.5 rounded-lg border bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    支持：相对日期、星期、时间、持续时间、地点
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleParseNlp}
                    disabled={!nlpText.trim() || isParsing}
                  >
                    {isParsing ? <Loader2 size={14} className="animate-spin mr-1" /> : <Wand2 size={14} className="mr-1" />}
                    解析
                  </Button>
                </div>
              </div>

              {/* 解析结果 */}
              {parsedResult && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={16} className="text-green-500" />
                    <span className="text-sm font-medium">解析成功</span>
                    <span className="text-xs text-muted-foreground ml-auto">
                      置信度: {Math.round(parsedResult.confidence * 100)}%
                    </span>
                  </div>

                  <div className="bg-muted/50 rounded-lg p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground w-12">标题</span>
                      <span className="text-sm font-medium">{parsedResult.title}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Clock size={12} className="text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">时间</span>
                      <span className="text-sm">
                        {parsedResult.allDay ? '全天' : `${formatLocalDateTime(parsedResult.startTime)} - ${formatLocalTime(parsedResult.endTime)}`}
                      </span>
                    </div>
                    {parsedResult.location && (
                      <div className="flex items-center gap-2">
                        <MapPin size={12} className="text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">地点</span>
                        <span className="text-sm">{parsedResult.location}</span>
                      </div>
                    )}
                    {parsedResult.category && (
                      <div className="flex items-center gap-2">
                        <Tag size={12} className="text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">分类</span>
                        <span className="text-sm">{parsedResult.category}</span>
                      </div>
                    )}
                    {!!parsedResult.recurrence && (
                      <div className="flex items-center gap-2">
                        <Repeat size={12} className="text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">重复</span>
                        <span className="text-sm">{(parsedResult.recurrence as { frequency: string }).frequency}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 冲突警告 */}
              {conflicts.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={16} className="text-red-500" />
                    <span className="text-sm font-medium text-red-700">时间冲突</span>
                  </div>
                  {conflicts.map((c) => (
                    <div key={c.eventId} className="text-xs text-red-600 pl-6">
                      {c.eventTitle} ({formatLocalTime(c.startTime)} - {formatLocalTime(c.endTime)})
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              {/* 表单模式 */}
              <div className="space-y-3">
                <div>
                  <label className="text-sm font-medium block mb-1">标题</label>
                  <input
                    type="text"
                    value={formTitle}
                    onChange={(e) => setFormTitle(e.target.value)}
                    placeholder="日程标题"
                    className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm font-medium block mb-1">日期</label>
                    <input
                      type="date"
                      value={formDate}
                      onChange={(e) => setFormDate(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium block mb-1">分类</label>
                    <select
                      value={formCategory}
                      onChange={(e) => setFormCategory(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    >
                      {CATEGORY_OPTIONS.map((cat) => (
                        <option key={cat.value} value={cat.value}>{cat.label}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {!formAllDay && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-sm font-medium block mb-1">开始时间</label>
                      <input
                        type="time"
                        value={formStartTime}
                        onChange={(e) => setFormStartTime(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium block mb-1">结束时间</label>
                      <input
                        type="time"
                        value={formEndTime}
                        onChange={(e) => setFormEndTime(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                      />
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="allDay"
                    checked={formAllDay}
                    onChange={(e) => setFormAllDay(e.target.checked)}
                    className="rounded"
                  />
                  <label htmlFor="allDay" className="text-sm">全天事件</label>
                </div>

                <div>
                  <label className="text-sm font-medium block mb-1">地点</label>
                  <input
                    type="text"
                    value={formLocation}
                    onChange={(e) => setFormLocation(e.target.value)}
                    placeholder="地点（可选）"
                    className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                </div>

                <div>
                  <label className="text-sm font-medium block mb-1">备注</label>
                  <textarea
                    value={formDescription}
                    onChange={(e) => setFormDescription(e.target.value)}
                    placeholder="备注（可选）"
                    className="w-full h-16 px-3 py-2 rounded-lg border bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                </div>
              </div>
            </>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            onClick={handleCreateEvent}
            disabled={isCreating || (mode === 'nlp' ? !parsedResult : !formTitle)}
          >
            {isCreating ? <Loader2 size={14} className="animate-spin mr-1" /> : null}
            创建
          </Button>
        </div>
      </div>
    </div>
  )
}
