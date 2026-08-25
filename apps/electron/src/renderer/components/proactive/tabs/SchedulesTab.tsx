/**
 * Schedules Tab - 定时任务管理
 *
 * 从 ProactiveSchedulerSettings 迁移并增强
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Clock3, LoaderCircle, Pause, Play, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ProactiveSchedule } from '@gravitas/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  proactiveSchedulesAtom,
  proactiveRunsAtom,
  proactiveSessionsAtom,
  proactiveLoadingAtom,
  proactiveSelectedSessionIdAtom,
  proactiveNewSessionAtom,
  proactiveSelectedChannelIdAtom,
  proactivePromptAtom,
  proactiveScheduleKindAtom,
  proactiveRunAtAtom,
  proactiveIntervalMinutesAtom,
  proactiveCronExpressionAtom,
  proactiveCronTimezoneAtom,
} from '@/atoms/proactive-scheduler'
import type { AgentRuntime, Channel } from '@gravitas/shared'

type SchedulableSession = import('@gravitas/shared').AgentSessionMeta & { agentRuntime: 'proma' | 'ai-sdk'; channelId: string }

function eligibleRuntime(session: import('@gravitas/shared').AgentSessionMeta): session is SchedulableSession {
  return Boolean(session.channelId) && (session.agentRuntime === 'proma' || session.agentRuntime === 'ai-sdk')
}

function isSchedulableRuntime(runtime: string): runtime is 'proma' | 'ai-sdk' {
  return runtime === 'proma' || runtime === 'ai-sdk'
}

export function SchedulesTab(): React.ReactElement {
  const [schedules, setSchedules] = useAtom(proactiveSchedulesAtom)
  const [runs, setRuns] = useAtom(proactiveRunsAtom)
  const [sessions, setSessions] = useAtom(proactiveSessionsAtom)
  const [loading, setLoading] = useAtom(proactiveLoadingAtom)
  const [sessionId, setSessionId] = useAtom(proactiveSelectedSessionIdAtom)
  const [newSession, setNewSession] = useAtom(proactiveNewSessionAtom)
  const [selectedChannelId, setSelectedChannelId] = useAtom(proactiveSelectedChannelIdAtom)
  const [prompt, setPrompt] = useAtom(proactivePromptAtom)
  const [kind, setKind] = useAtom(proactiveScheduleKindAtom)
  const [runAt, setRunAt] = useAtom(proactiveRunAtAtom)
  const [intervalMinutes, setIntervalMinutes] = useAtom(proactiveIntervalMinutesAtom)
  const [cronExpression, setCronExpression] = useAtom(proactiveCronExpressionAtom)
  const [cronTimezone, setCronTimezone] = useAtom(proactiveCronTimezoneAtom)
  const [channels, setChannels] = React.useState<Channel[]>([])
  const [selectedRuntime, setSelectedRuntime] = React.useState<'proma' | 'ai-sdk'>('proma')

  const refresh = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [nextSchedules, nextRuns, nextSessions, nextChannels] = await Promise.all([
        window.electronAPI.listProactiveSchedules(),
        window.electronAPI.listProactiveRuns(),
        window.electronAPI.listAgentSessions(),
        window.electronAPI.listChannels(),
      ])
      const eligible = nextSessions.filter(eligibleRuntime)
      setSchedules(nextSchedules)
      setRuns(nextRuns)
      setSessions(eligible)
      setChannels(nextChannels)
      setSessionId((current) => eligible.some((item) => item.id === current) ? current : eligible[0]?.id ?? '')
      setSelectedChannelId((current) => nextChannels.some((item) => item.id === current && item.enabled) ? current : nextChannels.find((item) => item.enabled)?.id ?? '')
    } catch (error) {
      console.error('[Proactive Schedules] 读取失败:', error)
      toast.error('读取定时任务失败')
    } finally {
      setLoading(false)
    }
  }, [setLoading, setRuns, setSchedules, setSessionId, setSessions, setSelectedChannelId])

  React.useEffect(() => {
    if (!runAt) setRunAt(toLocalDateTime(Date.now() + 60_000))
    void refresh()
  }, [refresh, runAt, setRunAt])

  const create = async (): Promise<void> => {
    if (!prompt.trim()) {
      toast.error('请填写任务内容')
      return
    }
    const enabledChannels = channels.filter((item) => item.enabled)
    const channel = enabledChannels.find((item) => item.id === selectedChannelId)
    const session = sessions.find((item) => item.id === sessionId)
    if (newSession) {
      if (!channel || !isSchedulableRuntime(selectedRuntime)) {
        toast.error('请选择已启用渠道和 Gravitas / AI SDK Runtime')
        return
      }
    } else {
      if (!session?.channelId || !eligibleRuntime(session)) {
        toast.error('请选择已配置渠道的 Gravitas 或 AI SDK 会话')
        return
      }
    }
    const modelId = channel?.models.find((model) => model.enabled)?.id ?? channel?.models[0]?.id
    if (!modelId) {
      toast.error('所选渠道没有可用模型')
      return
    }
    const schedule = kind === 'at'
      ? { type: 'at' as const, runAt: new Date(runAt).getTime() }
      : kind === 'interval'
        ? { type: 'interval' as const, intervalMs: Number(intervalMinutes) * 60_000 }
        : { type: 'cron' as const, expression: cronExpression.trim(), timezone: cronTimezone.trim() }
    try {
      await window.electronAPI.createProactiveSchedule({
        title: prompt.trim().slice(0, 48),
        sessionId: newSession ? undefined : session?.id,
        workspaceId: newSession ? undefined : session?.workspaceId,
        channelId: newSession ? (channel?.id ?? '') : (session?.channelId ?? ''),
        runtime: newSession ? selectedRuntime : ((session?.agentRuntime ?? 'proma') as 'proma' | 'ai-sdk'),
        modelId,
        prompt: prompt.trim(),
        schedule,
        newSession,
      })
      setPrompt('')
      toast.success('定时任务已创建')
      await refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建定时任务失败')
    }
  }

  const mutate = async (action: () => Promise<unknown>, success: string): Promise<void> => {
    try {
      await action()
      toast.success(success)
      await refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败')
    }
  }

  return (
    <div className="p-4 space-y-4 max-w-4xl mx-auto">
      {/* 创建表单 */}
      <div className="rounded-xl border border-border/50 bg-background shadow-sm">
        <div className="px-4 py-3 border-b border-border/50">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <Plus size={14} className="text-primary" />
            新建定时任务
          </h3>
        </div>
        <div className="p-4 space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1.5 text-sm text-muted-foreground">
              执行目标
              <Select value={newSession ? 'new' : 'existing'} onValueChange={(value) => setNewSession(value === 'new')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="existing">复用已有会话</SelectItem>
                  <SelectItem value="new">新建会话执行</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm text-muted-foreground">
              运行方式
              <Select value={kind} onValueChange={(value: 'at' | 'interval' | 'cron') => setKind(value)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="at">一次性执行</SelectItem>
                  <SelectItem value="interval">固定间隔</SelectItem>
                  <SelectItem value="cron">Cron 计划</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>

          {newSession ? (
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-1.5 text-sm text-muted-foreground">
                渠道
                <Select value={selectedChannelId} onValueChange={setSelectedChannelId} disabled={channels.length === 0}>
                  <SelectTrigger><SelectValue placeholder="选择已启用渠道" /></SelectTrigger>
                  <SelectContent>
                    {channels.filter((item) => item.enabled).map((channel) => (
                      <SelectItem key={channel.id} value={channel.id}>{channel.name} · {channel.provider}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="grid gap-1.5 text-sm text-muted-foreground">
                Runtime
                <Select value={selectedRuntime} onValueChange={(value: 'proma' | 'ai-sdk') => setSelectedRuntime(value)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="proma">Gravitas</SelectItem>
                    <SelectItem value="ai-sdk">AI SDK</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            </div>
          ) : (
            <label className="grid gap-1.5 text-sm text-muted-foreground">
              目标会话
              <Select value={sessionId} onValueChange={setSessionId} disabled={sessions.length === 0}>
                <SelectTrigger><SelectValue placeholder="选择已配置渠道的会话" /></SelectTrigger>
                <SelectContent>
                  {sessions.map((session) => (
                    <SelectItem key={session.id} value={session.id}>{session.title} · {session.agentRuntime}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}

          {kind === 'at' && (
            <label className="grid gap-1.5 text-sm text-muted-foreground">
              执行时间
              <Input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} />
            </label>
          )}
          {kind === 'interval' && (
            <label className="grid gap-1.5 text-sm text-muted-foreground">
              间隔（分钟，至少 1）
              <Input type="number" min="1" value={intervalMinutes} onChange={(e) => setIntervalMinutes(e.target.value)} />
            </label>
          )}
          {kind === 'cron' && (
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-1.5 text-sm text-muted-foreground">
                Cron 表达式
                <Input value={cronExpression} onChange={(e) => setCronExpression(e.target.value)} placeholder="例如：0 9 * * 1-5" />
              </label>
              <label className="grid gap-1.5 text-sm text-muted-foreground">
                IANA 时区
                <Input value={cronTimezone} onChange={(e) => setCronTimezone(e.target.value)} placeholder="例如：Asia/Shanghai" />
              </label>
            </div>
          )}

          <label className="grid gap-1.5 text-sm text-muted-foreground">
            任务内容
            <Input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="例如：检查当前工作区的未提交变更并总结" />
          </label>

          <Button onClick={() => void create()} disabled={loading || (newSession ? channels.length === 0 : sessions.length === 0)}>
            <Plus className="mr-2 size-4" />
            创建安全定时任务
          </Button>
        </div>
      </div>

      {/* 任务列表 */}
      <div className="rounded-xl border border-border/50 bg-background shadow-sm">
        <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <Clock3 size={14} className="text-primary" />
            已创建任务
          </h3>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={loading ? 'mr-2 size-4 animate-spin' : 'mr-2 size-4'} />
            刷新
          </Button>
        </div>
        <div className="p-4">
          {!loading && schedules.length === 0 && (
            <p className="text-center text-sm text-muted-foreground py-8">暂无定时任务。</p>
          )}
          <div className="space-y-2">
            {schedules.map((schedule) => (
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
        </div>
      </div>

      {/* 最近运行 */}
      <div className="rounded-xl border border-border/50 bg-background shadow-sm">
        <div className="px-4 py-3 border-b border-border/50">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <RefreshCw size={14} className="text-primary" />
            最近运行
          </h3>
        </div>
        <div className="p-4">
          {runs.slice(0, 8).map((run) => (
            <div key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm py-1.5">
              <span className={run.status === 'success' ? 'font-medium text-emerald-600 dark:text-emerald-400' : run.status === 'failed' ? 'font-medium text-destructive' : 'font-medium'}>
                {run.status}
              </span>
              <span className="text-muted-foreground">{run.trigger} · {formatTime(run.startedAt)}</span>
              {run.sessionId && <span className="font-mono text-xs text-muted-foreground">会话 {run.sessionId.slice(0, 8)}</span>}
              {run.outputSummary && <span className="text-muted-foreground">{run.outputSummary}</span>}
              {run.error && <span className="text-destructive">{run.error}</span>}
            </div>
          ))}
          {runs.length === 0 && <p className="text-center text-sm text-muted-foreground py-6">暂无运行记录。</p>}
        </div>
      </div>
    </div>
  )
}

function ScheduleCard({ schedule, onPause, onResume, onRun, onDelete }: {
  schedule: ProactiveSchedule
  onPause: () => void
  onResume: () => void
  onRun: () => void
  onDelete: () => void
}): React.ReactElement {
  const failureHint = schedule.consecutiveFailures > 0 ? ` · 连续失败 ${schedule.consecutiveFailures}/3` : ''
  return (
    <div className="flex flex-wrap items-center gap-3 p-3 rounded-lg bg-foreground/[0.02] border border-border/40">
      <Clock3 className="size-4 text-primary flex-shrink-0" />
      <div className="min-w-48 flex-1">
        <p className="font-medium text-sm">{schedule.title}</p>
        <p className="text-xs text-muted-foreground">
          {describeSchedule(schedule)} · {schedule.permissionMode} · {schedule.newSession ? '新建会话执行' : '复用会话'} · 下次 {formatScheduleTime(schedule)}{failureHint}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="sm" onClick={onRun}><Play className="mr-1 size-3.5" />运行</Button>
        {schedule.enabled ? (
          <Button variant="outline" size="sm" onClick={onPause}><Pause className="mr-1 size-3.5" />暂停</Button>
        ) : (
          <Button variant="outline" size="sm" onClick={onResume}><Play className="mr-1 size-3.5" />恢复</Button>
        )}
        <Button variant="ghost" size="icon" onClick={onDelete} aria-label="删除定时任务"><Trash2 className="size-4 text-destructive" /></Button>
      </div>
    </div>
  )
}

function describeSchedule(schedule: ProactiveSchedule): string {
  if (schedule.schedule.type === 'at') return '一次性'
  if (schedule.schedule.type === 'interval') return `每 ${schedule.schedule.intervalMs / 60_000} 分钟`
  return `Cron ${schedule.schedule.expression} · ${schedule.schedule.timezone}`
}

function formatScheduleTime(schedule: ProactiveSchedule): string {
  if (!schedule.nextRunAt) return '—'
  const timezone = schedule.schedule.type === 'cron' ? schedule.schedule.timezone : undefined
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short', timeZone: timezone }).format(schedule.nextRunAt)
}

function formatTime(value: number | undefined): string {
  return value ? new Date(value).toLocaleString() : '—'
}

function toLocalDateTime(value: number): string {
  const date = new Date(value - new Date().getTimezoneOffset() * 60_000)
  return date.toISOString().slice(0, 16)
}
