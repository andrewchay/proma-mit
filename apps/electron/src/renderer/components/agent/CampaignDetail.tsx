/**
 * CampaignDetail - Campaign 详情页
 *
 * Slice 2: 展示 Campaign 基本信息 + 三阶段进度。
 * Slice 3: 添加 KOL 候选池导入 + 展示。
 */

import * as React from 'react'
import { useSetAtom } from 'jotai'
import { ContentTrackingManager } from './ContentTrackingManager'
import { PhaseReviewPanel } from './PhaseReviewPanel'
import { ABTestPanel } from './ABTestPanel'
import { VideoAssetPanel } from './VideoAssetPanel'
import { ArrowLeft, Calendar, MapPin, Users, DollarSign, Plus, UserCheck, FileText, Rocket, ShieldCheck, BarChart3, TrendingUp, FlaskConical, Clapperboard, Archive, ArchiveRestore, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
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
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs'
import { CampaignBriefDialog } from './CampaignBriefDialog'
import { CampaignKOLImportDialog } from './CampaignKOLImportDialog'
import { ContentAuditDialog } from './ContentAuditDialog'
import { CampaignWorkflowSteps } from './CampaignWorkflowSteps'
import { FilePreviewDialog } from './FilePreviewDialog'
import { campaignsAtom } from '@/atoms/campaign-atoms'
import type { Campaign, CampaignKOLPoolItem } from '@gravitas/shared'

interface CampaignDetailProps {
  campaign: Campaign
  onBack: () => void
  onNavigateToKolData?: () => void
  onSendToAssistant?: (prompt: string) => void
}

const PLATFORM_LABEL: Record<string, string> = {
  xiaohongshu: '小红书',
  douyin: '抖音',
  dual: '双平台',
}

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  strategy: '策略制定',
  kol_selection: '达人筛选',
  negotiation: '商务洽谈',
  content_production: '内容制作',
  live: '投放执行',
  review: '复盘',
  completed: '已完成',
}

const POOL_STATUS_LABEL: Record<string, string> = {
  candidate: '候选',
  shortlisted: 'shortlisted',
  contacted: '已联系',
  confirmed: '已确认',
  rejected: '已拒绝',
}

// 阶段数据来自 campaign.phasePlans，不再硬编码品牌专属阶段文案。

