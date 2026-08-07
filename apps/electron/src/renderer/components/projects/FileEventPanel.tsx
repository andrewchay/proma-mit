/**
 * FileEventPanel — 工作区文件共享事件流（PH2-A）
 *
 * 团队 Tab 展示「哪个成员/Agent 改动了哪个文件」的活动流。
 * 数据来自 workspace-file-event-service（Write/Edit 工具落盘），
 * 可按成员/动作过滤。
 */

import * as React from 'react'
import { FileEdit, PenLine, RefreshCw } from 'lucide-react'
import type { WorkspaceFileEvent } from '@gravitas/shared'

const ACTION_META: Record<string, { label: string; className: string }> = {
  write: { label: '写入', className: 'bg-emerald-500/10 text-emerald-600' },
  edit: { label: '编辑', className: 'bg-blue-500/10 text-blue-500' },
  delete: { label: '删除', className: 'bg-red-500/10 text-red-600' },
}

function renderMember(memberId: string | undefined): string {
  if (!memberId) return '—'
  if (memberId.startsWith('agent-')) return `🤖 ${memberId.slice(6).slice(0, 12)}`
  if (memberId.startsWith('paa-')) return memberId.slice(4)
  if (memberId.startsWith('bot:')) return '🤖 机器人'
  return memberId
}

export function FileEventPanel(): React.ReactElement {
  const [events, setEvents] = React.useState<WorkspaceFileEvent[]>([])
  const [memberFilter, setMemberFilter] = React.useState('')
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async (): Promise<void> => {
    try {
      const list = await window.electronAPI.listFileEvents({ limit: 100 })
      setEvents(list)
    } catch (err) {
      console.error('[文件事件] 加载失败:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  const visible = React.useMemo(() => {
    const kw = memberFilter.trim().toLowerCase()
    if (!kw) return events
    return events.filter((e) => (e.memberId ?? '').toLowerCase().includes(kw))
  }, [events, memberFilter])

  const formatTime = (ts: number): string => {
    const d = new Date(ts)
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  return (
    <div className="rounded-lg border border-border/50 bg-foreground/[0.02] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileEdit size={16} className="text-muted-foreground" />
          <div>
            <h3 className="text-sm font-medium">文件共享事件流</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              成员/Agent 最近改动的文件（共 {events.length} 条）。
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

      <input
        value={memberFilter}
        onChange={(e) => setMemberFilter(e.target.value)}
        placeholder="按成员过滤（agent-… / paa-姓名）"
        className="w-full px-2.5 py-1.5 rounded-md border bg-background text-xs placeholder:text-foreground/40"
      />

      {loading ? (
        <div className="py-6 text-center text-sm text-muted-foreground">加载中…</div>
      ) : visible.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          暂无文件事件。Agent 在工作区写入/编辑文件后会在这里展示。
        </div>
      ) : (
        <div className="max-h-56 overflow-auto space-y-1">
          {visible.slice(0, 50).map((e) => {
            const meta = ACTION_META[e.action] ?? { label: e.action, className: 'bg-foreground/[0.06] text-foreground/60' }
            return (
              <div key={e.id} className="flex items-center gap-2 text-xs py-1">
                <span className="shrink-0 text-foreground/40 tabular-nums w-[86px]">{formatTime(e.at)}</span>
                <span className="shrink-0 flex items-center gap-1 text-foreground/70">
                  <PenLine size={10} />
                  <span className="max-w-[90px] truncate">{renderMember(e.memberId)}</span>
                </span>
                <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] ${meta.className}`}>{meta.label}</span>
                <span className="truncate flex-1 text-foreground/80" title={e.filePath}>{e.filePath}</span>
                {e.workspaceSlug && <span className="shrink-0 text-muted-foreground text-[10px]">{e.workspaceSlug}</span>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
