/**
 * AnalysisModuleView — 分析引擎工作区（免费版基础能力）
 *
 * 免费版能力 analysis-basic 的界面入口：生成并浏览时间使用、生产力与
 * 综合分析报告。数据源由主进程聚合（日程事件 + 任务表），本层只负责
 * 选择范围、触发生成与渲染报告。
 *
 * 边界：报告基于本地日程与任务数据统计得出，不包含健康、情绪、社交
 * 等维度（属于 Analysis Pro）。当数据为空时，报告会明确提示缺少数据，
 * 不会用推测数字填充。
 */
import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  BarChart3,
  Calendar,
  CheckCircle2,
  ClipboardList,
  Loader2,
  Sparkles,
  Trash2,
  TrendingUp,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AnalysisReport } from '@gravitas/shared'
import {
  analysisReportsAtom,
  activeAnalysisReportAtom,
  analysisTypeFilterAtom,
  analysisGeneratingAtom,
  analysisLoadingAtom,
  analysisErrorAtom,
  analysisNoticeAtom,
  analysisDateRangeAtom,
  filteredAnalysisReportsAtom,
  currentWeekRange,
  currentMonthRange,
  recentRange,
  loadAnalysisReports,
  generateReport,
  type AnalysisTypeFilter,
} from '@/atoms/analysis-atoms'
import { AnalysisSectionBody } from './AnalysisCharts'

/** 报告类型显示配置 */
const TYPE_META: Record<
  AnalysisReport['type'],
  { label: string; icon: typeof BarChart3; description: string }
> = {
  time: {
    label: '时间使用',
    icon: Calendar,
    description: '按分类统计日程时间分配与每日趋势',
  },
  productivity: {
    label: '生产力',
    icon: CheckCircle2,
    description: '任务完成率、优先级分布与逾期情况',
  },
  comprehensive: {
    label: '综合分析',
    icon: BarChart3,
    description: '时间使用与生产力合并报告',
  },
}

const TYPE_FILTERS: Array<{ id: AnalysisTypeFilter; label: string }> = [
  { id: null, label: '全部' },
  { id: 'time', label: '时间使用' },
  { id: 'productivity', label: '生产力' },
  { id: 'comprehensive', label: '综合分析' },
]

/** 格式化日期范围为可读文案 */
function formatPeriod(period: { start: string; end: string }): string {
  return `${period.start} ~ ${period.end}`
}

