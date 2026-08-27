/** 本地 Proactive Scheduler 的管理界面（卡片式改版）。 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Activity, Clock3, LoaderCircle, Pause, Play, Plus, RefreshCw, SlidersHorizontal, Trash2, ZapOff } from 'lucide-react'
import { toast } from 'sonner'
import type { AgentSessionMeta, Channel, ProactiveSchedule } from '@gravitas/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  proactiveLoadingAtom,
  proactiveRunsAtom,
  proactiveSchedulesAtom,
  proactiveSessionsAtom,
} from '@/atoms/proactive-scheduler'
import { SettingsCard, SettingsSection } from './primitives'
import { ProactiveScheduleCreateDialog } from './ProactiveScheduleCreateDialog'

type SchedulableSession = AgentSessionMeta & { agentRuntime: 'proma' | 'ai-sdk'; channelId: string }

function eligibleRuntime(session: AgentSessionMeta): session is SchedulableSession {
  return Boolean(session.channelId) && (session.agentRuntime === 'proma' || session.agentRuntime === 'ai-sdk')
}

type ScheduleFilter = 'all' | 'enabled' | 'paused' | 'failing'

const FILTER_LABEL: Record<ScheduleFilter, string> = {
  all: '全部',
  enabled: '已启用',
  paused: '已暂停',
  failing: '需关注',
}

export function ProactiveSchedulerSettings(): React.ReactElement {
  const [schedules, setSchedules] = useAtom(proactiveSchedulesAtom)
  const [runs, setRuns] = useAtom(proactiveRunsAtom)
  const [sessions, setSessions] = useAtom(proactiveSessionsAtom)
  const [loading, setLoading] = useAtom(proactiveLoadingAtom)
  const [channels, setChannels] = React.useState<Channel[]>([])
  const [createOpen, setCreateOpen] = React.useState(false)
  const [filter, setFilter] = React.useState<ScheduleFilter>('all')

  const refresh = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [nextSchedules, nextRuns, nextSessions, nextChannels] = await Promise.all([
        window.electronAPI.listProactiveSchedules(),
        window.electronAPI.listProactiveRuns(),
        window.electronAPI.listAgentSessions(),
        window.electronAPI.listChannels(),
      ])
      setSchedules(nextSchedules)
      setRuns(nextRuns)
      setSessions(nextSessions.filter(eligibleRuntime))
      setChannels(nextChannels)
    } catch (error) {
      console.error('[Proactive Scheduler] 读取失败:', error)
      toast.error('读取定时任务失败')
    } finally {
      setLoading(false)
    }
  }, [setLoading, setRuns, setSchedules, setSessions])

  React.useEffect(() => { void refresh() }, [refresh])

  const mutate = async (action: () => Promise<unknown>, success: string): Promise<void> => {
    try {
      await action()
      toast.success(success)
      await refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败')
    }
  }

  const filteredSchedules = React.useMemo(() => {
    switch (filter) {
      case 'all': return schedules
      case 'enabled': return schedules.filter((s) => s.enabled && s.consecutiveFailures < 3)
      case 'paused': return schedules.filter((s) => !s.enabled)
      case 'failing': return schedules.filter((s) => s.consecutiveFailures >= 3)
    }
  }, [schedules, filter])

  const countEnabled = schedules.filter((s) => s.enabled && s.consecutiveFailures < 3).length
  const countPaused = schedules.filter((s) => !s.enabled).length
  const countFailing = schedules.filter((s) => s.consecutiveFailures >= 3).length

  return (
    <div className="space-y-5">
      {/* 头部：标题 + 新建/刷新 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="rounded-xl bg-primary/10 p-2 text-primary"><SlidersHorizontal className="size-4" /></div>
          <div>
            <div className="text-sm font-semibold">定时任务</div>
            <div className="text-xs text-muted-foreground">只在本机运行的无人值守任务，默认安全权限</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={cn('mr-2 size-4', loading && 'animate-spin')} />刷新
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 size-4" />新建任务
          </Button>
        </div>
      </div>

      {/* 状态过滤 */}
      <div className="flex items-center gap-0.5 rounded-lg bg-foreground/[0.04] p-0.5 w-fit">
        {(['all', 'enabled', 'paused', 'failing'] as ScheduleFilter[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={cn(
              'px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors inline-flex items-center gap-1',
              filter === key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground/80'
            )}
          >
            {FILTER_LABEL[key]}
            {key === 'enabled' && countEnabled > 0 && <span className="text-[10px] text-muted-foreground tabular-nums">{countEnabled}</span>}
            {key === 'paused' && countPaused > 0 && <span className="text-[10px] text-muted-foreground tabular-nums">{countPaused}</span>}
            {key === 'failing' && countFailing > 0 && <span className="text-[10px] text-red-500 tabular-nums">{countFailing}</span>}
          </button>
        ))}
      </div>

      {/* 任务卡片网格 */}
      {loading ? (
        <div className="py-14 text-center text-sm text-muted-foreground"><LoaderCircle className="mx-auto mb-2 size-5 animate-spin" />加载中…</div>
      ) : filteredSchedules.length === 0 ? (
        <EmptyState
          filter={filter}
          hasAny={schedules.length > 0}
          onCreate={() => setCreateOpen(true)}
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {filteredSchedules.map((schedule) => (
            <ScheduleCard
              key={schedule.id}
              schedule={schedule}
              onPause={() => mutate(() => window.electronAPI.setProactiveScheduleEnabled(schedule.id, false), '已暂停定时任务')}
              onResume={() => mutate(() => window.electronAPI.setProactiveScheduleEnabled(schedule.id, true), '已恢复定时任务')}
              onRun={() => mutate(() => window.electronAPI.runProactiveSchedule(schedule.id), '已完成手动运行')}
              onDelete={() => mutate(() => window.electronAPI.deleteProactiveSchedule(schedule.id), '已删除定时任务')}
            />
          ))}
        </div>
      )}

      {/* 最近运行 */}
      <SettingsSection title="最近运行" description={runs.length > 0 ? `最近 ${Math.min(runs.length, 8)} 次执行` : undefined}>
        <div className="space-y-2">
          {runs.slice(0, 8).map((run) => (
            <SettingsCard key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className={cn(
                'shrink-0 px-2 py-0.5 rounded-full text-[11px] font-medium',
                run.status === 'success' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : run.status === 'failed' ? 'bg-red-500/10 text-red-500'
                    : run.status === 'running' ? 'bg-blue-500/10 text-blue-500'
                      : run.status === 'cancelled' ? 'bg-muted text-muted-foreground'
                        : 'bg-amber-500/10 text-amber-600'
              )}>{run.status}</span>
              <span className="text-muted-foreground">{run.trigger} · {formatTime(run.startedAt)}</span>
              {run.sessionId && <span className="font-mono text-xs text-muted-foreground">会话 {run.sessionId.slice(0, 8)}</span>}
              {run.outputSummary && <span className="truncate text-muted-foreground">{run.outputSummary}</span>}
              {run.error && <span className="text-destructive">{run.error}</span>}
            </SettingsCard>
          ))}
          {runs.length === 0 && <SettingsCard className="py-6 text-center text-sm text-muted-foreground">暂无运行记录。</SettingsCard>}
        </div>
      </SettingsSection>

      <ProactiveScheduleCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        channels={channels}
        sessions={sessions}
        loading={loading}
        onCreated={() => void refresh()}
      />
    </div>
  )
}

