/**
 * KOL 数据管理模块
 *
 * 展示 KOL 数据库中所有 KOL，支持：
 * - 搜索（按名称、平台、类目）
 * - 编辑 KOL 信息（含扩展数据编辑）
 * - 查看 KOL 详情（扩展数据维度面板）
 * - 删除 KOL
 * - 刷新数据
 * - 评分筛选与排序
 */

import * as React from 'react'
import { toast } from 'sonner'
import {
  Search, Pencil, Trash2, RefreshCw, X, Save, Users, Database,
  Eye, BarChart3, TrendingUp, MessageSquare, Tag, AlertTriangle,
  ChevronDown, ChevronUp, Star, DollarSign, Heart, Clock, Megaphone,
  MapPin, SlidersHorizontal
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { KOLListItem, KOLExtendedData } from '@gravitas/shared'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
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
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible'

// 平台颜色映射
const PLATFORM_COLORS: Record<string, string> = {
  '小红书': 'bg-red-50 text-red-700 border-red-200',
  '抖音': 'bg-slate-900 text-white border-slate-700',
  '微博': 'bg-orange-50 text-orange-700 border-orange-200',
  'B站': 'bg-pink-50 text-pink-700 border-pink-200',
  '快手': 'bg-orange-50 text-orange-700 border-orange-200',
  '微信公众号': 'bg-green-50 text-green-700 border-green-200',
}

/* ===================== 辅助组件 ===================== */

function ScoreBadge({ score, label, size = 'sm' }: { score: number; label: string; size?: 'sm' | 'md' | 'lg' }): React.ReactElement {
  const getScoreColor = (s: number): string => {
    if (s >= 80) return 'text-emerald-600 bg-emerald-50 border-emerald-200'
    if (s >= 60) return 'text-amber-600 bg-amber-50 border-amber-200'
    if (s >= 40) return 'text-orange-600 bg-orange-50 border-orange-200'
    return 'text-red-600 bg-red-50 border-red-200'
  }
  const sizeClasses = {
    sm: 'text-xs px-2 py-0.5',
    md: 'text-sm px-3 py-1',
    lg: 'text-base px-4 py-1.5',
  }
  return (
    <div className="flex flex-col items-center min-w-[40px]">
      <div className={cn('font-semibold rounded-full border', sizeClasses[size], getScoreColor(score))}>
        {score}
      </div>
      <span className={cn('text-muted-foreground mt-0.5', size === 'sm' ? 'text-[10px]' : 'text-xs')}>{label}</span>
    </div>
  )
}

function ScoreCard({ score, label, icon: Icon }: { score: number; label: string; icon?: React.ElementType }): React.ReactElement {
  const colorClass = score >= 80 ? 'text-emerald-600' : score >= 60 ? 'text-amber-600' : 'text-red-600'
  const bgClass = score >= 80 ? 'bg-emerald-50/80' : score >= 60 ? 'bg-amber-50/80' : 'bg-red-50/80'
  return (
    <div className={cn('flex flex-col items-center p-3 rounded-xl', bgClass)}>
      {Icon && <Icon className={cn('w-4 h-4 mb-1', colorClass)} />}
      <div className={cn('text-2xl font-bold', colorClass)}>{score}</div>
      <span className="text-xs text-muted-foreground mt-0.5">{label}</span>
    </div>
  )
}

function QualifyBadge({ value, threshold, excellentThreshold, label }: { value?: number; threshold: number; excellentThreshold: number; label: string }): React.ReactElement | null {
  if (value === undefined || value === null) return null
  const isExcellent = value >= excellentThreshold
  const isQualified = value >= threshold
  const status = isExcellent ? '优秀' : isQualified ? '合格' : '偏低'
  const color = isExcellent ? 'bg-emerald-100 text-emerald-700' : isQualified ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium', color)}>
      {label}: {value}% {status}
    </span>
  )
}

function PlatformBadge({ platform }: { platform: string }): React.ReactElement {
  const style = PLATFORM_COLORS[platform] ?? 'bg-gray-50 text-gray-700 border-gray-200'
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border', style)}>
      {platform}
    </span>
  )
}

function MiniBar({ value, max, label }: { value: number; max: number; label: string }): React.ReactElement {
  const pct = Math.min((value / max) * 100, 100)
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-20 text-muted-foreground shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
        <div className="h-full bg-primary/60 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 text-right font-medium">{value}</span>
    </div>
  )
}

