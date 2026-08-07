/**
 * TodoEventPanel — Todo 事件流（PH2-A）
 *
 * 团队 Tab 展示「谁创建/完成/改派了哪个待办」的语义活动流。
 * 数据来自 todo-event-service（订阅 project-service.onTaskChange 落盘）。
 * 可按成员/动作过滤。
 */

import * as React from 'react'
import { ListTodo, RefreshCw } from 'lucide-react'
import type { TodoEvent } from '@gravitas/shared'

const ACTION_META: Record<string, { label: string; className: string }> = {
  created: { label: '创建', className: 'bg-emerald-500/10 text-emerald-600' },
  updated: { label: '更新', className: 'bg-foreground/[0.06] text-foreground/60' },
  completed: { label: '完成', className: 'bg-green-500/10 text-green-600' },
  deleted: { label: '删除', className: 'bg-red-500/10 text-red-600' },
  assigned: { label: '改派', className: 'bg-amber-500/10 text-amber-600' },
}

function renderMember(memberId: string | undefined, assigneeName?: string): string {
  if (assigneeName) return assigneeName
  if (!memberId) return '—'
  if (memberId.startsWith('agent-')) return `🤖 ${memberId.slice(6).slice(0, 12)}`
  if (memberId.startsWith('paa-')) return memberId.slice(4)
  return memberId
}

export function TodoEventPanel(): React.ReactElement {
  const [events, setEvents] = React.useState<TodoEvent[]>([])
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async (): Promise<void> => {
    try {
      const list = await window.electronAPI.listTodoEvents({ limit: 100 })
      setEvents(list)
    } catch {
      setEvents([])
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  const formatTime = (ts: number): string => {
    const d = new Date(ts)
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  return (
    <div className="rounded-lg border border-border/50 bg-foreground/[0.02] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ListTodo size={16} className="text-muted-foreground" />
          <div>
            <h3 className="text-sm font-medium">团队 Todo 动态</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              成员/Agent 对待办的动作（创建/完成/改派），共 {events.length} 条。
            </p>
          </div>
        </div>
        <button
          onClick={() => { setLoading(true); void load() }}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/80 transition-colors"
        >
          <RefreshCw size={12} /> 刷新
        </button>
      </div>

      {loading ? (
        <div className="py-6 text-center text-sm text-muted-foreground">加载中…</div>
      ) : events.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          暂无 Todo 动态。项目管理里任务变更后会在这里展示。
        </div>
      ) : (
        <div className="max-h-56 overflow-auto space-y-1">
          {events.map((e) => {
            const meta = ACTION_META[e.action] ?? { label: e.action, className: 'bg-foreground/[0.06] text-foreground/60' }
            return (
              <div key={e.id} className="flex items-center gap-2 text-xs py-1">
                <span className="shrink-0 text-foreground/40 tabular-nums w-[86px]">{formatTime(e.at)}</span>
                <span className="shrink-0 max-w-[80px] truncate text-foreground/70">{renderMember(e.memberId, e.assigneeName)}</span>
                <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] ${meta.className}`}>{meta.label}</span>
                <span className="truncate flex-1 text-foreground/80" title={e.title}>{e.title}</span>
                {e.status === 'completed' && <span className="shrink-0 text-muted-foreground text-[10px]">已完成</span>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
