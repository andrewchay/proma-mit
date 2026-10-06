/**
 * CampaignCreateDialog - 创建 Campaign 弹窗
 *
 * Slice 1: 填写品牌名、预算、平台、周期，创建 Campaign。
 */

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { CreateCampaignInput } from '@gravitas/shared'

interface CampaignCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (campaign: import('@gravitas/shared').Campaign) => void
}

export function CampaignCreateDialog({ open, onOpenChange, onCreated }: CampaignCreateDialogProps): React.ReactElement {
  const [submitting, setSubmitting] = React.useState(false)

  const [name, setName] = React.useState('')
  const [brand, setBrand] = React.useState('')
  const [platform, setPlatform] = React.useState<'xiaohongshu' | 'douyin' | 'dual'>('xiaohongshu')
  const [budget, setBudget] = React.useState('')
  const [durationMonths, setDurationMonths] = React.useState('3')
  const [targetCity, setTargetCity] = React.useState('')
  const [targetAudience, setTargetAudience] = React.useState('')
  const [projectPath, setProjectPath] = React.useState('')

  const handlePickFolder = async () => {
    const result = await window.electronAPI.openFolderDialog()
    if (result) setProjectPath(result.path)
  }

  // 弹窗关闭时重置表单
  React.useEffect(() => {
    if (!open) {
      setName('')
      setBrand('')
      setBudget('')
      setDurationMonths('3')
      setTargetCity('')
      setTargetAudience('')
      setProjectPath('')
    }
  }, [open])

  const handleSubmit = async () => {
    if (!name.trim() || !brand.trim()) {
      toast.error('请填写项目名称和品牌名')
      return
    }

    const budgetNum = budget.trim() ? parseInt(budget, 10) : undefined
    if (budgetNum !== undefined && (isNaN(budgetNum) || budgetNum < 0)) {
      toast.error('请输入有效预算金额')
      return
    }
    const months = durationMonths.trim() ? parseInt(durationMonths, 10) : undefined
    if (months !== undefined && (isNaN(months) || months <= 0)) {
      toast.error('请输入有效投放周期')
      return
    }

    const input: CreateCampaignInput = {
      name: name.trim(),
      brand: brand.trim(),
      platform,
      projectPath: projectPath.trim() || undefined,
      budget: budgetNum,
      durationMonths: months,
      targetCity: targetCity.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      targetAudience: targetAudience.trim() || undefined,
    }

    setSubmitting(true)
    try {
      const campaign = await window.electronAPI.createCampaign(input)
      onCreated(campaign)
      onOpenChange(false)
      toast.success('Campaign 创建成功')
    } catch (error) {
      console.error('[CampaignCreateDialog] 创建失败:', error)
      toast.error('创建失败', { description: error instanceof Error ? error.message : '未知错误' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="text-base">新建 Campaign 项目</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">项目名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：VONBON 小红书 20万"
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">品牌名</label>
            <input
              type="text"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="如：VONBON 甄果"
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">投放平台（可选）</label>
              <Select value={platform} onValueChange={(v) => setPlatform(v as typeof platform)}>
                <SelectTrigger className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="xiaohongshu">小红书</SelectItem>
                  <SelectItem value="douyin">抖音</SelectItem>
                  <SelectItem value="dual">双平台</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">预算（元，可选）</label>
              <input
                type="number"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                placeholder="200000"
                className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">投放周期（月，可选）</label>
              <input
                type="number"
                value={durationMonths}
                onChange={(e) => setDurationMonths(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">目标城市（可选）</label>
              <input
                type="text"
                value={targetCity}
                onChange={(e) => setTargetCity(e.target.value)}
                placeholder="上海, 杭州"
                className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">目标人群（可选）</label>
            <input
              type="text"
              value={targetAudience}
              onChange={(e) => setTargetAudience(e.target.value)}
              placeholder="25-35岁沪杭都市女性，追求品质生活"
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">本地项目文件夹（可选）</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                placeholder="工作流产物将存放于该文件夹的 campaign-{id}/ 下"
                className="flex-1 px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <Button variant="outline" size="sm" className="shrink-0" onClick={() => void handlePickFolder()} type="button">
                选择
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">留空则默认存放于内部隔离目录</p>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button size="sm" onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? '创建中...' : '创建'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}