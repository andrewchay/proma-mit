import * as React from 'react'
import { AlertTriangle, FileSpreadsheet, Upload } from 'lucide-react'
import type {
  NewMediaImportContract,
  NewMediaImportPreview,
  NewMediaInsightReport,
  NewMediaReportImportBatch,
} from '@gravitas/shared'

const SOURCE_ORDER = ['xiaohongshu-professional', 'xiaohongshu-pugongying', 'xiaohongshu-juguang'] as const

function formatDay(value?: number): string {
  if (value === undefined) return '暂无数据'
  return new Date(value).toLocaleDateString('zh-CN')
}

function MetricGrid({ totals, measured }: { totals: Record<string, number>; measured: string[] }): React.ReactElement {
  if (measured.length === 0) return <div className="py-3 text-sm text-foreground/45">该范围内没有数据</div>
  return <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
    {measured.map((metric) => <div key={metric} className="rounded-xl bg-muted/45 p-3">
      <div className="text-[11px] text-foreground/50">{METRIC_LABEL[metric] ?? metric}</div>
      <div className="mt-1 text-lg font-semibold">{totals[metric] ?? 0}</div>
    </div>)}
  </div>
}

const METRIC_LABEL: Record<string, string> = {
  impressions: '曝光量', reads: '阅读量', likes: '点赞数', collects: '收藏数', comments: '评论数',
  shares: '分享数', followersGained: '新增粉丝', clicks: '点击量', interactions: '互动量',
  conversions: '转化数', spend: '消耗金额',
}

/**
 * 报表导入与洞察。
 *
 * 明确分开账号口径与商业投放口径，公开缺失日期与数据新鲜度，
 * 并声明本地不计算 ROI —— 缺少收入与归因数据。
 */
