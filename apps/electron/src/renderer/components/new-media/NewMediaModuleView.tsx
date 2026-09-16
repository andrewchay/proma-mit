import * as React from 'react'
import { useSetAtom } from 'jotai'
import { ArrowLeft, FileText, ShieldCheck, RefreshCw, MessageCircle, Radar, BarChart3, UserRound } from 'lucide-react'
import { activeViewAtom } from '@/atoms/active-view'
import { cn } from '@/lib/utils'
import type { NewMediaContentDraft, NewMediaControlledAction, NewMediaEngagementItem, NewMediaListeningQuery, NewMediaMention, NewMediaMetricSnapshot, NewMediaPlatform, NewMediaPublicationJob, NewMediaSocialReport, NewMediaTrendItem, XiaohongshuHandoff } from '@gravitas/shared'
import { CommunityPanel } from './CommunityPanel'
import { ListeningPanel } from './ListeningPanel'
import { InsightsPanel } from './InsightsPanel'
import { AccountsPanel } from './AccountsPanel'
import { XiaohongshuHandoffPanel } from './XiaohongshuHandoffPanel'

type SubView = 'accounts' | 'content' | 'community' | 'listening' | 'insights' | 'outbound'

const ALL_NEW_MEDIA_CAPABILITIES = ['content-operations', 'community-operations', 'social-listening', 'social-analytics', 'trend-radar', 'controlled-outbound']

const PLATFORM_LABEL: Record<NewMediaPlatform, string> = {
  xiaohongshu: '小红书',
  'wechat-official-account': '公众号',
}