function ScheduleCard({
  schedule, onPause, onResume, onRun, onDelete,
}: {
  schedule: ProactiveSchedule
  onPause: () => void
  onResume: () => void
  onRun: () => void
  onDelete: () => void
}): React.ReactElement {
  const failing = schedule.consecutiveFailures >= 3
  const running = schedule.enabled && !failing
  const paused = !schedule.enabled

  return (
    <div className="group relative flex flex-col gap-3 rounded-xl border border-border/50 bg-card p-4 shadow-sm transition-colors hover:border-primary/30">
      {/* 顶行：状态 + 标题 + 操作 */}
      <div className="flex items-start gap-2">
        <span
          className={cn(
            'mt-1.5 size-2 shrink-0 rounded-full',
            running ? 'bg-emerald-500' : paused ? 'bg-muted-foreground/40' : 'bg-red-500 animate-pulse'
          )}
          title={running ? '运行中' : paused ? '已暂停' : '连续失败'}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-foreground" title={schedule.title}>{schedule.title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{describeSchedule(schedule)}</p>
        </div>
        <div className="flex items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
          <IconButton title="手动运行" onClick={onRun}><Play className="size-3.5" /></IconButton>
          {schedule.enabled
            ? <IconButton title="暂停" onClick={onPause}><Pause className="size-3.5" /></IconButton>
            : <IconButton title="恢复" onClick={onResume}><Play className="size-3.5" /></IconButton>}
          <IconButton title="删除" destructive onClick={onDelete}><Trash2 className="size-3.5" /></IconButton>
        </div>
      </div>

      {/* 元信息 */}
      <div className="flex flex-wrap gap-1.5">
        <MetaBadge>{schedule.permissionMode === 'plan' ? 'Plan' : '安全'}</MetaBadge>
        <MetaBadge>{schedule.newSession ? '新建会话' : '复用会话'}</MetaBadge>
        <MetaBadge>{schedule.runtime === 'ai-sdk' ? 'AI SDK' : 'Gravitas'}</MetaBadge>
        {schedule.channelId && <MetaBadge className="truncate max-w-[120px]" title={schedule.channelId}>{schedule.channelId.slice(0, 10)}</MetaBadge>}
      </div>

      {/* 底部：下次运行 / 健康 */}
      <div className="flex items-center justify-between gap-2 border-t border-border/40 pt-2.5 text-xs">
        <span className="flex items-center gap-1 text-muted-foreground">
          <Clock3 className="size-3.5" />下次 {formatScheduleTime(schedule)}
        </span>
        <span className="flex items-center gap-1 text-muted-foreground">
          <Activity className="size-3.5" />最近 {formatDelta(schedule.lastRunAt)}
        </span>
      </div>

      {failing && (
        <p className="text-[11px] font-medium text-red-500">
          连续失败 {schedule.consecutiveFailures}/3，已自动暂停
        </p>
      )}
    </div>
  )
}

