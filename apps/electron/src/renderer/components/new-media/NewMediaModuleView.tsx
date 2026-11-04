import * as React from 'react'
import { Bot, FileText, FileSpreadsheet, ShieldCheck, RefreshCw, MessageCircle, Radar, BarChart3, Send, UserRound } from 'lucide-react'
import { ModuleBackButton } from '@/components/app-shell/ModuleBackButton'
import { cn } from '@/lib/utils'
import type { NewMediaContentDraft, NewMediaControlledAction, NewMediaEngagementItem, NewMediaListeningQuery, NewMediaMention, NewMediaMetricSnapshot, NewMediaPlatform, NewMediaPublicationJob, NewMediaSocialReport, NewMediaTrendItem, XiaohongshuHandoff } from '@gravitas/shared'
import { CommunityPanel } from './CommunityPanel'
import { ListeningPanel } from './ListeningPanel'
import { InsightsPanel } from './InsightsPanel'
import { PublishStatusPanel } from './PublishStatusPanel'
import { AutomationPanel } from './AutomationPanel'
import { ReportImportPanel } from './ReportImportPanel'
import { WechatAnalyticsPanel } from './WechatAnalyticsPanel'
import { AccountsPanel } from './AccountsPanel'
import { XiaohongshuHandoffPanel } from './XiaohongshuHandoffPanel'

type SubView = 'accounts' | 'content' | 'community' | 'listening' | 'import' | 'insights' | 'outbound' | 'publish' | 'automation'

const ALL_NEW_MEDIA_CAPABILITIES = ['content-operations', 'community-operations', 'social-listening', 'social-analytics', 'trend-radar', 'controlled-outbound']

const PLATFORM_LABEL: Record<NewMediaPlatform, string> = {
  xiaohongshu: '小红书',
  'wechat-official-account': '公众号',
}

const ACTION_STATUS: Record<NewMediaControlledAction['status'], string> = {
  pending_approval: '待审批',
  approved: '待执行',
  rejected: '已拒绝',
  executing: '执行中',
  executed: '已执行',
  failed: '执行失败',
  simulated: '已模拟',
}

const HANDOFF_STATUS: Record<XiaohongshuHandoff['status'], string> = {
  draft_ready: '待导出交付包',
  handed_off: '待确认发布',
  user_confirmed_published: '已由用户确认发布',
}

function needsAction(action: NewMediaControlledAction): boolean {
  return action.status === 'pending_approval' || action.status === 'approved' || action.status === 'failed'
}

