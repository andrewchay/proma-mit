/**
 * 分析图表渲染组件（纯 CSS，无第三方图表依赖）
 *
 * 项目当前没有图表库，OutreachMetricsCard 等既有组件同样用 CSS 实现可视化。
 * 这里保持一致：柱状图、环形图、折线趋势与表格都由布局与背景色绘制，
 * 避免为一个报告页引入 recharts 级别的依赖。
 *
 * 数据形态对应 @gravitas/core/services/analysis 的 AnalysisSection.data，
 * 该字段是 unknown，因此这里做运行时结构校验，形态不符时返回 null
 * 而不是抛错 —— 报告来自磁盘，损坏数据不应让整个页面白屏。
 */
import type * as React from 'react'

/** 分类占比项（时间分析 / 任务状态 / 优先级共用） */
interface NamedValue {
  name: string
  value: number
  /** 时间分析会带颜色 */
  color?: string
  /** 时间分析用的是 minutes + percentage */
  minutes?: number
  percentage?: number
}

/** 默认调色板（与主题 primary 系一致的低饱和色） */
const PALETTE = [
  'hsl(var(--primary))',
  '#8b5cf6',
  '#f59e0b',
  '#10b981',
  '#ef4444',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
]

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 从 section.data 中取出 { name, value } 数组；兼容 minutes/percentage 形态 */
function extractNamedValues(data: unknown, key: string): NamedValue[] | null {
  if (!isRecord(data)) return null
  const raw = data[key]
  if (!Array.isArray(raw)) return null
  const items: NamedValue[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const name = typeof entry.name === 'string' ? entry.name : undefined
    if (!name) continue
    // 时间分析的 categories 用 minutes + percentage，生产力用 value。
    // 取值时优先 value，其次 minutes；只有当两者都不存在时才退回 percentage，
    // 避免把百分比当成绝对量参与占比计算（会出现 NaN%）。
    const value =
      typeof entry.value === 'number'
        ? entry.value
        : typeof entry.minutes === 'number'
          ? entry.minutes
          : 0
    items.push({
      name,
      value,
      color: typeof entry.color === 'string' ? entry.color : undefined,
      minutes: typeof entry.minutes === 'number' ? entry.minutes : undefined,
      percentage: typeof entry.percentage === 'number' ? entry.percentage : undefined,
    })
  }
  return items.length > 0 ? items : null
}

