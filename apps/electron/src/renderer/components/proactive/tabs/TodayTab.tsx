/**
 * Today Tab - 今日概览（接入真实数据）
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Sparkles, AlertCircle, Activity, Clock, Zap, CheckCircle, XCircle, Pause } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useProactiveDataSync } from '@/atoms/proactive-sync'
import { proactiveSchedulesAtom, proactiveRunsAtom, proactiveRecommendationsAtom, proactiveApprovalsAtom, proactiveLoadingAtom } from '@/atoms/proactive-data'
import type { ProactiveSchedule, ProactiveTaskRun, ProactiveRecommendation, ProactiveApproval } from '@gravitas/shared'

export function TodayTab(): React.ReactElement {
  // 启动数据同步
  useProactiveDataSync()

  const [schedules] = useAtom(proactiveSchedulesAtom)
  const [runs] = useAtom(proactiveRunsAtom)
  const [recommendations] = useAtom(proactiveRecommendationsAtom)
  const [approvals] = useAtom(proactiveApprovalsAtom)
  const [loading] = useAtom(proactiveLoadingAtom)

  const activeSchedules = schedules.filter((s) => s.enabled)
  const pendingApprovals = approvals.filter((a) => a.status === 'pending')
  const suggestedRecommendations = recommendations.filter((r) => r.status === 'suggested')
  const recentRuns = runs.slice(0, 5)

  const handleAcceptRecommendation = async (id: string): Promise<void> => {
    try {
      await window.electronAPI.proactive?.acceptRecommendation?.(id)
    } catch (error) {
      console.error('接受推荐失败:', error)
    }
  }

  const handleDismissRecommendation = async (id: string): Promise<void> => {
    try {
      await window.electronAPI.proactive?.dismissRecommendation?.(id)
    } catch (error) {
      console.error('忽略推荐失败:', error)
    }
  }

  const handleApprove = async (id: string): Promise<void> => {
    try {
      await window.electronAPI.proactive?.approveApproval?.(id)
    } catch (error) {
      console.error('批准失败:', error)
    }
  }

  const handleReject = async (id: string): Promise<void> => {
    try {
      await window.electronAPI.proactive?.rejectApproval?.(id)
    } catch (error) {
      console.error('拒绝失败:', error)
    }
  }

  return (
    <div className="p-4 space-y-4 max-w-4xl mx-auto">
      {/* 加载指示器 */}
      {loading && (
        <div className="flex items-center justify-center py-2 text-xs text-muted-foreground">
          <Activity className="size-3 mr-1 animate-spin" />
          加载中...
        </div>
      )}

      {/* 顶部统计 */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard icon={Sparkles} label="推荐" value={suggestedRecommendations.length} color="text-amber-500" />
        <StatCard icon={AlertCircle} label="待审批" value={pendingApprovals.length} color="text-orange-500" />
        <StatCard icon={Activity} label="运行中" value={activeSchedules.length} color="text-blue-500" />
        <StatCard icon={Clock} label="今日运行" value={recentRuns.filter((r) => r.startedAt && isToday(r.startedAt)).length} color="text-emerald-500" />
      </div>

      {/* Recommended */}
      {suggestedRecommendations.length > 0 && (
        <SectionCard title="推荐开启" icon={Sparkles}>
          <div className="space-y-2">
            {suggestedRecommendations.map((rec) => (
              <RecommendationCard key={rec.id} recommendation={rec} onAccept={handleAcceptRecommendation} onDismiss={handleDismissRecommendation} />
            ))}
          </div>
        </SectionCard>
      )}

      {/* Needs Approval */}
      {pendingApprovals.length > 0 && (
        <SectionCard title="需要确认" icon={AlertCircle}>
          <div className="space-y-2">
            {pendingApprovals.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} onApprove={handleApprove} onReject={handleReject} />
            ))}
          </div>
        </SectionCard>
      )}

      {/* Active */}
      {activeSchedules.length > 0 && (
        <SectionCard title="正在运行" icon={Activity}>
          <div className="space-y-2">
            {activeSchedules.map((schedule) => (
              <ActiveScheduleCard key={schedule.id} schedule={schedule} />
            ))}
          </div>
        </SectionCard>
      )}

      {/* Recent Runs */}
      {recentRuns.length > 0 && (
        <SectionCard title="最近运行" icon={Clock}>
          <div className="space-y-1.5">
            {recentRuns.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </div>
        </SectionCard>
      )}

      {/* Empty State */}
      {suggestedRecommendations.length === 0 && pendingApprovals.length === 0 && activeSchedules.length === 0 && recentRuns.length === 0 && !loading && (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Zap className="size-12 mb-4 opacity-30" />
          <p className="text-sm">暂无主动任务</p>
          <p className="text-xs mt-1 opacity-60">Proma 会根据你的使用习惯推荐主动功能</p>
        </div>
      )}
    </div>
  )
}

