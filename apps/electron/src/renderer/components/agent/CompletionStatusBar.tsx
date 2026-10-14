/**
 * CompletionStatusBar — 任务完成态红绿灯状态条
 *
 * 渲染 Agent 回复末尾约定的 🔴/🟡/🟢 进度状态行（约定见 agent-prompt-builder
 * 的 TRAFFIC_LIGHT_GUIDE）。解析结果来自 @gravitas/shared 的
 * parseAgentCompletionStatus；任何不符合约定的文本都不会渲染本组件（干净退化）。
 *
 * 展示语义（与提示词约定一致）：
 * - 🔴 进行中：原始需求有未达项
 * - 🟡 待决策：需求已达成，后续计划等待用户拍板
 * - 🟢 已完成：需求已达成，剩余事项已存档
 *
 * 图标采用扁平设计（lucide 线性图标），不用 emoji，保证跨平台渲染一致。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { CircleDot, CircleHelp, CircleCheck } from 'lucide-react'
import { parseAgentCompletionStatus } from '@gravitas/shared'
import type { AgentCompletionStatus, AgentTrafficLight } from '@gravitas/shared'

/** 各状态的扁平图标、配色与固定文案 */
const TRAFFIC_LIGHT_META: Record<AgentTrafficLight, { icon: React.ComponentType<{ className?: string }>; label: string; iconClassName: string; className: string }> = {
  red: { icon: CircleDot, label: '进行中', iconClassName: 'text-red-500 animate-pulse', className: 'text-red-600 dark:text-red-400 border-red-500/30 bg-red-500/5' },
  yellow: { icon: CircleHelp, label: '待决策', iconClassName: 'text-amber-500', className: 'text-amber-600 dark:text-amber-400 border-amber-500/30 bg-amber-500/5' },
  green: { icon: CircleCheck, label: '已完成', iconClassName: 'text-emerald-500', className: 'text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/5' },
}

export function CompletionStatusBar({ text, className }: { text: string; className?: string }): React.ReactElement | null {
  const status: AgentCompletionStatus | null = React.useMemo(() => parseAgentCompletionStatus(text), [text])
  if (!status) return null

  const meta = TRAFFIC_LIGHT_META[status.status]
  const Icon = meta.icon
  return (
    <div
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs',
        meta.className,
        className,
      )}
      title="任务完成态（Agent 红绿灯）"
    >
      <Icon className={cn('size-3.5 shrink-0', meta.iconClassName)} />
      <span className="shrink-0 font-medium">{meta.label}</span>
      {status.detail && (
        <span className="truncate text-muted-foreground">{status.detail}</span>
      )}
    </div>
  )
}
