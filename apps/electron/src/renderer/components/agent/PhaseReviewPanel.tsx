/**
 * PhaseReviewPanel - 阶段复盘面板
 *
 * Slice 1: 展示阶段投放数据明细表格 + 汇总统计 + 报告生成
 * Slice 2: 添加 AI 复盘分析
 * Slice 3: 添加 AB 测试对比
 */

import * as React from 'react'
import { toast } from 'sonner'
import {
  TrendingUp, BarChart3, DollarSign, Eye, Heart, MessageSquare,
  Share2, Bookmark, Plus, FileText, Sparkles, Calendar, Users,
  ChevronDown, Trash2, CheckCircle
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import type { KOLContentTracking, CampaignPhaseReport } from '@gravitas/shared'

/* ===================== 辅助函数 ===================== */

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

const PLATFORM_LABEL: Record<string, string> = {
  xiaohongshu: '小红书',
  douyin: '抖音',
  weibo: '微博',
  bilibili: 'B站',
  kuaishou: '快手',
}

const PERFORMANCE_GRADE_LABEL: Record<string, string> = {
  excellent: '优秀',
  good: '良好',
  normal: '正常',
  poor: '需优化',
  pending: '待分析',
}

const PERFORMANCE_GRADE_COLOR: Record<string, string> = {
  excellent: 'text-emerald-600 bg-emerald-50 border-emerald-200',
  good: 'text-emerald-500 bg-emerald-50/70 border-emerald-100',
  normal: 'text-amber-600 bg-amber-50 border-amber-200',
  poor: 'text-red-600 bg-red-50 border-red-200',
  pending: 'text-gray-500 bg-gray-50 border-gray-200',
}


/* ===================== 统计卡片 ===================== */

interface StatCardProps {
  label: string
  value: string
  icon: React.ElementType
  accent?: boolean
}

function StatCard({ label, value, icon: Icon, accent }: StatCardProps): React.ReactElement {
  return (
    <div className={cn(
      'p-3 rounded-xl border text-center',
      accent ? 'border-primary/20 bg-primary/5' : 'border-border bg-background'
    )}>
      <div className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground mb-1">
        <Icon size={12} />
        {label}
      </div>
      <div className={cn('text-sm font-semibold', accent && 'text-primary')}>
        {value}
      </div>
    </div>
  )
}

/* ===================== 数据明细表格 ===================== */

interface DataTableProps {
  data: KOLContentTracking[]
}

function DataTable({ data }: DataTableProps): React.ReactElement {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center border border-dashed border-border rounded-xl">
        <BarChart3 size={32} className="text-muted-foreground/30 mb-2" />
        <p className="text-sm text-muted-foreground">暂无内容数据</p>
        <p className="text-xs text-muted-foreground/60 mt-1">请先前往「内容数据」Tab 添加数据</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-[11px]">
        <thead className="bg-muted/50">
          <tr>
            <th className="px-2 py-2 text-left font-medium text-muted-foreground whitespace-nowrap">日期</th>
            <th className="px-2 py-2 text-left font-medium text-muted-foreground whitespace-nowrap">KOL</th>
            <th className="px-2 py-2 text-left font-medium text-muted-foreground whitespace-nowrap">平台</th>
            <th className="px-2 py-2 text-right font-medium text-muted-foreground whitespace-nowrap">曝光</th>
            <th className="px-2 py-2 text-right font-medium text-muted-foreground whitespace-nowrap">浏览</th>
            <th className="px-2 py-2 text-right font-medium text-muted-foreground whitespace-nowrap">点赞</th>
            <th className="px-2 py-2 text-right font-medium text-muted-foreground whitespace-nowrap">收藏</th>
            <th className="px-2 py-2 text-right font-medium text-muted-foreground whitespace-nowrap">评论</th>
            <th className="px-2 py-2 text-right font-medium text-muted-foreground whitespace-nowrap">转发</th>
            <th className="px-2 py-2 text-right font-medium text-muted-foreground whitespace-nowrap">CPM</th>
            <th className="px-2 py-2 text-right font-medium text-muted-foreground whitespace-nowrap">CPE</th>
            <th className="px-2 py-2 text-right font-medium text-muted-foreground whitespace-nowrap">互动率</th>
            <th className="px-2 py-2 text-center font-medium text-muted-foreground whitespace-nowrap">等级</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40">
          {data.map((item) => (
            <tr key={item.id} className="hover:bg-accent/20">
              <td className="px-2 py-2 whitespace-nowrap text-muted-foreground">
                {item.publishDate || '-'}
              </td>
              <td className="px-2 py-2 font-medium whitespace-nowrap">
                {item.kolName}
              </td>
              <td className="px-2 py-2 whitespace-nowrap">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                  {PLATFORM_LABEL[item.platform] ?? item.platform}
                </span>
              </td>
              <td className="px-2 py-2 text-right whitespace-nowrap">{formatNumber(item.exposure)}</td>
              <td className="px-2 py-2 text-right whitespace-nowrap">{formatNumber(item.views)}</td>
              <td className="px-2 py-2 text-right whitespace-nowrap">{formatNumber(item.likes)}</td>
              <td className="px-2 py-2 text-right whitespace-nowrap">{formatNumber(item.saves)}</td>
              <td className="px-2 py-2 text-right whitespace-nowrap">{formatNumber(item.comments)}</td>
              <td className="px-2 py-2 text-right whitespace-nowrap">{formatNumber(item.shares)}</td>
              <td className="px-2 py-2 text-right whitespace-nowrap">{formatMoney(item.cpm)}</td>
              <td className="px-2 py-2 text-right whitespace-nowrap">{formatMoney(item.cpe)}</td>
              <td className="px-2 py-2 text-right whitespace-nowrap">{formatPercent(item.engagementRate)}</td>
              <td className="px-2 py-2 text-center whitespace-nowrap">
                <span className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded border',
                  PERFORMANCE_GRADE_COLOR[item.performanceGrade] ?? PERFORMANCE_GRADE_COLOR.pending
                )}>
                  {PERFORMANCE_GRADE_LABEL[item.performanceGrade] ?? '待分析'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ===================== AI 复盘展示 ===================== */

/** 三分决策的展示配置（保持放大 / 停止 / 新开始） */
const DECISION_META = {
  keep: { label: '保持放大', badge: 'text-emerald-600 bg-emerald-50 border-emerald-200', dot: 'bg-emerald-500' },
  stop: { label: '停止', badge: 'text-red-600 bg-red-50 border-red-200', dot: 'bg-red-500' },
  start: { label: '新开始', badge: 'text-blue-600 bg-blue-50 border-blue-200', dot: 'bg-blue-500' },
} as const

type DecisionKey = keyof typeof DECISION_META

interface AIReviewSectionProps {
  report: CampaignPhaseReport
}

function AIReviewSection({ report }: AIReviewSectionProps): React.ReactElement {
  return (
    <div className="space-y-4">
      {/* AI 总结 */}
      {report.aiSummary && (
        <div className="p-4 rounded-xl border border-primary/10 bg-primary/5">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles size={14} className="text-primary" />
            <span className="text-xs font-semibold text-primary">AI 复盘总结</span>
          </div>
          <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
            {report.aiSummary}
          </p>
        </div>
      )}

      {/* 决策总表：保持 / 停止 / 新开始（结论先行） */}
      {report.aiDecisions.length > 0 && (
        <div className="p-4 rounded-xl border border-border bg-background">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle size={14} className="text-foreground" />
            <span className="text-xs font-semibold">决策总表 · 保持 / 停止 / 新开始</span>
          </div>
          <div className="space-y-2">
            {report.aiDecisions.map((d, i) => {
              const meta = DECISION_META[(d.decision in DECISION_META ? d.decision : 'start') as DecisionKey]
              return (
                <div key={i} className="flex items-start gap-2 text-sm">
                  <span className={cn('mt-1.5 h-2 w-2 rounded-full flex-shrink-0', meta.dot)} />
                  <div className="min-w-0">
                    <span className={cn('text-[10px] px-1.5 py-0.5 rounded border mr-1.5 whitespace-nowrap', meta.badge)}>
                      {meta.label}
                    </span>
                    <span className="font-medium">{d.element}</span>
                    {d.evidence && <span className="text-muted-foreground"> · {d.evidence}</span>}
                    {d.reason && <div className="text-[12px] text-muted-foreground mt-0.5">{d.reason}</div>}
                    {d.nextAction && <div className="text-[12px] mt-0.5">→ {d.nextAction}</div>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* 核心发现 */}
        {report.aiFindings.length > 0 && (
          <div className="p-4 rounded-xl border border-border bg-background">
            <div className="flex items-center gap-2 mb-3">
              <BarChart3 size={14} className="text-blue-500" />
              <span className="text-xs font-semibold">核心发现</span>
            </div>
            <ul className="space-y-2">
              {report.aiFindings.map((finding, i) => (
                <li key={i} className="text-sm text-foreground flex items-start gap-2">
                  <span className="text-blue-500 mt-0.5 flex-shrink-0">•</span>
                  <span>{finding}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 优化建议 */}
        {report.aiRecommendations.length > 0 && (
          <div className="p-4 rounded-xl border border-border bg-background">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle size={14} className="text-emerald-500" />
              <span className="text-xs font-semibold">优化建议</span>
            </div>
            <ul className="space-y-2">
              {report.aiRecommendations.map((rec, i) => (
                <li key={i} className="text-sm text-foreground flex items-start gap-2">
                  <span className="text-emerald-500 mt-0.5 flex-shrink-0">•</span>
                  <span>{rec}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* 放量建议 */}
      {report.aiScaleAdvice && (
        <div className="p-4 rounded-xl border border-amber-200/60 bg-amber-50/30">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp size={14} className="text-amber-600" />
            <span className="text-xs font-semibold text-amber-700">放量建议</span>
          </div>
          <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
            {report.aiScaleAdvice}
          </p>
        </div>
      )}

      {/* 目标达成 */}
      <div className="flex flex-wrap gap-2">
        {report.cpmTarget > 0 && (
          <Badge
            variant="outline"
            className={cn(
              'text-xs',
              report.cpmTargetAchieved
                ? 'border-emerald-200 text-emerald-600 bg-emerald-50'
                : 'border-red-200 text-red-600 bg-red-50'
            )}
          >
            CPM 目标 {report.cpmTargetAchieved ? '✅' : '❌'}
          </Badge>
        )}
        {report.engagementTarget > 0 && (
          <Badge
            variant="outline"
            className={cn(
              'text-xs',
              report.engagementTargetAchieved
                ? 'border-emerald-200 text-emerald-600 bg-emerald-50'
                : 'border-red-200 text-red-600 bg-red-50'
            )}
          >
            互动率目标 {report.engagementTargetAchieved ? '✅' : '❌'}
          </Badge>
        )}
      </div>
    </div>
  )
}

/* ===================== 报告列表（支持选择）==================== */

interface ReportListProps {
  reports: CampaignPhaseReport[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onDelete: (id: string) => void
}

function ReportList({ reports, selectedId, onSelect, onDelete }: ReportListProps): React.ReactElement {
  if (reports.length === 0) {
    return (
      <div className="text-center py-6 text-muted-foreground text-sm">
        暂无复盘报告，点击上方「生成复盘报告」按钮创建
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {reports.map((report) => {
        const isSelected = selectedId === report.id
        return (
          <div key={report.id}>
            <div
              className={cn(
                'flex items-center gap-3 p-3 rounded-xl border transition-colors cursor-pointer',
                isSelected
                  ? 'border-primary/30 bg-primary/5'
                  : 'border-border bg-background hover:border-primary/20'
              )}
              onClick={() => onSelect(isSelected ? null : report.id)}
            >
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                <FileText size={14} className="text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    第 {report.phase} 阶段复盘
                  </span>
                  <span className={cn(
                    'text-[10px] px-1.5 py-0.5 rounded',
                    report.status === 'finalized'
                      ? 'bg-emerald-50 text-emerald-600 border border-emerald-200'
                      : 'bg-amber-50 text-amber-600 border border-amber-200'
                  )}>
                    {report.status === 'finalized' ? '已定稿' : '草稿'}
                  </span>
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {report.startDate} ~ {report.endDate} ·
                  {report.totalKols} 位 KOL · {report.totalPosts} 篇内容 ·
                  曝光 {formatNumber(report.totalExposure)}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-red-600 flex-shrink-0"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(report.id)
                }}
              >
                <Trash2 size={13} />
              </Button>
            </div>

            {/* 展开 AI 分析 */}
            {isSelected && (
              <div className="mt-2 ml-4">
                <AIReviewSection report={report} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ===================== 主组件 ===================== */

interface PhaseReviewPanelProps {
  campaignId: string
  currentPhase: number
}

export function PhaseReviewPanel({ campaignId, currentPhase }: PhaseReviewPanelProps): React.ReactElement {
  const [selectedPhase, setSelectedPhase] = React.useState(currentPhase)
  const [trackingData, setTrackingData] = React.useState<KOLContentTracking[]>([])
  const [reports, setReports] = React.useState<CampaignPhaseReport[]>([])
  const [loading, setLoading] = React.useState(false)
  const [generating, setGenerating] = React.useState(false)
  const [startDate, setStartDate] = React.useState('')
  const [endDate, setEndDate] = React.useState('')

  const [selectedReportId, setSelectedReportId] = React.useState<string | null>(null)

  // 计算默认日期范围（当前阶段的前30天）
  React.useEffect(() => {
    const end = new Date()
    const start = new Date()
    start.setDate(start.getDate() - 30)
    setEndDate(end.toISOString().split('T')[0] || '')
    setStartDate(start.toISOString().split('T')[0] || '')
  }, [])

  // 加载内容数据和报告
  const loadData = React.useCallback(async () => {
    setLoading(true)
    try {
      const [trackingResult, reportsResult] = await Promise.all([
        window.electronAPI.listContentTracking(campaignId),
        window.electronAPI.listPhaseReports(campaignId),
      ])
      setTrackingData(trackingResult)
      setReports(reportsResult)
    } catch (error) {
      console.error('[阶段复盘] 加载失败:', error)
      toast.error('加载数据失败')
    } finally {
      setLoading(false)
    }
  }, [campaignId])

  React.useEffect(() => {
    loadData()
  }, [loadData])

  // 按阶段筛选数据
  const phaseData = React.useMemo(() => {
    return trackingData.filter((item) => item.phase === selectedPhase || item.phase === 0)
  }, [trackingData, selectedPhase])

  // 计算汇总指标
  const stats = React.useMemo(() => {
    if (phaseData.length === 0) {
      return {
        totalKols: 0, totalPosts: 0, totalExposure: 0, totalViews: 0,
        totalCost: 0, avgCpm: 0, avgCpe: 0, avgEngagementRate: 0,
      }
    }

    const kolSet = new Set<string>()
    let totalExposure = 0, totalViews = 0, totalCost = 0
    let totalLikes = 0, totalSaves = 0, totalComments = 0, totalShares = 0

    for (const item of phaseData) {
      kolSet.add(item.kolId)
      totalExposure += item.exposure
      totalViews += item.views
      totalCost += (item.paidSpend || 0)
      totalLikes += item.likes
      totalSaves += item.saves
      totalComments += item.comments
      totalShares += item.shares
    }

    const safeExposure = Math.max(totalExposure, 1)
    const safeEngagement = Math.max(totalLikes + totalSaves + totalComments + totalShares, 1)

    return {
      totalKols: kolSet.size,
      totalPosts: phaseData.length,
      totalExposure,
      totalViews,
      totalCost,
      avgCpm: totalCost > 0 ? (totalCost / safeExposure) * 1000 : 0,
      avgCpe: totalCost > 0 ? totalCost / safeEngagement : 0,
      avgEngagementRate: (safeEngagement / safeExposure) * 100,
    }
  }, [phaseData])

  // 生成复盘报告
  const handleGenerateReport = async () => {
    if (!startDate || !endDate) {
      toast.error('请选择复盘时间范围')
      return
    }
    setGenerating(true)
    try {
      const report = await window.electronAPI.generatePhaseReport({
        campaignId,
        phase: selectedPhase,
        reportType: 'phase',
        startDate,
        endDate,
      })
      toast.success('复盘报告已生成')
      setReports((prev) => [report, ...prev])
    } catch (error) {
      console.error('[阶段复盘] 生成报告失败:', error)
      toast.error('生成报告失败')
    } finally {
      setGenerating(false)
    }
  }

  // 删除报告
  const handleDeleteReport = async (id: string) => {
    try {
      const success = await window.electronAPI.deletePhaseReport(id)
      if (success) {
        toast.success('报告已删除')
        setReports((prev) => prev.filter((r) => r.id !== id))
        if (selectedReportId === id) setSelectedReportId(null)
      } else {
        toast.error('删除失败')
      }
    } catch (error) {
      console.error('[阶段复盘] 删除报告失败:', error)
      toast.error('删除失败')
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 阶段选择 + 生成按钮 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="relative">
            <select
              value={selectedPhase}
              onChange={(e) => setSelectedPhase(Number(e.target.value))}
              className="h-8 pl-3 pr-8 text-xs rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/20 appearance-none cursor-pointer"
            >
              <option value={1}>第一阶段</option>
              <option value={2}>第二阶段</option>
              <option value={3}>第三阶段</option>
            </select>
            <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          </div>

          <div className="flex items-center gap-1">
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="h-8 px-2 text-xs rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <span className="text-xs text-muted-foreground">~</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="h-8 px-2 text-xs rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
        </div>

        <Button
          size="sm"
          onClick={() => void handleGenerateReport()}
          disabled={generating || loading}
          className="text-xs"
        >
          <Sparkles size={14} className="mr-1" />
          {generating ? '生成中...' : '生成复盘报告'}
        </Button>
      </div>

      {/* 数据总览卡片 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <StatCard
          label="参与 KOL"
          value={`${stats.totalKols} 位`}
          icon={Users}
        />
        <StatCard
          label="内容数量"
          value={`${stats.totalPosts} 篇`}
          icon={FileText}
        />
        <StatCard
          label="总曝光"
          value={formatNumber(stats.totalExposure)}
          icon={Eye}
          accent={stats.totalExposure > 0}
        />
        <StatCard
          label="总成本"
          value={formatMoney(stats.totalCost)}
          icon={DollarSign}
        />
        <StatCard
          label="平均 CPM"
          value={formatMoney(stats.avgCpm)}
          icon={BarChart3}
        />
        <StatCard
          label="平均 CPE"
          value={formatMoney(stats.avgCpe)}
          icon={Heart}
        />
        <StatCard
          label="平均互动率"
          value={formatPercent(stats.avgEngagementRate)}
          icon={TrendingUp}
          accent={stats.avgEngagementRate > 5}
        />
        <StatCard
          label="总浏览"
          value={formatNumber(stats.totalViews)}
          icon={Eye}
        />
      </div>

      {/* 数据明细表格 */}
      <div>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          数据明细
        </h3>
        {loading ? (
          <div className="text-sm text-muted-foreground py-8 text-center">加载中...</div>
        ) : (
          <DataTable data={phaseData} />
        )}
      </div>

      <Separator />

      {/* 复盘报告列表 */}
      <div>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          复盘报告
        </h3>
        <ReportList reports={reports} selectedId={selectedReportId} onSelect={setSelectedReportId} onDelete={handleDeleteReport} />
      </div>
    </div>
  )
}