function SectionCard({ title, children, className }: { title: string; children: React.ReactNode; className?: string }): React.ReactElement {
  return (
    <div className={cn('rounded-xl bg-card shadow-sm border border-border/30 p-4', className)}>
      <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
        <div className="w-1 h-4 bg-primary/60 rounded-full" />
        {title}
      </h4>
      {children}
    </div>
  )
}

/* ===================== KOL 详情弹窗 ===================== */

function KOLDetailDialog({ kol, open, onOpenChange }: { kol: KOLListItem | null; open: boolean; onOpenChange: (open: boolean) => void }): React.ReactElement | null {
  if (!kol) return null
  const ext = kol.extendedData

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-auto p-0">
        <DialogHeader className="px-6 pt-6 pb-2">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
              <span className="text-lg font-medium text-primary">{kol.name.slice(0, 1)}</span>
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-lg flex items-center gap-2">
                <span className="truncate">{kol.name}</span>
                <PlatformBadge platform={kol.platform} />
                {kol.category && <Badge variant="secondary">{kol.category}</Badge>}
              </DialogTitle>
              <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                <span className="flex items-center gap-1"><Users className="w-3 h-3" /> {kol.followers || '-'}</span>
                <span className="flex items-center gap-1"><Heart className="w-3 h-3" /> {kol.engagement || '-'}</span>
                <span className="flex items-center gap-1"><DollarSign className="w-3 h-3" /> {kol.price || '-'}</span>
                <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {kol.city || '-'}</span>
              </div>
            </div>
          </div>
        </DialogHeader>

        <Tabs defaultValue="scores" className="px-6">
          <TabsList className="w-full justify-start">
            <TabsTrigger value="scores" className="gap-1"><Star className="w-3.5 h-3.5" />评分</TabsTrigger>
            <TabsTrigger value="data" className="gap-1"><BarChart3 className="w-3.5 h-3.5" />数据维度</TabsTrigger>
            {ext?.recentAdNotes && ext.recentAdNotes.length > 0 && (
              <TabsTrigger value="ads" className="gap-1"><Megaphone className="w-3.5 h-3.5" />广告数据</TabsTrigger>
            )}
            {ext?.recentNotesTrend && ext.recentNotesTrend.length > 0 && (
              <TabsTrigger value="trend" className="gap-1"><TrendingUp className="w-3.5 h-3.5" />数据趋势</TabsTrigger>
            )}
          </TabsList>

          {/* 评分面板 */}
          <TabsContent value="scores" className="space-y-4 pb-6">
            <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
              <ScoreCard score={kol.overallScore} label="综合" icon={Star} />
              <ScoreCard score={kol.baseScore} label="基础" icon={Database} />
              <ScoreCard score={kol.contentScore} label="内容" icon={Eye} />
              <ScoreCard score={kol.commercialScore} label="商业" icon={DollarSign} />
              <ScoreCard score={kol.fanScore ?? 0} label="粉丝质量" icon={Users} />
              <ScoreCard score={kol.engagementScore ?? 0} label="互动质量" icon={Heart} />
              <ScoreCard score={kol.valueScore ?? 0} label="性价比" icon={TrendingUp} />
              <ScoreCard score={kol.adQualityScore ?? 0} label="广告质量" icon={Megaphone} />
            </div>
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50/50 border border-red-100">
              <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
              <span className="text-sm font-medium text-red-700">风险评分: {kol.riskScore ?? 0}</span>
              <span className="text-xs text-red-500/80">（数值越低风险越小）</span>
            </div>
          </TabsContent>

          {/* 数据维度面板 */}
          <TabsContent value="data" className="space-y-4 pb-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* 粉丝画像 */}
              <SectionCard title="粉丝画像">
                <div className="space-y-2">
                  {ext?.femaleRatio !== undefined && (
                    <QualifyBadge value={ext.femaleRatio} threshold={70} excellentThreshold={80} label="女粉占比" />
                  )}
                  {ext?.maleRatio !== undefined && (
                    <div className="text-xs text-muted-foreground">男粉占比: {ext.maleRatio}%</div>
                  )}
                  {ext?.age18to35Ratio !== undefined && (
                    <QualifyBadge value={ext.age18to35Ratio} threshold={40} excellentThreshold={50} label="18-35岁占比" />
                  )}
                  {ext?.ageDistribution && (
                    <div className="text-xs text-muted-foreground">年龄分布: {ext.ageDistribution}</div>
                  )}
                  {!ext?.femaleRatio && !ext?.age18to35Ratio && (
                    <div className="text-xs text-muted-foreground italic">暂无粉丝画像数据</div>
                  )}
                </div>
              </SectionCard>

              {/* 内容数据 */}
              <SectionCard title="内容数据">
                <div className="space-y-2">
                  {ext?.minLikes3m !== undefined && <MiniBar value={ext.minLikes3m} max={ext.maxLikes3m || ext.avgLikes3m || 1000} label="近3月最低点赞" />}
                  {ext?.maxLikes3m !== undefined && <MiniBar value={ext.maxLikes3m} max={ext.maxLikes3m} label="近3月最高点赞" />}
                  {ext?.avgLikes3m !== undefined && <MiniBar value={ext.avgLikes3m} max={ext.maxLikes3m || ext.avgLikes3m * 2} label="近3月平均点赞" />}
                  {ext?.monthlyPostCount !== undefined && (
                    <div className="text-xs flex items-center gap-2">
                      <Clock className="w-3 h-3 text-muted-foreground" />
                      <span>月更条数: <span className="font-medium">{ext.monthlyPostCount}</span> 条</span>
                      <span className="text-muted-foreground">({ext.monthlyPostCount >= 8 ? '优秀' : ext.monthlyPostCount >= 4 ? '合格' : '偏低'})</span>
                    </div>
                  )}
                  {ext?.postsLast30d !== undefined && (
                    <div className="text-xs text-muted-foreground">近30天发布: {ext.postsLast30d} 条</div>
                  )}
                  {ext?.viralRate30d !== undefined && (
                    <div className="text-xs flex items-center gap-2">
                      <TrendingUp className="w-3 h-3 text-muted-foreground" />
                      <span>30日爆文率: <span className="font-medium">{ext.viralRate30d}%</span></span>
                      <span className="text-muted-foreground">({ext.viralRate30d >= 10 ? '优秀' : ext.viralRate30d >= 5 ? '合格' : '偏低'})</span>
                    </div>
                  )}
                  {ext?.viralNotesCount !== undefined && (
                    <div className="text-xs text-muted-foreground">近30天爆文数: {ext.viralNotesCount} 条</div>
                  )}
                </div>
              </SectionCard>

              {/* 投放成本 */}
              <SectionCard title="投放成本">
                <div className="space-y-2 text-xs">
                  {ext?.cpe !== undefined && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">CPE（单次互动成本）</span>
                      <span className="font-medium">¥{ext.cpe.toFixed(2)}</span>
                      <span className={cn('px-1.5 py-0.5 rounded text-[10px]', ext.cpe <= 10 ? 'bg-emerald-100 text-emerald-700' : ext.cpe <= 20 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700')}>
                        {ext.cpe <= 10 ? '性价比高' : ext.cpe <= 20 ? '常态' : '需谨慎'}
                      </span>
                    </div>
                  )}
                  {ext?.cpm !== undefined && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">CPM（千次曝光成本）</span>
                      <span className="font-medium">¥{ext.cpm.toFixed(2)}</span>
                    </div>
                  )}
                  {ext?.estimatedPrice !== undefined && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">预估报价</span>
                      <span className="font-medium">¥{ext.estimatedPrice.toFixed(0)}</span>
                    </div>
                  )}
                  {ext?.priceReasonableness && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">报价合理性</span>
                      <Badge variant={ext.priceReasonableness === 'excellent' || ext.priceReasonableness === 'low' ? 'default' : ext.priceReasonableness === 'normal' ? 'secondary' : 'destructive'}>
                        {ext.priceReasonableness === 'excellent' ? '优秀' : ext.priceReasonableness === 'low' ? '偏低' : ext.priceReasonableness === 'normal' ? '正常' : '偏高'}
                      </Badge>
                    </div>
                  )}
                </div>
              </SectionCard>

              {/* 笔记占比 */}
              <SectionCard title="笔记占比">
                <div className="space-y-2">
                  {ext?.adNoteRatio !== undefined && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">广告笔记占比</span>
                        <span className="font-medium">{ext.adNoteRatio}%</span>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-primary/60 rounded-full" style={{ width: `${ext.adNoteRatio}%` }} />
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {ext.adNoteRatio <= 10 ? '优秀（广告少，日常多）' : ext.adNoteRatio <= 30 ? '合格' : '偏高（广告占比较高）'}
                      </div>
                    </div>
                  )}
                  {ext?.organicNoteRatio !== undefined && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">日常笔记占比</span>
                        <span className="font-medium">{ext.organicNoteRatio}%</span>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-400/60 rounded-full" style={{ width: `${ext.organicNoteRatio}%` }} />
                      </div>
                    </div>
                  )}
                  {ext?.adNotesLast30d !== undefined && (
                    <div className="text-xs text-muted-foreground">近30天广告笔记: {ext.adNotesLast30d} 条</div>
                  )}
                </div>
              </SectionCard>

              {/* 评论分析 */}
              <SectionCard title="评论分析">
                <div className="space-y-2">
                  {ext?.negativeCommentRatio !== undefined && (
                    <div className="text-xs flex items-center gap-2">
                      <MessageSquare className="w-3 h-3 text-muted-foreground" />
                      <span>负面评论占比: <span className="font-medium">{ext.negativeCommentRatio}%</span></span>
                      <span className={cn('px-1.5 py-0.5 rounded text-[10px]', ext.negativeCommentRatio < 10 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700')}>
                        {ext.negativeCommentRatio < 10 ? '合格' : '偏高'}
                      </span>
                    </div>
                  )}
                  {ext?.commentWordCloud && ext.commentWordCloud.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {ext.commentWordCloud.slice(0, 12).map((word, i) => (
                        <Badge key={i} variant={word.sentiment === 'positive' ? 'default' : word.sentiment === 'negative' ? 'destructive' : 'secondary'} className="text-[10px]">
                          {word.word} ({word.count})
                        </Badge>
                      ))}
                    </div>
                  )}
                  {!ext?.negativeCommentRatio && (!ext?.commentWordCloud || ext.commentWordCloud.length === 0) && (
                    <div className="text-xs text-muted-foreground italic">暂无评论分析数据</div>
                  )}
                </div>
              </SectionCard>

              {/* 标签汇总 */}
              <SectionCard title="标签汇总">
                <div className="space-y-2">
                  {kol.valueTags && kol.valueTags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {kol.valueTags.map((tag, i) => (
                        <Badge key={i} variant="default" className="bg-emerald-100 text-emerald-700 hover:bg-emerald-200 border-emerald-200 text-[10px]">
                          <Tag className="w-3 h-3 mr-0.5" />{tag}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {kol.riskFlags && kol.riskFlags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {kol.riskFlags.map((flag, i) => (
                        <Badge key={i} variant="destructive" className="text-[10px]">
                          <AlertTriangle className="w-3 h-3 mr-0.5" />{flag}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {(!kol.valueTags || kol.valueTags.length === 0) && (!kol.riskFlags || kol.riskFlags.length === 0) && (
                    <div className="text-xs text-muted-foreground italic">暂无标签</div>
                  )}
                </div>
              </SectionCard>
            </div>
          </TabsContent>

          {/* 广告数据面板 */}
          <TabsContent value="ads" className="pb-6">
            {ext?.recentAdNotes && ext.recentAdNotes.length > 0 && (
              <div className="rounded-xl bg-card shadow-sm border border-border/30 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">日期</th>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">标题</th>
                        <th className="px-3 py-2 text-right font-medium text-muted-foreground">曝光</th>
                        <th className="px-3 py-2 text-right font-medium text-muted-foreground">点赞</th>
                        <th className="px-3 py-2 text-right font-medium text-muted-foreground">互动</th>
                        <th className="px-3 py-2 text-right font-medium text-muted-foreground">vs日常</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/40">
                      {ext.recentAdNotes.map((note, i) => (
                        <tr key={i} className="hover:bg-accent/30">
                          <td className="px-3 py-2 text-muted-foreground">{note.date}</td>
                          <td className="px-3 py-2 max-w-[200px] truncate">{note.title}</td>
                          <td className="px-3 py-2 text-right">{note.exposure?.toLocaleString() || '-'}</td>
                          <td className="px-3 py-2 text-right">{note.likes?.toLocaleString() || '-'}</td>
                          <td className="px-3 py-2 text-right">{(note.comments + note.saves)?.toLocaleString() || '-'}</td>
                          <td className="px-3 py-2 text-right">
                            <span className={cn(
                              note.vsOrganic?.engagementDiff > 0 ? 'text-emerald-600' : note.vsOrganic?.engagementDiff < 0 ? 'text-red-600' : 'text-muted-foreground'
                            )}>
                              {note.vsOrganic?.engagementDiff > 0 ? '+' : ''}{note.vsOrganic?.engagementDiff || 0}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </TabsContent>

          {/* 数据趋势面板 */}
          <TabsContent value="trend" className="pb-6">
            {(() => {
              const trend = ext?.recentNotesTrend
              if (!trend || trend.length === 0) return null
              const maxExp = Math.max(...trend.map(n => n.exposure || 0))
              return (
                <div className="space-y-4">
                  <div className="rounded-xl bg-card shadow-sm border border-border/30 p-4">
                    <h4 className="text-sm font-semibold mb-3">近10篇笔记数据</h4>
                    <div className="space-y-2">
                      {trend.map((note, i) => (
                        <div key={i} className="flex items-center gap-3 text-xs">
                          <span className="w-6 text-muted-foreground shrink-0">{i + 1}</span>
                          <span className="w-20 text-muted-foreground shrink-0">{note.date}</span>
                          <span className="flex-1 truncate min-w-0">{note.title}</span>
                          <div className="w-24 flex items-center gap-1">
                            <div className="h-2 bg-primary/30 rounded-full overflow-hidden flex-1">
                              <div className="h-full bg-primary/60 rounded-full" style={{ width: `${maxExp > 0 ? ((note.exposure || 0) / maxExp) * 100 : 0}%` }} />
                            </div>
                          </div>
                          <span className="w-12 text-right">{note.likes || 0}赞</span>
                          <span className="w-12 text-right">{note.exposure || 0}曝</span>
                          {note.isAd && <Badge variant="destructive" className="text-[10px] shrink-0">广告</Badge>}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )
            })()}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

/* ===================== 主组件 ===================== */

export function KOLDataManager(): React.ReactElement {
  const [kols, setKols] = React.useState<KOLListItem[]>([])
  const [loading, setLoading] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [platformFilter, setPlatformFilter] = React.useState('')
  const [categoryFilter, setCategoryFilter] = React.useState('')

  // 新增：评分筛选与排序
  const [scoreFilterField, setScoreFilterField] = React.useState('')
  const [scoreFilterMin, setScoreFilterMin] = React.useState<number | ''>('')
  const [sortField, setSortField] = React.useState('overallScore')
  const [sortOrder, setSortOrder] = React.useState<'desc' | 'asc'>('desc')

  // 编辑弹窗
  const [editingKOL, setEditingKOL] = React.useState<KOLListItem | null>(null)
  const [editForm, setEditForm] = React.useState<Partial<KOLListItem>>({})
  const [advancedOpen, setAdvancedOpen] = React.useState(false)
  const [extendedDataJson, setExtendedDataJson] = React.useState('')

  // 删除确认
  const [deletingId, setDeletingId] = React.useState<string | null>(null)

  // 详情弹窗
  const [detailKOL, setDetailKOL] = React.useState<KOLListItem | null>(null)
  const [detailOpen, setDetailOpen] = React.useState(false)

  const loadKOLs = React.useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.listAllKOLs()
      setKols(result)
    } catch (error) {
      console.error('[KOL 数据] 加载失败:', error)
      toast.error('加载 KOL 数据失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    loadKOLs()
  }, [loadKOLs])

  // 筛选与排序
  const filteredKOLs = React.useMemo(() => {
    let result = kols.filter((kol) => {
      const matchSearch = searchQuery === '' ||
        kol.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        kol.city.toLowerCase().includes(searchQuery.toLowerCase())
      const matchPlatform = platformFilter === '' || kol.platform === platformFilter
      const matchCategory = categoryFilter === '' || kol.category === categoryFilter
      const matchScore = scoreFilterField === '' || scoreFilterMin === '' ||
        (kol[scoreFilterField as keyof KOLListItem] as number ?? 0) >= (scoreFilterMin as number)
      return matchSearch && matchPlatform && matchCategory && matchScore
    })

    // 排序
    result = [...result].sort((a, b) => {
      const aVal = (a[sortField as keyof KOLListItem] as number) ?? 0
      const bVal = (b[sortField as keyof KOLListItem] as number) ?? 0
      return sortOrder === 'desc' ? bVal - aVal : aVal - bVal
    })

    return result
  }, [kols, searchQuery, platformFilter, categoryFilter, scoreFilterField, scoreFilterMin, sortField, sortOrder])

  // 唯一平台和类目列表
  const platforms = React.useMemo(() => [...new Set(kols.map((k) => k.platform))].sort(), [kols])
  const categories = React.useMemo(() => [...new Set(kols.map((k) => k.category).filter(Boolean))].sort(), [kols])

  const scoreFields = [
    { value: 'overallScore', label: '综合评分' },
    { value: 'baseScore', label: '基础评分' },
    { value: 'contentScore', label: '内容评分' },
    { value: 'commercialScore', label: '商业评分' },
    { value: 'fanScore', label: '粉丝质量' },
    { value: 'engagementScore', label: '互动质量' },
    { value: 'valueScore', label: '性价比' },
    { value: 'adQualityScore', label: '广告质量' },
    { value: 'riskScore', label: '风险评分' },
  ]

  const handleEdit = (kol: KOLListItem) => {
    setEditingKOL(kol)
    setEditForm({ ...kol })
    setAdvancedOpen(false)
    setExtendedDataJson(kol.extendedData ? JSON.stringify(kol.extendedData, null, 2) : '')
  }

  const handleSaveEdit = async () => {
    if (!editingKOL || !editForm.name) return

    // 解析扩展数据 JSON
    let parsedExtendedData: KOLExtendedData | undefined
    if (extendedDataJson.trim()) {
      try {
        parsedExtendedData = JSON.parse(extendedDataJson) as KOLExtendedData
      } catch (e) {
        toast.error('扩展数据 JSON 格式错误，请检查语法')
        return
      }
    }

    try {
      const success = await window.electronAPI.updateKOL({
        id: editingKOL.id,
        name: editForm.name,
        platform: editForm.platform || editingKOL.platform,
        followers: editForm.followers || '',
        engagement: editForm.engagement || '',
        category: editForm.category || '',
        price: editForm.price || '',
        city: editForm.city || '',
        extendedData: parsedExtendedData,
        fanScore: editForm.fanScore,
        engagementScore: editForm.engagementScore,
        valueScore: editForm.valueScore,
        adQualityScore: editForm.adQualityScore,
        riskScore: editForm.riskScore,
      })

      if (success) {
        toast.success('KOL 信息已更新')
        setEditingKOL(null)
        loadKOLs()
      } else {
        toast.error('更新失败')
      }
    } catch (error) {
      console.error('[KOL 数据] 更新失败:', error)
      toast.error('更新失败')
    }
  }

  const handleDelete = async () => {
    if (!deletingId) return

    try {
      const success = await window.electronAPI.deleteKOL(deletingId)
      if (success) {
        toast.success('KOL 已删除')
        setDeletingId(null)
        loadKOLs()
      } else {
        toast.error('删除失败')
      }
    } catch (error) {
      console.error('[KOL 数据] 删除失败:', error)
      toast.error('删除失败')
    }
  }

  const openDetail = (kol: KOLListItem) => {
    setDetailKOL(kol)
    setDetailOpen(true)
  }

  return (
    <div className="flex flex-col h-full titlebar-no-drag">
      {/* 头部 */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border/60">
        <div className="flex items-center gap-3">
          <Database className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">KOL 数据管理</h2>
          <span className="text-sm text-muted-foreground">({kols.length} 条)</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              setLoading(true)
              try {
                const result = await window.electronAPI.recalculateKOLScores()
                toast.success(`已重新计算 ${result.updated} 个 KOL 的评分`)
                loadKOLs()
              } catch (error) {
                console.error('[KOL 数据] 评分计算失败:', error)
                toast.error('评分计算失败')
              } finally {
                setLoading(false)
              }
            }}
            disabled={loading}
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors',
              loading
                ? 'text-muted-foreground cursor-not-allowed'
                : 'text-foreground hover:bg-primary/5'
            )}
          >
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
            重新计算评分
          </button>
          <button
            onClick={loadKOLs}
            disabled={loading}
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors',
              loading
                ? 'text-muted-foreground cursor-not-allowed'
                : 'text-foreground hover:bg-primary/5'
            )}
          >
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
            刷新
          </button>
        </div>
      </div>

      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-3 px-6 py-3 border-b border-border/40">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="搜索名称、城市..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40"
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
          className="px-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          <option value="">全部平台</option>
          {platforms.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>

        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="px-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          <option value="">全部类目</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        {/* 评分筛选 */}
        <select
          value={scoreFilterField}
          onChange={(e) => setScoreFilterField(e.target.value)}
          className="px-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          <option value="">评分筛选</option>
          {scoreFields.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
        {scoreFilterField && (
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">≥</span>
            <input
              type="number"
              min={0}
              max={100}
              value={scoreFilterMin}
              onChange={(e) => setScoreFilterMin(e.target.value === '' ? '' : Number(e.target.value))}
              className="w-16 px-2 py-1.5 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
              placeholder="0"
            />
          </div>
        )}

        {/* 排序 */}
        <select
          value={sortField}
          onChange={(e) => setSortField(e.target.value)}
          className="px-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          {scoreFields.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
        <button
          onClick={() => setSortOrder((o) => o === 'desc' ? 'asc' : 'desc')}
          className="px-2 py-2 rounded-lg border border-border/60 bg-background text-sm hover:bg-primary/5 transition-colors"
          title={sortOrder === 'desc' ? '降序' : '升序'}
        >
          <SlidersHorizontal className={cn('w-4 h-4', sortOrder === 'asc' && 'rotate-180')} />
        </button>
      </div>

      {/* KOL 列表 */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {loading && kols.length === 0 ? (
          <div className="flex items-center justify-center h-64 text-muted-foreground">
            <RefreshCw className="w-5 h-5 animate-spin mr-2" />
            加载中...
          </div>
        ) : filteredKOLs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
            <Users className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">
              {kols.length === 0 ? '暂无 KOL 数据，请通过营销工具采集' : '没有匹配的 KOL'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredKOLs.map((kol) => (
              <div
                key={kol.id}
                className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3 rounded-xl border border-border/40 bg-card hover:bg-accent/40 transition-colors group cursor-pointer"
                onClick={() => openDetail(kol)}
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  {/* 头像占位 */}
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <span className="text-sm font-medium text-primary">
                      {kol.name.slice(0, 1)}
                    </span>
                  </div>

                  {/* 信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-sm truncate">{kol.name}</span>
                      <PlatformBadge platform={kol.platform} />
                      {kol.category && (
                        <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
                          {kol.category}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>粉丝: {kol.followers || '-'}</span>
                      <span>互动: {kol.engagement || '-'}</span>
                      <span>报价: {kol.price || '-'}</span>
                      <span>城市: {kol.city || '-'}</span>
                      <span className="text-xs text-muted-foreground/60">来源: {kol.source}</span>
                    </div>

                    {/* 扩展数据摘要 */}
                    {kol.extendedData && (
                      <div className="flex flex-wrap items-center gap-2 mt-1.5">
                        {kol.extendedData.femaleRatio !== undefined && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-pink-50 text-pink-600 border border-pink-100">
                            女粉 {kol.extendedData.femaleRatio}%
                          </span>
                        )}
                        {kol.extendedData.cpe !== undefined && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 border border-emerald-100">
                            CPE ¥{kol.extendedData.cpe.toFixed(1)}
                          </span>
                        )}
                        {kol.extendedData.viralRate30d !== undefined && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 border border-amber-100">
                            爆文率 {kol.extendedData.viralRate30d}%
                          </span>
                        )}
                        {kol.extendedData.monthlyPostCount !== undefined && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-100">
                            月更 {kol.extendedData.monthlyPostCount} 条
                          </span>
                        )}
                      </div>
                    )}

                    {/* 标签 */}
                    <div className="flex flex-wrap items-center gap-1 mt-1.5">
                      {kol.valueTags && kol.valueTags.map((tag, i) => (
                        <Badge key={i} className="text-[10px] bg-emerald-100 text-emerald-700 hover:bg-emerald-200 border-emerald-200 px-1.5 py-0">
                          <Tag className="w-2.5 h-2.5 mr-0.5" />{tag}
                        </Badge>
                      ))}
                      {kol.riskFlags && kol.riskFlags.map((flag, i) => (
                        <Badge key={i} variant="destructive" className="text-[10px] px-1.5 py-0">
                          <AlertTriangle className="w-2.5 h-2.5 mr-0.5" />{flag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 评分区域 */}
                <div className="flex items-center gap-2 sm:gap-3 sm:mr-2 flex-wrap">
                  <ScoreBadge score={kol.overallScore} label="综合" />
                  <div className="hidden lg:flex items-center gap-2">
                    <ScoreBadge score={kol.baseScore} label="基础" />
                    <ScoreBadge score={kol.contentScore} label="内容" />
                    <ScoreBadge score={kol.commercialScore} label="商业" />
                  </div>
                  <div className="hidden xl:flex items-center gap-2">
                    <ScoreBadge score={kol.fanScore ?? 0} label="粉丝" />
                    <ScoreBadge score={kol.engagementScore ?? 0} label="互动" />
                    <ScoreBadge score={kol.valueScore ?? 0} label="性价比" />
                    <ScoreBadge score={kol.adQualityScore ?? 0} label="广告" />
                  </div>
                  {/* 风险评分（小圆点） */}
                  {kol.riskScore !== undefined && kol.riskScore > 0 && (
                    <div className="flex flex-col items-center">
                      <div className={cn(
                        'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white',
                        kol.riskScore >= 60 ? 'bg-red-500' : kol.riskScore >= 40 ? 'bg-orange-500' : 'bg-emerald-500'
                      )}>
                        {kol.riskScore}
                      </div>
                      <span className="text-[10px] text-muted-foreground mt-0.5">风险</span>
                    </div>
                  )}
                </div>

                {/* 操作 */}
                <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => { e.stopPropagation(); openDetail(kol); }}
                    className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-primary/5 transition-colors"
                    title="查看详情"
                  >
                    <Eye className="w-4 h-4" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleEdit(kol); }}
                    className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-primary/5 transition-colors"
                    title="编辑"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setDeletingId(kol.id); }}
                    className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/5 transition-colors"
                    title="删除"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 详情弹窗 */}
      <KOLDetailDialog kol={detailKOL} open={detailOpen} onOpenChange={setDetailOpen} />

      {/* 编辑弹窗 */}
      <Dialog open={!!editingKOL} onOpenChange={(open) => { if (!open) setEditingKOL(null) }}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>编辑 KOL</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-sm font-medium mb-1 block">名称</label>
              <input
                type="text"
                value={editForm.name ?? ''}
                onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block">平台</label>
                <input
                  type="text"
                  value={editForm.platform ?? ''}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, platform: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">类目</label>
                <input
                  type="text"
                  value={editForm.category ?? ''}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, category: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block">粉丝量</label>
                <input
                  type="text"
                  value={editForm.followers ?? ''}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, followers: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">互动率</label>
                <input
                  type="text"
                  value={editForm.engagement ?? ''}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, engagement: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block">报价</label>
                <input
                  type="text"
                  value={editForm.price ?? ''}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, price: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">城市</label>
                <input
                  type="text"
                  value={editForm.city ?? ''}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, city: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>

            {/* 新增评分字段 */}
            <Separator className="my-2" />
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block">粉丝质量评分</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={editForm.fanScore ?? ''}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, fanScore: e.target.value === '' ? undefined : Number(e.target.value) }))}
                  className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">互动质量评分</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={editForm.engagementScore ?? ''}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, engagementScore: e.target.value === '' ? undefined : Number(e.target.value) }))}
                  className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">性价比评分</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={editForm.valueScore ?? ''}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, valueScore: e.target.value === '' ? undefined : Number(e.target.value) }))}
                  className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">广告质量评分</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={editForm.adQualityScore ?? ''}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, adQualityScore: e.target.value === '' ? undefined : Number(e.target.value) }))}
                  className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">风险评分</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={editForm.riskScore ?? ''}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, riskScore: e.target.value === '' ? undefined : Number(e.target.value) }))}
                  className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>

            {/* 高级数据（可折叠） */}
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger className="flex items-center gap-2 w-full text-sm font-medium text-muted-foreground hover:text-foreground transition-colors py-1">
                {advancedOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                高级数据（扩展数据 JSON）
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="space-y-2 mt-2">
                  <p className="text-xs text-muted-foreground">
                    输入 JSON 格式的扩展数据，包含 likes、saves、femaleRatio、cpe、viralRate30d 等字段。
                  </p>
                  <textarea
                    value={extendedDataJson}
                    onChange={(e) => setExtendedDataJson(e.target.value)}
                    rows={8}
                    placeholder={`{\n  "likes": 1000,\n  "saves": 500,\n  "femaleRatio": 75,\n  "cpe": 8.5,\n  "viralRate30d": 12\n}`}
                    className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/20 resize-y"
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
          <DialogFooter>
            <button
              onClick={() => setEditingKOL(null)}
              className="px-4 py-2 rounded-lg text-sm text-muted-foreground hover:bg-muted transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSaveEdit}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Save className="w-4 h-4" />
              保存
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={!!deletingId} onOpenChange={(open) => { if (!open) setDeletingId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              删除后无法恢复，确定要删除这个 KOL 吗？
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