function IconButton({
  children, title, destructive, onClick,
}: {
  children: React.ReactNode
  title: string
  destructive?: boolean
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        'rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground',
        destructive && 'hover:text-destructive'
      )}
    >
      {children}
    </button>
  )
}

function MetaBadge({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }): React.ReactElement {
  return <span className={cn('rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground', className)} title={title}>{children}</span>
}

function EmptyState({ filter, hasAny, onCreate }: { filter: ScheduleFilter; hasAny: boolean; onCreate: () => void }): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border/70 bg-muted/20 py-14 text-center">
      <div className="rounded-2xl bg-muted p-3">{hasAny ? <ZapOff className="size-6 text-muted-foreground" /> : <Clock3 className="size-6 text-muted-foreground" />}</div>
      <p className="text-sm text-muted-foreground">
        {hasAny ? `「${FILTER_LABEL[filter]}」下暂无任务` : '还没有定时任务，创建一个让你的工作自动跑起来'}
      </p>
      {!hasAny && <Button size="sm" onClick={onCreate}><Plus className="mr-2 size-4" />新建任务</Button>}
    </div>
  )
}

function describeSchedule(schedule: ProactiveSchedule): string {
  if (schedule.schedule.type === 'at') return '一次性执行'
  if (schedule.schedule.type === 'interval') return `每 ${schedule.schedule.intervalMs / 60_000} 分钟`
  return `Cron ${schedule.schedule.expression} · ${schedule.schedule.timezone}`
}
function formatScheduleTime(schedule: ProactiveSchedule): string {
  if (!schedule.nextRunAt) return '—'
  const timezone = schedule.schedule.type === 'cron' ? schedule.schedule.timezone : undefined
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short', timeZone: timezone }).format(schedule.nextRunAt)
}
function formatDelta(value: number | undefined): string {
  if (!value) return '—'
  const diff = Date.now() - value
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}
function formatTime(value: number | undefined): string { return value ? new Date(value).toLocaleString() : '—' }