function StatCard({ icon: Icon, label, value, color }: { icon: React.ElementType; label: string; value: number; color: string }): React.ReactElement {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-foreground/[0.02] border border-border/40">
      <Icon className={cn('size-5', color)} />
      <div>
        <div className="text-lg font-semibold leading-tight">{value}</div>
        <div className="text-[11px] text-muted-foreground">{label}</div>
      </div>
    </div>
  )
}

function SectionCard({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="rounded-xl border border-border/50 bg-background shadow-sm">
      <div className="px-4 py-3 border-b border-border/50">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Icon size={14} className="text-primary" />
          {title}
        </h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function RecommendationCard({ recommendation, onAccept, onDismiss }: { recommendation: ProactiveRecommendation; onAccept: (id: string) => void; onDismiss: (id: string) => void }): React.ReactElement {
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-800/30">
      <Sparkles className="size-4 text-amber-500 mt-0.5 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{recommendation.title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{recommendation.reason}</p>
        <div className="flex items-center gap-2 mt-2">
          <Button size="sm" variant="default" className="h-7 text-xs" onClick={() => onAccept(recommendation.id)}>
            <CheckCircle className="mr-1 size-3" />
            创建
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onDismiss(recommendation.id)}>
            <XCircle className="mr-1 size-3" />
            忽略
          </Button>
        </div>
      </div>
    </div>
  )
}

function ApprovalCard({ approval, onApprove, onReject }: { approval: ProactiveApproval; onApprove: (id: string) => void; onReject: (id: string) => void }): React.ReactElement {
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-orange-50/50 dark:bg-orange-950/20 border border-orange-200/50 dark:border-orange-800/30">
      <AlertCircle className="size-4 text-orange-500 mt-0.5 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{approval.title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{approval.summary}</p>
        <div className="flex items-center gap-2 mt-2">
          <Button size="sm" variant="default" className="h-7 text-xs" onClick={() => onApprove(approval.id)}>批准</Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onReject(approval.id)}>拒绝</Button>
        </div>
      </div>
    </div>
  )
}

function ActiveScheduleCard({ schedule }: { schedule: ProactiveSchedule }): React.ReactElement {
  return (
    <div className="flex items-center gap-3 p-2.5 rounded-lg bg-blue-50/30 dark:bg-blue-950/10 border border-blue-200/30 dark:border-blue-800/20">
      <Activity className="size-4 text-blue-500 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{schedule.title}</p>
        <p className="text-xs text-muted-foreground">
          下次运行: {schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : '—'}
        </p>
      </div>
      <Pause className="size-4 text-muted-foreground cursor-pointer hover:text-foreground" />
    </div>
  )
}

function RunRow({ run }: { run: ProactiveTaskRun }): React.ReactElement {
  const statusIcon = run.status === 'success' ? <CheckCircle className="size-3.5 text-emerald-500" />
    : run.status === 'failed' ? <XCircle className="size-3.5 text-destructive" />
    : <Activity className="size-3.5 text-blue-500" />

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-foreground/[0.02]">
      {statusIcon}
      <span className="text-xs capitalize">{run.status}</span>
      <span className="text-xs text-muted-foreground">{run.trigger}</span>
      <span className="text-xs text-muted-foreground ml-auto">
        {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}
      </span>
    </div>
  )
}

function isToday(timestamp: number): boolean {
  const date = new Date(timestamp)
  const now = new Date()
  return date.getDate() === now.getDate() && date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear()
}
