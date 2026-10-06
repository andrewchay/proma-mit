import * as React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import type { NewMediaConnectedAccount, WechatPublishRecord, WechatPublishStatus } from '@gravitas/shared'

const STATUS_LABEL: Record<WechatPublishStatus, string> = {
  submit_requested: '已请求提交',
  publishing: '发布中（尚未确认成功）',
  published: '发布成功',
  rejected: '平台审核不通过',
  failed: '发布失败',
  deleted: '已删除',
  unknown: '结果未知',
}

const STATUS_STYLE: Record<WechatPublishStatus, string> = {
  submit_requested: 'bg-muted text-foreground/70',
  publishing: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  published: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  rejected: 'bg-red-500/15 text-red-700 dark:text-red-300',
  failed: 'bg-red-500/15 text-red-700 dark:text-red-300',
  deleted: 'bg-muted text-foreground/60',
  unknown: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
}

/**
 * 发布回执与状态时间线。
 *
 * 明确区分三件事：
 * - 提交受理 ≠ 发布成功（回执里写的是「平台已受理」）；
 * - 结果只认平台查询返回的状态，未映射的状态码显示为「结果未知」，不猜测；
 * - 失败原因与下一步边界直接写在卡片上，用户不需要读日志判断能不能重试。
 */
export function PublishStatusPanel({ onRefresh }: { onRefresh: () => Promise<void> }): React.ReactElement {
  const [records, setRecords] = React.useState<WechatPublishRecord[]>([])
  const [accounts, setAccounts] = React.useState<NewMediaConnectedAccount[]>([])
  const [notice, setNotice] = React.useState('')
  const [busyId, setBusyId] = React.useState('')

  const reload = React.useCallback(async (): Promise<void> => {
    const [nextRecords, nextAccounts] = await Promise.all([
      window.electronAPI.paa.newMedia.publish.list(),
      window.electronAPI.paa.newMedia.accounts.list(),
    ])
    setRecords(nextRecords)
    setAccounts(nextAccounts)
  }, [])

  React.useEffect(() => { void reload() }, [reload])

  const accountName = (accountId: string): string => accounts.find((account) => account.id === accountId)?.displayName ?? accountId

  const poll = async (record: WechatPublishRecord): Promise<void> => {
    setBusyId(record.id)
    setNotice('')
    try {
      await window.electronAPI.paa.newMedia.publish.poll(record.id)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '查询发布状态失败')
    } finally {
      setBusyId('')
      await reload()
      await onRefresh()
    }
  }

  const reconcileSubmit = async (record: WechatPublishRecord, platformAccepted: boolean): Promise<void> => {
    const note = window.prompt(platformAccepted ? '请填写你在微信后台看到的证据（例如 publish_id 或发布记录）' : '请说明确认平台未受理的依据')
    if (!note?.trim()) return
    const publishId = platformAccepted ? window.prompt('如已看到 publish_id 请填写，留空则保持结果未知') ?? '' : ''
    try {
      await window.electronAPI.paa.newMedia.publish.reconcileSubmit({ publishRecordId: record.id, platformAccepted, publishId: publishId.trim() || undefined, note })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '对账失败')
    }
    await reload()
  }

  return <div className="mx-auto max-w-4xl space-y-3">
    <section className="rounded-2xl bg-background p-4 shadow-sm">
      <h2 className="font-medium">发布回执</h2>
      <p className="mt-1 text-sm text-foreground/55">提交只代表平台受理；是否真正发布以平台查询结果为准。发布前必须经过外发审批。</p>
      {notice && <div className="mt-3 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">{notice}</div>}
    </section>

    {records.map((record) => <article key={record.id} className="rounded-2xl bg-background p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-medium">{accountName(record.accountId)}</div>
          <div className="mt-1 text-xs text-foreground/45">publish_id：{record.publishId ?? '未知（需对账）'} · 提交于 {new Date(record.submittedAt).toLocaleString('zh-CN')}</div>
        </div>
        <span className={`rounded-full px-2 py-1 text-xs ${STATUS_STYLE[record.status]}`}>{STATUS_LABEL[record.status]}</span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-1 text-xs text-foreground/60">
        <span>平台原始状态：{record.platformStatus ?? '未返回'}</span>
        <span>确认发布时间：{record.publishedAt ? new Date(record.publishedAt).toLocaleString('zh-CN') : '尚未确认'}</span>
        <span>article_id：{record.articleId ?? '—'}</span>
        <span>最近查询：{record.lastPolledAt ? new Date(record.lastPolledAt).toLocaleString('zh-CN') : '尚未查询'}</span>
      </div>
      {record.articleUrl && <div className="mt-2 truncate text-xs text-primary">{record.articleUrl}</div>}
      {record.failIndices && record.failIndices.length > 0 && <div className="mt-1 text-xs text-red-700 dark:text-red-300">未通过篇目序号：{record.failIndices.join('、')}</div>}

      {record.status === 'unknown' && <div className="mt-2 flex items-start gap-1 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
        <AlertTriangle size={12} className="mt-0.5" />
        <span>{record.submitOutcomeUnknown
          ? '提交结果未知：平台可能已经受理。禁止直接重新提交，请先在微信后台核对后再对账。'
          : '平台返回了未映射的状态码，本地不做猜测；请以微信后台为准，并对映射表进行核对。'}</span>
      </div>}

      {record.status === 'rejected' && <div className="mt-2 rounded-lg bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-300">平台审核不通过：需要修改内容后重新创建草稿并再次提交，不能重复提交同一草稿。</div>}
      {record.status === 'failed' && <div className="mt-2 rounded-lg bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-300">发布失败（{record.failureCode ?? '未记录原因'}）：可按平台提示修改后重新走草稿与审批流程。</div>}
      {record.status === 'deleted' && <div className="mt-2 text-xs text-foreground/50">该发布已在平台删除；本地保留历史状态转换以便追溯。</div>}

      <div className="mt-3">
        <div className="text-xs font-medium">状态时间线</div>
        <ol className="mt-1 space-y-1 border-l border-border/50 pl-3">
          {record.transitions.map((item, index) => <li key={`${item.at}-${index}`} className="text-xs text-foreground/60">
            <span className="text-foreground/40">{new Date(item.at).toLocaleString('zh-CN')}</span>
            {' · '}{item.from ? `${STATUS_LABEL[item.from]} → ` : ''}{STATUS_LABEL[item.to]}
            {item.platformStatus !== undefined ? `（平台 ${item.platformStatus}）` : ''}
            {item.note ? ` · ${item.note}` : ''}
          </li>)}
        </ol>
      </div>

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {record.submitOutcomeUnknown && <>
          <button onClick={() => void reconcileSubmit(record, true)} className="rounded-lg px-3 py-1.5 text-xs hover:bg-muted">对账：平台已受理</button>
          <button onClick={() => void reconcileSubmit(record, false)} className="rounded-lg px-3 py-1.5 text-xs hover:bg-muted">对账：平台未受理</button>
        </>}
        <button disabled={!record.publishId || busyId === record.id} onClick={() => void poll(record)} className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50">
          {busyId === record.id ? <RefreshCw size={12} className="animate-spin" /> : null}查询平台状态
        </button>
      </div>
    </article>)}

    {records.length === 0 && <div className="rounded-2xl bg-background p-8 text-center text-sm text-foreground/45 shadow-sm">尚无可展示的发布回执</div>}
  </div>
}
