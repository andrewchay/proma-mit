/**
 * CalendarModuleView — 工作模块「日程管家」入口
 *
 * 由 ~/LLM/PAA 的 schedule / calendar 两个子视图迁移而来：
 * - 日程管家：月视图日历 + 任务看板 + 自然语言创建
 * - 日历同步：多日历源管理（Google / Apple / Outlook / 本地）+ 同步日志
 *
 * 顶部提供子视图切换。
 */

import * as React from 'react'
import { CalendarDays, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScheduleView } from './ScheduleView'
import { CalendarView } from './CalendarSyncView'

type CalendarSubView = 'schedule' | 'sync'

export function CalendarModuleView(): React.ReactElement {
  const [subView, setSubView] = React.useState<CalendarSubView>('schedule')

  return (
    <div className="flex flex-col h-full">
      {/* 顶栏：返回对话 + 子视图切换 */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50 flex-shrink-0">
        <div className="flex items-center gap-2 text-[13px] font-medium text-foreground/75">
          <CalendarDays size={15} className="text-foreground/45" />
          日程管家
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-0.5 rounded-lg bg-foreground/[0.04] p-0.5">
          <button
            onClick={() => setSubView('schedule')}
            className={cn(
              'px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors',
              subView === 'schedule'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-foreground/50 hover:text-foreground/80'
            )}
          >
            日程管家
          </button>
          <button
            onClick={() => setSubView('sync')}
            className={cn(
              'px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors',
              subView === 'sync'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-foreground/50 hover:text-foreground/80'
            )}
          >
            <span className="inline-flex items-center gap-1">
              <RefreshCw size={11} />
              日历同步
            </span>
          </button>
        </div>
      </div>

      {/* 子视图内容 */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {subView === 'schedule' ? <ScheduleView /> : <CalendarView />}
      </div>
    </div>
  )
}
