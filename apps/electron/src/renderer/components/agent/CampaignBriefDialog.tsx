/**
 * CampaignBriefDialog - KOL Brief 编辑弹窗
 *
 * Slice 4: 查看/编辑/生成 KOL 合作 Brief。
 */

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FileText, Wand2, Save, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Campaign, CampaignKOLPoolItem, CampaignBrief } from '@gravitas/shared'

interface CampaignBriefDialogProps {
  campaign: Campaign
  kol: CampaignKOLPoolItem
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CampaignBriefDialog({
  campaign,
  kol,
  open,
  onOpenChange,
}: CampaignBriefDialogProps): React.ReactElement {
  const [brief, setBrief] = React.useState<CampaignBrief | null>(null)
  const [content, setContent] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [generating, setGenerating] = React.useState(false)

  // 加载 Brief
  React.useEffect(() => {
    if (!open) return
    setLoading(true)
    window.electronAPI
      .getCampaignBrief(campaign.id, kol.kolId)
      .then((b) => {
        if (b) {
          setBrief(b)
          setContent(b.content)
        } else {
          setBrief(null)
          setContent('')
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [open, campaign.id, kol.kolId])

  const handleGenerate = () => {
    setGenerating(true)
    // 使用模板生成基础 Brief
    const template = generateBriefContent(campaign, kol)
    setContent(template)
    setGenerating(false)
    toast.success('Brief 已生成，请根据实际需求调整')
  }

  const handleSave = async () => {
    if (!content.trim()) {
      toast.error('Brief 内容不能为空')
      return
    }
    setSaving(true)
    try {
      const saved = await window.electronAPI.saveCampaignBrief({
        campaignId: campaign.id,
        kolId: kol.kolId,
        kolName: kol.name,
        content: content.trim(),
        aiGenerated: brief?.aiGenerated ?? false,
      })
      setBrief(saved)
      toast.success('Brief 保存成功')
    } catch (error) {
      console.error('[BriefDialog] 保存失败:', error)
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <FileText size={16} />
            {kol.name} 的 Brief
          </DialogTitle>
        </DialogHeader>

        {/* 信息面板 */}
        <div className="grid grid-cols-2 gap-3 py-2 border-b border-border">
          <div className="p-2.5 rounded-lg bg-muted/30">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Campaign</div>
            <div className="text-xs font-medium truncate">{campaign.name}</div>
            <div className="text-[11px] text-muted-foreground">{campaign.brand} · {campaign.targetAudience}</div>
          </div>
          <div className="p-2.5 rounded-lg bg-muted/30">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">KOL</div>
            <div className="text-xs font-medium truncate">{kol.name}</div>
            <div className="text-[11px] text-muted-foreground">
              {kol.platform} · {kol.followers} · {kol.category}
            </div>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            onClick={handleGenerate}
            disabled={generating}
            className="text-xs"
          >
            <Wand2 size={13} className="mr-1" />
            {generating ? '生成中...' : '生成基础 Brief'}
          </Button>
          {brief && (
            <span className={cn(
              'text-[10px] px-1.5 py-0.5 rounded font-medium',
              brief.aiGenerated ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
            )}>
              {brief.aiGenerated ? 'AI 生成' : '手动'}
            </span>
          )}
        </div>

        {/* 编辑区 */}
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {loading ? (
            <div className="text-sm text-muted-foreground py-8 text-center">加载中...</div>
          ) : (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="点击「生成基础 Brief」自动填充，或手动编写合作 Brief..."
              className="flex-1 min-h-[200px] w-full p-3 rounded-lg border border-border bg-background text-sm font-mono leading-relaxed resize-none focus:outline-none focus:ring-1 focus:ring-ring"
              spellCheck={false}
            />
          )}
        </div>

        {/* 底部操作 */}
        <div className="flex justify-between items-center pt-2 border-t border-border">
          <div className="text-[11px] text-muted-foreground">
            {brief ? `最后更新: ${new Date(brief.updatedAt).toLocaleString()}` : '尚未保存'}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              <X size={13} className="mr-1" />
              取消
            </Button>
            <Button size="sm" onClick={() => void handleSave()} disabled={saving || !content.trim()}>
              <Save size={13} className="mr-1" />
              {saving ? '保存中...' : '保存'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 生成 Brief 模板内容
 */
function generateBriefContent(campaign: Campaign, kol: CampaignKOLPoolItem): string {
  const platformLabel: Record<string, string> = {
    xiaohongshu: '小红书',
    douyin: '抖音',
    dual: '双平台',
  }

  return `# ${campaign.brand} × ${kol.name} 合作 Brief

## 合作背景
- **品牌**：${campaign.brand}
- **项目**：${campaign.name}
- **投放平台**：${platformLabel[campaign.platform] ?? campaign.platform}
- **目标人群**：${campaign.targetAudience || '待补充'}
- **投放周期**：${campaign.durationMonths} 个月

## KOL 画像
- **账号**：${kol.name}
- **平台**：${kol.platform}
- **粉丝量**：${kol.followers}
- **互动率**：${kol.engagement}
- **内容类目**：${kol.category}
${kol.city ? `- **所在城市**：${kol.city}` : ''}
${kol.price ? `- **合作报价**：${kol.price}` : ''}

## 内容方向（按 Campaign 阶段规划）

${campaign.phasePlans.map((phase) => `### 第 ${phase.phase} 阶段：${phase.name}（${phase.goal}）
- 结合 ${campaign.brand} 品牌调性创作内容
- 围绕 ${campaign.creativePlan.contentPillars.join('、') || '产品卖点'} 展开
- 适配 ${kol.platform} 平台内容形态与受众习惯`).join('\n\n')}

## 内容要求
- [ ] 必须露出品牌名「${campaign.brand}」
- [ ] 强调核心信息：${campaign.creativePlan.coreMessage}
- [ ] 内容风格：${campaign.creativePlan.tone}
- [ ] 重点内容支柱：${campaign.creativePlan.contentPillars.join('、')}
- [ ] 内容风格适配 ${kol.platform} 平台调性
- [ ] 避免过度营销感，保持真实分享感

## 交付要求
- 笔记/视频数量：____ 条
- 发布时间：配合 Campaign 整体排期
- 需提前 3 天提交内容审核
- 发布后 7 天内提供数据截图

## 审核标准
- 内容真实、有情感共鸣
- 产品露出自然不生硬
- 评论区互动积极回应
- 无负面舆情风险

---
*此 Brief 由 MAPro 自动生成，可根据实际合作需求调整。*
`
}
