/**
 * 截止日期徽标 — Due Date Badge
 *
 * 展示 DDL + 紧迫感（逾期红 / 今天与 3 天内琥珀 / 其余灰）。
 * 已完成或无 DDL 不渲染；规则见 project-flow-metrics.dueDateUrgency。
 */
import type * as React from 'react'
import { dueDateUrgency } from './project-flow-metrics'

/** tone → 底色（与项目模块既有徽标色系一致） */
const TONE_CLASS: Record<'red' | 'amber' | 'gray', string> = {
  red: 'bg-red-100 text-red-700',
  amber: 'bg-amber-100 text-amber-700',
  gray: 'bg-gray-100 text-gray-600',
}

interface DueDateBadgeProps {
  dueDate?: number
  /** 任务处于 completed/cancelled 语义组时传 true，徽标不渲染 */
  isDone: boolean
}

export function DueDateBadge({ dueDate, isDone }: DueDateBadgeProps): React.ReactElement | null {
  const urgency = dueDateUrgency(dueDate, isDone)
  if (!urgency) return null
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded ${TONE_CLASS[urgency.tone]}`} title={`截止日期：${urgency.text}`}>
      📅 {urgency.text}
    </span>
  )
}
