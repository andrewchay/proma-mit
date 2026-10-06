/**
 * ContentAuditDialog - 内容审核弹窗
 *
 * 提交 KOL 内容进行 AI 审核，展示三维度评分结果。
 */

import * as React from 'react'
import { toast } from 'sonner'
import { ShieldCheck, X, Loader2, CheckCircle, AlertCircle, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Campaign, CampaignKOLPoolItem, ContentAudit } from '@gravitas/shared'
import { ContentAuditReportCard } from '@/components/campaign'

interface ContentAuditDialogProps {
  campaign: Campaign
  kol: CampaignKOLPoolItem
  open: boolean
  onOpenChange: (open: boolean) => void
  onAudited: () => void
}

const STATUS_CONFIG = {
  passed: { label: '通过', color: 'text-emerald-600 bg-emerald-50', icon: CheckCircle },
  failed: { label: '不通过', color: 'text-red-600 bg-red-50', icon: XCircle },
  pending: { label: '待审核', color: 'text-amber-600 bg-amber-50', icon: AlertCircle },
  reviewing: { label: '审核中', color: 'text-blue-600 bg-blue-50', icon: Loader2 },
}

function ScoreRing({ score, label }: { score: number; label: string }): React.ReactElement {
  const color = score >= 80 ? 'text-emerald-500' : score >= 60 ? 'text-amber-500' : score >= 40 ? 'text-orange-500' : 'text-red-500'
  return (
    <div className="flex flex-col items-center">
      <div className={cn('text-2xl font-bold', color)}>{score}</div>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  )
}

export function ContentAuditDialog({
  campaign,
  kol,
  open,
  onOpenChange,
  onAudited,
}: ContentAuditDialogProps): React.ReactElement {
  const [contentDesc, setContentDesc] = React.useState('')
  const [contentUrl, setContentUrl] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [auditResult, setAuditResult] = React.useState<ContentAudit | null>(null)

  const handleSubmit = async () => {
    if (!contentDesc.trim()) {
      toast.error('请输入内容描述')
      return
    }
    setSubmitting(true)
    try {
      const result = await window.electronAPI.createContentAudit({
        campaignId: campaign.id,
        kolId: kol.kolId,
        kolName: kol.name,
        brand: campaign.brand,
        product: campaign.brand,
        platform: kol.platform,
        contentType: '图文',
        contentDescription: contentDesc.trim(),
        contentUrl: contentUrl.trim() || undefined,
      })
      if (result) {
        setAuditResult(result)
        toast.success('审核完成')
        onAudited()
      } else {
        toast.error('审核失败')
      }
    } catch (error) {
      console.error('[审核弹窗] 提交失败:', error)
      toast.error('审核提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  const statusConfig = STATUS_CONFIG[auditResult?.auditStatus ?? 'pending']
  const StatusIcon = statusConfig.icon

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[900px] max-h-[85vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-5 pb-3">
          <DialogTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" />
            内容审核 — {kol.name}
          </DialogTitle>
        </DialogHeader>

        <div className="px-6 pb-4 flex-1 overflow-y-auto">
          {!auditResult ? (
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground">
                品牌：<span className="text-foreground font-medium">{campaign.brand}</span>
                <span className="mx-2">·</span>
                平台：<span className="text-foreground font-medium">{kol.platform}</span>
              </div>

              <div>
                <label className="text-sm font-medium mb-1.5 block">内容描述 / 脚本</label>
                <textarea
                  value={contentDesc}
                  onChange={(e) => setContentDesc(e.target.value)}
                  placeholder="粘贴 KOL 提交的内容文案或脚本..."
                  className="w-full h-32 px-3 py-2 rounded-lg border border-border/60 bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>

              <div>
                <label className="text-sm font-medium mb-1.5 block">内容链接（可选）</label>
                <input
                  type="text"
                  value={contentUrl}
                  onChange={(e) => setContentUrl(e.target.value)}
                  placeholder="https://..."
                  className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                  取消
                </Button>
                <Button
                  size="sm"
                  onClick={() => void handleSubmit()}
                  disabled={submitting || !contentDesc.trim()}
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin mr-1" />
                      AI 审核中...
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="w-4 h-4 mr-1" />
                      提交审核
                    </>
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <ContentAuditReportCard audit={auditResult} />

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setAuditResult(null)
                    setContentDesc('')
                    setContentUrl('')
                  }}
                >
                  重新审核
                </Button>
                <Button size="sm" onClick={() => onOpenChange(false)}>
                  关闭
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
