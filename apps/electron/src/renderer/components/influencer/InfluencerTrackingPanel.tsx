/**
 * InfluencerTrackingPanel — 内容追踪
 *
 * 选择 Campaign 后挂载完整的内容数据追踪管理器
 * （发布台账 / 报数对号 / 自然流与投流分析 / 性能等级）。
 */
import * as React from 'react'
import { BarChart3, Loader2 } from 'lucide-react'
import type { Campaign } from '@gravitas/shared'
import { ContentTrackingManager } from '@/components/agent/ContentTrackingManager'

export function InfluencerTrackingPanel(): React.ReactElement {
  const [campaigns, setCampaigns] = React.useState<Campaign[]>([])
  const [campaignId, setCampaignId] = React.useState('')
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    void (async () => {
      setLoading(true)
      try {
        const list = await window.electronAPI.listCampaigns()
        setCampaigns(list ?? [])
        if (list && list.length > 0) setCampaignId(list[0]!.id)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  if (loading && campaigns.length === 0) {
    return <div className="flex items-center gap-2 p-4 text-[13px] text-foreground/50"><Loader2 size={13} className="animate-spin" />加载内容追踪…</div>
  }

  if (campaigns.length === 0) {
    return (
      <div className="rounded-lg border border-border/30 p-4 text-center text-[13px] text-foreground/40">
        暂无 Campaign。请先在「广告投放 → KOL Campaign」中创建。
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="text-[13px] font-medium text-foreground/85 flex items-center gap-2">
          <BarChart3 size={14} className="text-foreground/45" />
          内容追踪
        </div>
        <div className="flex-1" />
        <select
          value={campaignId}
          onChange={(e) => setCampaignId(e.target.value)}
          className="px-2 py-1.5 rounded-lg border border-border/50 bg-background text-[12px] max-w-[240px]"
        >
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {campaignId && <ContentTrackingManager campaignId={campaignId} />}
    </div>
  )
}

export default InfluencerTrackingPanel
