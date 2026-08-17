/**
 * ContextUsageBadge — 上下文使用量指示器
 *
 * 输入框工具栏上的一个 36×36 圆形按钮：
 * - 内部为 16px 圆环，按 displayTokens / displayWindow 比例渲染
 * - hover / click 弹出 Popover，内含：
 *   1) 订阅额度区（Kimi/DeepSeek 等支持 Plan Quota 的渠道）
 *   2) 当前会话 token 明细
 *   3) 手动压缩按钮
 * - 压缩中时按钮位置显示 Loader2 旋转图标
 * - 占用接近压缩阈值（窗口 × 0.775 × 80%）时圆环变琥珀色
 * - 无数据时不显示
 */

import * as React from 'react'
import { Loader2, Minimize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { ChannelPlanQuotaResult, ChannelPlanQuotaWindow } from '@gravitas/shared'
import { supportsChannelPlanQuota, fetchChannelPlanQuota } from '@/lib/channel-plan-quota'

/** 压缩阈值比例（SDK 在 ~77.5% 窗口大小时自动压缩） */
const COMPACT_THRESHOLD_RATIO = 0.775
/** 显示警告的阈值（压缩阈值的 80%） */
const WARNING_RATIO = 0.80
/** Popover hover 关闭延迟（ms），与 AgentThinkingPopover 一致 */
const HOVER_CLOSE_DELAY = 150

interface ContextUsageBadgeProps {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  costUsd?: number
  contextWindow?: number
  isCompacting: boolean
  isProcessing: boolean
  onCompact: () => void
  /** 当前渠道 ID（用于查询订阅额度） */
  channelId?: string
  /** 当前渠道更新时间（用于缓存失效） */
  channelUpdatedAt?: number
  /** 当前渠道 provider / baseUrl（用于判断是否支持额度查询） */
  channelProvider?: string
  channelBaseUrl?: string
}

/** 格式化 token 数为可读字符串（如 1234 → "1.2k"） */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`
  }
  return `${tokens}`
}

/** 圆环进度指示器 — 16×16 SVG，描边 2px */
interface UsageRingProps {
  ratio: number
  isWarning: boolean
}
function UsageRing({ ratio, isWarning }: UsageRingProps): React.ReactElement {
  const radius = 8
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(1, ratio))
  const dashOffset = circumference * (1 - clamped)

  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      className={cn(
        'shrink-0 transition-colors',
        isWarning ? 'text-amber-500 dark:text-amber-400' : 'text-foreground/70',
      )}
      aria-hidden="true"
    >
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="2"
      />
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        transform="rotate(-90 10 10)"
        style={{ transition: 'stroke-dashoffset 300ms ease-out' }}
      />
    </svg>
  )
}

/** Popover 里的一行 key/value */
interface DetailRowProps {
  label: string
  value: string
  emphasized?: boolean
}
function DetailRow({ label, value, emphasized }: DetailRowProps): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <span className="text-foreground/70">{label}</span>
      <span className={cn('tabular-nums', emphasized ? 'font-medium text-foreground' : 'text-foreground/90')}>
        {value}
      </span>
    </div>
  )
}

// ===== 订阅额度卡片 =====

/** 格式化重置时间为相对或绝对时间 */
function formatResetTime(resetAt?: number): string | null {
  if (!resetAt) return null
  const now = Date.now()
  const diff = resetAt - now
  if (diff <= 0) return null
  if (diff < 60 * 60 * 1000) return `${Math.ceil(diff / (60 * 1000))}分钟后`
  if (diff < 24 * 60 * 60 * 1000) return `${Math.ceil(diff / (60 * 60 * 1000))}小时后`
  return new Intl.DateTimeFormat(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(resetAt))
}

/** 单个额度窗口卡片 */
interface QuotaWindowCardProps {
  window: ChannelPlanQuotaWindow
}

function QuotaWindowCard({ window: w }: QuotaWindowCardProps): React.ReactElement {
  const isLow = w.remainingPercent <= 20
  const resetText = formatResetTime(w.resetAt)
  const shortLabel = w.type === '5h'
    ? '5H'
    : w.type === 'weekly'
      ? '每周'
      : w.type === 'monthly'
        ? '每月'
        : w.label

  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-border/40 bg-background/60 px-2.5 py-2 min-w-[72px]">
      <span className="text-[10px] text-muted-foreground">{shortLabel}</span>
      <span className={cn(
        'text-sm font-semibold tabular-nums',
        isLow ? 'text-red-500' : 'text-foreground',
      )}>
        {w.remainingLabel ?? `${w.remainingPercent}%`}
      </span>
      {/* 迷你进度条 */}
      <div className="h-1 w-full rounded-full bg-foreground/10 overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            isLow ? 'bg-red-500' : w.remainingPercent <= 50 ? 'bg-amber-500' : 'bg-emerald-500',
          )}
          style={{ width: `${w.remainingPercent}%` }}
        />
      </div>
      {resetText && (
        <span className="text-[9px] text-muted-foreground/70">{resetText}</span>
      )}
    </div>
  )
}

/** 订阅额度区域 */
interface PlanQuotaSectionProps {
  channelId: string
  channelUpdatedAt?: number
}

function PlanQuotaSection({ channelId, channelUpdatedAt }: PlanQuotaSectionProps): React.ReactElement | null {
  const [quota, setQuota] = React.useState<ChannelPlanQuotaResult | null>(null)

  React.useEffect(() => {
    let cancelled = false
    fetchChannelPlanQuota(channelId, channelUpdatedAt)
      .then((result) => {
        if (!cancelled) setQuota(result)
      })
      .catch(() => {
        // 静默失败，不影响主面板
      })
    return () => { cancelled = true }
  }, [channelId, channelUpdatedAt])

  if (!quota?.supported || quota.windows.length === 0) return null

  // 按优先级排序：monthly > weekly > 5h > custom
  const order: Record<string, number> = { monthly: 0, weekly: 1, '5h': 2, custom: 3 }
  const sortedWindows = [...quota.windows].sort((a, b) =>
    (order[a.type] ?? 99) - (order[b.type] ?? 99),
  )

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground/60">
        {quota.planName ?? '订阅额度'}
      </div>
      <div className="flex gap-1.5">
        {sortedWindows.map((w, i) => (
          <QuotaWindowCard key={`${w.type}-${i}`} window={w} />
        ))}
      </div>
    </div>
  )
}

export function ContextUsageBadge({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheCreationTokens,
  contextWindow,
  isCompacting,
  isProcessing,
  onCompact,
  channelId,
  channelUpdatedAt,
  channelProvider,
  channelBaseUrl,
}: ContextUsageBadgeProps): React.ReactElement | null {
  // 保留最近一次有效的 token 值，避免切换会话时闪烁消失
  const stableRef = React.useRef<{
    inputTokens: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    contextWindow?: number
  } | null>(null)
  if (inputTokens && inputTokens > 0) {
    stableRef.current = { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, contextWindow }
  }

  const [open, setOpen] = React.useState(false)
  const closeTimerRef = React.useRef<number | null>(null)

  const cancelClose = React.useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const scheduleClose = React.useCallback(() => {
    cancelClose()
    closeTimerRef.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY)
  }, [cancelClose])

  React.useEffect(() => cancelClose, [cancelClose])

  // 压缩中 → 按钮位置显示 spinner
  if (isCompacting) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-[36px] rounded-full text-muted-foreground cursor-default"
        disabled
      >
        <Loader2 className="size-4 animate-spin" />
      </Button>
    )
  }

  // 使用稳定值：优先当前数据，回退到上次有效数据
  const stable = stableRef.current
  const hasCurrent = inputTokens != null && inputTokens > 0
  const displayTokens = hasCurrent ? inputTokens : stable?.inputTokens
  const displayWindow = hasCurrent ? contextWindow : stable?.contextWindow
  const displayOutput = hasCurrent ? outputTokens : stable?.outputTokens
  const displayCacheRead = hasCurrent ? cacheReadTokens : stable?.cacheReadTokens
  const displayCacheCreation = hasCurrent ? cacheCreationTokens : stable?.cacheCreationTokens

  // 从未有过 usage 数据 → 不显示
  if (!displayTokens || displayTokens <= 0) return null

  // 警告阈值：基于压缩阈值（contextWindow × 0.775 × 80%）
  const compactThreshold = displayWindow
    ? Math.floor(displayWindow * COMPACT_THRESHOLD_RATIO)
    : undefined
  const isWarning = compactThreshold
    ? displayTokens / compactThreshold >= WARNING_RATIO
    : false

  const ratio = displayWindow ? displayTokens / displayWindow : 0

  // 纯输入 = 总上下文 - 缓存读取 - 缓存写入
  const pureInput = displayTokens - (displayCacheRead ?? 0) - (displayCacheCreation ?? 0)

  const percent = displayWindow
    ? Math.round((displayTokens / displayWindow) * 100)
    : undefined

  const handleCompactClick = (): void => {
    if (isProcessing) return
    onCompact()
    setOpen(false)
  }

  // 判断当前渠道是否支持订阅额度查询
  const hasPlanQuota = channelId && supportsChannelPlanQuota(
    channelProvider || channelBaseUrl
      ? { provider: channelProvider as never, baseUrl: channelBaseUrl ?? '' }
      : null,
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            'size-[36px] rounded-full',
            isWarning ? 'text-amber-600 dark:text-amber-400' : 'text-foreground/60 hover:text-foreground',
          )}
          onMouseEnter={() => {
            cancelClose()
            setOpen(true)
          }}
          onMouseLeave={scheduleClose}
        >
          <UsageRing ratio={ratio} isWarning={isWarning} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={8}
        className="w-auto min-w-[240px] max-w-[320px] p-2.5"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-2">
          {/* 订阅额度区 */}
          {hasPlanQuota && channelId && (
            <>
              <PlanQuotaSection channelId={channelId} channelUpdatedAt={channelUpdatedAt} />
              <div className="h-px bg-border my-0.5" />
            </>
          )}

          {/* 当前会话 token 明细 */}
          <div className="flex flex-col gap-1.5">
            <div className="text-[11px] font-medium text-foreground/60">当前会话</div>
            {pureInput > 0 && <DetailRow label="输入" value={pureInput.toLocaleString()} />}
            {displayOutput ? <DetailRow label="输出" value={displayOutput.toLocaleString()} /> : null}
            {displayCacheCreation ? <DetailRow label="缓存写入" value={displayCacheCreation.toLocaleString()} /> : null}
            {displayCacheRead ? <DetailRow label="缓存读取" value={displayCacheRead.toLocaleString()} /> : null}

            {displayWindow ? (
              <>
                <div className="h-px bg-border my-0.5" />
                <DetailRow
                  label="上下文"
                  value={`${formatTokens(displayTokens)} / ${formatTokens(displayWindow)}`}
                  emphasized
                />
                {percent != null && (
                  <DetailRow
                    label="占用"
                    value={`${percent}%`}
                    emphasized={isWarning}
                  />
                )}
              </>
            ) : null}
          </div>

          <div className="h-px bg-border my-0.5" />
          <Button
            type="button"
            variant={isWarning ? 'default' : 'outline'}
            size="sm"
            className={cn(
              'h-7 text-xs gap-1.5',
              isWarning && 'bg-amber-500 hover:bg-amber-600 text-white',
            )}
            onClick={handleCompactClick}
            disabled={isProcessing}
          >
            <Minimize2 className="size-3.5" />
            {isProcessing ? '对话进行中' : '手动压缩'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
