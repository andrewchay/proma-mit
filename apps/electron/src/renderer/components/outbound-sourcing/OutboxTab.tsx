/**
 * OutboxTab — 待发队列标签（审批制发送的唯一人工入口）
 *
 * 列出待发邮件（draft 可审批/驳回，sent/failed/rejected 只读）；
 * 审批卡中可编辑收件人/主题/正文后确认发送。
 */
import * as React from 'react'
import { Check, Loader2, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { OutboundOutboxItem, OutboundOutboxStatus } from '@gravitas/shared'

const STATUS_META: Record<OutboundOutboxStatus, { label: string; className: string }> = {
  draft: { label: '待确认', className: 'bg-amber-500/15 text-amber-600' },
  approved: { label: '已批准', className: 'bg-sky-500/15 text-sky-600' },
  sent: { label: '已发送', className: 'bg-emerald-500/15 text-emerald-600' },
  rejected: { label: '已驳回', className: 'bg-foreground/[0.06] text-foreground/50' },
  failed: { label: '发送失败', className: 'bg-red-500/15 text-red-500' },
}

export function OutboxTab(): React.ReactElement {
  const [items, setItems] = React.useState<OutboundOutboxItem[]>([])
  const [loading, setLoading] = React.useState(true)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [editTo, setEditTo] = React.useState('')
  const [editSubject, setEditSubject] = React.useState('')
  const [editBody, setEditBody] = React.useState('')
  const [sending, setSending] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      setItems(await window.electronAPI.outboundMail.listOutbox())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取队列失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
    return window.electronAPI.outboundMail.onOutboxChanged(() => void refresh())
  }, [refresh])

  const startEdit = (item: OutboundOutboxItem): void => {
    setEditingId(item.id)
    setEditTo(item.to)
    setEditSubject(item.subject)
    setEditBody(item.body)
  }

  const handleSend = async (item: OutboundOutboxItem): Promise<void> => {
    setSending(item.id)
    setError(null)
    try {
      const edited = editingId === item.id
        ? { to: editTo.trim(), subject: editSubject.trim(), body: editBody }
        : undefined
      await window.electronAPI.outboundMail.approveSend({ id: item.id, edited })
      setEditingId(null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败')
    } finally {
      setSending(null)
    }
  }

  const handleReject = async (item: OutboundOutboxItem): Promise<void> => {
    setError(null)
    try {
      await window.electronAPI.outboundMail.rejectEmail({ id: item.id })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '驳回失败')
    }
  }

  if (loading) return <div className="py-8 text-center text-[13px] text-foreground/40">加载中…</div>

  return (
    <div className="space-y-3">
      {error && <div className="rounded-lg bg-red-500/10 p-2.5 text-[12px] text-red-500">{error}</div>}
      {items.length === 0 ? (
        <div className="py-10 text-center text-[13px] text-foreground/40">待发队列为空；Agent 生成的外联与回复会先进入这里等待确认。</div>
      ) : (
        items.map((item) => {
          const meta = STATUS_META[item.status] ?? { label: item.status, className: 'bg-foreground/[0.06] text-foreground/50' }
          const editable = item.status === 'draft'
          const editing = editingId === item.id
          return (
            <div key={item.id} className="rounded-xl bg-card p-4 shadow-sm">
              <div className="flex items-center gap-2">
                <Badge className={`text-[11px] ${meta.className}`}>{meta.label}</Badge>
                <span className="text-[12px] text-foreground/50">{item.to}</span>
                <div className="flex-1" />
                <span className="text-[11px] text-foreground/35">{new Date(item.createdAt).toLocaleString()}</span>
              </div>
              {editable && editing ? (
                <div className="mt-3 space-y-2">
                  <Input value={editTo} onChange={(e) => setEditTo(e.target.value)} placeholder="收件人" />
                  <Input value={editSubject} onChange={(e) => setEditSubject(e.target.value)} placeholder="主题" />
                  <Textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={8} className="text-[13px]" />
                </div>
              ) : (
                <>
                  <div className="mt-2 text-[13px] font-medium text-foreground/85">{item.subject}</div>
                  <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap text-[12px] leading-5 text-foreground/60">{item.body}</pre>
                  {item.error && <div className="mt-2 text-[12px] text-red-500">{item.error}</div>}
                </>
              )}
              {editable && (
                <div className="mt-3 flex items-center gap-2 border-t border-border/40 pt-3">
                  {editing ? (
                    <>
                      <Button size="sm" onClick={() => void handleSend(item)} disabled={sending === item.id}>
                        {sending === item.id ? <Loader2 size={13} className="mr-1 animate-spin" /> : <Check size={13} className="mr-1" />}
                        确认发送
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        <RotateCcw size={13} className="mr-1" />
                        取消编辑
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => startEdit(item)}>审核并编辑</Button>
                  )}
                  <div className="flex-1" />
                  <Button size="sm" variant="ghost" onClick={() => void handleReject(item)}>
                    <X size={13} className="mr-1" />
                    驳回
                  </Button>
                </div>
              )}
              {item.status === 'sent' && item.sentMessageId && (
                <div className="mt-2 text-[11px] text-foreground/35">Message-ID: {item.sentMessageId}（审计已记录）</div>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}

export default OutboxTab
