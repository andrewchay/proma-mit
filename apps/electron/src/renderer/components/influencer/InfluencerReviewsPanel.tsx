/**
 * InfluencerReviewsPanel — 稿件审核
 *
 * 选择 Campaign 与候选池 KOL 发起内容审核，并展示历史审核记录
 * （奥格威五维评分卡片）。数据走 campaign-manager 的内容审核流水线。
 */
import * as React from 'react'
import { FileCheck2, Loader2 } from 'lucide-react'
import type { Campaign, CampaignKOLPoolItem, ContentAudit } from '@gravitas/shared'
import { ContentAuditDialog } from '@/components/agent/ContentAuditDialog'
import { ContentAuditReportCard } from '@/components/campaign'

export function InfluencerReviewsPanel(): React.ReactElement {
  const [campaigns, setCampaigns] = React.useState<Campaign[]>([])
  const [campaignId, setCampaignId] = React.useState('')
  const [pool, setPool] = React.useState<CampaignKOLPoolItem[]>([])
  const [audits, setAudits] = React.useState<ContentAudit[]>([])
  const [loading, setLoading] = React.useState(true)
  const [auditTarget, setAuditTarget] = React.useState<CampaignKOLPoolItem | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)

  const loadCampaigns = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const list = await window.electronAPI.listCampaigns()
      setCampaigns(list ?? [])
      if (list && list.length > 0) setCampaignId((prev) => prev || list[0]!.id)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadPoolAndAudits = React.useCallback(async (): Promise<void> => {
    if (!campaignId) {
      setPool([])
      setAudits([])
      return
    }
    setPool(await window.electronAPI.getPoolKOLs(campaignId))
    setAudits(await window.electronAPI.listContentAudits(campaignId))
  }, [campaignId])

  React.useEffect(() => {
    void loadCampaigns()
  }, [loadCampaigns])

  React.useEffect(() => {
    void loadPoolAndAudits()
  }, [loadPoolAndAudits])

  if (loading && campaigns.length === 0) {
    return <div className="flex items-center gap-2 p-4 text-[13px] text-foreground/50"><Loader2 size={13} className="animate-spin" />加载审核面板…</div>
  }

  if (campaigns.length === 0) {
    return (
      <div className="rounded-lg border border-border/30 p-4 text-center text-[13px] text-foreground/40">
        暂无 Campaign。请先在「广告投放 → KOL Campaign」中创建。
      </div>
    )
  }

  const currentCampaign = campaigns.find((c) => c.id === campaignId)

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="text-[13px] font-medium text-foreground/85 flex items-center gap-2">
          <FileCheck2 size={14} className="text-foreground/45" />
          稿件审核
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

      {pool.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[12px] text-foreground/45">候选池 KOL（{pool.length}）</div>
          <div className="grid gap-1.5">
            {pool.map((kol) => (
              <div key={kol.kolId} className="flex items-center gap-3 rounded-lg border border-border/50 p-2.5">
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] font-medium text-foreground/85">{kol.name}</span>
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-foreground/[0.05] text-foreground/50 ml-2">{kol.platform}</span>
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-foreground/[0.05] text-foreground/50 ml-1">{kol.status}</span>
                </div>
                <button
                  onClick={() => { setAuditTarget(kol); setDialogOpen(true) }}
                  className="px-2.5 py-1 rounded-lg bg-primary text-primary-foreground text-[12px] font-medium"
                >
                  发起审核
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <div className="text-[12px] text-foreground/45">审核记录（{audits.length}）</div>
        {audits.length === 0 ? (
          <div className="rounded-lg border border-border/30 p-4 text-center text-[13px] text-foreground/40">暂无审核记录</div>
        ) : (
          audits.map((audit) => <ContentAuditReportCard key={audit.auditId} audit={audit} />)
        )}
      </div>

      {currentCampaign && auditTarget && (
        <ContentAuditDialog
          campaign={currentCampaign}
          kol={auditTarget}
          open={dialogOpen}
          onOpenChange={(open) => {
            setDialogOpen(open)
            if (!open) {
              setAuditTarget(null)
              void loadPoolAndAudits()
            }
          }}
          onAudited={() => void loadPoolAndAudits()}
        />
      )}
    </div>
  )
}

export default InfluencerReviewsPanel
