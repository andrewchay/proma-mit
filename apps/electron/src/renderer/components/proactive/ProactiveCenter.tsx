/**
 * Proactive Center - 主动协作中心
 *
 * 六 Tab 布局：
 * - Today: 今日概览（推荐/活跃/审批/最近运行/洞察）
 * - Schedules: 定时任务管理
 * - Monitors: 监听任务管理
 * - Approvals: 待审批事项
 * - Runs: 运行历史
 * - Memory: 记忆管理
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Zap, Calendar, Monitor, CheckCircle, History, Brain, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { proactiveCenterTabAtom, type ProactiveTab } from '@/atoms/proactive-center'
import { TodayTab } from './tabs/TodayTab'
import { SchedulesTab } from './tabs/SchedulesTab'
import { MonitorsTab } from './tabs/MonitorsTab'
import { ApprovalsTab } from './tabs/ApprovalsTab'
import { RunsTab } from './tabs/RunsTab'
import { MemoryTab } from './tabs/MemoryTab'

const TABS: Array<{ id: ProactiveTab; label: string; icon: React.ElementType }> = [
  { id: 'today', label: 'Today', icon: Sparkles },
  { id: 'schedules', label: '定时任务', icon: Calendar },
  { id: 'monitors', label: '监听', icon: Monitor },
  { id: 'approvals', label: '审批', icon: CheckCircle },
  { id: 'runs', label: '运行记录', icon: History },
  { id: 'memory', label: '记忆', icon: Brain },
]

export function ProactiveCenter(): React.ReactElement {
  const [activeTab, setActiveTab] = useAtom(proactiveCenterTabAtom)

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border/50">
        <Zap className="size-5 text-primary" />
        <h1 className="text-base font-semibold">Proactive Center</h1>
        <span className="text-xs text-muted-foreground ml-1">主动协作</span>
      </div>

      {/* Tab Bar */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border/50 overflow-x-auto">
        {TABS.map((tab) => {
          const Icon = tab.icon
          const active = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors whitespace-nowrap',
                active
                  ? 'bg-primary/10 text-primary'
                  : 'text-foreground/55 hover:bg-foreground/[0.04] hover:text-foreground/80'
              )}
            >
              <Icon size={14} />
              <span>{tab.label}</span>
            </button>
          )
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'today' && <TodayTab />}
        {activeTab === 'schedules' && <SchedulesTab />}
        {activeTab === 'monitors' && <MonitorsTab />}
        {activeTab === 'approvals' && <ApprovalsTab />}
        {activeTab === 'runs' && <RunsTab />}
        {activeTab === 'memory' && <MemoryTab />}
      </div>
    </div>
  )
}
