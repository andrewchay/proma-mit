/**
 * CompletionStatusBar — 任务完成态红绿灯状态条
 *
 * 渲染 Agent 回复末尾约定的 🟢/🟡/🔴 进度状态行（约定见 agent-prompt-builder
 * 的 TRAFFIC_LIGHT_GUIDE）。解析结果来自 @gravitas/shared 的
 * parseAgentCompletionStatus；任何不符合约定的文本都不会渲染本组件（干净退化）。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { parseAgentCompletionStatus } from '@gravitas/shared'
import type { AgentCompletionStatus, AgentTrafficLight } from '@gravitas/shared'

/** 各状态的外观与固定文案（emoji 由解析层保留，这里补充语义标签） */
const TRAFFIC_LIGHT_META: Record<AgentTrafficLight, { label: string; className: string }> = {
  green: { label: '进行中', className: 'text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/5' },
  yellow: { label: '待决策', className: 'text-amber-600 dark:text-amber-400 border-amber-500/30 bg-amber-500/5' },
  // 红灯语义是「已完成，剩余事项已存档」，不是错误，用中性色避免误导
  red: { label: '已完成', className: 'text-muted-foreground border-muted-foreground/30 bg-muted/30' },
}

export function CompletionStatusBar({ text, className }: { text: string; className?: string }): React.ReactElement | null {
  const status: AgentCompletionStatus | null = React.useMemo(() => parseAgentCompletionStatus(text), [text])
  if (!status) return null

  const meta = TRAFFIC_LIGHT_META[status.status]
  return (
    <div
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs',
        meta.className,
        className,
      )}
      title="任务完成态（Agent 红绿灯）"
    >
      <span className="shrink-0">{status.status === 'green' ? '🟢' : status.status === 'yellow' ? '🟡' : '🔴'}</span>
      <span className="shrink-0 font-medium">{meta.label}</span>
      {status.detail && (
        <span className="truncate text-muted-foreground">{status.detail}</span>
      )}
    </div>
  )
}
