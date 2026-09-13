/**
 * OutreachMetricsCard — 本地外联漏斗指标卡
 *
 * 展示已发送 / 待确认 / 回信公司数 / 回复率 / 平均首次回复时延，
 * 数据来自主进程 outreach-metrics-service（本地 outbox + inbox）。
 * 打开/链接点击不在本地统计范围，卡片中已说明。
 */
import * as React from 'react'
import { Activity } from 'lucide-react'
import type { OutreachMetrics } from '../../../main/lib/outbound-mail/outreach-metrics-service'

function formatLatency(ms: number | null): string {
  if (ms === null) return '—'
  const hours = ms / 3_600_000
  return hours >= 24 ? `${(hours / 24).toFixed(1)} 天` : `${hours.toFixed(1)} 小时`
}

export function OutreachMetricsCard(): React.ReactElement | null {
  const [metrics, setMetrics] = React.useState<OutreachMetrics | null>(null)

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      setMetrics(await window.electronAPI.outboundMail.getMetrics())
    } catch {
      setMetrics(null)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
    const offOutbox = window.electronAPI.outboundMail.onOutboxChanged(() => void refresh())
    const offSynced = window.electronAPI.outboundMail.onSynced(() => void refresh())
    return () => { offOutbox(); offSynced() }
  }, [refresh])

  if (!metrics) return null
  // 全线为零时不占据首屏
  if (metrics.sent === 0 && metrics.pending === 0 && metrics.replies === 0) return null

  const stats = [
    { label: '已发送', value: String(metrics.sent) },
    { label: '待确认', value: String(metrics.pending) },
    { label: '回信公司', value: `${metrics.repliedCompanies}/${metrics.contactedCompanies}` },
    { label: '回复率', value: `${Math.round(metrics.replyRate * 100)}%` },
    { label: '平均首回时延', value: formatLatency(metrics.averageFirstReplyLatencyMs) },
  ]

  return (
    <div className="rounded-xl bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground/85">
        <Activity size={16} className="text-sky-600" />
        外联漏斗
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {stats.map((s) => (
          <div key={s.label}>
            <div className="text-[11px] text-foreground/45">{s.label}</div>
            <div className="text-[15px] font-medium text-foreground/85">{s.value}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-foreground/40">基于本地待发队列与已同步来信；邮件打开/链接点击不在本地统计范围。</p>
    </div>
  )
}

export default OutreachMetricsCard