export function CampaignDetail({ campaign: initialCampaign, onBack, onNavigateToKolData, onSendToAssistant }: CampaignDetailProps): React.ReactElement {
  const setCampaigns = useSetAtom(campaignsAtom)
  const [campaign, setCampaign] = React.useState(initialCampaign)
  const [poolKOLs, setPoolKOLs] = React.useState<CampaignKOLPoolItem[]>([])
  const [importDialogOpen, setImportDialogOpen] = React.useState(false)
  const [briefDialogOpen, setBriefDialogOpen] = React.useState(false)
  const [selectedBriefKOL, setSelectedBriefKOL] = React.useState<CampaignKOLPoolItem | null>(null)
  const [loadingPool, setLoadingPool] = React.useState(true)
  const [advancing, setAdvancing] = React.useState(false)
  const [archiving, setArchiving] = React.useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)

  // ... rest of the component

  // 内容审核状态
  const [auditDialogOpen, setAuditDialogOpen] = React.useState(false)
  const [selectedAuditKOL, setSelectedAuditKOL] = React.useState<CampaignKOLPoolItem | null>(null)
  const [auditHistoryOpen, setAuditHistoryOpen] = React.useState(false)
  const [auditHistory, setAuditHistory] = React.useState<import('@gravitas/shared').ContentAudit[]>([])
  const [loadingAudits, setLoadingAudits] = React.useState(false)

  // 文件预览状态
  const [previewFilePath, setPreviewFilePath] = React.useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = React.useState(false)

  React.useEffect(() => {
    setCampaign(initialCampaign)
  }, [initialCampaign])

  // 加载工作区路径（确保工作区存在即可）
  React.useEffect(() => {
    window.electronAPI
      .ensureCampaignWorkspace(campaign)
      .catch(console.error)
  }, [campaign])

  const applyCampaignUpdate = React.useCallback((updated: Campaign) => {
    setCampaign(updated)
    setCampaigns((prev) => prev.map((item) => item.id === updated.id ? updated : item))
  }, [setCampaigns])

  // 加载候选池 KOL
  React.useEffect(() => {
    setLoadingPool(true)
    window.electronAPI
      .getPoolKOLs(campaign.id)
      .then((list) => {
        setPoolKOLs(list)
      })
      .catch(console.error)
      .finally(() => setLoadingPool(false))
  }, [campaign.id])

  React.useEffect(() => {
    if (!auditHistoryOpen) return
    setLoadingAudits(true)
    window.electronAPI
      .listContentAudits(campaign.id)
      .then((list) => setAuditHistory(list))
      .catch(console.error)
      .finally(() => setLoadingAudits(false))
  }, [auditHistoryOpen, campaign.id])

  const handleImported = () => {
    window.electronAPI
      .getPoolKOLs(campaign.id)
      .then((list) => setPoolKOLs(list))
      .catch(console.error)
  }

  const handleAdvancePhase = async () => {
    if (campaign.currentPhase >= 3) {
      toast.info('已到达最后阶段')
      return
    }
    setAdvancing(true)
    try {
      const updated = await window.electronAPI.advanceCampaignPhase(campaign.id)
      if (updated) {
        applyCampaignUpdate(updated)
        const phaseName = updated.phasePlans[updated.currentPhase - 1]?.name ?? `第 ${updated.currentPhase} 阶段`
        toast.success(`已进入第 ${updated.currentPhase} 阶段：${phaseName}`)
      } else {
        toast.error('推进失败')
      }
    } catch (error) {
      console.error('[CampaignDetail] 推进失败:', error)
      toast.error('推进失败')
    } finally {
      setAdvancing(false)
    }
  }

  const handleToggleArchive = async () => {
    setArchiving(true)
    try {
      const updated = await window.electronAPI.setCampaignArchived(campaign.id, !campaign.archived)
      if (!updated) {
        toast.error('操作失败')
        return
      }
      applyCampaignUpdate(updated)
      toast.success(updated.archived ? '已归档' : '已取消归档')
    } catch (error) {
      console.error('[CampaignDetail] 归档操作失败:', error)
      toast.error('操作失败')
    } finally {
      setArchiving(false)
    }
  }

  const handleConfirmDelete = async () => {
    setDeleting(true)
    try {
      const ok = await window.electronAPI.deleteCampaign(campaign.id)
      if (!ok) {
        toast.error('删除失败')
        setDeleting(false)
        return
      }
      setCampaigns((prev) => prev.filter((item) => item.id !== campaign.id))
      toast.success('已删除 Campaign')
      onBack()
    } catch (error) {
      console.error('[CampaignDetail] 删除失败:', error)
      toast.error('删除失败')
      setDeleting(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
      {/* 头部 */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border titlebar-no-drag">
        <button
          onClick={onBack}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold truncate">{campaign.name}</h2>
            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-primary/10 text-primary font-medium">
              {PLATFORM_LABEL[campaign.platform]}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground font-medium">
              {STATUS_LABEL[campaign.status]}
            </span>
            {campaign.archived && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-600 font-medium">
                已归档
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => void handleToggleArchive()}
            disabled={archiving}
          >
            {campaign.archived ? <ArchiveRestore size={13} className="mr-1" /> : <Archive size={13} className="mr-1" />}
            {archiving ? '处理中...' : (campaign.archived ? '取消归档' : '归档')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-xs text-muted-foreground hover:text-destructive hover:border-destructive/40"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 size={13} className="mr-1" />
            删除
          </Button>
        </div>
      </div>

      {/* 基本信息卡片 */}
      <div className="p-5">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <div className="p-3 rounded-xl border border-border bg-background">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1">
              <DollarSign size={12} />
              总预算
            </div>
            <div className="text-sm font-semibold">{campaign.budget.toLocaleString()} 元</div>
          </div>
          <div className="p-3 rounded-xl border border-border bg-background">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1">
              <Calendar size={12} />
              投放周期
            </div>
            <div className="text-sm font-semibold">{campaign.durationMonths} 个月</div>
          </div>
          <div className="p-3 rounded-xl border border-border bg-background">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1">
              <MapPin size={12} />
              目标城市
            </div>
            <div className="text-sm font-semibold truncate">
              {campaign.targetCity.length > 0 ? campaign.targetCity.join('、') : '未指定'}
            </div>
          </div>
          <div className="p-3 rounded-xl border border-border bg-background">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1">
              <Users size={12} />
              品牌
            </div>
            <div className="text-sm font-semibold truncate">{campaign.brand}</div>
          </div>
        </div>

        {/* 目标人群 */}
        {campaign.targetAudience && (
          <div className="mb-5 p-3 rounded-xl border border-border bg-background">
            <div className="text-[11px] text-muted-foreground mb-1">目标人群</div>
            <div className="text-sm">{campaign.targetAudience}</div>
          </div>
        )}

        {/* 工作流步骤 */}
        <div className="mb-5">
          <CampaignWorkflowSteps
            campaignId={campaign.id}
            campaignName={campaign.name}
            campaignContext={{
              brand: campaign.brand,
              platform: campaign.platform,
              budget: campaign.budget.toString(),
              targetCity: campaign.targetCity.join('、'),
              targetAudience: campaign.targetAudience,
              durationMonths: campaign.durationMonths.toString(),
            }}
            onOpenInAgent={(prompt) => onSendToAssistant?.(prompt)}
          />
        </div>

        {/* 三阶段进度 */}
        <div className="mb-5">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            投放阶段
          </h3>
          <div className="space-y-3">
            {campaign.phasePlans.map((phase) => {
              const isActive = phase.phase === campaign.currentPhase
              const isCompleted = phase.phase < campaign.currentPhase
              return (
                <div
                  key={phase.phase}
                  className={cn(
                    'flex items-start gap-3 p-3 rounded-xl border transition-all',
                    isActive
                      ? 'border-primary/30 bg-primary/5'
                      : isCompleted
                        ? 'border-border/60 bg-muted/20'
                        : 'border-border bg-background'
                  )}
                >
                  <div
                    className={cn(
                      'flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold',
                      isActive
                        ? 'bg-primary text-primary-foreground'
                        : isCompleted
                          ? 'bg-primary/20 text-primary'
                          : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {isCompleted ? '✓' : phase.phase}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className={cn(
                        'text-sm font-medium',
                        isActive ? 'text-foreground' : isCompleted ? 'text-foreground/70' : 'text-muted-foreground'
                      )}>
                        {phase.name}
                      </span>
                      <span className="text-[11px] text-muted-foreground">{phase.months}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{phase.goal}</p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* 创意策略 */}
        <div className="mb-5">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            创意策略
          </h3>
          <div className="p-3 rounded-xl border border-border bg-background">
            <div className="text-sm font-semibold">{campaign.creativePlan.bigIdea}</div>
            <p className="text-xs text-muted-foreground mt-1">{campaign.creativePlan.coreMessage}</p>
            <div className="flex flex-wrap gap-1.5 mt-3">
              {campaign.creativePlan.contentPillars.map((pillar) => (
                <span key={pillar} className="px-2 py-1 rounded-md bg-muted text-[10px] text-muted-foreground">
                  {pillar}
                </span>
              ))}
            </div>
            <div className="text-[11px] text-muted-foreground mt-3">
              语气：{campaign.creativePlan.tone}
            </div>
          </div>
        </div>

        {/* 预算分配 + 推进按钮 */}
        <div className="mb-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              预算分配
            </h3>
            {campaign.currentPhase < 3 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleAdvancePhase()}
                disabled={advancing}
                className="text-xs border-primary/30 text-primary hover:bg-primary/5"
              >
                <Rocket size={13} className="mr-1" />
                {advancing ? '推进中...' : '推进到下一阶段'}
              </Button>
            )}
            {campaign.currentPhase >= 3 && (
              <span className="text-[10px] text-muted-foreground px-2 py-1 rounded bg-muted">
                全部阶段已完成
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {campaign.phasePlans.map((phase) => {
              const isActive = phase.phase === campaign.currentPhase
              return (
                <div
                  key={phase.phase}
                  className={cn(
                    'p-3 rounded-xl border text-center',
                    isActive ? 'border-primary/20 bg-primary/5' : 'border-border bg-background'
                  )}
                >
                  <div className="text-[11px] text-muted-foreground mb-1">{phase.name}</div>
                  <div className="text-sm font-semibold">{phase.budget.toLocaleString()} 元</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {phase.months}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* KOL 候选池 + 内容数据 — Tabs */}
        <div>
          <Tabs defaultValue="kol-pool" className="w-full">
            <div className="flex items-center justify-between mb-3">
              <TabsList className="h-8">
                <TabsTrigger value="kol-pool" className="text-xs gap-1">
                  <UserCheck className="w-3.5 h-3.5" />
                  KOL 候选池
                </TabsTrigger>
                <TabsTrigger value="content-tracking" className="text-xs gap-1">
                  <BarChart3 className="w-3.5 h-3.5" />
                  内容数据
                </TabsTrigger>
                <TabsTrigger value="phase-review" className="text-xs gap-1">
                  <TrendingUp className="w-3.5 h-3.5" />
                  阶段复盘
                </TabsTrigger>
                <TabsTrigger value="ab-test" className="text-xs gap-1">
                  <FlaskConical className="w-3.5 h-3.5" />
                  AB 测试
                </TabsTrigger>
                <TabsTrigger value="video-assets" className="text-xs gap-1">
                  <Clapperboard className="w-3.5 h-3.5" />
                  视频素材
                </TabsTrigger>
              </TabsList>
              <Button size="sm" variant="outline" onClick={() => setImportDialogOpen(true)}>
                <Plus size={14} className="mr-1" />
                导入 KOL
              </Button>
            </div>

            <TabsContent value="kol-pool" className="mt-0">
              {loadingPool ? (
                <div className="text-sm text-muted-foreground py-8 text-center">加载中...</div>
              ) : poolKOLs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-center border border-dashed border-border rounded-xl">
                  <UserCheck size={32} className="text-muted-foreground/30 mb-2" />
                  <p className="text-sm text-muted-foreground">暂无 KOL 在候选池</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">点击上方按钮导入 KOL</p>
                </div>
              ) : (
                <div className="grid gap-2">
                  {poolKOLs.map((kol) => (
                    <div
                      key={kol.kolId}
                      className="flex items-center gap-3 p-3 rounded-xl border border-border bg-background hover:border-primary/20 transition-colors"
                    >
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 text-xs font-medium text-primary">
                        {kol.name.charAt(0)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{kol.name}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                            {kol.platform}
                          </span>
                          <span className={cn(
                            'text-[10px] px-1.5 py-0.5 rounded font-medium',
                            kol.status === 'confirmed' ? 'bg-green-500/10 text-green-600' :
                            kol.status === 'contacted' ? 'bg-blue-500/10 text-blue-600' :
                            kol.status === 'shortlisted' ? 'bg-amber-500/10 text-amber-600' :
                            kol.status === 'rejected' ? 'bg-red-500/10 text-red-600' :
                            'bg-gray-500/10 text-gray-600'
                          )}>
                            {POOL_STATUS_LABEL[kol.status] ?? kol.status}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {kol.followers} 粉丝 · {kol.engagement} 互动率 · {kol.category}
                          {kol.city && ` · ${kol.city}`}
                          {kol.price && ` · ${kol.price}`}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-primary flex-shrink-0"
                        onClick={() => {
                          setSelectedBriefKOL(kol)
                          setBriefDialogOpen(true)
                        }}
                      >
                        <FileText size={13} className="mr-1" />
                        Brief
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-emerald-600 flex-shrink-0"
                        onClick={() => {
                          setSelectedAuditKOL(kol)
                          setAuditDialogOpen(true)
                        }}
                      >
                        <ShieldCheck size={13} className="mr-1" />
                        审核
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="content-tracking" className="mt-0">
              <ContentTrackingManager
                campaignId={campaign.id}
                onSendToAssistant={onSendToAssistant}
              />
            </TabsContent>

            <TabsContent value="phase-review" className="mt-0">
              <PhaseReviewPanel
                campaignId={campaign.id}
                currentPhase={campaign.currentPhase}
              />
            </TabsContent>

            <TabsContent value="ab-test" className="mt-0">
              <ABTestPanel
                campaignId={campaign.id}
                currentPhase={campaign.currentPhase}
              />
            </TabsContent>

            <TabsContent value="video-assets" className="mt-0">
              <VideoAssetPanel
                campaignId={campaign.id}
                onSendToAssistant={onSendToAssistant}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <CampaignKOLImportDialog
        campaignId={campaign.id}
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        onImported={handleImported}
        onNavigateToKolData={onNavigateToKolData}
      />

      {selectedBriefKOL && (
        <CampaignBriefDialog
          campaign={campaign}
          kol={selectedBriefKOL}
          open={briefDialogOpen}
          onOpenChange={(open) => {
            setBriefDialogOpen(open)
            if (!open) setSelectedBriefKOL(null)
          }}
        />
      )}

      {selectedAuditKOL && (
        <ContentAuditDialog
          campaign={campaign}
          kol={selectedAuditKOL}
          open={auditDialogOpen}
          onOpenChange={(open) => {
            setAuditDialogOpen(open)
            if (!open) setSelectedAuditKOL(null)
          }}
          onAudited={() => {
            window.electronAPI.listContentAudits(campaign.id)
              .then((list) => setAuditHistory(list))
              .catch(console.error)
          }}
        />
      )}

      <FilePreviewDialog
        filePath={previewFilePath}
        open={previewOpen}
        onOpenChange={(open) => {
          setPreviewOpen(open)
          if (!open) setPreviewFilePath(null)
        }}
      />

      {/* 删除 Campaign 确认弹窗 */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除 Campaign</AlertDialogTitle>
            <AlertDialogDescription>
              将删除项目「{campaign.name}」及其所有关联数据（候选池、Brief、内容追踪、阶段复盘、视频素材、工作区目录）。删除后可在回收站恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? '删除中...' : '删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  )
}