export function NewMediaModuleView(): React.ReactElement {
  const setActiveView = useSetAtom(activeViewAtom)
  const [subView, setSubView] = React.useState<SubView>('content')
  const [drafts, setDrafts] = React.useState<NewMediaContentDraft[]>([])
  const [jobs, setJobs] = React.useState<NewMediaPublicationJob[]>([])
  const [actions, setActions] = React.useState<NewMediaControlledAction[]>([])
  const [engagements, setEngagements] = React.useState<NewMediaEngagementItem[]>([])
  const [queries, setQueries] = React.useState<NewMediaListeningQuery[]>([])
  const [mentions, setMentions] = React.useState<NewMediaMention[]>([])
  const [snapshots, setSnapshots] = React.useState<NewMediaMetricSnapshot[]>([])
  const [trends, setTrends] = React.useState<NewMediaTrendItem[]>([])
  const [report, setReport] = React.useState<NewMediaSocialReport | null>(null)
  const [handoffs, setHandoffs] = React.useState<XiaohongshuHandoff[]>([])
  const [sourceText, setSourceText] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [agentEnabled, setAgentEnabled] = React.useState(false)

  const refresh = React.useCallback(async () => {
    setLoading(true)
    try {
      const now = Date.now()
      const [nextDrafts, nextJobs, nextActions, nextEngagements, nextQueries, nextMentions, nextSnapshots, nextTrends, nextReport, nextHandoffs] = await Promise.all([
        window.electronAPI.paa.newMedia.content.listDrafts(),
        window.electronAPI.paa.newMedia.content.listPublicationJobs(),
        window.electronAPI.paa.newMedia.controlledOutbound.list(),
        window.electronAPI.paa.newMedia.community.listEngagements(),
        window.electronAPI.paa.newMedia.listening.listQueries(),
        window.electronAPI.paa.newMedia.listening.listMentions(),
        window.electronAPI.paa.newMedia.analytics.listSnapshots(),
        window.electronAPI.paa.newMedia.analytics.listTrends(),
        window.electronAPI.paa.newMedia.analytics.getReport(now - 30 * 24 * 60 * 60 * 1000, now),
        window.electronAPI.paa.newMedia.xiaohongshuHandoff.list(),
      ])
      setDrafts(nextDrafts); setJobs(nextJobs); setActions(nextActions); setEngagements(nextEngagements)
      setQueries(nextQueries); setMentions(nextMentions); setSnapshots(nextSnapshots); setTrends(nextTrends); setReport(nextReport); setHandoffs(nextHandoffs)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
    void window.electronAPI.getSettings().then((settings) => setAgentEnabled(Array.isArray(settings.newMediaCapabilities) && settings.newMediaCapabilities.length > 0))
  }, [refresh])

  const toggleAgentCapabilities = async (): Promise<void> => {
    const next = agentEnabled ? [] : ALL_NEW_MEDIA_CAPABILITIES
    await window.electronAPI.updateSettings({ newMediaCapabilities: next })
    setAgentEnabled(!agentEnabled)
  }

  const createDraft = async (): Promise<void> => {
    if (!sourceText.trim()) return
    await window.electronAPI.paa.newMedia.content.createDraft(sourceText, ['xiaohongshu', 'wechat-official-account'])
    setSourceText('')
    await refresh()
  }

  const requestPublish = async (draft: NewMediaContentDraft, platform: NewMediaPlatform): Promise<void> => {
    await window.electronAPI.paa.newMedia.content.schedulePublication({
      draftId: draft.id, platform, accountId: 'local-placeholder', scheduledAt: Date.now() + 60 * 60 * 1000,
    })
    await window.electronAPI.paa.newMedia.controlledOutbound.request({
      kind: 'publish', platform, targetId: draft.id, summary: `${PLATFORM_LABEL[platform]}内容草稿发布（本地模拟）`,
    })
    setSubView('outbound')
    await refresh()
  }

  const prepareHandoff = async (draftId: string): Promise<void> => {
    await window.electronAPI.paa.newMedia.xiaohongshuHandoff.prepare(draftId)
    await refresh()
  }

  const approveAndSimulate = async (action: NewMediaControlledAction): Promise<void> => {
    await window.electronAPI.paa.newMedia.controlledOutbound.approve(action.id, 'local-user')
    await window.electronAPI.paa.newMedia.controlledOutbound.simulate(action.id)
    await refresh()
  }

  return (
    <div className="flex h-full flex-col bg-muted/20">
      <header className="flex items-center gap-3 border-b border-border/50 bg-background/80 px-4 py-3 backdrop-blur">
        <button onClick={() => setActiveView('conversations')} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-foreground/60 hover:bg-muted">
          <ArrowLeft size={15} />返回对话
        </button>
        <div className="font-medium">新媒体运营</div>
        <span className="rounded-full bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">仅本地 · 不会真实发布</span>
        <div className="flex-1" />
        <button onClick={() => void toggleAgentCapabilities()} className={cn('rounded-lg px-3 py-1.5 text-xs', agentEnabled ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-foreground/60')}>{agentEnabled ? 'Agent 能力已启用' : '启用 Agent 能力'}</button>
        <button onClick={() => void refresh()} className="rounded-lg p-2 hover:bg-muted" aria-label="刷新"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button>
      </header>

      <div className="flex gap-1 border-b border-border/40 px-4 py-2">
        {([['accounts', '账号', UserRound], ['content', '内容与排程', FileText], ['community', '互动', MessageCircle], ['listening', '聆听', Radar], ['insights', '洞察', BarChart3], ['outbound', '外发审批', ShieldCheck]] as const).map(([id, label, Icon]) => (
          <button key={id} onClick={() => setSubView(id)} className={cn('inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm', subView === id ? 'bg-primary text-primary-foreground' : 'text-foreground/60 hover:bg-muted')}>
            <Icon size={14} />{label}
          </button>
        ))}
      </div>

      <main className="flex-1 overflow-y-auto p-5">
        {subView === 'accounts' ? <AccountsPanel /> : subView === 'community' ? <CommunityPanel items={engagements} onRefresh={refresh} /> : subView === 'listening' ? <ListeningPanel queries={queries} mentions={mentions} onRefresh={refresh} /> : subView === 'insights' ? <InsightsPanel snapshots={snapshots} trends={trends} report={report} onRefresh={refresh} /> : subView === 'content' ? (
          <div className="mx-auto max-w-5xl space-y-5">
            <section className="rounded-2xl bg-background p-4 shadow-sm">
              <h2 className="mb-3 font-medium">创建双平台草稿</h2>
              <textarea value={sourceText} onChange={(event) => setSourceText(event.target.value)} placeholder="输入原始内容，将生成小红书与公众号本地草稿……" className="min-h-28 w-full resize-y rounded-xl bg-muted/60 p-3 text-sm outline-none ring-primary/30 focus:ring-2" />
              <div className="mt-3 flex justify-end"><button onClick={() => void createDraft()} className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">生成本地草稿</button></div>
            </section>
            <section className="grid gap-3 md:grid-cols-2">
              {drafts.map((draft) => <article key={draft.id} className="rounded-2xl bg-background p-4 shadow-sm">
                <div className="mb-3 text-xs text-foreground/45">{new Date(draft.createdAt).toLocaleString()}</div>
                <p className="mb-4 line-clamp-3 text-sm">{draft.sourceText}</p>
                <div className="space-y-2">{Object.entries(draft.platformCopies).map(([platform, copy]) => copy && <div key={platform} className="rounded-xl bg-muted/50 p-3">
                  <div className="flex items-center justify-between gap-2"><strong className="text-sm">{PLATFORM_LABEL[platform as NewMediaPlatform]}</strong>{platform === 'xiaohongshu' ? <button onClick={() => void prepareHandoff(draft.id)} className="text-xs text-primary hover:underline">准备官方发布交接</button> : <button onClick={() => void requestPublish(draft, platform as NewMediaPlatform)} className="text-xs text-primary hover:underline">排程并创建审批</button>}</div>
                  <div className="mt-1 text-sm">{copy.title}</div>
                </div>)}</div>
              </article>)}
            </section>
            <XiaohongshuHandoffPanel drafts={drafts} handoffs={handoffs} onRefresh={refresh} />
            {jobs.length > 0 && <section className="rounded-2xl bg-background p-4 shadow-sm"><h2 className="mb-3 font-medium">发布排程</h2>{jobs.map((job) => <div key={job.id} className="flex justify-between border-t border-border/40 py-2 text-sm"><span>{PLATFORM_LABEL[job.platform]} · {new Date(job.scheduledAt).toLocaleString()}</span><span>{job.status}</span></div>)}</section>}
          </div>
        ) : (
          <div className="mx-auto max-w-4xl space-y-3">{actions.map((action) => <article key={action.id} className="rounded-2xl bg-background p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3"><div><div className="font-medium">{action.summary}</div><div className="mt-1 text-xs text-foreground/45">{PLATFORM_LABEL[action.platform]} · {action.kind}</div></div><span className="rounded-full bg-muted px-2 py-1 text-xs">{action.status}</span></div>
            {action.status === 'pending_approval' && <div className="mt-4 flex justify-end"><button onClick={() => void approveAndSimulate(action)} className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">批准并生成模拟回执</button></div>}
            {action.simulationReceipt && <div className="mt-3 rounded-lg bg-emerald-500/10 p-2 text-xs text-emerald-700 dark:text-emerald-300">{action.simulationReceipt}（未发生真实外部操作）</div>}
          </article>)}</div>
        )}
      </main>
    </div>
  )
}

export default NewMediaModuleView
