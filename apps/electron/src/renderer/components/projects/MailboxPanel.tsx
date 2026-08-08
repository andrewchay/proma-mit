/**
 * MailboxPanel — 团队收件箱（PH2-C）
 *
 * 聚合「需要人类确认 / 需要被处理」的事项：Agent 权限请求 / 提问 / 计划审批。
 * 每条带成员归属，点击打开对应会话处理。
 */

import * as React from 'react'
import { useStore } from 'jotai'
import { useOpenSession } from '@/hooks/useOpenSession'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { Inbox, RefreshCw, ShieldCheck, HelpCircle, ClipboardCheck, ListTodo, Send } from 'lucide-react'
import type { MailboxItem } from '@gravitas/shared'

const KINDS: Record<MailboxItem['kind'], { label: string; icon: React.ReactNode; cls: string }> = {
  permission: { label: '权限', icon: <ShieldCheck size={12} />, cls: 'bg-amber-500/10 text-amber-600' },
  ask: { label: '提问', icon: <HelpCircle size={12} />, cls: 'bg-blue-500/10 text-blue-500' },
  plan_review: { label: '审批', icon: <ClipboardCheck size={12} />, cls: 'bg-violet-500/10 text-violet-600' },
  todo: { label: '待办', icon: <ListTodo size={12} />, cls: 'bg-emerald-500/10 text-emerald-600' },
  invoke: { label: '互调', icon: <Send size={12} />, cls: 'bg-pink-500/10 text-pink-500' },
}

function renderMember(memberId?: string): string {
  if (!memberId) return '—'
  if (memberId.startsWith('agent-')) return `🤖 ${memberId.slice(6).slice(0, 10)}`
  if (memberId.startsWith('paa-')) return memberId.slice(4)
  return memberId
}

export function MailboxPanel(): React.ReactElement {
  const store = useStore()
  const { openSession } = useOpenSession()
  const [items, setItems] = React.useState<MailboxItem[]>([])
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async (): Promise<void> => {
    try {
      const list = await window.electronAPI.listMailbox()
      setItems(list)
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  // 定时刷新（pending 状态会变化）
  React.useEffect(() => {
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [load])

  // 处理一条需要交互的收件箱项：有 sessionId（权限/提问/审批）→ 打开对应会话；
  // todo/互调（无会话）属展示项，不做跳转。
  const handleOpen = (item: MailboxItem): void => {
    if (!item.sessionId) return
    store.set(settingsOpenAtom, false)
    openSession('agent', item.sessionId, item.title)
  }

  const isActionable = (item: MailboxItem): boolean => Boolean(item.sessionId) && (item.kind === 'permission' || item.kind === 'ask' || item.kind === 'plan_review')

  return (
    <div className="rounded-lg border border-border/50 bg-foreground/[0.02] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Inbox size={16} className="text-muted-foreground" />
          <div>
            <h3 className="text-sm font-medium">团队收件箱</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              需要确认：权限 / 提问 / 审批 / 待办 / 互调（{items.length} 条）
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
      ) : items.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          收件箱已清空。Agent 需要你确认时会出现在这里。
        </div>
      ) : (
        <div className="max-h-56 overflow-auto space-y-1">
          {items.map((item) => {
            const kind = KINDS[item.kind]
            const actionable = isActionable(item)
            return (
              <div
                key={item.id}
                onClick={actionable ? () => handleOpen(item) : undefined}
                className={`flex items-center gap-2 text-xs py-1 ${actionable ? 'cursor-pointer hover:bg-accent/40 rounded px-1' : ''}`}
              >
                <span className={`shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${kind.cls}`}>
                  {kind.icon} {kind.label}
                </span>
                <span className="shrink-0 max-w-[80px] truncate text-foreground/60">{renderMember(item.memberId)}</span>
                <span className="truncate flex-1 text-foreground/80" title={item.summary}>{item.summary}</span>
                {actionable ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleOpen(item) }}
                    className="shrink-0 text-[11px] text-primary/70 hover:text-primary"
                  >
                    处理
                  </button>
                ) : (
                  <span className="shrink-0 text-[10px] text-foreground/30">只读</span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
