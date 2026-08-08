/**
 * AutomationModuleView — 工作模块「自动化」入口
 *
 * 聚合「自动化」相关三处能力（原分散在工作模块 + 设置面板）：
 * - 运行中：自动任务运行中心（RunRecord 实时刷新）
 * - 定时任务：Proactive Scheduler 管理（创建 / 暂停 / 恢复 / 删除）
 * - 运行记录：Agent / Workflow / 定时任务统一运行历史
 */

import * as React from 'react'
import { ArrowLeft, Zap, ListChecks, Clock3, History } from 'lucide-react'
import { cn } from '@/lib/utils'
import { activeViewAtom } from '@/atoms/active-view'
import { useSetAtom } from 'jotai'
import { AutomationRunningPanel } from './AutomationRunningPanel'
import { ProactiveSchedulerSettings } from '@/components/settings/ProactiveSchedulerSettings'
import { RunCenterSettings } from '@/components/settings/RunCenterSettings'
import { CostAuditPanel } from './CostAuditPanel'

type AutomationSubView = 'schedules' | 'running' | 'runs'

const SUB_VIEWS: { id: AutomationSubView; label: string; icon: React.ReactNode }[] = [
  { id: 'schedules', label: '定时任务', icon: <Clock3 size={11} /> },
  { id: 'running', label: '运行中', icon: <ListChecks size={11} /> },
  { id: 'runs', label: '运行记录', icon: <History size={11} /> },
]

export function AutomationModuleView(): React.ReactElement {
  const setActiveView = useSetAtom(activeViewAtom)
  // 默认展示「定时任务」：自动任务应是自己创建的定时任务（能定时开启来跑）
  const [subView, setSubView] = React.useState<AutomationSubView>('schedules')

  return (
    <div className="flex flex-col h-full">
      {/* 顶栏：返回对话 + 子视图切换（顶部在全局 50px 拖拽区内，按钮需 titlebar-no-drag） */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50 flex-shrink-0">
        <button
          onClick={() => setActiveView('conversations')}
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[13px] text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/85 transition-colors titlebar-no-drag"
        >
          <ArrowLeft size={15} />
          返回对话
        </button>
        <div className="flex items-center gap-2 text-[13px] font-medium text-foreground/75">
          <Zap size={15} className="text-foreground/45" />
          自动化
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-0.5 rounded-lg bg-foreground/[0.04] p-0.5">
          {SUB_VIEWS.map(({ id, label, icon }) => (
            <button
              key={id}
              onClick={() => setSubView(id)}
              className={cn(
                'px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors inline-flex items-center gap-1 titlebar-no-drag',
                subView === id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-foreground/50 hover:text-foreground/80'
              )}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 子视图内容 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {subView === 'schedules' && (
          <div className="p-4 space-y-4">
            <ProactiveSchedulerSettings />
            {/* PH2-C：费用审计 */}
            <CostAuditPanel />
          </div>
        )}
        {subView === 'running' && <AutomationRunningPanel />}
        {subView === 'runs' && (
          <div className="p-4">
            <RunCenterSettings />
          </div>
        )}
      </div>
    </div>
  )
}
