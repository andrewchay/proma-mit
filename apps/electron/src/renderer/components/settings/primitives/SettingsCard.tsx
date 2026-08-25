/**
 * SettingsCard - 设置卡片容器
 *
 * 圆角卡片，自动在子元素间插入分隔线。
 * 用于包裹 SettingsRow 或其他控件。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { Separator } from '@/components/ui/separator'
import { CARD_CLASS, DIVIDER_CLASS } from './SettingsUIConstants'

interface SettingsCardProps {
  /** 卡片标题（可选） */
  title?: string
  /** 子内容 */
  children: React.ReactNode
  /** 额外 className */
  className?: string
  /** 是否自动在子元素间插入分隔线（默认 true） */
  divided?: boolean
}

export function SettingsCard({
  title,
  children,
  className,
  divided = true,
}: SettingsCardProps): React.ReactElement {
  const childArray = React.Children.toArray(children).filter(Boolean)

  return (
    <div className={cn(CARD_CLASS, className)}>
      {title && (
        <div className="px-1 pb-3">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
        </div>
      )}
      {divided
        ? childArray.map((child, index) => (
            <React.Fragment key={index}>
              {child}
              {index < childArray.length - 1 && (
                <Separator className={DIVIDER_CLASS} />
              )}
            </React.Fragment>
          ))
        : children}
    </div>
  )
}