export function ReportImportPanel({ onRefresh }: { onRefresh: () => Promise<void> }): React.ReactElement {
  const [contracts, setContracts] = React.useState<readonly NewMediaImportContract[]>([])
  const [sourceKind, setSourceKind] = React.useState<string>('xiaohongshu-professional')
  const [accountId, setAccountId] = React.useState('')
  const [preview, setPreview] = React.useState<NewMediaImportPreview | null>(null)
  const [batches, setBatches] = React.useState<NewMediaReportImportBatch[]>([])
  const [insight, setInsight] = React.useState<NewMediaInsightReport | null>(null)
  const [message, setMessage] = React.useState('')

  const activeContract = contracts.find((item) => item.sourceKind === sourceKind)

  const reload = React.useCallback(async (): Promise<void> => {
    const now = Date.now()
    const [nextContracts, nextBatches, nextInsight] = await Promise.all([
      window.electronAPI.paa.newMedia.reportImport.listContracts(),
      window.electronAPI.paa.newMedia.reportImport.listBatches(),
      window.electronAPI.paa.newMedia.reportImport.getInsightReport(now - 30 * 24 * 60 * 60 * 1000, now),
    ])
    setContracts(nextContracts)
    setBatches(nextBatches)
    setInsight(nextInsight)
  }, [])

  React.useEffect(() => { void reload() }, [reload])

  const pick = async (): Promise<void> => {
    setMessage('')
    if (!accountId.trim()) { setMessage('请先填写导入归属账号。'); return }
    const result = await window.electronAPI.paa.newMedia.reportImport.pickAndPreview({ sourceKind: sourceKind as NewMediaImportContract['sourceKind'], accountId: accountId.trim() })
    if (result.canceled) return
    setPreview(result.preview)
  }

  const commit = async (allowDuplicateFile: boolean): Promise<void> => {
    if (!preview) return
    try {
      const batch = await window.electronAPI.paa.newMedia.reportImport.commit({ token: preview.pendingToken, confirmed: true, importedBy: 'local-user', allowDuplicateFile })
      setPreview(null)
      setMessage(`已导入 ${batch.importedRows} 行，跳过重复 ${batch.skippedDuplicateRows} 行，拒绝非法 ${batch.invalidRows.length} 行。`)
      await reload()
      await onRefresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '导入失败')
    }
  }

  const cancel = async (): Promise<void> => {
    if (preview) await window.electronAPI.paa.newMedia.reportImport.cancelPreview(preview.pendingToken)
    setPreview(null)
  }

  return <div className="mx-auto max-w-6xl space-y-4">
    <section className="rounded-2xl bg-background p-4 shadow-sm">
      <div className="flex items-center gap-2"><FileSpreadsheet size={17} /><h2 className="font-medium">官方报表导入</h2></div>
      <p className="mt-1 text-sm text-foreground/55">从专业号、蒲公英或聚光后台导出文件后在此导入。导入只读取本地文件，不访问平台接口。</p>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs text-foreground/60">报表来源
          <select value={sourceKind} onChange={(event) => { setSourceKind(event.target.value); setPreview(null) }} className="mt-1 block rounded-lg bg-muted px-3 py-2 text-sm">
            {SOURCE_ORDER.map((kind) => <option key={kind} value={kind}>{contracts.find((item) => item.sourceKind === kind)?.label ?? kind}</option>)}
          </select>
        </label>
        <label className="text-xs text-foreground/60">归属账号
          <input value={accountId} onChange={(event) => setAccountId(event.target.value)} placeholder="账号标识（与账号面板一致）" className="mt-1 block w-56 rounded-lg bg-muted px-3 py-2 text-sm" />
        </label>
        <button onClick={() => void pick()} className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"><Upload size={14} />选择文件并预览</button>
      </div>

      {activeContract && <div className="mt-3 rounded-xl bg-muted/45 p-3 text-xs text-foreground/60">
        <div>来源：{activeContract.origin}</div>
        <div className="mt-1">边界：{activeContract.boundary}</div>
        {activeContract.requiresCommercialAuthorization && <div className="mt-1 text-amber-700 dark:text-amber-300">该来源属于商业数据，需要平台白名单或书面授权后才能获取。</div>}
      </div>}

      {message && <div className="mt-3 rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">{message}</div>}

      {preview && <div className="mt-3 rounded-xl bg-muted/40 p-3">
        <div className="text-sm font-medium">{preview.fileName}{preview.sheetName ? `（工作表：${preview.sheetName}）` : ''}</div>
        <div className="mt-1 text-xs text-foreground/55">共 {preview.totalRows} 行，可导入 {preview.validRows} 行，非法 {preview.invalidRows.length} 行</div>
        <div className="mt-2 text-xs text-foreground/55">已匹配列：{preview.matchedFields.map((field) => METRIC_LABEL[field] ?? field).join('、') || '无'}</div>
        {preview.unmappedHeaders.length > 0 && <div className="mt-1 text-xs text-foreground/45">未识别列（会被忽略）：{preview.unmappedHeaders.join('、')}</div>}
        {preview.existingBatchId && <div className="mt-2 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300"><AlertTriangle size={13} />该文件此前已导入过，重复导入只会跳过重复行。</div>}
        {preview.invalidRows.length > 0 && <div className="mt-2 max-h-32 overflow-auto text-xs text-foreground/55">
          {preview.invalidRows.slice(0, 20).map((row) => <div key={`${row.rowNumber}-${row.reason}`}>第 {row.rowNumber} 行：{row.reason}</div>)}
        </div>}
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <button onClick={() => void cancel()} className="rounded-lg px-3 py-1.5 text-xs hover:bg-background">取消</button>
          <button onClick={() => void commit(false)} className="rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground">确认导入</button>
          {preview.existingBatchId && <button onClick={() => void commit(true)} className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs text-white">仍要重复导入</button>}
        </div>
      </div>}
    </section>

    {insight && <section className="space-y-3">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl bg-background p-4 shadow-sm">
          <h3 className="font-medium">账号口径（专业号自有内容）</h3>
          <div className="mt-1 text-xs text-foreground/50">覆盖 {insight.account.coveredDays.length} 天，缺失 {insight.account.missingDays.length} 天，最新数据 {formatDay(insight.account.lastCapturedAt)}</div>
          <div className="mt-3"><MetricGrid totals={insight.account.totals} measured={insight.account.measuredMetrics} /></div>
          {insight.account.missingDays.length > 0 && <div className="mt-2 text-xs text-amber-700 dark:text-amber-300">缺失日期：{insight.account.missingDays.slice(0, 10).join('、')}{insight.account.missingDays.length > 10 ? ' 等' : ''}</div>}
        </div>
        <div className="rounded-2xl bg-background p-4 shadow-sm">
          <h3 className="font-medium">商业投放口径（不与账号数据合并）</h3>
          <div className="mt-1 text-xs text-foreground/50">覆盖 {insight.commercial.coveredDays.length} 天，缺失 {insight.commercial.missingDays.length} 天，最新数据 {formatDay(insight.commercial.lastCapturedAt)}</div>
          <div className="mt-3"><MetricGrid totals={insight.commercial.totals} measured={insight.commercial.measuredMetrics} /></div>
          {insight.commercial.sources.map((source) => <div key={source.sourceKind} className="mt-2 text-xs text-foreground/50">{source.label}：{source.rowCount} 行 / {source.batchCount} 个批次。{source.boundary}</div>)}
        </div>
      </div>
      <div className="rounded-2xl bg-background p-4 shadow-sm">
        <h3 className="font-medium">口径与限制</h3>
        <ul className="mt-2 space-y-1 text-xs text-foreground/55">{insight.disclaimers.map((item) => <li key={item}>· {item}</li>)}</ul>
        <div className="mt-2 text-xs text-foreground/45">本地人工录入快照 {insight.manualSnapshotCount} 条，单独计数，不计入以上导入汇总。</div>
      </div>
    </section>}

    <section className="rounded-2xl bg-background p-4 shadow-sm">
      <h2 className="mb-3 font-medium">导入批次</h2>
      <div className="space-y-2">
        {batches.map((batch) => <div key={batch.id} className="rounded-xl bg-muted/45 p-3 text-sm">
          <div className="flex flex-wrap justify-between gap-2">
            <span>{batch.fileName} · {contracts.find((item) => item.sourceKind === batch.sourceKind)?.label ?? batch.sourceKind}</span>
            <span className={batch.commercial ? 'text-amber-700 dark:text-amber-300' : 'text-foreground/60'}>{batch.commercial ? '商业数据' : '账号数据'}</span>
          </div>
          <div className="mt-1 text-xs text-foreground/50">导入 {batch.importedRows} / 共 {batch.totalRows} 行，重复跳过 {batch.skippedDuplicateRows}，非法 {batch.invalidRows.length}，{new Date(batch.importedAt).toLocaleString('zh-CN')} 由 {batch.importedBy}</div>
          <div className="mt-1 text-[11px] text-foreground/35">文件校验值 {batch.fileSha256.slice(0, 16)}…</div>
        </div>)}
        {batches.length === 0 && <div className="py-4 text-center text-sm text-foreground/45">尚未导入任何报表</div>}
      </div>
    </section>
  </div>
}
