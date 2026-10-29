import * as React from 'react'
import type { ProjectJudgmentReasonCode } from '@gravitas/shared'

export const JUDGMENT_REASON_LABELS: Record<ProjectJudgmentReasonCode, string> = {
  wrong_direction: '方向错了',
  missing_context: '缺少上下文',
  wrong_granularity: '粒度不合适',
  preference_violation: '不符合偏好',
  execution_error: '事实或执行错误',
  other: '其他原因',
}

export const JudgmentReasonSelect = React.forwardRef<HTMLSelectElement, { name?: string; disabled?: boolean }>(
  function JudgmentReasonSelect({ name, disabled }, ref) {
    return <select ref={ref} name={name} disabled={disabled} defaultValue="" aria-label="退回原因分类" className="rounded-md bg-background p-2 text-xs">
      <option value="">选择退回原因</option>
      {Object.entries(JUDGMENT_REASON_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
  },
)