/** 数值格式化：分钟转可读时长 */
function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} 分钟`
  const hours = minutes / 60
  return hours >= 10 ? `${Math.round(hours)} 小时` : `${hours.toFixed(1)} 小时`
}

// ===== 环形图 =====

/**
 * 环形占比图。
 *
 * 用 conic-gradient 绘制：按各段百分比累加角度，避免 SVG 与 JS 计算尺寸。
 */
export function DonutChart({ items }: { items: NamedValue[] }): React.ReactElement {
  const total = items.reduce((sum, i) => sum + i.value, 0)
  if (total <= 0) {
    return <div className="text-[12px] text-foreground/40 py-6 text-center">无数据</div>
  }

  let acc = 0
  const stops: string[] = []
  items.forEach((item, idx) => {
    const start = (acc / total) * 100
    acc += item.value
    const end = (acc / total) * 100
    const color = item.color ?? PALETTE[idx % PALETTE.length]
    stops.push(`${color} ${start}% ${end}%`)
  })

  return (
    <div className="flex items-center gap-5">
      <div
        className="w-28 h-28 rounded-full flex-shrink-0 relative"
        style={{ background: `conic-gradient(${stops.join(', ')})` }}
      >
        {/* 中心挖空形成环形 */}
        <div className="absolute inset-[22%] rounded-full bg-card flex flex-col items-center justify-center">
          <span className="text-[15px] font-medium text-foreground/85">{items.length}</span>
          <span className="text-[10px] text-foreground/45">分类</span>
        </div>
      </div>
      <div className="flex-1 min-w-0 space-y-1.5">
        {items.map((item, idx) => {
          const pct = (item.value / total) * 100
          return (
            <div key={item.name} className="flex items-center gap-2 text-[12px]">
              <span
                className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                style={{ background: item.color ?? PALETTE[idx % PALETTE.length] }}
              />
              <span className="flex-1 min-w-0 truncate text-foreground/70">{item.name}</span>
              <span className="text-foreground/85 tabular-nums">
                {item.minutes !== undefined ? formatMinutes(item.minutes) : item.value}
              </span>
              <span className="text-foreground/45 tabular-nums w-11 text-right">
                {pct.toFixed(1)}%
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ===== 柱状图 =====

/** 横向柱状图（分类对比，标签较长时比纵向更易读） */
export function BarChart({ items }: { items: NamedValue[] }): React.ReactElement {
  const max = Math.max(...items.map((i) => i.value), 0)
  if (max <= 0) {
    return <div className="text-[12px] text-foreground/40 py-6 text-center">无数据</div>
  }

  return (
    <div className="space-y-2">
      {items.map((item, idx) => {
        const pct = (item.value / max) * 100
        return (
          <div key={item.name} className="flex items-center gap-2.5">
            <span className="w-24 text-[12px] text-foreground/60 truncate flex-shrink-0" title={item.name}>
              {item.name}
            </span>
            <div className="flex-1 h-4 rounded bg-foreground/[0.05] overflow-hidden">
              <div
                className="h-full rounded transition-all"
                style={{
                  width: `${pct}%`,
                  background: item.color ?? PALETTE[idx % PALETTE.length],
                }}
              />
            </div>
            <span className="w-10 text-[12px] text-foreground/75 tabular-nums text-right flex-shrink-0">
              {item.minutes !== undefined ? formatMinutes(item.minutes) : item.value}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ===== 折线 / 趋势图 =====

/** 数值序列的折线趋势（用渐变列模拟面积图，不依赖 SVG） */
export function TrendChart({
  points,
  valueLabel,
}: {
  points: Array<{ date: string; value: number }>
  valueLabel?: string
}): React.ReactElement {
  if (points.length === 0) {
    return <div className="text-[12px] text-foreground/40 py-6 text-center">无数据</div>
  }
  const max = Math.max(...points.map((p) => p.value), 1)

  return (
    <div>
      <div className="flex items-end gap-1 h-32">
        {points.map((point) => {
          const pct = (point.value / max) * 100
          return (
            <div key={point.date} className="flex-1 flex flex-col items-center justify-end h-full group">
              <span className="text-[10px] text-foreground/55 opacity-0 group-hover:opacity-100 transition-opacity mb-0.5 tabular-nums">
                {point.value}
              </span>
              <div
                className="w-full rounded-t bg-primary/70 group-hover:bg-primary transition-colors min-h-[2px]"
                style={{ height: `${Math.max(pct, 2)}%` }}
                title={`${point.date}：${point.value}${valueLabel ?? ''}`}
              />
            </div>
          )
        })}
      </div>
      <div className="flex justify-between mt-1.5 text-[10px] text-foreground/40">
        <span>{points[0]?.date}</span>
        {points.length > 1 && <span>{points[points.length - 1]?.date}</span>}
      </div>
    </div>
  )
}

// ===== 堆叠柱状图（每日分类时长） =====

/** 每日分类时长堆叠柱（时间分析的 dailyBreakdown） */
export function StackedBarChart({
  daily,
}: {
  daily: Array<{ date: string; totalMinutes: number; categories: Record<string, number> }>
}): React.ReactElement {
  if (daily.length === 0) {
    return <div className="text-[12px] text-foreground/40 py-6 text-center">无数据</div>
  }
  const max = Math.max(...daily.map((d) => d.totalMinutes), 1)
  // 收集全部出现过的分类，保证各柱颜色一致
  const categoryNames = Array.from(new Set(daily.flatMap((d) => Object.keys(d.categories))))
  const colorOf = (name: string): string =>
    PALETTE[categoryNames.indexOf(name) % PALETTE.length]!

  return (
    <div>
      <div className="flex items-end gap-1 h-32">
        {daily.map((day) => (
          <div
            key={day.date}
            className="flex-1 flex flex-col justify-end h-full"
            title={`${day.date}：${formatMinutes(day.totalMinutes)}`}
          >
            {categoryNames.map((name) => {
              const minutes = day.categories[name] ?? 0
              if (minutes <= 0) return null
              const pct = (minutes / max) * 100
              return (
                <div
                  key={name}
                  style={{ height: `${pct}%`, background: colorOf(name) }}
                  className="w-full first:rounded-t"
                />
              )
            })}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 mt-2">
        {categoryNames.map((name) => (
          <span key={name} className="inline-flex items-center gap-1 text-[10px] text-foreground/55">
            <span className="w-2 h-2 rounded-sm" style={{ background: colorOf(name) }} />
            {name}
          </span>
        ))}
      </div>
    </div>
  )
}

// ===== 表格 =====

/** 键值统计表（各报告的「统计」section） */
export function StatsTable({ data }: { data: unknown }): React.ReactElement {
  if (!isRecord(data)) {
    return <div className="text-[12px] text-foreground/40 py-3">数据格式无法识别</div>
  }

  const labelMap: Record<string, string> = {
    total: '任务总数',
    completed: '已完成',
    completionRate: '完成率',
    overdue: '逾期',
    highPriorityTotal: '高优先级总数',
    highPriorityCompleted: '高优先级完成',
    totalHours: '总时长（小时）',
    avgDailyHours: '日均时长（小时）',
    tasksTotal: '任务总数',
    tasksCompleted: '已完成',
    overdueTasks: '逾期任务',
  }

  const rows = Object.entries(data).filter(
    ([, value]) => typeof value === 'number' || typeof value === 'string',
  ) as Array<[string, number | string]>
  if (rows.length === 0) {
    return <div className="text-[12px] text-foreground/40 py-3">无统计数据</div>
  }

  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
      {rows.map(([key, value]) => (
        <div key={key} className="flex items-baseline justify-between border-b border-border/40 pb-1.5">
          <dt className="text-[12px] text-foreground/55">{labelMap[key] ?? key}</dt>
          <dd className="text-[13px] text-foreground/85 tabular-nums">
            {key.toLowerCase().includes('rate') && typeof value === 'number' ? `${value}%` : value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

// ===== Section 渲染入口 =====

/**
 * 按 section 类型与 chartType 分发到对应图表。
 *
 * data 形态不符时返回数据不可用提示，不抛错。
 */
export function AnalysisSectionBody({
  type,
  chartType,
  data,
}: {
  type: 'chart' | 'text' | 'table' | 'comparison'
  chartType?: 'bar' | 'pie' | 'line' | 'stacked-bar' | 'radar'
  data: unknown
}): React.ReactElement {
  if (type === 'table') {
    // 时间/生产力的「分类详情」是 categories 数组，其余是键值统计
    const categories = extractNamedValues(data, 'categories')
    if (categories) {
      return (
        <div className="space-y-1.5">
          {categories.map((item, idx) => (
            <div key={item.name} className="flex items-center gap-2 text-[12px]">
              <span
                className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                style={{ background: item.color ?? PALETTE[idx % PALETTE.length] }}
              />
              <span className="flex-1 text-foreground/70">{item.name}</span>
              <span className="text-foreground/85 tabular-nums">
                {item.minutes !== undefined ? formatMinutes(item.minutes) : item.value}
              </span>
              {item.percentage !== undefined && (
                <span className="w-12 text-right text-foreground/45 tabular-nums">
                  {item.percentage.toFixed(1)}%
                </span>
              )}
            </div>
          ))}
        </div>
      )
    }
    return <StatsTable data={data} />
  }

  if (type === 'text') {
    return (
      <p className="text-[13px] text-foreground/75 leading-relaxed whitespace-pre-wrap">
        {typeof data === 'string' ? data : JSON.stringify(data, null, 2)}
      </p>
    )
  }

  // chart
  switch (chartType) {
    case 'pie': {
      const items =
        extractNamedValues(data, 'categories') ??
        extractNamedValues(data, 'statusDistribution') ??
        extractNamedValues(data, 'priorityDistribution')
      return items ? <DonutChart items={items} /> : <Unavailable />
    }
    case 'bar': {
      const items =
        extractNamedValues(data, 'categories') ??
        extractNamedValues(data, 'daily') ??
        extractNamedValues(data, 'priorityDistribution')
      return items ? <BarChart items={items} /> : <Unavailable />
    }
    case 'line': {
      const points = extractDailyRates(data)
      return points ? <TrendChart points={points} /> : <Unavailable />
    }
    case 'stacked-bar': {
      const daily = extractDailyBreakdown(data)
      return daily ? <StackedBarChart daily={daily} /> : <Unavailable />
    }
    default: {
      // 未指定 chartType 时按数据形态猜测
      const daily = extractDailyBreakdown(data)
      if (daily) return <StackedBarChart daily={daily} />
      const rates = extractDailyRates(data)
      if (rates) return <TrendChart points={rates} />
      const items = extractNamedValues(data, 'categories')
      if (items) return <BarChart items={items} />
      return <Unavailable />
    }
  }
}

/** 从 dailyRates（每日完成趋势）提取折线点 */
function extractDailyRates(data: unknown): Array<{ date: string; value: number }> | null {
  if (!isRecord(data)) return null
  const raw = data.dailyRates
  if (!Array.isArray(raw)) return null
  const points: Array<{ date: string; value: number }> = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const date = typeof entry.date === 'string' ? entry.date : undefined
    // 每日完成数比完成率更直观，优先用 completed
    const value =
      typeof entry.completed === 'number'
        ? entry.completed
        : typeof entry.value === 'number'
          ? entry.value
          : undefined
    if (date && value !== undefined) points.push({ date, value })
  }
  return points.length > 0 ? points : null
}

/** 从 dailyBreakdown（每日分类时长）提取堆叠柱数据 */
function extractDailyBreakdown(
  data: unknown,
): Array<{ date: string; totalMinutes: number; categories: Record<string, number> }> | null {
  if (!isRecord(data)) return null
  const raw = data.dailyBreakdown ?? data.daily
  if (!Array.isArray(raw)) return null
  const daily: Array<{ date: string; totalMinutes: number; categories: Record<string, number> }> = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const date = typeof entry.date === 'string' ? entry.date : undefined
    if (!date) continue
    const totalMinutes =
      typeof entry.totalMinutes === 'number' ? entry.totalMinutes : 0
    const categories: Record<string, number> = {}
    if (isRecord(entry.categories)) {
      for (const [key, value] of Object.entries(entry.categories)) {
        if (typeof value === 'number') categories[key] = value
      }
    }
    daily.push({ date, totalMinutes, categories })
  }
  return daily.length > 0 ? daily : null
}

function Unavailable(): React.ReactElement {
  return <div className="text-[12px] text-foreground/40 py-3">该图表的数据格式暂不支持渲染</div>
}