export function AnalysisModuleView(): React.ReactElement {
  const [reports, setReports] = useAtom(analysisReportsAtom)
  const [activeReport, setActiveReport] = useAtom(activeAnalysisReportAtom)
  const [typeFilter, setTypeFilter] = useAtom(analysisTypeFilterAtom)
  const [generating, setGenerating] = useAtom(analysisGeneratingAtom)
  const [loading, setLoading] = useAtom(analysisLoadingAtom)
  const [error, setError] = useAtom(analysisErrorAtom)
  const [notice, setNotice] = useAtom(analysisNoticeAtom)
  const [range, setRange] = useAtom(analysisDateRangeAtom)
  const filteredReports = useAtomValue(filteredAnalysisReportsAtom)

  const api = window.electronAPI?.analysis

  /** 拉取报告列表 */
  const load = React.useCallback(async () => {
    if (!api) return
    setLoading(true)
    setError(null)
    try {
      const list = await loadAnalysisReports()
      setReports(list)
      // 首次加载自动选中最新一份，避免右侧空着
      if (!activeReport && list.length > 0) {
        setActiveReport(list[0]!)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [api, setReports, setLoading, setError, activeReport, setActiveReport])

  // biome-ignore lint/correctness/useExhaustiveDependencies: load 随 activeReport 变化会导致切换报告时重复拉取，此 effect 仅挂载执行一次
  React.useEffect(() => {
    void load()
    // 仅在挂载时加载；后续刷新由生成/删除操作显式触发
  }, [])

  /** 生成报告 */
  const handleGenerate = async (type: AnalysisReport['type']): Promise<void> => {
    if (!api) return
    setGenerating(true)
    setError(null)
    setNotice(null)
    try {
      const report = await generateReport(type, range)
      setReports((prev) => [report, ...prev])
      setActiveReport(report)
      setNotice(`${TYPE_META[type].label}报告已生成（${formatPeriod(report.period)}）`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  /** 删除报告 */
  const handleDelete = async (report: AnalysisReport): Promise<void> => {
    if (!api) return
    const confirmed = window.confirm(`确定删除报告「${report.title}」？此操作不可撤销。`)
    if (!confirmed) return

    setError(null)
    try {
      const ok = await api.deleteReport(report.id)
      if (!ok) {
        setError('报告不存在或已被删除')
      }
      setReports((prev) => prev.filter((r) => r.id !== report.id))
      if (activeReport?.id === report.id) setActiveReport(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** 应用预设范围 */
  const applyPreset = (preset: 'week' | 'month' | '30d' | '7d'): void => {
    const next =
      preset === 'week'
        ? currentWeekRange()
        : preset === 'month'
          ? currentMonthRange()
          : preset === '7d'
            ? recentRange(7)
            : recentRange(30)
    setRange(next)
  }

  return (
    <div className="flex flex-col h-full">
      {/* 顶部：标题 + 生成操作 */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50 flex-shrink-0">
        <div className="flex items-center gap-2 text-[13px] font-medium text-foreground/75">
          <BarChart3 size={15} className="text-foreground/45" />
          分析引擎
        </div>
        <div className="flex-1" />
        <span className="text-[12px] text-foreground/45">
          范围 {range.startDate} ~ {range.endDate}
        </span>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* 左侧：生成面板 + 报告列表 */}
        <div className="w-80 border-r border-border/50 flex flex-col flex-shrink-0">
          {/* 时间范围选择 */}
          <div className="p-3 border-b border-border/50 space-y-2.5">
            <div className="text-[11px] font-medium text-foreground/45 tracking-wide">时间范围</div>
            <div className="flex gap-1.5">
              <Input
                type="date"
                value={range.startDate}
                onChange={(e) => setRange((prev) => ({ ...prev, startDate: e.target.value }))}
                className="h-7 text-[12px] px-2"
              />
              <Input
                type="date"
                value={range.endDate}
                onChange={(e) => setRange((prev) => ({ ...prev, endDate: e.target.value }))}
                className="h-7 text-[12px] px-2"
              />
            </div>
            <div className="flex flex-wrap gap-1">
              {(
                [
                  ['week', '本周'],
                  ['month', '本月'],
                  ['7d', '近 7 天'],
                  ['30d', '近 30 天'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => applyPreset(key)}
                  className="px-2 py-0.5 rounded text-[11px] bg-foreground/[0.05] text-foreground/60 hover:bg-foreground/[0.09] transition-colors"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* 生成按钮 */}
          <div className="p-3 border-b border-border/50 space-y-1.5">
            <div className="text-[11px] font-medium text-foreground/45 tracking-wide">生成报告</div>
            {(Object.keys(TYPE_META) as Array<AnalysisReport['type']>).map((type) => {
              const meta = TYPE_META[type]
              const Icon = meta.icon
              return (
                <button
                  key={type}
                  onClick={() => handleGenerate(type)}
                  disabled={!api || generating}
                  className="w-full flex items-start gap-2 px-2.5 py-2 rounded-md text-left hover:bg-foreground/[0.05] disabled:opacity-50 transition-colors"
                >
                  <Icon size={14} className="text-foreground/45 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-foreground/85">{meta.label}</div>
                    <div className="text-[11px] text-foreground/45 leading-snug">{meta.description}</div>
                  </div>
                </button>
              )
            })}
            {generating && (
              <div className="flex items-center gap-1.5 px-2.5 text-[11px] text-foreground/50">
                <Loader2 size={12} className="animate-spin" />
                正在生成…
              </div>
            )}
          </div>

          {/* 报告列表 */}
          <div className="px-3 py-2 flex items-center gap-1 border-b border-border/50">
            {TYPE_FILTERS.map(({ id, label }) => (
              <button
                key={label}
                onClick={() => setTypeFilter(id)}
                className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                  typeFilter === id
                    ? 'bg-primary/15 text-primary'
                    : 'text-foreground/55 hover:bg-foreground/[0.05]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {loading && reports.length === 0 ? (
              <div className="flex items-center justify-center py-12 text-foreground/40">
                <Loader2 size={16} className="animate-spin" />
              </div>
            ) : filteredReports.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
                <ClipboardList size={22} className="text-foreground/20" />
                <div className="text-[13px] text-foreground/50">
                  {reports.length === 0 ? '还没有报告' : '该类型下暂无报告'}
                </div>
                {reports.length === 0 && (
                  <p className="text-[11px] text-foreground/40 leading-relaxed">
                    选择时间范围后点击上方任一类型生成报告。
                  </p>
                )}
              </div>
            ) : (
              <div className="p-1.5 space-y-0.5">
                {filteredReports.map((report) => {
                  const Icon = TYPE_META[report.type].icon
                  return (
                    <div key={report.id} className="group flex items-center">
                      <button
                        onClick={() => setActiveReport(report)}
                        className={`flex-1 min-w-0 text-left px-2.5 py-2 rounded-md transition-colors ${
                          activeReport?.id === report.id
                            ? 'bg-foreground/[0.08]'
                            : 'hover:bg-foreground/[0.05]'
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          <Icon size={12} className="text-foreground/35 flex-shrink-0" />
                          <span className="text-[13px] text-foreground/85 truncate">
                            {TYPE_META[report.type].label}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-foreground/40 truncate">
                          {formatPeriod(report.period)}
                        </div>
                      </button>
                      <button
                        onClick={() => handleDelete(report)}
                        className="opacity-0 group-hover:opacity-100 p-1.5 rounded text-foreground/40 hover:text-destructive transition-all"
                        title="删除报告"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* 右侧：报告详情 */}
        <div className="flex-1 min-w-0 flex flex-col">
          {activeReport ? (
            <ReportDetail report={activeReport} onClose={() => setActiveReport(null)} />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-foreground/35">
              <BarChart3 size={28} className="text-foreground/20" />
              <div className="text-[13px]">选择左侧报告查看详情</div>
              <p className="max-w-xs text-center text-[11px] text-foreground/30 leading-relaxed">
                报告数据来自本地日程与任务记录，仅在生成时统计一次；数据变化后需重新生成。
              </p>
            </div>
          )}
        </div>
      </div>

      {/* 状态条 */}
      {(error || notice) && (
        <div
          className={`px-4 py-1.5 text-[12px] flex items-center gap-2 border-t border-border/50 ${
            error ? 'text-destructive' : 'text-foreground/60'
          }`}
        >
          <span className="flex-1 truncate">{error ?? notice}</span>
          <button
            onClick={() => {
              setError(null)
              setNotice(null)
            }}
            className="text-foreground/40 hover:text-foreground/70"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  )
}

/** 报告详情：摘要 + 各 section 图表 + 建议 */
function ReportDetail({
  report,
  onClose,
}: {
  report: AnalysisReport
  onClose: () => void
}): React.ReactElement {
  const Icon = TYPE_META[report.type].icon

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-start gap-3 px-5 py-3 border-b border-border/50 flex-shrink-0">
        <Icon size={16} className="text-foreground/45 mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <h2 className="text-[15px] font-medium text-foreground/90">{report.title}</h2>
          <div className="mt-0.5 text-[11px] text-foreground/45">
            生成于 {new Date(report.createdAt).toLocaleString('zh-CN')}
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded text-foreground/40 hover:text-foreground/70 hover:bg-foreground/[0.05]"
        >
          <X size={15} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
        {/* 摘要 */}
        <div className="rounded-lg bg-foreground/[0.03] px-3.5 py-3">
          <div className="text-[11px] font-medium text-foreground/45 mb-1.5">摘要</div>
          <p className="text-[13px] text-foreground/80 leading-relaxed">{report.summary}</p>
        </div>

        {/* 图表区 */}
        {report.sections.map((section) => (
          <div key={section.id} className="rounded-xl bg-card p-4 shadow-sm">
            <div className="text-[13px] font-medium text-foreground/80 mb-3">{section.title}</div>
            <AnalysisSectionBody
              type={section.type}
              chartType={section.chartType}
              data={section.data}
            />
            {section.insight && (
              <div className="mt-3 flex items-start gap-1.5 text-[12px] text-foreground/55 border-t border-border/40 pt-2.5">
                <TrendingUp size={12} className="mt-0.5 flex-shrink-0 text-foreground/40" />
                <span className="leading-relaxed">{section.insight}</span>
              </div>
            )}
          </div>
        ))}

        {/* 建议 */}
        {report.recommendations.length > 0 && (
          <div className="rounded-xl bg-primary/[0.06] p-4">
            <div className="flex items-center gap-1.5 text-[13px] font-medium text-foreground/80 mb-2.5">
              <Sparkles size={14} className="text-primary" />
              建议
            </div>
            <ul className="space-y-1.5">
              {report.recommendations.map((rec, idx) => (
                <li key={idx} className="flex items-start gap-2 text-[13px] text-foreground/75">
                  <span className="mt-1.5 w-1 h-1 rounded-full bg-primary/60 flex-shrink-0" />
                  <span className="leading-relaxed">{rec}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

export default AnalysisModuleView
