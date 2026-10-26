import type * as React from 'react'

/** Owner 模块状态徽章：每个模块卡标题右侧的独立状态位，与配置表单和说明文字分开呈现。 */
const tones = {
  muted: 'bg-muted text-muted-foreground',
  accent: 'bg-primary/10 text-primary',
  warn: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  danger: 'bg-destructive/10 text-destructive',
} as const

export function OwnerModuleStatus({ tone = 'muted', children }: {
  tone?: keyof typeof tones
  children: React.ReactNode
}): React.ReactElement {
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${tones[tone]}`} role="status">
      {children}
    </span>
  )
}
