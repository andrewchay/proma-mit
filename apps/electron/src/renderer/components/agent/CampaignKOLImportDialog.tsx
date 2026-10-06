/**
 * CampaignKOLImportDialog - 导入 KOL 到候选池弹窗（优化版）
 *
 * 改进：
 * 1. 空状态提示 — 引导到 KOL 数据页面或营销工具
 * 2. 平台/类目筛选 — 新增下拉筛选
 * 3. 加载动画 — 使用旋转图标
 * 4. KOL 卡片信息展示 — 更丰富的字段展示
 * 5. 分组 — 按平台分组展示
 */

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Search, Check, User, RefreshCw, Database, ArrowRight, Filter, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { KOLSearchResult } from '@gravitas/shared'

interface CampaignKOLImportDialogProps {
  campaignId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: () => void
  onNavigateToKolData?: () => void
}

const PLATFORM_COLORS: Record<string, string> = {
  '小红书': 'bg-red-50 text-red-700 border-red-200',
  '抖音': 'bg-slate-900 text-white border-slate-700',
  '微博': 'bg-orange-50 text-orange-700 border-orange-200',
  'B站': 'bg-pink-50 text-pink-700 border-pink-200',
  '快手': 'bg-orange-50 text-orange-700 border-orange-200',
  '微信公众号': 'bg-green-50 text-green-700 border-green-200',
}

function PlatformBadge({ platform }: { platform: string }): React.ReactElement {
  const style = PLATFORM_COLORS[platform] ?? 'bg-gray-50 text-gray-700 border-gray-200'
  return (
    <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border', style)}>
      {platform}
    </span>
  )
}

