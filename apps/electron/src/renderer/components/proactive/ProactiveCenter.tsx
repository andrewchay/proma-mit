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
import { Zap, Calendar, Monitor, CheckCircle, History, Brain, Sparkles, Workflow, ListChecks, Wallet, KeyRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import { proactiveCenterTabAtom, type ProactiveTab } from '@/atoms/proactive-center'
import { useProactiveDataSync } from '@/atoms/proactive-sync'
import { TodayTab } from './tabs/TodayTab'
import { SchedulesTab } from './tabs/SchedulesTab'
import { MonitorsTab } from './tabs/MonitorsTab'
import { ApprovalsTab } from './tabs/ApprovalsTab'
import { RunsTab } from './tabs/RunsTab'
import { MemoryTab } from './tabs/MemoryTab'
import { RoutinesTab } from './tabs/RoutinesTab'
import { AutomationRunningPanel } from '@/components/automation/AutomationRunningPanel'
import { CostAuditPanel } from '@/components/automation/CostAuditPanel'
import { CredentialHealthPanel } from '@/components/automation/CredentialHealthPanel'
import { RunCenterSettings } from '@/components/settings/RunCenterSettings'

const TABS: Array<{ id: ProactiveTab; label: string; icon: React.ElementType }> = [
  { id: 'today', label: 'Today', icon: Sparkles },
  { id: 'schedules', label: '定时任务', icon: Calendar },
  { id: 'monitors', label: '监听', icon: Monitor },
  { id: 'approvals', label: '审批', icon: CheckCircle },
  { id: 'running', label: '运行中', icon: ListChecks },
  { id: 'runs', label: '运行记录', icon: History },
  { id: 'memory', label: '记忆', icon: Brain },
  { id: 'routines', label: 'Routines', icon: Workflow },
  { id: 'cost-audit', label: '费用审计', icon: Wallet },
  { id: 'credential-health', label: '凭据体检', icon: KeyRound },
]

export function ProactiveCenter(): React.ReactElement {
  const [activeTab, setActiveTab] = useAtom(proactiveCenterTabAtom)
  const refresh = useProactiveDataSync()

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
        {activeTab === 'today' && <TodayTab onRefresh={refresh} />}
        {activeTab === 'schedules' && <SchedulesTab />}
        {activeTab === 'monitors' && <MonitorsTab />}
        {activeTab === 'approvals' && <ApprovalsTab onRefresh={refresh} />}
        {activeTab === 'running' && <AutomationRunningPanel />}
        {activeTab === 'runs' && (
          <div className="space-y-2">
            <RunsTab onRefresh={refresh} />
            <div className="px-4 pb-4 max-w-4xl mx-auto">
              <RunCenterSettings />
            </div>
          </div>
        )}
        {activeTab === 'memory' && <MemoryTab />}
        {activeTab === 'routines' && <RoutinesTab />}
        {activeTab === 'cost-audit' && <div className="p-4 max-w-4xl mx-auto"><CostAuditPanel /></div>}
        {activeTab === 'credential-health' && <div className="p-4 max-w-4xl mx-auto"><CredentialHealthPanel /></div>}
      </div>
    </div>
  )
}
