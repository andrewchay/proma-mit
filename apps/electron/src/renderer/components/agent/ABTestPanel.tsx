/**
 * ABTestPanel - AB 测试对比分析面板
 *
 * Slice 3: AB 对照组数据对比 + 放量建议
 */

import * as React from 'react'
import { toast } from 'sonner'
import {
  FlaskConical, Plus, TrendingUp, Target, Calendar, Users,
  DollarSign, Eye, Heart, MessageSquare, Share2, Bookmark,
  ArrowRight, CheckCircle, XCircle, Sparkles, ChevronDown,
  ChevronUp, Trash2, BarChart3, Award, AlertTriangle
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem
} from '@/components/ui/select'
import type { CampaignABTest, ABTestResult, CreateABTestInput } from '@gravitas/shared'

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

const VARIABLE_TYPE_LABEL: Record<string, string> = {
  content: '内容形式',
  kol_tier: 'KOL 层级',
  platform: '投放平台',
  timing: '投放时间',
  creative: '创意方向',
}

const STATUS_LABEL: Record<string, string> = {
  running: '进行中',
  completed: '已完成',
  cancelled: '已取消',
}

const STATUS_COLOR: Record<string, string> = {
  running: 'text-blue-600 bg-blue-50 border-blue-200',
  completed: 'text-emerald-600 bg-emerald-50 border-emerald-200',
  cancelled: 'text-gray-500 bg-gray-50 border-gray-200',
}

/* ===================== 对比指标卡片 ===================== */

interface ComparisonMetricCardProps {
  label: string
  controlValue: string
  testValue: string
  controlBetter: boolean
  significant?: boolean
}

function ComparisonMetricCard({ label, controlValue, testValue, controlBetter, significant }: ComparisonMetricCardProps): React.ReactElement {
  return (
    <div className="p-3 rounded-xl border border-border bg-background">
      <div className="text-[11px] text-muted-foreground mb-2">{label}</div>
      <div className="grid grid-cols-2 gap-2">
        <div className={cn(
          'p-2 rounded-lg text-center',
          controlBetter ? 'bg-emerald-50 border border-emerald-100' : 'bg-muted/50'
        )}>
          <div className="text-[10px] text-muted-foreground mb-0.5">对照组</div>
          <div className="text-sm font-semibold">{controlValue}</div>
        </div>
        <div className={cn(
          'p-2 rounded-lg text-center',
          !controlBetter ? 'bg-emerald-50 border border-emerald-100' : 'bg-muted/50'
        )}>
          <div className="text-[10px] text-muted-foreground mb-0.5">测试组</div>
          <div className="text-sm font-semibold">{testValue}</div>
        </div>
      </div>
      {significant !== undefined && (
        <div className={cn(
          'mt-2 text-[10px] text-center px-2 py-1 rounded',
          significant ? 'text-emerald-600 bg-emerald-50' : 'text-amber-600 bg-amber-50'
        )}>
          {significant ? '✓ 差异显著' : '差异不显著'}
        </div>
      )}
    </div>
  )
}

/* ===================== 显著性分析条 ===================== */

