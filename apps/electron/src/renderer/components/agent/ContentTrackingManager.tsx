/**
 * ContentTrackingManager - 合作达人内容数据追踪管理
 *
 * 管理 KOL 发布内容的数据表现，支持：
 * - 内容数据录入（自然流/付费/混合）
 * - 数据更新（24h 追踪）
 * - 投流数据追踪
 * - AI 分析与建议
 * - 数据标准（Benchmark）参考
 */

import * as React from 'react'
import { toast } from 'sonner'
import {
  Eye, BarChart3, DollarSign, Heart, MessageSquare,
  Share2, Bookmark, Trash2, Pencil, Plus, Filter, ExternalLink,
  Megaphone, Target, AlertTriangle, CheckCircle, Clock,
  Zap, Sparkles, X
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type {
  KOLContentTracking,
  CreateContentTrackingInput,
  UpdateContentTrackingDataInput,
  AddPaidDataInput,
  UpdateAnalysisInput,
} from '@gravitas/shared'

/* ===================== 辅助函数 & 配置 ===================== */

const PLATFORM_LABEL: Record<string, string> = {
  xiaohongshu: '小红书',
  douyin: '抖音',
  weibo: '微博',
  bilibili: 'B站',
  kuaishou: '快手',
}

const CONTENT_TYPE_LABEL: Record<string, string> = {
  organic: '自然流',
  paid: '付费',
  mixed: '混合',
}

const DATA_SOURCE_LABEL: Record<string, string> = {
  api: 'API',
  manual: '手动',
  screenshot: '截图',
  estimated: '预估',
}

const PERFORMANCE_GRADE_CONFIG = {
  excellent: { label: '优秀', color: 'text-emerald-700 bg-emerald-50 border-emerald-200', icon: CheckCircle },
  good: { label: '良好', color: 'text-emerald-600 bg-emerald-50/70 border-emerald-100', icon: CheckCircle },
  normal: { label: '正常', color: 'text-amber-700 bg-amber-50 border-amber-200', icon: Clock },
  poor: { label: '需优化', color: 'text-red-700 bg-red-50 border-red-200', icon: AlertTriangle },
  pending: { label: '待分析', color: 'text-gray-600 bg-gray-50 border-gray-200', icon: Clock },
} as const

function formatNumber(n: number): string {
  if (n === undefined || n === null) return '-'
  return n.toLocaleString()
}

function formatPercent(n: number, digits = 1): string {
  if (n === undefined || n === null) return '-'
  return `${n.toFixed(digits)}%`
}

function formatMoney(n: number): string {
  if (n === undefined || n === null) return '-'
  return `¥${n.toLocaleString()}`
}

/* ===================== 性能等级徽章 ===================== */

function PerformanceBadge({ grade }: { grade: KOLContentTracking['performanceGrade'] }): React.ReactElement {
  const config = PERFORMANCE_GRADE_CONFIG[grade] ?? PERFORMANCE_GRADE_CONFIG.pending
  const Icon = config.icon
  return (
    <span className={cn('inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border', config.color)}>
      <Icon className="w-3.5 h-3.5" />
      {config.label}
    </span>
  )
}

/* ===================== 内容类型徽章 ===================== */

function ContentTypeBadge({ type }: { type: KOLContentTracking['contentType'] }): React.ReactElement {
  const colors = {
    organic: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    paid: 'bg-purple-50 text-purple-700 border-purple-200',
    mixed: 'bg-blue-50 text-blue-700 border-blue-200',
  }
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-medium border', colors[type] ?? colors.organic)}>
      {CONTENT_TYPE_LABEL[type] ?? type}
    </span>
  )
}

/* ===================== 数据来源徽章 ===================== */

function DataSourceBadge({ source }: { source: KOLContentTracking['dataSource'] }): React.ReactElement {
  const colors = {
    api: 'bg-primary/10 text-primary border-primary/20',
    manual: 'bg-muted text-muted-foreground border-border',
    screenshot: 'bg-amber-50 text-amber-700 border-amber-200',
    estimated: 'bg-orange-50 text-orange-700 border-orange-200',
  }
  return (
    <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border', colors[source] ?? colors.manual)}>
      {DATA_SOURCE_LABEL[source] ?? source}
    </span>
  )
}

/* ===================== 迷你数据条 ===================== */

function MiniBar({ value, max, label, colorClass = 'bg-primary/60' }: { value: number; max: number; label: string; colorClass?: string }): React.ReactElement {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-14 text-muted-foreground shrink-0 text-[10px]">{label}</span>
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', colorClass)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-12 text-right font-medium text-[10px]">{formatNumber(value)}</span>
    </div>
  )
}

/* ===================== 数据卡片 ===================== */

interface TrackingCardProps {
  item: KOLContentTracking
  onUpdate: (item: KOLContentTracking) => void
  onAddPaid: (item: KOLContentTracking) => void
  onViewAnalysis: (item: KOLContentTracking) => void
  onDelete: (id: string) => void
  onAIAnalyze: (item: KOLContentTracking) => void
  maxValues: { exposure: number; views: number; likes: number }
}

