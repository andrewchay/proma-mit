/**
 * InboxTab — 收件箱标签
 *
 * 展示已同步来信（新来信 / 外联回信筛选），支持手动同步、
 * 查看正文、"AI 起草回复"（创建会话预填 sourcing_draft_reply 简报字段）。
 */
import * as React from 'react'
import { useSetAtom, useStore } from 'jotai'
import { Inbox, MailOpen, RefreshCw, Settings2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { activeViewAtom } from '@/atoms/active-view'
import { appModeAtom } from '@/atoms/app-mode'
import { tabsAtom, activeTabIdAtom, openTab } from '@/atoms/tab-atoms'
import {
  agentSessionsAtom,
  currentAgentSessionIdAtom,
  agentChannelIdAtom,
  currentAgentWorkspaceIdAtom,
  agentPendingPromptAtom,
} from '@/atoms/agent-atoms'
import type { OutboundInboxItem } from '@gravitas/shared'
import { MailboxConfigDialog } from './MailboxConfigDialog'

const CATEGORY_LABEL: Record<string, string> = {
  outreach_reply: '外联回信',
  new_inbound: '新来信',
  other: '其他',
}

export function InboxTab(): React.ReactElement {
  const store = useStore()
  const setActiveView = useSetAtom(activeViewAtom)
  const [items, setItems] = React.useState<OutboundInboxItem[]>([])
  const [loading, setLoading] = React.useState(true)
  const [syncing, setSyncing] = React.useState(false)
  const [filter, setFilter] = React.useState<'all' | 'outreach_reply' | 'new_inbound'>('all')
  const [detail, setDetail] = React.useState<OutboundInboxItem | null>(null)
  const [configOpen, setConfigOpen] = React.useState(false)
  const [configured, setConfigured] = React.useState<boolean | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [drafting, setDrafting] = React.useState(false)


  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const [result, config] = await Promise.all([
        window.electronAPI.outboundMail.listInbox({ limit: 100 }),
        window.electronAPI.outboundMail.getConfig(),
      ])
      setItems(result.items)
      setConfigured(Boolean(config))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取收件箱失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
    const cleanup = window.electronAPI.outboundMail.onSynced(() => void refresh())
    return cleanup
  }, [refresh])

  const handleSync = async (): Promise<void> => {
    setSyncing(true)
    setError(null)
    try {
      const result = await window.electronAPI.outboundMail.syncNow()
      if (!result.ok) setError(result.error ?? '同步失败')
    } catch (err) {
      setError(err instanceof Error ? err.message : '同步失败')
    } finally {
      setSyncing(false)
      void refresh()
    }
  }

  /** 创建会话预填回复草稿指令（sourcing_draft_reply 简报字段） */
  const handleDraftReply = async (item: OutboundInboxItem): Promise<void> => {
    setDrafting(true)
    try {
      const channelId = store.get(agentChannelIdAtom) || undefined
      const workspaceId = store.get(currentAgentWorkspaceIdAtom) || undefined
      const meta = await window.electronAPI.createAgentSession(undefined, channelId, workspaceId)
      store.set(agentSessionsAtom, (prev) => [meta, ...prev])
      store.set(currentAgentSessionIdAtom, meta.id)
      const currentTabs = store.get(tabsAtom)
      const result = openTab(currentTabs, { type: 'agent', sessionId: meta.id, title: `回复 ${item.fromEmail}`.slice(0, 30) })
      store.set(tabsAtom, result.tabs)
      store.set(activeTabIdAtom, result.activeTabId)
      const message = [
        `请为以下来信起草回复：`,
        `用 sourcing_draft_reply 工具传入：from_email=${item.fromEmail}、subject=${JSON.stringify(item.subject)}、message_id=${JSON.stringify(item.messageId)}。`,
        '依据工具返回的回复规则与 Calendly 意向判定撰写纯文本草稿，',
        '确认后用 sourcing_queue_email 入队（发送需我在待发队列中逐封确认）。',
      ].join('\n')
      store.set(agentPendingPromptAtom, { sessionId: meta.id, message })
      store.set(appModeAtom, 'agent')
      setActiveView('conversations')
    } finally {
      setDrafting(false)
    }
  }

  const filtered = items.filter((i) => (filter === 'all' ? true : filter === 'outreach_reply' ? i.category === 'outreach_reply' : i.category !== 'outreach_reply'))

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void handleSync()} disabled={syncing || configured === false}>
          <RefreshCw size={14} className={syncing ? 'mr-1.5 animate-spin' : 'mr-1.5'} />
          {syncing ? '同步中…' : '同步收件箱'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfigOpen(true)}>
          <Settings2 size={14} className="mr-1.5" />
          邮箱账户
        </Button>
        <div className="flex-1" />
        <div className="flex rounded-lg border border-border/50 p-0.5 text-[12px]">
          {(['all', 'outreach_reply', 'new_inbound'] as const).map((key) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-2.5 py-1 rounded-md transition-colors ${filter === key ? 'bg-foreground/[0.08] text-foreground/85' : 'text-foreground/50 hover:text-foreground/75'}`}
            >
              {key === 'all' ? '全部' : CATEGORY_LABEL[key]}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="rounded-lg bg-red-500/10 p-2.5 text-[12px] text-red-500">{error}</div>}
      {configured === false && (
        <div className="rounded-lg bg-amber-500/10 p-2.5 text-[12px] text-amber-600">
          尚未配置邮箱账户，请先点击"邮箱账户"完成 IMAP/SMTP 配置。
        </div>
      )}
      {loading ? (
        <div className="py-8 text-center text-[13px] text-foreground/40">加载中…</div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-foreground/35">
          <Inbox size={28} />
          <span className="text-[13px]">暂无来信</span>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((item) => (
            <div key={item.id} className="rounded-xl bg-card p-3.5 shadow-sm transition-colors hover:bg-foreground/[0.02]">
              <div className="flex items-start gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600">
                  <MailOpen size={15} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-foreground/85">{item.fromName || item.fromEmail}</span>
                    <Badge variant="secondary" className="text-[10px]">{CATEGORY_LABEL[item.category] ?? item.category}</Badge>
                    {item.handled && <Badge variant="outline" className="text-[10px]">已处理</Badge>}
                  </div>
                  <div className="truncate text-[13px] text-foreground/75">{item.subject}</div>
                  <div className="truncate text-[12px] text-foreground/45">{item.snippet}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => setDetail(item)}>查看</Button>
                  <Button size="sm" variant="outline" onClick={() => void handleDraftReply(item)} disabled={drafting}>
                    <Sparkles size={13} className="mr-1" />
                    AI 起草回复
                  </Button>
                </div>
              </div>
              <div className="mt-1 text-right text-[11px] text-foreground/35">{new Date(item.receivedAt).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-[14px]">{detail?.subject}</DialogTitle>
          </DialogHeader>
          <div className="text-[12px] text-foreground/50">
            {detail?.fromName ? `${detail.fromName} <${detail.fromEmail}>` : detail?.fromEmail}
            {detail ? ` · ${new Date(detail.receivedAt).toLocaleString()}` : ''}
          </div>
          <pre className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-lg bg-foreground/[0.03] p-3 text-[12px] leading-5 text-foreground/75">{detail?.text}</pre>
        </DialogContent>
      </Dialog>

      <MailboxConfigDialog open={configOpen} onOpenChange={setConfigOpen} onSaved={() => void refresh()} />
    </div>
  )
}

export default InboxTab