export function CampaignKOLImportDialog({
  campaignId,
  open,
  onOpenChange,
  onImported,
  onNavigateToKolData,
}: CampaignKOLImportDialogProps): React.ReactElement {
  const [availableKOLs, setAvailableKOLs] = React.useState<KOLSearchResult>({ kols: [], total: 0 })
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
  const [loading, setLoading] = React.useState(false)
  const [importing, setImporting] = React.useState(false)
  const [searchKeyword, setSearchKeyword] = React.useState('')
  const [platformFilter, setPlatformFilter] = React.useState('')
  const [categoryFilter, setCategoryFilter] = React.useState('')

  // 加载可用 KOL
  const loadKOLs = React.useCallback(async () => {
    setLoading(true)
    const filters: {
      keywords?: string[]
      platform?: string
      category?: string
      limit?: number
    } = {}
    if (searchKeyword.trim()) {
      filters.keywords = searchKeyword.trim().split(/\s+/)
    }
    if (platformFilter) {
      filters.platform = platformFilter
    }
    if (categoryFilter) {
      filters.category = categoryFilter
    }
    filters.limit = 100

    try {
      const result = await window.electronAPI.listAvailableKOLs(
        Object.keys(filters).length > 0 ? filters : undefined
      )
      setAvailableKOLs(result)
    } catch (err) {
      console.error('[KOLImportDialog] 加载失败:', err)
      toast.error('加载 KOL 列表失败')
    } finally {
      setLoading(false)
    }
  }, [searchKeyword, platformFilter, categoryFilter])

  React.useEffect(() => {
    if (!open) return
    loadKOLs()
  }, [open, loadKOLs])

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const handleImport = async () => {
    if (selectedIds.size === 0) {
      toast.error('请至少选择一个 KOL')
      return
    }
    setImporting(true)
    try {
      const result = await window.electronAPI.importKOLsToPool({
        campaignId,
        kolIds: Array.from(selectedIds),
      })
      toast.success(`成功导入 ${result.imported} 个 KOL`)
      setSelectedIds(new Set())
      onOpenChange(false)
      onImported()
    } catch (error) {
      console.error('[KOLImportDialog] 导入失败:', error)
      toast.error('导入失败', { description: error instanceof Error ? error.message : '未知错误' })
    } finally {
      setImporting(false)
    }
  }

  const allSelected = availableKOLs.kols.length > 0 && selectedIds.size === availableKOLs.kols.length

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(availableKOLs.kols.map((k) => k.id)))
    }
  }

  // 从数据中推导唯一平台/类目列表
  const platforms = React.useMemo(
    () => [...new Set(availableKOLs.kols.map((k) => k.platform))].sort(),
    [availableKOLs.kols]
  )
  const categories = React.useMemo(
    () => [...new Set(availableKOLs.kols.map((k) => k.category).filter(Boolean))].sort(),
    [availableKOLs.kols]
  )

  // 按平台分组
  const groupedKOLs = React.useMemo(() => {
    const groups = new Map<string, typeof availableKOLs.kols>()
    for (const kol of availableKOLs.kols) {
      const list = groups.get(kol.platform) ?? []
      list.push(kol)
      groups.set(kol.platform, list)
    }
    return groups
  }, [availableKOLs.kols])

  const hasActiveFilters = searchKeyword || platformFilter || categoryFilter

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[85vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-5 pb-3">
          <DialogTitle className="text-base">导入 KOL 到候选池</DialogTitle>
        </DialogHeader>

        {/* 搜索 + 筛选栏 */}
        <div className="px-6 pb-3 space-y-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="搜索 KOL 名称、城市..."
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                className="pl-8 text-sm"
              />
              {searchKeyword && (
                <button
                  onClick={() => setSearchKeyword('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadKOLs()}
              disabled={loading}
              className="flex-shrink-0"
            >
              <RefreshCw size={14} className={cn('mr-1', loading && 'animate-spin')} />
              刷新
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Filter size={14} className="text-muted-foreground flex-shrink-0" />
            <select
              value={platformFilter}
              onChange={(e) => setPlatformFilter(e.target.value)}
              className="px-2 py-1.5 rounded-md border border-border/60 bg-background text-xs focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option value="">全部平台</option>
              {platforms.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="px-2 py-1.5 rounded-md border border-border/60 bg-background text-xs focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option value="">全部类目</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            {hasActiveFilters && (
              <button
                onClick={() => {
                  setSearchKeyword('')
                  setPlatformFilter('')
                  setCategoryFilter('')
                }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                清除筛选
              </button>
            )}
          </div>

          {/* 统计 */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              共 {availableKOLs.total} 个 KOL
              {selectedIds.size > 0 && (
                <span className="text-primary font-medium"> · 已选 {selectedIds.size} 个</span>
              )}
            </span>
            {availableKOLs.kols.length > 0 && (
              <Button variant="ghost" size="sm" onClick={toggleSelectAll} className="text-xs h-6 px-2">
                {allSelected ? '取消全选' : '全选'}
              </Button>
            )}
          </div>
        </div>

        {/* KOL 列表 */}
        <div className="flex-1 overflow-y-auto min-h-0 px-6 pb-4">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <RefreshCw className="w-5 h-5 animate-spin mr-2" />
              加载 KOL 数据中...
            </div>
          ) : availableKOLs.kols.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Database size={40} className="text-muted-foreground/20 mb-3" />
              <p className="text-sm font-medium text-foreground mb-1">暂无 KOL 数据</p>
              <p className="text-xs text-muted-foreground max-w-[320px] mb-4">
                KOL 数据库为空。请先通过「营销工具」采集 KOL 数据，或前往「KOL 数据」页面管理。
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onOpenChange(false)
                    onNavigateToKolData?.()
                  }}
                >
                  前往 KOL 数据页面
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onOpenChange(false)
                  }}
                >
                  关闭
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {[...groupedKOLs.entries()].map(([platform, kols]) => (
                <div key={platform}>
                  <div className="flex items-center gap-2 mb-2 sticky top-0 bg-background/95 backdrop-blur-sm py-1 z-10">
                    <PlatformBadge platform={platform} />
                    <span className="text-xs text-muted-foreground">({kols.length} 个)</span>
                  </div>
                  <div className="space-y-1">
                    {kols.map((kol) => {
                      const isSelected = selectedIds.has(kol.id)
                      return (
                        <button
                          key={kol.id}
                          onClick={() => toggleSelect(kol.id)}
                          className={cn(
                            'w-full flex items-center gap-3 p-3 rounded-xl border transition-all text-left',
                            isSelected
                              ? 'border-primary/40 bg-primary/5 shadow-[0_0_0_1px_rgba(var(--primary),0.1)]'
                              : 'border-border/60 bg-card hover:border-primary/25 hover:bg-accent/30'
                          )}
                        >
                          <div
                            className={cn(
                              'flex-shrink-0 w-5 h-5 rounded-md border flex items-center justify-center transition-colors',
                              isSelected
                                ? 'bg-primary border-primary text-primary-foreground'
                                : 'border-border bg-background'
                            )}
                          >
                            {isSelected && <Check size={12} />}
                          </div>
                          <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 text-sm font-medium text-primary">
                            {kol.name.charAt(0)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className="text-sm font-medium truncate">{kol.name}</span>
                              {kol.category && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">
                                  {kol.category}
                                </span>
                              )}
                              {kol.overallScore > 0 && (
                                <span className={cn(
                                  'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                                  kol.overallScore >= 80 ? 'bg-emerald-50 text-emerald-700' :
                                  kol.overallScore >= 60 ? 'bg-amber-50 text-amber-700' :
                                  kol.overallScore >= 40 ? 'bg-orange-50 text-orange-700' :
                                  'bg-red-50 text-red-700'
                                )}>
                                  综合 {kol.overallScore}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                              <span>{kol.followers || '-'} 粉丝</span>
                              <span className="text-border">|</span>
                              <span>{kol.engagement || '-'} 互动</span>
                              <span className="text-border">|</span>
                              <span>{kol.price || '-'} 报价</span>
                              {kol.city && (
                                <>
                                  <span className="text-border">|</span>
                                  <span>{kol.city}</span>
                                </>
                              )}
                            </div>
                          </div>
                          <ArrowRight
                            size={14}
                            className={cn(
                              'text-muted-foreground/30 flex-shrink-0 transition-colors',
                              isSelected && 'text-primary'
                            )}
                          />
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-border bg-background/95">
          <div className="text-xs text-muted-foreground">
            {selectedIds.size > 0 ? (
              <span className="text-primary font-medium">已选择 {selectedIds.size} 个 KOL</span>
            ) : (
              '请选择要导入的 KOL'
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              size="sm"
              onClick={() => void handleImport()}
              disabled={selectedIds.size === 0 || importing}
            >
              {importing ? '导入中...' : `导入 ${selectedIds.size > 0 ? selectedIds.size : ''}`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