function TrackingCard({ item, onUpdate, onAddPaid, onViewAnalysis, onDelete, onAIAnalyze, maxValues }: TrackingCardProps): React.ReactElement {
  const hasPaid = item.paidSpend > 0 || item.paidExposure > 0 || item.paidViews > 0 || item.paidLikes > 0
  const organicExposure = Math.max(0, item.exposure - (item.paidExposure || 0))
  const organicLikes = Math.max(0, item.likes - (item.paidLikes || 0))

  return (
    <div className="rounded-xl bg-card shadow-sm border border-border/40 p-4 hover:border-primary/20 transition-colors">
      {/* 头部：平台 + 达人名 + 类型 */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium px-2 py-0.5 rounded-md bg-primary/10 text-primary border border-primary/20">
            {PLATFORM_LABEL[item.platform] ?? item.platform}
          </span>
          <span className="text-sm font-semibold">@{item.kolName}</span>
          <ContentTypeBadge type={item.contentType} />
          <PerformanceBadge grade={item.performanceGrade} />
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onAIAnalyze(item)}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/5 transition-colors"
            title="AI 分析"
          >
            <Sparkles className="w-4 h-4" />
          </button>
          <button
            onClick={() => onUpdate(item)}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-primary/5 transition-colors"
            title="更新数据"
          >
            <Pencil className="w-4 h-4" />
          </button>
          <button
            onClick={() => onAddPaid(item)}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-purple-600 hover:bg-purple-50 transition-colors"
            title="投流追踪"
          >
            <Megaphone className="w-4 h-4" />
          </button>
          <button
            onClick={() => onDelete(item.id)}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/5 transition-colors"
            title="删除"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 元信息行 */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground mb-3 flex-wrap">
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {item.publishDate}
        </span>
        <DataSourceBadge source={item.dataSource} />
        {item.contentUrl && (
          <a
            href={item.contentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="w-3 h-3" />
            查看内容
          </a>
        )}
      </div>

      {/* 数据表现区 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <div className="p-2.5 rounded-lg bg-primary/5">
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
            <Eye className="w-3 h-3" /> 曝光
          </div>
          <div className="text-sm font-semibold">{formatNumber(item.exposure)}</div>
        </div>
        <div className="p-2.5 rounded-lg bg-primary/5">
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
            <BarChart3 className="w-3 h-3" /> 浏览
          </div>
          <div className="text-sm font-semibold">{formatNumber(item.views)}</div>
        </div>
        <div className="p-2.5 rounded-lg bg-primary/5">
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
            <Target className="w-3 h-3" /> CTR
          </div>
          <div className="text-sm font-semibold">{formatPercent(item.ctr)}</div>
        </div>
        <div className="p-2.5 rounded-lg bg-primary/5">
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
            <Zap className="w-3 h-3" /> 互动率
          </div>
          <div className="text-sm font-semibold">{formatPercent(item.engagementRate)}</div>
        </div>
      </div>

      {/* 互动数据 + 成本 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <div className="space-y-1.5">
          <MiniBar value={item.likes} max={maxValues.likes} label="点赞" colorClass="bg-rose-400/70" />
          <MiniBar value={item.saves} max={maxValues.likes} label="收藏" colorClass="bg-amber-400/70" />
          <MiniBar value={item.comments} max={maxValues.likes} label="评论" colorClass="bg-blue-400/70" />
          <MiniBar value={item.shares} max={maxValues.likes} label="转发" colorClass="bg-emerald-400/70" />
        </div>
        <div className="p-2.5 rounded-lg bg-muted/30 space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground flex items-center gap-1">
              <DollarSign className="w-3 h-3" /> CPM
            </span>
            <span className="font-medium">{formatMoney(item.cpm)}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground flex items-center gap-1">
              <DollarSign className="w-3 h-3" /> CPE
            </span>
            <span className="font-medium">{formatMoney(item.cpe)}</span>
          </div>
          {item.completionRate !== undefined && item.completionRate !== null && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">完播率</span>
              <span className="font-medium">{formatPercent(item.completionRate)}</span>
            </div>
          )}
        </div>
      </div>

      {/* 投流数据对比 */}
      {hasPaid && (
        <div className="p-3 rounded-lg bg-purple-50/50 border border-purple-100/50 mb-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-purple-700 mb-2">
            <Megaphone className="w-3.5 h-3.5" />
            投流数据
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div>
              <span className="text-muted-foreground">投放金额</span>
              <div className="font-medium text-purple-700">{formatMoney(item.paidSpend)}</div>
            </div>
            <div>
              <span className="text-muted-foreground">投流曝光</span>
              <div className="font-medium">{formatNumber(item.paidExposure)}</div>
            </div>
            <div>
              <span className="text-muted-foreground">投流浏览</span>
              <div className="font-medium">{formatNumber(item.paidViews)}</div>
            </div>
            <div>
              <span className="text-muted-foreground">投流点赞</span>
              <div className="font-medium">{formatNumber(item.paidLikes)}</div>
            </div>
          </div>
          {/* 自然流 vs 投流对比 */}
          <div className="mt-2 pt-2 border-t border-purple-100/50 grid grid-cols-2 gap-2 text-[10px]">
            <div className="text-emerald-700">
              <span className="text-muted-foreground">自然流：</span>
              曝光 {formatNumber(organicExposure)} · 点赞 {formatNumber(organicLikes)}
            </div>
            <div className="text-purple-700">
              <span className="text-muted-foreground">投流：</span>
              曝光 {formatNumber(item.paidExposure)} · 点赞 {formatNumber(item.paidLikes)}
            </div>
          </div>
        </div>
      )}

      {/* 底部操作栏 */}
      <div className="flex items-center justify-between pt-2 border-t border-border/30">
        <div className="text-[10px] text-muted-foreground">
          数据回收于 {new Date(item.collectedAt).toLocaleString()}
        </div>
        <div className="flex items-center gap-1">
          {(item.aiAnalysis || item.recommendations) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => onViewAnalysis(item)}
            >
              <Sparkles className="w-3.5 h-3.5 mr-1" />
              查看建议
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ===================== 数据录入弹窗 ===================== */

interface DataFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingItem: KOLContentTracking | null
  campaignId: string
  onSaved: () => void
}

function DataFormDialog({ open, onOpenChange, editingItem, campaignId, onSaved }: DataFormDialogProps): React.ReactElement {
  const isEditing = !!editingItem

  const [form, setForm] = React.useState<Partial<CreateContentTrackingInput>>({
    campaignId,
    kolId: '',
    kolName: '',
    platform: 'xiaohongshu',
    contentUrl: '',
    contentType: 'organic',
    publishDate: new Date().toISOString().split('T')[0],
    exposure: 0,
    views: 0,
    likes: 0,
    saves: 0,
    comments: 0,
    shares: 0,
    completionRate: undefined,
    dataSource: 'manual',
    paidSpend: undefined,
  })

  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    if (editingItem) {
      setForm({
        campaignId: editingItem.campaignId,
        kolId: editingItem.kolId,
        kolName: editingItem.kolName,
        platform: editingItem.platform,
        contentUrl: editingItem.contentUrl,
        contentType: editingItem.contentType,
        publishDate: editingItem.publishDate,
        exposure: editingItem.exposure,
        views: editingItem.views,
        likes: editingItem.likes,
        saves: editingItem.saves,
        comments: editingItem.comments,
        shares: editingItem.shares,
        completionRate: editingItem.completionRate,
        dataSource: editingItem.dataSource,
      })
    } else {
      setForm({
        campaignId,
        kolId: '',
        kolName: '',
        platform: 'xiaohongshu',
        contentUrl: '',
        contentType: 'organic',
        publishDate: new Date().toISOString().split('T')[0],
        exposure: 0,
        views: 0,
        likes: 0,
        saves: 0,
        comments: 0,
        shares: 0,
        completionRate: undefined,
        dataSource: 'manual',
        paidSpend: undefined,
      })
    }
  }, [editingItem, campaignId, open])

  const handleSubmit = async () => {
    if (!form.kolName?.trim()) {
      toast.error('请输入达人名')
      return
    }
    if (!form.contentUrl?.trim()) {
      toast.error('请输入内容链接')
      return
    }

    setSubmitting(true)
    try {
      if (isEditing && editingItem) {
        const updateInput: UpdateContentTrackingDataInput = {
          id: editingItem.id,
          exposure: Number(form.exposure) || 0,
          views: Number(form.views) || 0,
          likes: Number(form.likes) || 0,
          saves: Number(form.saves) || 0,
          comments: Number(form.comments) || 0,
          shares: Number(form.shares) || 0,
          completionRate: form.completionRate !== undefined ? Number(form.completionRate) : undefined,
          dataSource: form.dataSource as UpdateContentTrackingDataInput['dataSource'],
        }
        const result = await window.electronAPI.updateContentTrackingData(updateInput)
        if (result) {
          toast.success('数据已更新')
          onOpenChange(false)
          onSaved()
        } else {
          toast.error('更新失败')
        }
      } else {
        const createInput = form as CreateContentTrackingInput
        const result = await window.electronAPI.addContentTracking(createInput)
        if (result) {
          toast.success('数据已添加')
          onOpenChange(false)
          onSaved()
        } else {
          toast.error('添加失败')
        }
      }
    } catch (error) {
      console.error('[内容数据] 提交失败:', error)
      toast.error('提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  const inputClass = "w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-auto p-0">
        <DialogHeader className="px-6 pt-5 pb-3">
          <DialogTitle className="text-base flex items-center gap-2">
            {isEditing ? <Pencil className="w-5 h-5 text-primary" /> : <Plus className="w-5 h-5 text-primary" />}
            {isEditing ? '更新内容数据' : '添加内容数据'}
          </DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-6 space-y-4">
          {/* 达人信息 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium mb-1.5 block">达人名 <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={form.kolName ?? ''}
                onChange={(e) => setForm((prev) => ({ ...prev, kolName: e.target.value }))}
                placeholder="KOL 名称"
                className={inputClass}
                disabled={isEditing}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">KOL ID</label>
              <input
                type="text"
                value={form.kolId ?? ''}
                onChange={(e) => setForm((prev) => ({ ...prev, kolId: e.target.value }))}
                placeholder="可选"
                className={inputClass}
                disabled={isEditing}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium mb-1.5 block">平台 <span className="text-red-500">*</span></label>
              <select
                value={form.platform ?? 'xiaohongshu'}
                onChange={(e) => setForm((prev) => ({ ...prev, platform: e.target.value }))}
                className={inputClass}
                disabled={isEditing}
              >
                <option value="xiaohongshu">小红书</option>
                <option value="douyin">抖音</option>
                <option value="weibo">微博</option>
                <option value="bilibili">B站</option>
                <option value="kuaishou">快手</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">内容类型</label>
              <select
                value={form.contentType ?? 'organic'}
                onChange={(e) => setForm((prev) => ({ ...prev, contentType: e.target.value as CreateContentTrackingInput['contentType'] }))}
                className={inputClass}
              >
                <option value="organic">自然流</option>
                <option value="paid">付费</option>
                <option value="mixed">混合</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium mb-1.5 block">内容链接 <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={form.contentUrl ?? ''}
              onChange={(e) => setForm((prev) => ({ ...prev, contentUrl: e.target.value }))}
              placeholder="https://..."
              className={inputClass}
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-1.5 block">发布日期</label>
            <input
              type="date"
              value={form.publishDate ?? ''}
              onChange={(e) => setForm((prev) => ({ ...prev, publishDate: e.target.value }))}
              className={inputClass}
            />
          </div>

          <Separator />

          {/* 数据 */}
          <div className="grid grid-cols-3 gap-3">
            {([
              { key: 'exposure', label: '曝光', icon: Eye },
              { key: 'views', label: '浏览', icon: BarChart3 },
              { key: 'likes', label: '点赞', icon: Heart },
              { key: 'saves', label: '收藏', icon: Bookmark },
              { key: 'comments', label: '评论', icon: MessageSquare },
              { key: 'shares', label: '转发', icon: Share2 },
            ] as const).map(({ key, label }) => (
              <div key={key}>
                <label className="text-sm font-medium mb-1.5 block">{label}</label>
                <input
                  type="number"
                  min={0}
                  value={form[key] ?? 0}
                  onChange={(e) => setForm((prev) => ({ ...prev, [key]: Number(e.target.value) || 0 }))}
                  className={inputClass}
                />
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium mb-1.5 block">完播率 (%)</label>
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={form.completionRate ?? ''}
                onChange={(e) => setForm((prev) => ({ ...prev, completionRate: e.target.value === '' ? undefined : Number(e.target.value) }))}
                placeholder="可选"
                className={inputClass}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">数据来源</label>
              <select
                value={form.dataSource ?? 'manual'}
                onChange={(e) => setForm((prev) => ({ ...prev, dataSource: e.target.value as CreateContentTrackingInput['dataSource'] }))}
                className={inputClass}
              >
                <option value="manual">手动录入</option>
                <option value="api">API 获取</option>
                <option value="screenshot">截图识别</option>
                <option value="estimated">预估</option>
              </select>
            </div>
          </div>

          {!isEditing && (
            <div>
              <label className="text-sm font-medium mb-1.5 block">投放金额（可选）</label>
              <input
                type="number"
                min={0}
                value={form.paidSpend ?? ''}
                onChange={(e) => setForm((prev) => ({ ...prev, paidSpend: e.target.value === '' ? undefined : Number(e.target.value) }))}
                placeholder="如有投流，输入投放金额"
                className={inputClass}
              />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSubmit()}
              disabled={submitting || !form.kolName?.trim() || !form.contentUrl?.trim()}
            >
              {submitting ? (
                <>
                  <Clock className="w-4 h-4 animate-spin mr-1" />
                  保存中...
                </>
              ) : (
                <>
                  <SaveIcon className="w-4 h-4 mr-1" />
                  {isEditing ? '更新数据' : '添加数据'}
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SaveIcon(props: React.SVGProps<SVGSVGElement>): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  )
}

/* ===================== 投流追踪弹窗 ===================== */

interface PaidDataDialogProps {
  item: KOLContentTracking | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

function PaidDataDialog({ item, open, onOpenChange, onSaved }: PaidDataDialogProps): React.ReactElement | null {
  const [paidSpend, setPaidSpend] = React.useState(0)
  const [paidExposure, setPaidExposure] = React.useState(0)
  const [paidViews, setPaidViews] = React.useState(0)
  const [paidLikes, setPaidLikes] = React.useState(0)
  const [paidDataJson, setPaidDataJson] = React.useState('{}')
  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    if (item && open) {
      setPaidSpend(item.paidSpend || 0)
      setPaidExposure(item.paidExposure || 0)
      setPaidViews(item.paidViews || 0)
      setPaidLikes(item.paidLikes || 0)
      try {
        const parsed = item.paidData ? JSON.parse(item.paidData) : {}
        setPaidDataJson(JSON.stringify(parsed, null, 2))
      } catch {
        setPaidDataJson(item.paidData || '{}')
      }
    }
  }, [item, open])

  const handleSubmit = async () => {
    if (!item) return
    setSubmitting(true)
    try {
      let parsedPaidData: string
      try {
        const obj = JSON.parse(paidDataJson)
        parsedPaidData = JSON.stringify(obj)
      } catch {
        toast.error('投流数据 JSON 格式错误')
        setSubmitting(false)
        return
      }

      const input: AddPaidDataInput = {
        id: item.id,
        paidSpend: Number(paidSpend) || 0,
        paidExposure: Number(paidExposure) || 0,
        paidViews: Number(paidViews) || 0,
        paidLikes: Number(paidLikes) || 0,
        paidData: parsedPaidData,
      }
      const result = await window.electronAPI.addContentPaidData(input)
      if (result) {
        toast.success('投流数据已更新')
        onOpenChange(false)
        onSaved()
      } else {
        toast.error('更新失败')
      }
    } catch (error) {
      console.error('[投流追踪] 提交失败:', error)
      toast.error('提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  const inputClass = "w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"

  if (!item) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-auto p-0">
        <DialogHeader className="px-6 pt-5 pb-3">
          <DialogTitle className="text-base flex items-center gap-2">
            <Megaphone className="w-5 h-5 text-purple-500" />
            投流追踪 — {item.kolName}
          </DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-6 space-y-4">
          <div className="text-sm text-muted-foreground">
            内容：<a href={item.contentUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{item.contentUrl}</a>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium mb-1.5 block">投放金额 (¥)</label>
              <input
                type="number"
                min={0}
                value={paidSpend}
                onChange={(e) => setPaidSpend(Number(e.target.value) || 0)}
                className={inputClass}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">投流曝光</label>
              <input
                type="number"
                min={0}
                value={paidExposure}
                onChange={(e) => setPaidExposure(Number(e.target.value) || 0)}
                className={inputClass}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">投流浏览</label>
              <input
                type="number"
                min={0}
                value={paidViews}
                onChange={(e) => setPaidViews(Number(e.target.value) || 0)}
                className={inputClass}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">投流点赞</label>
              <input
                type="number"
                min={0}
                value={paidLikes}
                onChange={(e) => setPaidLikes(Number(e.target.value) || 0)}
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label className="text-sm font-medium mb-1.5 block">投流数据详情 (JSON)</label>
            <textarea
              value={paidDataJson}
              onChange={(e) => setPaidDataJson(e.target.value)}
              rows={6}
              placeholder={`{\n  "douplus_spend": 500,\n  "douplus_exposure": 2000,\n  "conversion_rate": 3.5\n}`}
              className={cn(inputClass, 'font-mono text-xs resize-y')}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSubmit()}
              disabled={submitting}
              className="bg-purple-600 hover:bg-purple-700 text-white"
            >
              {submitting ? (
                <>
                  <Clock className="w-4 h-4 animate-spin mr-1" />
                  保存中...
                </>
              ) : (
                <>
                  <Megaphone className="w-4 h-4 mr-1" />
                  保存投流数据
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ===================== AI 分析建议弹窗 ===================== */

interface AnalysisDialogProps {
  item: KOLContentTracking | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
  onAIAnalyze?: (item: KOLContentTracking) => void
}

function AnalysisDialog({ item, open, onOpenChange, onSaved, onAIAnalyze }: AnalysisDialogProps): React.ReactElement | null {
  const [performanceGrade, setPerformanceGrade] = React.useState<KOLContentTracking['performanceGrade']>('pending')
  const [recommendations, setRecommendations] = React.useState('')
  const [aiAnalysis, setAiAnalysis] = React.useState('')
  const [benchmarkComparison, setBenchmarkComparison] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    if (item && open) {
      setPerformanceGrade(item.performanceGrade)
      setRecommendations(item.recommendations || '')
      setAiAnalysis(item.aiAnalysis || '')
      setBenchmarkComparison(item.benchmarkComparison || '')
    }
  }, [item, open])

  const handleSubmit = async () => {
    if (!item) return
    setSubmitting(true)
    try {
      const input: UpdateAnalysisInput = {
        id: item.id,
        performanceGrade,
        benchmarkComparison,
        aiAnalysis,
        recommendations,
      }
      const result = await window.electronAPI.updateContentTrackingAnalysis(input)
      if (result) {
        toast.success('分析已更新')
        onOpenChange(false)
        onSaved()
      } else {
        toast.error('更新失败')
      }
    } catch (error) {
      console.error('[分析建议] 提交失败:', error)
      toast.error('提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleAIAnalyze = () => {
    if (item && onAIAnalyze) {
      onAIAnalyze(item)
      onOpenChange(false)
    }
  }

  const inputClass = "w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"

  if (!item) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-auto p-0">
        <DialogHeader className="px-6 pt-5 pb-3">
          <DialogTitle className="text-base flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-amber-500" />
            分析建议 — {item.kolName}
          </DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-6 space-y-4">
          {/* 快速数据概览 */}
          <div className="grid grid-cols-4 gap-2 p-3 rounded-lg bg-muted/30">
            <div className="text-center">
              <div className="text-xs text-muted-foreground">曝光</div>
              <div className="text-sm font-semibold">{formatNumber(item.exposure)}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-muted-foreground">CTR</div>
              <div className="text-sm font-semibold">{formatPercent(item.ctr)}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-muted-foreground">CPM</div>
              <div className="text-sm font-semibold">{formatMoney(item.cpm)}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-muted-foreground">CPE</div>
              <div className="text-sm font-semibold">{formatMoney(item.cpe)}</div>
            </div>
          </div>

          {/* 性能等级 */}
          <div>
            <label className="text-sm font-medium mb-1.5 block">性能等级</label>
            <div className="flex items-center gap-2">
              {(['excellent', 'good', 'normal', 'poor', 'pending'] as const).map((grade) => {
                const config = PERFORMANCE_GRADE_CONFIG[grade]
                const Icon = config.icon
                return (
                  <button
                    key={grade}
                    onClick={() => setPerformanceGrade(grade)}
                    className={cn(
                      'inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all',
                      performanceGrade === grade
                        ? config.color + ' ring-2 ring-offset-1 ring-primary/30'
                        : 'bg-background border-border text-muted-foreground hover:bg-muted/50'
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {config.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* AI 分析 */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm font-medium">AI 分析</label>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={handleAIAnalyze}
              >
                <Sparkles className="w-3.5 h-3.5 mr-1" />
                生成 AI 分析
              </Button>
            </div>
            <textarea
              value={aiAnalysis}
              onChange={(e) => setAiAnalysis(e.target.value)}
              rows={6}
              placeholder="AI 分析结果..."
              className={inputClass}
            />
          </div>

          {/* 标准对比 */}
          <div>
            <label className="text-sm font-medium mb-1.5 block">与标准对比</label>
            <textarea
              value={benchmarkComparison}
              onChange={(e) => setBenchmarkComparison(e.target.value)}
              rows={3}
              placeholder="与行业基准对比..."
              className={inputClass}
            />
          </div>

          {/* 建议 */}
          <div>
            <label className="text-sm font-medium mb-1.5 block">优化建议</label>
            <textarea
              value={recommendations}
              onChange={(e) => setRecommendations(e.target.value)}
              rows={4}
              placeholder="输入优化建议..."
              className={inputClass}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSubmit()}
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <Clock className="w-4 h-4 animate-spin mr-1" />
                  保存中...
                </>
              ) : (
                <>
                  <SaveIcon className="w-4 h-4 mr-1" />
                  保存分析
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ===================== 数据标准展示组件 ===================== */

function BenchmarkPanel(): React.ReactElement {
  const [platform, setPlatform] = React.useState('all')

  // 默认数据标准（前端硬编码作为参考，实际可从后端加载）
  const benchmarks = [
    { platform: 'xiaohongshu', priceTier: 'budget' as const, followersRange: '1k-10k' as const, metricName: 'ctr' as const, excellent: 8, good: 5, normal: 3, desc: '小红书素人 CTR 基准' },
    { platform: 'xiaohongshu', priceTier: 'mid' as const, followersRange: '10k-100k' as const, metricName: 'ctr' as const, excellent: 6, good: 4, normal: 2, desc: '小红书腰部 CTR 基准' },
    { platform: 'xiaohongshu', priceTier: 'premium' as const, followersRange: '100k-1m' as const, metricName: 'ctr' as const, excellent: 5, good: 3, normal: 1.5, desc: '小红书头部 CTR 基准' },
    { platform: 'xiaohongshu', priceTier: 'budget' as const, followersRange: '1k-10k' as const, metricName: 'engagement_rate' as const, excellent: 10, good: 6, normal: 3, desc: '小红书素人互动率基准' },
    { platform: 'xiaohongshu', priceTier: 'mid' as const, followersRange: '10k-100k' as const, metricName: 'engagement_rate' as const, excellent: 8, good: 5, normal: 2.5, desc: '小红书腰部互动率基准' },
    { platform: 'xiaohongshu', priceTier: 'budget' as const, followersRange: '1k-10k' as const, metricName: 'cpm' as const, excellent: 50, good: 100, normal: 200, desc: 'CPM 越低越好' },
    { platform: 'xiaohongshu', priceTier: 'mid' as const, followersRange: '10k-100k' as const, metricName: 'cpm' as const, excellent: 80, good: 150, normal: 300, desc: 'CPM 越低越好' },
    { platform: 'douyin', priceTier: 'budget' as const, followersRange: '1k-10k' as const, metricName: 'ctr' as const, excellent: 5, good: 3, normal: 1.5, desc: '抖音素人 CTR 基准' },
    { platform: 'douyin', priceTier: 'mid' as const, followersRange: '10k-100k' as const, metricName: 'ctr' as const, excellent: 4, good: 2.5, normal: 1.2, desc: '抖音腰部 CTR 基准' },
    { platform: 'douyin', priceTier: 'budget' as const, followersRange: '1k-10k' as const, metricName: 'engagement_rate' as const, excellent: 8, good: 5, normal: 2.5, desc: '抖音素人互动率基准' },
    { platform: 'douyin', priceTier: 'mid' as const, followersRange: '10k-100k' as const, metricName: 'engagement_rate' as const, excellent: 6, good: 4, normal: 2, desc: '抖音腰部互动率基准' },
    { platform: 'douyin', priceTier: 'budget' as const, followersRange: '1k-10k' as const, metricName: 'cpm' as const, excellent: 30, good: 60, normal: 120, desc: 'CPM 越低越好' },
  ]

  const filtered = platform === 'all' ? benchmarks : benchmarks.filter((b) => b.platform === platform)

  const metricLabels: Record<string, string> = {
    ctr: 'CTR (%)',
    engagement_rate: '互动率 (%)',
    cpm: 'CPM (¥)',
    cpe: 'CPE (¥)',
    exposure_rate: '曝光率 (%)',
  }

  const platformOptions = [
    { value: 'all', label: '全部平台' },
    { value: 'xiaohongshu', label: '小红书' },
    { value: 'douyin', label: '抖音' },
  ]

  return (
    <div className="rounded-xl bg-card shadow-sm border border-border/40 p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold flex items-center gap-2">
          <Target className="w-4 h-4 text-primary" />
          数据标准参考 (Benchmark)
        </h4>
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className="px-2 py-1 rounded-lg border border-border/60 bg-background text-xs focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          {platformOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-2 py-2 text-left font-medium text-muted-foreground">平台</th>
              <th className="px-2 py-2 text-left font-medium text-muted-foreground">价格带</th>
              <th className="px-2 py-2 text-left font-medium text-muted-foreground">粉丝范围</th>
              <th className="px-2 py-2 text-left font-medium text-muted-foreground">指标</th>
              <th className="px-2 py-2 text-right font-medium text-emerald-600">优秀</th>
              <th className="px-2 py-2 text-right font-medium text-amber-600">良好</th>
              <th className="px-2 py-2 text-right font-medium text-gray-500">合格</th>
              <th className="px-2 py-2 text-left font-medium text-muted-foreground">说明</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {filtered.map((b, i) => (
              <tr key={i} className="hover:bg-accent/20">
                <td className="px-2 py-2">{PLATFORM_LABEL[b.platform] ?? b.platform}</td>
                <td className="px-2 py-2">
                  <Badge variant="outline" className="text-[10px]">
                    {b.priceTier === 'budget' ? '素人' : b.priceTier === 'mid' ? '腰部' : b.priceTier === 'premium' ? '头部' : '顶级'}
                  </Badge>
                </td>
                <td className="px-2 py-2 text-muted-foreground">{b.followersRange}</td>
                <td className="px-2 py-2 font-medium">{metricLabels[b.metricName] ?? b.metricName}</td>
                <td className="px-2 py-2 text-right text-emerald-600 font-medium">{b.excellent}</td>
                <td className="px-2 py-2 text-right text-amber-600 font-medium">{b.good}</td>
                <td className="px-2 py-2 text-right text-gray-500">{b.normal}</td>
                <td className="px-2 py-2 text-muted-foreground">{b.desc}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-2 py-4 text-center text-muted-foreground">暂无数据标准</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ===================== 主组件 ===================== */

interface ContentTrackingManagerProps {
  campaignId: string
  onSendToAssistant?: (prompt: string) => void
}

export function ContentTrackingManager({ campaignId, onSendToAssistant }: ContentTrackingManagerProps): React.ReactElement {
  const [trackingList, setTrackingList] = React.useState<KOLContentTracking[]>([])
  const [loading, setLoading] = React.useState(false)
  const [platformFilter, setPlatformFilter] = React.useState('all')
  const [contentTypeFilter, setContentTypeFilter] = React.useState('all')
  const [performanceFilter, setPerformanceFilter] = React.useState('all')
  const [searchQuery, setSearchQuery] = React.useState('')
  const [showBenchmark, setShowBenchmark] = React.useState(false)

  // 弹窗状态
  const [addDialogOpen, setAddDialogOpen] = React.useState(false)
  const [editingItem, setEditingItem] = React.useState<KOLContentTracking | null>(null)
  const [paidDialogItem, setPaidDialogItem] = React.useState<KOLContentTracking | null>(null)
  const [paidDialogOpen, setPaidDialogOpen] = React.useState(false)
  const [analysisItem, setAnalysisItem] = React.useState<KOLContentTracking | null>(null)
  const [analysisDialogOpen, setAnalysisDialogOpen] = React.useState(false)
  const [deletingId, setDeletingId] = React.useState<string | null>(null)

  const loadData = React.useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.listContentTracking(campaignId)
      setTrackingList(result)
    } catch (error) {
      console.error('[内容数据] 加载失败:', error)
      toast.error('加载内容数据失败')
    } finally {
      setLoading(false)
    }
  }, [campaignId])

  React.useEffect(() => {
    loadData()
  }, [loadData])

  // 计算最大用于进度条
  const maxValues = React.useMemo(() => {
    if (trackingList.length === 0) return { exposure: 1, views: 1, likes: 1 }
    return {
      exposure: Math.max(...trackingList.map((t) => t.exposure), 1),
      views: Math.max(...trackingList.map((t) => t.views), 1),
      likes: Math.max(...trackingList.map((t) => t.likes), 1),
    }
  }, [trackingList])

  // 筛选
  const filteredList = React.useMemo(() => {
    return trackingList.filter((item) => {
      const matchPlatform = platformFilter === 'all' || item.platform === platformFilter
      const matchType = contentTypeFilter === 'all' || item.contentType === contentTypeFilter
      const matchPerf = performanceFilter === 'all' || item.performanceGrade === performanceFilter
      const matchSearch = searchQuery === '' ||
        item.kolName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.contentUrl.toLowerCase().includes(searchQuery.toLowerCase())
      return matchPlatform && matchType && matchPerf && matchSearch
    })
  }, [trackingList, platformFilter, contentTypeFilter, performanceFilter, searchQuery])

  // 唯一平台列表
  const platforms = React.useMemo(() => [...new Set(trackingList.map((t) => t.platform))], [trackingList])

  const handleDelete = async () => {
    if (!deletingId) return
    try {
      const success = await window.electronAPI.deleteContentTracking(deletingId)
      if (success) {
        toast.success('记录已删除')
        setDeletingId(null)
        loadData()
      } else {
        toast.error('删除失败')
      }
    } catch (error) {
      console.error('[内容数据] 删除失败:', error)
      toast.error('删除失败')
    }
  }

  const handleAIAnalyze = (item: KOLContentTracking) => {
    const prompt = `请分析以下 KOL 内容数据表现，并给出优化建议：

达人：@${item.kolName}
平台：${PLATFORM_LABEL[item.platform] ?? item.platform}
内容类型：${CONTENT_TYPE_LABEL[item.contentType] ?? item.contentType}

数据表现：
- 曝光：${formatNumber(item.exposure)}
- 浏览：${formatNumber(item.views)}
- CTR：${formatPercent(item.ctr)}
- 点赞：${formatNumber(item.likes)}
- 收藏：${formatNumber(item.saves)}
- 评论：${formatNumber(item.comments)}
- 转发：${formatNumber(item.shares)}
- 互动率：${formatPercent(item.engagementRate)}
- CPM：${formatMoney(item.cpm)}
- CPE：${formatMoney(item.cpe)}
${item.completionRate !== undefined ? `- 完播率：${formatPercent(item.completionRate)}` : ''}

${item.paidSpend > 0 ? `投流数据：\n- 投放金额：${formatMoney(item.paidSpend)}\n- 投流曝光：${formatNumber(item.paidExposure)}\n- 投流点赞：${formatNumber(item.paidLikes)}` : ''}

请从以下维度分析：
1. 数据表现与行业基准对比
2. 自然流 vs 投流效果（如有）
3. 内容优化建议
4. 投放策略建议`

    if (onSendToAssistant) {
      onSendToAssistant(prompt)
      toast.info('已在 Agent 中打开分析请求')
    } else {
      toast.info('AI 分析功能需要 Agent 支持')
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部操作栏 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            内容数据追踪
          </h3>
          <Badge variant="secondary" className="text-xs">
            {trackingList.length} 条
          </Badge>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowBenchmark((prev) => !prev)}
          >
            <Target className="w-4 h-4 mr-1" />
            {showBenchmark ? '隐藏标准' : '数据标准'}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setEditingItem(null)
              setAddDialogOpen(true)
            }}
          >
            <Plus className="w-4 h-4 mr-1" />
            添加内容数据
          </Button>
        </div>
      </div>

      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="搜索达人名或内容链接..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <select
          value={platformFilter}
          onChange={(e) => setPlatformFilter(e.target.value)}
          className="px-2 py-1.5 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          <option value="all">全部平台</option>
          {platforms.map((p) => (
            <option key={p} value={p}>{PLATFORM_LABEL[p] ?? p}</option>
          ))}
        </select>

        <select
          value={contentTypeFilter}
          onChange={(e) => setContentTypeFilter(e.target.value)}
          className="px-2 py-1.5 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          <option value="all">全部类型</option>
          <option value="organic">自然流</option>
          <option value="paid">付费</option>
          <option value="mixed">混合</option>
        </select>

        <select
          value={performanceFilter}
          onChange={(e) => setPerformanceFilter(e.target.value)}
          className="px-2 py-1.5 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          <option value="all">全部等级</option>
          <option value="excellent">优秀</option>
          <option value="good">良好</option>
          <option value="normal">正常</option>
          <option value="poor">需优化</option>
          <option value="pending">待分析</option>
        </select>
      </div>

      {/* 数据标准面板 */}
      {showBenchmark && <BenchmarkPanel />}

      {/* 数据列表 */}
      {loading && trackingList.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Clock className="w-5 h-5 animate-spin mr-2" />
          加载中...
        </div>
      ) : filteredList.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center border border-dashed border-border rounded-xl">
          <BarChart3 className="w-10 h-10 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            {trackingList.length === 0 ? '暂无内容数据，点击上方按钮添加' : '没有匹配的内容数据'}
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {filteredList.map((item) => (
            <TrackingCard
              key={item.id}
              item={item}
              onUpdate={(it) => {
                setEditingItem(it)
                setAddDialogOpen(true)
              }}
              onAddPaid={(it) => {
                setPaidDialogItem(it)
                setPaidDialogOpen(true)
              }}
              onViewAnalysis={(it) => {
                setAnalysisItem(it)
                setAnalysisDialogOpen(true)
              }}
              onDelete={(id) => setDeletingId(id)}
              onAIAnalyze={handleAIAnalyze}
              maxValues={maxValues}
            />
          ))}
        </div>
      )}

      {/* 弹窗 */}
      <DataFormDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        editingItem={editingItem}
        campaignId={campaignId}
        onSaved={() => {
          loadData()
          setEditingItem(null)
        }}
      />

      <PaidDataDialog
        item={paidDialogItem}
        open={paidDialogOpen}
        onOpenChange={(open) => {
          setPaidDialogOpen(open)
          if (!open) setPaidDialogItem(null)
        }}
        onSaved={loadData}
      />

      <AnalysisDialog
        item={analysisItem}
        open={analysisDialogOpen}
        onOpenChange={(open) => {
          setAnalysisDialogOpen(open)
          if (!open) setAnalysisItem(null)
        }}
        onSaved={loadData}
        onAIAnalyze={handleAIAnalyze}
      />

      {/* 删除确认 */}
      <AlertDialog open={!!deletingId} onOpenChange={(open) => { if (!open) setDeletingId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              删除后无法恢复，确定要删除这条内容数据追踪记录吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
