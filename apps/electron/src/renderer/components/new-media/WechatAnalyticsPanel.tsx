import * as React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import type {
  NewMediaConnectedAccount,
  WechatAnalyticsOverview,
  WechatAnalyticsSource,
} from '@gravitas/shared'

const SOURCE_LABEL: Record<WechatAnalyticsSource, string> = {
  usersummary: '用户增长（每日增量）',
  usercumulate: '累计用户（每日存量）',
  articletotal: '图文传播（新接口，单日）',
  articlesummary: '图文汇总（旧接口）',
}

const SOURCE_WINDOW: Record<WechatAnalyticsSource, number> = {
  usersummary: 7,
  usercumulate: 7,
  articletotal: 1,
  articlesummary: 3,
}

function dayKey(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10)
}

/**
 * 微信分析数据同步与覆盖情况。
 *
 * 如实呈现两件事：
 * - 数据有延迟：最晚只能查到「今天 - 延迟天数」，同步范围会被本地钳制；
 * - 口径互不相加：新/旧图文接口与用户增量/累计分别展示，不做跨口径合并。
 */
export function WechatAnalyticsPanel({ onRefresh }: { onRefresh: () => Promise<void> }): React.ReactElement {
  const [accounts, setAccounts] = React.useState<NewMediaConnectedAccount[]>([])
  const [accountId, setAccountId] = React.useState('')
  const [source, setSource] = React.useState<WechatAnalyticsSource>('usersummary')
  const [beginDate, setBeginDate] = React.useState(dayKey(7))
  const [endDate, setEndDate] = React.useState(dayKey(1))
  const [overview, setOverview] = React.useState<WechatAnalyticsOverview | null>(null)
  const [notice, setNotice] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const wechatAccounts = accounts.filter((account) => account.platform === 'wechat-official-account')
  const activeAccount = accountId || wechatAccounts[0]?.id || ''

  const reload = React.useCallback(async (): Promise<void> => {
    const next = await window.electronAPI.paa.newMedia.accounts.list()
    setAccounts(next)
    const wechat = next.find((account) => account.platform === 'wechat-official-account')
    if (wechat) setOverview(await window.electronAPI.paa.newMedia.wechatAnalytics.overview(wechat.id))
  }, [])

  React.useEffect(() => { void reload() }, [reload])

  const sync = async (): Promise<void> => {
    if (!activeAccount) { setNotice('请先添加微信公众号账号'); return }
    setBusy(true)
    setNotice('')
    try {
      const result = source === 'usersummary' || source === 'usercumulate'
        ? await window.electronAPI.paa.newMedia.wechatAnalytics.syncUser({ accountId: activeAccount, source, beginDate, endDate })
        : await window.electronAPI.paa.newMedia.wechatAnalytics.syncArticle({ accountId: activeAccount, source, beginDate, endDate })
      setNotice(`已同步 ${result.rows} 行（${SOURCE_LABEL[result.source]}，数据延迟 ${result.latencyDays} 天）。`)
      setOverview(await window.electronAPI.paa.newMedia.wechatAnalytics.overview(activeAccount))
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '同步失败')
    } finally {
      setBusy(false)
    }
  }

  return <section className="rounded-2xl bg-background p-4 shadow-sm">
    <h2 className="font-medium">微信分析数据</h2>
    <p className="mt-1 text-sm text-foreground/55">同步平台统计接口的数据。查询范围会被本地按数据延迟钳制；新旧图文接口口径不同，分开保存、分开展示，不做跨口径相加。</p>

    <div className="mt-3 flex flex-wrap items-end gap-2">
      <label className="text-xs text-foreground/60">账号
        <select value={activeAccount} onChange={(event) => setAccountId(event.target.value)} className="mt-1 block rounded-lg bg-muted px-3 py-2 text-sm">
          {wechatAccounts.length === 0 && <option value="">暂无公众号账号</option>}
          {wechatAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}
        </select>
      </label>
      <label className="text-xs text-foreground/60">数据来源
        <select value={source} onChange={(event) => setSource(event.target.value as WechatAnalyticsSource)} className="mt-1 block rounded-lg bg-muted px-3 py-2 text-sm">
          {(Object.keys(SOURCE_LABEL) as WechatAnalyticsSource[]).map((item) => <option key={item} value={item}>{SOURCE_LABEL[item]}</option>)}
        </select>
      </label>
      <label className="text-xs text-foreground/60">开始
        <input type="date" value={beginDate} onChange={(event) => setBeginDate(event.target.value)} className="mt-1 block rounded-lg bg-muted px-3 py-2 text-sm" />
      </label>
      <label className="text-xs text-foreground/60">结束
        <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className="mt-1 block rounded-lg bg-muted px-3 py-2 text-sm" />
      </label>
      <button disabled={busy || !activeAccount} onClick={() => void sync()} className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">
        {busy ? <RefreshCw size={13} className="animate-spin" /> : null}同步数据
      </button>
    </div>
    <div className="mt-1 text-[11px] text-foreground/45">该来源单次最多 {SOURCE_WINDOW[source]} 天；数据延迟由平台决定，超出可查范围会被本地拒绝。</div>

    {notice && <div className="mt-3 rounded-lg bg-muted p-3 text-sm text-foreground/70">{notice}</div>}

    {overview && <div className="mt-4 space-y-2">
      <div className="text-xs font-medium">数据覆盖（各口径独立）</div>
      {overview.sources.map((entry) => <div key={entry.source} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs">
        <span className="font-medium">{SOURCE_LABEL[entry.source]}</span>
        <span className="text-foreground/55">{entry.rowCount} 行 · 最新 {entry.latestDate ?? '无数据'}{entry.lagDays !== undefined ? ` · 落后 ${entry.lagDays} 天` : ''}</span>
        <span className="w-full text-[11px] text-foreground/45">{entry.definition}</span>
      </div>)}
      {overview.sources.every((entry) => entry.rowCount === 0) && <div className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300"><AlertTriangle size={12} />尚未同步任何分析数据；上面选择范围后点击「同步数据」。</div>}
      <div className="text-[11px] text-foreground/40">限制声明：{overview.limits.source}（核对时间 {overview.limits.verifiedAt}）</div>
    </div>}
  </section>
}