export function NewMediaModuleView(): React.ReactElement {
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
  const [outboundNotice, setOutboundNotice] = React.useState('')
  const [executors, setExecutors] = React.useState<Array<{ kind: string; platform: string; description: string }>>([])
  const [sourceText, setSourceText] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [agentEnabled, setAgentEnabled] = React.useState(false)

  const actionToFocus = React.useRef<string | null>(null)

  React.useLayoutEffect(() => {
    if (subView !== 'outbound' || !actionToFocus.current) return
    const target = document.getElementById(`outbound-${actionToFocus.current}`)
    actionToFocus.current = null
    target?.focus()
  }, [subView])

  const pendingActions = actions.filter(needsAction)
  const pastActions = actions.filter((action) => !needsAction(action))

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
      setExecutors(await window.electronAPI.paa.newMedia.controlledOutbound.listExecutors())
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

  const approveAction = async (action: NewMediaControlledAction): Promise<void> => {
    await window.electronAPI.paa.newMedia.controlledOutbound.approve(action.id)
    await refresh()
  }

  const simulateAction = async (action: NewMediaControlledAction): Promise<void> => {
    await window.electronAPI.paa.newMedia.controlledOutbound.simulate(action.id)
    await refresh()
  }

  /** 真实执行：只有拿到单次执行权的那一次会真正调用平台执行器。 */
  const executeAction = async (action: NewMediaControlledAction): Promise<void> => {
    setOutboundNotice('')
    try {
      await window.electronAPI.paa.newMedia.controlledOutbound.execute(action.id)
    } catch (error) {
      setOutboundNotice(error instanceof Error ? error.message : '执行失败')
    }
    await refresh()
  }

  /** 结果未知的失败必须先对账，避免重复外发。 */
  const reconcileAction = async (action: NewMediaControlledAction, platformAccepted: boolean): Promise<void> => {
    const note = window.prompt(platformAccepted ? '请说明你在平台后台看到的已发布证据' : '请说明对账依据（平台后台确认未接收）')
    if (!note?.trim()) return
    await window.electronAPI.paa.newMedia.controlledOutbound.reconcile({ actionId: action.id, platformAccepted, note })
    await refresh()
  }

  const retryAction = async (action: NewMediaControlledAction): Promise<void> => {
    setOutboundNotice('')
    try {
      await window.electronAPI.paa.newMedia.controlledOutbound.retry(action.id)
    } catch (error) {
      setOutboundNotice(error instanceof Error ? error.message : '重试失败')
    }
    await refresh()
  }

  return (
    <div className="flex h-full flex-col bg-muted/20">
      <header className="flex items-center gap-3 border-b border-border/50 bg-background/80 px-4 py-3 backdrop-blur">
        <ModuleBackButton />
        <div className="font-medium">新媒体运营</div>
        <span className="rounded-full bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">仅本地 · 不会真实发布</span>
        <div className="flex-1" />
        <button onClick={() => void toggleAgentCapabilities()} className={cn('rounded-lg px-3 py-1.5 text-xs', agentEnabled ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-foreground/60')}>{agentEnabled ? 'Agent 能力已启用' : '启用 Agent 能力'}</button>
        <button onClick={() => void refresh()} className="rounded-lg p-2 hover:bg-muted" aria-label="刷新"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button>
      </header>

      <div className="flex gap-1 border-b border-border/40 px-4 py-2">
        {([['accounts', '账号', UserRound], ['content', '内容与排程', FileText], ['community', '互动', MessageCircle], ['listening', '聆听', Radar], ['import', '报表导入', FileSpreadsheet], ['insights', '洞察', BarChart3], ['outbound', '外发审批', ShieldCheck], ['publish', '发布回执', Send], ['automation', '自动化', Bot]] as const).map(([id, label, Icon]) => (
          <button key={id} onClick={() => setSubView(id)} className={cn('inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm', subView === id ? 'bg-primary text-primary-foreground' : 'text-foreground/60 hover:bg-muted')}>
            <Icon size={14} />{label}
          </button>
        ))}
      </div>

      <main className="flex-1 overflow-y-auto p-5">
        {subView === 'accounts' ? <AccountsPanel /> : subView === 'community' ? <CommunityPanel items={engagements} onRefresh={refresh} /> : subView === 'listening' ? <ListeningPanel queries={queries} mentions={mentions} onRefresh={refresh} /> : subView === 'import' ? <ReportImportPanel onRefresh={refresh} /> : subView === 'insights' ? <InsightsPanel snapshots={snapshots} trends={trends} report={report} onRefresh={refresh} /> : subView === 'content' ? (
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
                <div className="space-y-2">
                  {(Object.keys(PLATFORM_LABEL) as NewMediaPlatform[]).map((platform) => {
                    const copy = draft.platformCopies[platform]
                    if (!copy) return null
                    const handoff = platform === 'xiaohongshu'
                      ? handoffs.find((item) => item.draftId === draft.id)
                      : undefined
                    const action = platform === 'wechat-official-account'
                      ? actions.reduce<NewMediaControlledAction | undefined>((latest, item) =>
                        item.kind === 'publish' && item.targetId === draft.id && item.platform === platform &&
                          (!latest || item.requestedAt > latest.requestedAt) ? item : latest, undefined)
                      : undefined
                    const status = handoff ? HANDOFF_STATUS[handoff.status] : action ? ACTION_STATUS[action.status] : '草稿'
                    return (
                      <div key={platform} className="rounded-xl bg-muted/50 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <strong className="text-sm">{PLATFORM_LABEL[platform]}</strong>
                            <span className="text-xs text-muted-foreground">{status}</span>
                          </div>
                          {platform === 'xiaohongshu' ? (
                            <button className="text-xs text-primary hover:underline" onClick={() => {
                              if (handoff) document.getElementById('xiaohongshu-handoffs')?.focus()
                              else void prepareHandoff(draft.id)
                            }}>
                              {handoff ? '查看交接' : '准备官方发布交接'}
                            </button>
                          ) : action ? (
                            <button className="text-xs text-primary hover:underline" onClick={() => {
                              actionToFocus.current = action.id
                              setSubView('outbound')
                            }}>查看审批与回执</button>
                          ) : (
                            <button className="text-xs text-primary hover:underline" onClick={() => void requestPublish(draft, platform)}>
                              排程并创建审批
                            </button>
                          )}
                        </div>
                        <div className="mt-1 text-sm">{copy.title}</div>
                        {action && ['rejected', 'executed', 'simulated'].includes(action.status) && (
                          <button className="mt-2 text-xs text-primary hover:underline" onClick={() => void requestPublish(draft, platform)}>
                            新建排程与审批
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </article>)}
            </section>
            <section id="xiaohongshu-handoffs" aria-label="小红书发布交接" tabIndex={-1}>
              <XiaohongshuHandoffPanel drafts={drafts} handoffs={handoffs} onRefresh={refresh} />
            </section>
            {jobs.length > 0 && <section className="rounded-2xl bg-background p-4 shadow-sm"><h2 className="mb-3 font-medium">发布排程</h2>{jobs.map((job) => <div key={job.id} className="flex justify-between border-t border-border/40 py-2 text-sm"><span>{PLATFORM_LABEL[job.platform]} · {new Date(job.scheduledAt).toLocaleString()}</span><span>{job.status}</span></div>)}</section>}
          </div>
        ) : (
          <div className="mx-auto max-w-4xl space-y-3">
            <div className="rounded-2xl bg-background p-4 shadow-sm">
              <h2 className="font-medium">执行器状态</h2>
              <p className="mt-1 text-xs text-foreground/55">没有可用执行器时，「真实执行」不会被允许，也不会退回模拟成功。</p>
              <div className="mt-2 space-y-1 text-xs text-foreground/60">
                {executors.length === 0
                  ? <div className="text-amber-700 dark:text-amber-300">当前没有注册任何真实执行器；微信发布执行器将随 freepublish 状态机一起接入。</div>
                  : executors.map((executor) => <div key={`${executor.kind}:${executor.platform}`}>{executor.kind} · {PLATFORM_LABEL[executor.platform as NewMediaPlatform]}：{executor.description}</div>)}
              </div>
            </div>
            {outboundNotice && <div className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">{outboundNotice}</div>}
            {([
              ['待处理', pendingActions],
              ['执行中与历史', pastActions],
            ] as const).map(([title, items]) => (
              <section key={title} className="space-y-3">
                <h2 className="text-sm font-medium">{title}（{items.length}）</h2>
                {items.length === 0 && <p className="text-sm text-muted-foreground">暂无记录</p>}
                {items.map((action) => <article key={action.id} id={`outbound-${action.id}`} tabIndex={-1} className="rounded-2xl bg-background p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3"><div><div className="font-medium">{action.summary}</div><div className="mt-1 text-xs text-foreground/45">{PLATFORM_LABEL[action.platform]} · {action.kind}{action.attempts > 0 ? ` · 已尝试 ${action.attempts} 次` : ''}</div></div><span className="rounded-full bg-muted px-2 py-1 text-xs">{ACTION_STATUS[action.status]}</span></div>
                  {action.status === 'pending_approval' && <div className="mt-4 flex justify-end"><button onClick={() => void approveAction(action)} className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">批准</button></div>}
                  {action.status === 'approved' && <div className="mt-4 flex flex-wrap justify-end gap-2">
                    <button onClick={() => void simulateAction(action)} className="rounded-lg px-3 py-2 text-sm hover:bg-muted">生成模拟回执</button>
                    <button onClick={() => void executeAction(action)} className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">真实执行（单次授权）</button>
                  </div>}
                  {action.status === 'failed' && <div className="mt-4 space-y-2">
                    <div className="rounded-lg bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-300">执行失败：{action.failureCode}（{action.failureOutcome}）{action.retryRequiresReconciliation ? ' · 结果未知，必须先对账再重试' : ''}</div>
                    <div className="flex flex-wrap justify-end gap-2">
                      {action.retryRequiresReconciliation && <>
                        <button onClick={() => void reconcileAction(action, true)} className="rounded-lg px-3 py-2 text-xs hover:bg-muted">对账：平台已接收</button>
                        <button onClick={() => void reconcileAction(action, false)} className="rounded-lg px-3 py-2 text-xs hover:bg-muted">对账：平台未接收</button>
                      </>}
                      {!action.retryRequiresReconciliation && <button onClick={() => void retryAction(action)} className="rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground">重试执行</button>}
                    </div>
                  </div>}
                  {action.status === 'executed' && action.receipt && <div className="mt-3 rounded-lg bg-emerald-500/10 p-2 text-xs text-emerald-700 dark:text-emerald-300">
                    平台回执：{action.receipt.summary}{action.receipt.externalId ? ` · ${action.receipt.externalId}` : ''}{action.receipt.platformStatus ? ` · ${action.receipt.platformStatus}` : ''}
                    {action.receipt.platformStatus === 'publishing' ? '（已提交，尚未确认发布成功）' : ''}
                  </div>}
                  {action.simulationReceipt && <div className="mt-3 rounded-lg bg-muted p-2 text-xs text-foreground/60">{action.simulationReceipt}（本地模拟，未发生真实外部操作）</div>}
                </article>)}
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

export default NewMediaModuleView