function SignificanceBar({ score }: { score: number }): React.ReactElement {
  const percentage = Math.min(Math.max(score * 100, 0), 100)
  let color = 'bg-red-500'
  if (percentage >= 95) color = 'bg-emerald-500'
  else if (percentage >= 80) color = 'bg-blue-500'
  else if (percentage >= 60) color = 'bg-amber-500'

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">置信度</span>
        <span className={cn('font-medium', percentage >= 95 ? 'text-emerald-600' : percentage >= 80 ? 'text-blue-600' : 'text-amber-600')}>
          {percentage.toFixed(1)}%
        </span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${percentage}%` }} />
      </div>
      <div className="text-[10px] text-muted-foreground">
        {percentage >= 95 ? '统计显著，可放心放量' : percentage >= 80 ? '较显著，建议扩大样本验证' : '样本不足或差异不明显，需继续观察'}
      </div>
    </div>
  )
}

/* ===================== 放量建议面板 ===================== */

function ScaleRecommendationPanel({ test }: { test: CampaignABTest }): React.ReactElement {
  if (test.status !== 'completed') {
    return (
      <div className="p-4 rounded-xl border border-dashed border-border bg-muted/30 text-center">
        <AlertTriangle size={20} className="text-amber-500 mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">测试进行中，请等待测试完成后再查看放量建议</p>
      </div>
    )
  }

  return (
    <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50/50 space-y-4">
      <div className="flex items-center gap-2">
        <Award size={16} className="text-emerald-600" />
        <span className="text-sm font-semibold text-emerald-800">放量建议</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="p-3 rounded-lg bg-white/80 border border-emerald-100">
          <div className="text-[10px] text-emerald-600/80 mb-1">优胜组</div>
          <div className="text-sm font-semibold text-emerald-800">
            {test.winnerGroup === 'control' ? '对照组' : test.winnerGroup === 'test' ? '测试组' : test.winnerGroup}
          </div>
        </div>
        <div className="p-3 rounded-lg bg-white/80 border border-emerald-100 md:col-span-2">
          <div className="text-[10px] text-emerald-600/80 mb-1">胜出原因</div>
          <div className="text-sm text-emerald-800">{test.winnerReason || '暂无分析'}</div>
        </div>
      </div>

      {test.scaleRecommendation && (
        <div className="p-3 rounded-lg bg-white/80 border border-emerald-100">
          <div className="text-[10px] text-emerald-600/80 mb-1">后续规划</div>
          <p className="text-sm text-emerald-800 whitespace-pre-wrap">{test.scaleRecommendation}</p>
        </div>
      )}
    </div>
  )
}

/* ===================== 创建弹窗 ===================== */

interface CreateABTestDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  campaignId: string
  currentPhase: number
  onCreated: () => void
}

function CreateABTestDialog({ open, onOpenChange, campaignId, currentPhase, onCreated }: CreateABTestDialogProps): React.ReactElement {
  const [loading, setLoading] = React.useState(false)
  const [form, setForm] = React.useState<CreateABTestInput>({
    campaignId,
    phase: currentPhase,
    testName: '',
    hypothesis: '',
    variableType: 'content',
    variableDescription: '',
    controlGroupDefinition: '',
    testGroupDefinition: '',
    startDate: '',
    endDate: '',
  })

  const handleSubmit = async (): Promise<void> => {
    if (!form.testName.trim() || !form.hypothesis.trim()) {
      toast.error('请填写测试名称和假设')
      return
    }
    setLoading(true)
    try {
      await window.electronAPI.createABTest(form)
      toast.success('AB 测试创建成功')
      onOpenChange(false)
      onCreated()
      setForm({
        campaignId,
        phase: currentPhase,
        testName: '',
        hypothesis: '',
        variableType: 'content',
        variableDescription: '',
        controlGroupDefinition: '',
        testGroupDefinition: '',
        startDate: '',
        endDate: '',
      })
    } catch (err) {
      toast.error(`创建失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical size={16} />
            创建 AB 测试
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">测试名称</Label>
            <Input
              className="h-9 text-sm"
              placeholder="例如：头图视频 vs 场景图对比测试"
              value={form.testName}
              onChange={(e) => setForm(f => ({ ...f, testName: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">测试假设</Label>
            <Textarea
              className="text-sm min-h-[60px]"
              placeholder="例如：使用场景图作为头图比产品图能获得更高的点击率"
              value={form.hypothesis}
              onChange={(e) => setForm(f => ({ ...f, hypothesis: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">变量类型</Label>
            <Select
              value={form.variableType}
              onValueChange={(v) => setForm(f => ({ ...f, variableType: v as CreateABTestInput['variableType'] }))}
            >
              <SelectTrigger className="h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="content">内容形式</SelectItem>
                <SelectItem value="kol_tier">KOL 层级</SelectItem>
                <SelectItem value="platform">投放平台</SelectItem>
                <SelectItem value="timing">投放时间</SelectItem>
                <SelectItem value="creative">创意方向</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">变量描述</Label>
            <Textarea
              className="text-sm min-h-[50px]"
              placeholder="描述具体在测试什么变量..."
              value={form.variableDescription}
              onChange={(e) => setForm(f => ({ ...f, variableDescription: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">对照组定义</Label>
              <Textarea
                className="text-sm min-h-[50px]"
                placeholder="对照组的具体配置..."
                value={form.controlGroupDefinition}
                onChange={(e) => setForm(f => ({ ...f, controlGroupDefinition: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">测试组定义</Label>
              <Textarea
                className="text-sm min-h-[50px]"
                placeholder="测试组的具体配置..."
                value={form.testGroupDefinition}
                onChange={(e) => setForm(f => ({ ...f, testGroupDefinition: e.target.value }))}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">开始日期</Label>
              <Input
                type="date"
                className="h-9 text-sm"
                value={form.startDate}
                onChange={(e) => setForm(f => ({ ...f, startDate: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">结束日期</Label>
              <Input
                type="date"
                className="h-9 text-sm"
                value={form.endDate}
                onChange={(e) => setForm(f => ({ ...f, endDate: e.target.value }))}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>取消</Button>
          <Button size="sm" onClick={handleSubmit} disabled={loading}>
            {loading ? '创建中...' : '创建测试'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ===================== 完成测试弹窗 ===================== */

interface CompleteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  test: CampaignABTest | null
  onComplete: (winnerGroup: string, winnerReason: string, scaleRecommendation: string) => void
}

function CompleteDialog({ open, onOpenChange, test, onComplete }: CompleteDialogProps): React.ReactElement {
  const [winnerGroup, setWinnerGroup] = React.useState('test')
  const [winnerReason, setWinnerReason] = React.useState('')
  const [scaleRecommendation, setScaleRecommendation] = React.useState('')

  React.useEffect(() => {
    if (open && test) {
      setWinnerGroup('test')
      setWinnerReason('')
      setScaleRecommendation('')
    }
  }, [open, test])

  if (!test) return <></>

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle size={16} className="text-emerald-500" />
            完成 AB 测试
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">优胜组</Label>
            <Select value={winnerGroup} onValueChange={setWinnerGroup}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="control">对照组</SelectItem>
                <SelectItem value="test">测试组</SelectItem>
                <SelectItem value="tie">平局/无显著差异</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">胜出原因</Label>
            <Textarea
              className="text-sm min-h-[60px]"
              placeholder="说明为什么该组表现更优..."
              value={winnerReason}
              onChange={(e) => setWinnerReason(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">放量建议 / 后续规划</Label>
            <Textarea
              className="text-sm min-h-[80px]"
              placeholder="基于测试结果，给出后续投放的放量建议..."
              value={scaleRecommendation}
              onChange={(e) => setScaleRecommendation(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>取消</Button>
          <Button size="sm" onClick={() => onComplete(winnerGroup, winnerReason, scaleRecommendation)}>
            确认完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ===================== 主面板 ===================== */

interface ABTestPanelProps {
  campaignId: string
  currentPhase: number
}

export function ABTestPanel({ campaignId, currentPhase }: ABTestPanelProps): React.ReactElement {
  const [abTests, setAbTests] = React.useState<CampaignABTest[]>([])
  const [results, setResults] = React.useState<ABTestResult[]>([])
  const [loading, setLoading] = React.useState(true)
  const [selectedTestId, setSelectedTestId] = React.useState<string | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = React.useState(false)
  const [completeDialogOpen, setCompleteDialogOpen] = React.useState(false)
  const [analyzing, setAnalyzing] = React.useState(false)
  const [expandedResults, setExpandedResults] = React.useState(false)

  const selectedTest = React.useMemo(() =>
    abTests.find(t => t.id === selectedTestId) ?? null,
    [abTests, selectedTestId]
  )

  const selectedResults = React.useMemo(() =>
    results.filter(r => r.abTestId === selectedTestId),
    [results, selectedTestId]
  )

  const controlResult = React.useMemo(() =>
    selectedResults.find(r => r.groupName === 'control'),
    [selectedResults]
  )

  const testResult = React.useMemo(() =>
    selectedResults.find(r => r.groupName === 'test'),
    [selectedResults]
  )

  const loadData = React.useCallback(async () => {
    try {
      setLoading(true)
      const tests = await window.electronAPI.listABTests(campaignId)
      setAbTests(tests)
      if (tests.length > 0 && !selectedTestId) {
        setSelectedTestId(tests[0]!.id)
      }
      // Load all results
      const allResults: ABTestResult[] = []
      for (const test of tests) {
        const res = await window.electronAPI.getABTestResults(test.id)
        allResults.push(...res)
      }
      setResults(allResults)
    } catch (err) {
      toast.error(`加载失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }, [campaignId, selectedTestId])

  React.useEffect(() => {
    loadData()
  }, [loadData])

  const handleDelete = async (id: string): Promise<void> => {
    if (!confirm('确定删除此 AB 测试？')) return
    try {
      await window.electronAPI.deleteABTest(id)
      toast.success('已删除')
      if (selectedTestId === id) setSelectedTestId(null)
      loadData()
    } catch (err) {
      toast.error(`删除失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleAnalyze = async (): Promise<void> => {
    if (!selectedTestId) return
    setAnalyzing(true)
    try {
      const { success, result, error } = await window.electronAPI.analyzeABTest(selectedTestId)
      if (success && result) {
        toast.success('AI 分析完成')
        setAbTests(prev => prev.map(t => t.id === result.id ? result : t))
      } else {
        toast.error(error || '分析失败')
      }
    } catch (err) {
      toast.error(`分析失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setAnalyzing(false)
    }
  }

  const handleComplete = async (winnerGroup: string, winnerReason: string, scaleRecommendation: string): Promise<void> => {
    if (!selectedTestId) return
    try {
      const updated = await window.electronAPI.completeABTest(selectedTestId, winnerGroup, winnerReason, scaleRecommendation)
      if (updated) {
        toast.success('测试已完成')
        setAbTests(prev => prev.map(t => t.id === updated.id ? updated : t))
      }
      setCompleteDialogOpen(false)
    } catch (err) {
      toast.error(`操作失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleUpdateResult = async (groupName: string, updates: Partial<ABTestResult>): Promise<void> => {
    if (!selectedTestId) return
    try {
      const result = await window.electronAPI.updateABTestResult({
        abTestId: selectedTestId,
        groupName,
        ...updates,
      } as import('@gravitas/shared').UpdateABTestResultInput)
      setResults(prev => prev.map(r => r.id === result.id ? result : r))
      toast.success('数据已更新')
    } catch (err) {
      toast.error(`更新失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (loading) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">加载中...</div>
    )
  }

  return (
    <div className="space-y-4">
      {/* 头部工具栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FlaskConical size={16} className="text-primary" />
          <span className="text-sm font-medium">AB 测试管理</span>
          <Badge variant="outline" className="text-[10px]">
            {abTests.length} 个测试
          </Badge>
        </div>
        <Button size="sm" variant="outline" onClick={() => setCreateDialogOpen(true)}>
          <Plus size={14} className="mr-1" />
          创建测试
        </Button>
      </div>

      {abTests.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center border border-dashed border-border rounded-xl">
          <FlaskConical size={32} className="text-muted-foreground/30 mb-2" />
          <p className="text-sm text-muted-foreground">暂无 AB 测试</p>
          <p className="text-xs text-muted-foreground/60 mt-1">创建测试来对比不同投放策略的效果</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => setCreateDialogOpen(true)}>
            <Plus size={14} className="mr-1" />
            创建测试
          </Button>
        </div>
      ) : (
        <>
          {/* 测试列表 */}
          <div className="flex gap-2 overflow-x-auto pb-1">
            {abTests.map((test) => (
              <button
                key={test.id}
                onClick={() => setSelectedTestId(test.id)}
                className={cn(
                  'flex-shrink-0 px-3 py-2 rounded-lg border text-left transition-all',
                  selectedTestId === test.id
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-background hover:border-primary/20'
                )}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-xs font-medium truncate max-w-[140px]">{test.testName}</span>
                  <span className={cn(
                    'text-[9px] px-1 py-0.5 rounded border',
                    STATUS_COLOR[test.status]
                  )}>
                    {STATUS_LABEL[test.status]}
                  </span>
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {VARIABLE_TYPE_LABEL[test.variableType]} · {test.startDate} ~ {test.endDate}
                </div>
              </button>
            ))}
          </div>

          {/* 选中测试详情 */}
          {selectedTest && (
            <div className="space-y-4">
              {/* 基本信息 */}
              <div className="p-4 rounded-xl border border-border bg-background">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Target size={14} className="text-primary" />
                    <span className="text-sm font-semibold">{selectedTest.testName}</span>
                    <Badge variant="outline" className={cn('text-[10px]', STATUS_COLOR[selectedTest.status])}>
                      {STATUS_LABEL[selectedTest.status]}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1">
                    {selectedTest.status === 'running' && (
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setCompleteDialogOpen(true)}>
                        <CheckCircle size={13} className="mr-1" />
                        完成测试
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground hover:text-red-500" onClick={() => handleDelete(selectedTest.id)}>
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                  <div className="space-y-2">
                    <div className="flex items-start gap-2">
                      <span className="text-[11px] text-muted-foreground w-14 flex-shrink-0">假设</span>
                      <span className="text-sm">{selectedTest.hypothesis}</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-[11px] text-muted-foreground w-14 flex-shrink-0">变量</span>
                      <span className="text-sm">{VARIABLE_TYPE_LABEL[selectedTest.variableType]} — {selectedTest.variableDescription}</span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-start gap-2">
                      <span className="text-[11px] text-muted-foreground w-14 flex-shrink-0">对照组</span>
                      <span className="text-sm text-muted-foreground">{selectedTest.controlGroupDefinition}</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-[11px] text-muted-foreground w-14 flex-shrink-0">测试组</span>
                      <span className="text-sm text-muted-foreground">{selectedTest.testGroupDefinition}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* 数据对比 */}
              <div className="p-4 rounded-xl border border-border bg-background">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <BarChart3 size={14} className="text-primary" />
                    <span className="text-sm font-semibold">数据对比</span>
                  </div>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setExpandedResults(!expandedResults)}>
                    {expandedResults ? <ChevronUp size={13} className="mr-1" /> : <ChevronDown size={13} className="mr-1" />}
                    {expandedResults ? '收起详情' : '编辑数据'}
                  </Button>
                </div>

                {expandedResults ? (
                  <div className="space-y-3">
                    {/* 可编辑的数据输入表格 */}
                    <div className="overflow-x-auto rounded-lg border border-border">
                      <table className="w-full text-[11px]">
                        <thead className="bg-muted/50">
                          <tr>
                            <th className="px-2 py-2 text-left font-medium">指标</th>
                            <th className="px-2 py-2 text-left font-medium">对照组</th>
                            <th className="px-2 py-2 text-left font-medium">测试组</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/40">
                          {[
                            { key: 'kolCount', label: 'KOL 数量' },
                            { key: 'postCount', label: '笔记数量' },
                            { key: 'totalCost', label: '总成本 (¥)', format: 'money' },
                            { key: 'totalExposure', label: '总曝光', format: 'number' },
                            { key: 'totalViews', label: '总阅读', format: 'number' },
                            { key: 'totalLikes', label: '总点赞', format: 'number' },
                            { key: 'totalSaves', label: '总收藏', format: 'number' },
                            { key: 'totalComments', label: '总评论', format: 'number' },
                            { key: 'totalShares', label: '总转发', format: 'number' },
                            { key: 'conversionCount', label: '转化数', format: 'number' },
                            { key: 'conversionRate', label: '转化率 (%)', format: 'percent' },
                          ].map((metric) => (
                            <tr key={metric.key}>
                              <td className="px-2 py-2 font-medium text-muted-foreground">{metric.label}</td>
                              <td className="px-2 py-2">
                                <Input
                                  className="h-7 text-[11px]"
                                  type="number"
                                  value={String(controlResult?.[metric.key as keyof ABTestResult] ?? '')}
                                  onChange={(e) => {
                                    const val = e.target.value === '' ? 0 : Number(e.target.value)
                                    handleUpdateResult('control', { [metric.key]: val })
                                  }}
                                />
                              </td>
                              <td className="px-2 py-2">
                                <Input
                                  className="h-7 text-[11px]"
                                  type="number"
                                  value={String(testResult?.[metric.key as keyof ABTestResult] ?? '')}
                                  onChange={(e) => {
                                    const val = e.target.value === '' ? 0 : Number(e.target.value)
                                    handleUpdateResult('test', { [metric.key]: val })
                                  }}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* 核心指标对比卡片 */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <ComparisonMetricCard
                        label="总曝光"
                        controlValue={formatNumber(controlResult?.totalExposure ?? 0)}
                        testValue={formatNumber(testResult?.totalExposure ?? 0)}
                        controlBetter={(controlResult?.totalExposure ?? 0) > (testResult?.totalExposure ?? 0)}
                        significant={controlResult && testResult ? controlResult.isSignificant || testResult.isSignificant : undefined}
                      />
                      <ComparisonMetricCard
                        label="总阅读"
                        controlValue={formatNumber(controlResult?.totalViews ?? 0)}
                        testValue={formatNumber(testResult?.totalViews ?? 0)}
                        controlBetter={(controlResult?.totalViews ?? 0) > (testResult?.totalViews ?? 0)}
                      />
                      <ComparisonMetricCard
                        label="总互动"
                        controlValue={formatNumber((controlResult?.totalLikes ?? 0) + (controlResult?.totalComments ?? 0) + (controlResult?.totalSaves ?? 0) + (controlResult?.totalShares ?? 0))}
                        testValue={formatNumber((testResult?.totalLikes ?? 0) + (testResult?.totalComments ?? 0) + (testResult?.totalSaves ?? 0) + (testResult?.totalShares ?? 0))}
                        controlBetter={((controlResult?.totalLikes ?? 0) + (controlResult?.totalComments ?? 0) + (controlResult?.totalSaves ?? 0) + (controlResult?.totalShares ?? 0)) > ((testResult?.totalLikes ?? 0) + (testResult?.totalComments ?? 0) + (testResult?.totalSaves ?? 0) + (testResult?.totalShares ?? 0))}
                      />
                      <ComparisonMetricCard
                        label="总成本"
                        controlValue={formatMoney(controlResult?.totalCost ?? 0)}
                        testValue={formatMoney(testResult?.totalCost ?? 0)}
                        controlBetter={(controlResult?.totalCost ?? 0) < (testResult?.totalCost ?? 0)}
                      />
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <ComparisonMetricCard
                        label="CPM"
                        controlValue={formatMoney(controlResult?.avgCpm ?? 0)}
                        testValue={formatMoney(testResult?.avgCpm ?? 0)}
                        controlBetter={(controlResult?.avgCpm ?? 0) < (testResult?.avgCpm ?? 0)}
                      />
                      <ComparisonMetricCard
                        label="CPE"
                        controlValue={formatMoney(controlResult?.avgCpe ?? 0)}
                        testValue={formatMoney(testResult?.avgCpe ?? 0)}
                        controlBetter={(controlResult?.avgCpe ?? 0) < (testResult?.avgCpe ?? 0)}
                      />
                      <ComparisonMetricCard
                        label="互动率"
                        controlValue={formatPercent(controlResult?.avgEngagementRate ?? 0)}
                        testValue={formatPercent(testResult?.avgEngagementRate ?? 0)}
                        controlBetter={(controlResult?.avgEngagementRate ?? 0) > (testResult?.avgEngagementRate ?? 0)}
                      />
                      <ComparisonMetricCard
                        label="转化率"
                        controlValue={formatPercent(controlResult?.conversionRate ?? 0)}
                        testValue={formatPercent(testResult?.conversionRate ?? 0)}
                        controlBetter={(controlResult?.conversionRate ?? 0) > (testResult?.conversionRate ?? 0)}
                      />
                    </div>

                    {/* 显著性分析 */}
                    {controlResult && testResult && (
                      <div className="p-3 rounded-xl border border-border bg-muted/30">
                        <div className="flex items-center gap-2 mb-3">
                          <TrendingUp size={14} className="text-blue-500" />
                          <span className="text-xs font-semibold">统计显著性分析</span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <SignificanceBar score={controlResult.significanceScore} />
                          <SignificanceBar score={testResult.significanceScore} />
                        </div>
                      </div>
                    )}

                    {/* 详细数据表 */}
                    <div className="overflow-x-auto rounded-lg border border-border">
                      <table className="w-full text-[11px]">
                        <thead className="bg-muted/50">
                          <tr>
                            <th className="px-2 py-2 text-left font-medium">指标</th>
                            <th className="px-2 py-2 text-right font-medium">对照组</th>
                            <th className="px-2 py-2 text-right font-medium">测试组</th>
                            <th className="px-2 py-2 text-right font-medium">差异</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/40">
                          {[
                            { label: 'KOL 数量', c: controlResult?.kolCount ?? 0, t: testResult?.kolCount ?? 0 },
                            { label: '笔记数量', c: controlResult?.postCount ?? 0, t: testResult?.postCount ?? 0 },
                            { label: '总成本', c: controlResult?.totalCost ?? 0, t: testResult?.totalCost ?? 0, money: true },
                            { label: '总曝光', c: controlResult?.totalExposure ?? 0, t: testResult?.totalExposure ?? 0 },
                            { label: '总阅读', c: controlResult?.totalViews ?? 0, t: testResult?.totalViews ?? 0 },
                            { label: '总点赞', c: controlResult?.totalLikes ?? 0, t: testResult?.totalLikes ?? 0 },
                            { label: '总收藏', c: controlResult?.totalSaves ?? 0, t: testResult?.totalSaves ?? 0 },
                            { label: '总评论', c: controlResult?.totalComments ?? 0, t: testResult?.totalComments ?? 0 },
                            { label: '总转发', c: controlResult?.totalShares ?? 0, t: testResult?.totalShares ?? 0 },
                            { label: '转化数', c: controlResult?.conversionCount ?? 0, t: testResult?.conversionCount ?? 0 },
                            { label: '转化率', c: controlResult?.conversionRate ?? 0, t: testResult?.conversionRate ?? 0, percent: true },
                          ].map((row) => {
                            const diff = row.t - row.c
                            const diffPercent = row.c !== 0 ? (diff / row.c) * 100 : 0
                            return (
                              <tr key={row.label}>
                                <td className="px-2 py-2 font-medium">{row.label}</td>
                                <td className="px-2 py-2 text-right">
                                  {row.money ? formatMoney(row.c) : row.percent ? formatPercent(row.c) : formatNumber(row.c)}
                                </td>
                                <td className="px-2 py-2 text-right">
                                  {row.money ? formatMoney(row.t) : row.percent ? formatPercent(row.t) : formatNumber(row.t)}
                                </td>
                                <td className={cn(
                                  'px-2 py-2 text-right font-medium',
                                  diff > 0 ? 'text-emerald-600' : diff < 0 ? 'text-red-600' : 'text-muted-foreground'
                                )}>
                                  {diff > 0 ? '+' : ''}{row.money ? formatMoney(diff) : row.percent ? formatPercent(diff) : formatNumber(diff)}
                                  {' '}( {diff > 0 ? '+' : ''}{diffPercent.toFixed(1)}% )
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>

              {/* AI 分析 + 放量建议 */}
              <div className="space-y-4">
                {selectedTest.status === 'running' && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    onClick={handleAnalyze}
                    disabled={analyzing}
                  >
                    <Sparkles size={13} className="mr-1" />
                    {analyzing ? 'AI 分析中...' : 'AI 智能分析'}
                  </Button>
                )}

                <ScaleRecommendationPanel test={selectedTest} />
              </div>
            </div>
          )}
        </>
      )}

      <CreateABTestDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        campaignId={campaignId}
        currentPhase={currentPhase}
        onCreated={loadData}
      />

      <CompleteDialog
        open={completeDialogOpen}
        onOpenChange={setCompleteDialogOpen}
        test={selectedTest}
        onComplete={handleComplete}
      />
    </div>
  )
}
