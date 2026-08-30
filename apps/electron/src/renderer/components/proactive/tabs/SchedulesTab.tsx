/**
 * Schedules Tab - 定时任务管理
 *
 * 从 ProactiveSchedulerSettings 迁移并增强
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Clock3, LoaderCircle, Pause, Pencil, Play, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ProactiveSchedule } from '@gravitas/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
import type { AgentRuntime, AgentSessionMeta, Channel } from '@gravitas/shared'
import { proactiveConfigurationRecommendationAtom } from '@/atoms/proactive-center'
import { proactiveRecommendationsAtom } from '@/atoms/proactive-data'

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
  const [editingSchedule, setEditingSchedule] = React.useState<ProactiveSchedule | null>(null)
  const [configurationRecommendation, setConfigurationRecommendation] = useAtom(proactiveConfigurationRecommendationAtom)
  const [, setRecommendations] = useAtom(proactiveRecommendationsAtom)

  React.useEffect(() => {
    const recommendation = configurationRecommendation
    const action = recommendation?.action
    if (!recommendation || !isScheduleRecommendationAction(action)) return
    setPrompt((current) => current || `执行「${recommendation.title}」并输出可审计摘要`)
    if (action.schedule.type === 'cron') {
      setKind('cron')
      setCronExpression(action.schedule.expression)
      setCronTimezone(action.schedule.timezone)
    } else if (action.schedule.type === 'interval') {
      setKind('interval')
      setIntervalMinutes(String(Math.max(1, Math.round(action.schedule.intervalMs / 60_000))))
    }
  }, [configurationRecommendation, setCronExpression, setCronTimezone, setIntervalMinutes, setKind, setPrompt])

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
      if (configurationRecommendation) {
        const accepted = await window.electronAPI.proactive?.acceptRecommendation?.(configurationRecommendation.id)
        if (accepted) setRecommendations((current) => current.map((item) => item.id === accepted.id ? accepted : item))
        setConfigurationRecommendation(null)
      }
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
                onEdit={() => setEditingSchedule(schedule)}
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

      {editingSchedule && (
        <ScheduleEditDialog
          key={editingSchedule.id}
          schedule={editingSchedule}
          sessions={sessions}
          channels={channels}
          onOpenChange={(open) => { if (!open) setEditingSchedule(null) }}
          onSaved={async () => { setEditingSchedule(null); await refresh() }}
        />
      )}
    </div>
  )
}

interface ScheduleRecommendationAction {
  type: 'create_schedule'
  schedule: { type: 'cron'; expression: string; timezone: string } | { type: 'interval'; intervalMs: number }
}

function isScheduleRecommendationAction(value: unknown): value is ScheduleRecommendationAction {
  if (typeof value !== 'object' || value === null) return false
  const action = value as Record<string, unknown>
  if (action.type !== 'create_schedule' || typeof action.schedule !== 'object' || action.schedule === null) return false
  const schedule = action.schedule as Record<string, unknown>
  return (schedule.type === 'cron' && typeof schedule.expression === 'string' && typeof schedule.timezone === 'string') || (schedule.type === 'interval' && typeof schedule.intervalMs === 'number')
}

function ScheduleCard({ schedule, onPause, onResume, onRun, onDelete, onEdit }: {
  schedule: ProactiveSchedule
  onPause: () => void
  onResume: () => void
  onRun: () => void
  onDelete: () => void
  onEdit: () => void
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
        <Button variant="outline" size="sm" onClick={onEdit} aria-label={`编辑 ${schedule.title}`}><Pencil className="mr-1 size-3.5" />编辑</Button>
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

interface ScheduleEditDialogProps {
  schedule: ProactiveSchedule
  sessions: AgentSessionMeta[]
  channels: Channel[]
  onOpenChange: (open: boolean) => void
  onSaved: () => Promise<void>
}

function ScheduleEditDialog({ schedule, sessions, channels, onOpenChange, onSaved }: ScheduleEditDialogProps): React.ReactElement {
  const schedulableSessions = sessions.filter(eligibleRuntime)
  const [title, setTitle] = React.useState(schedule.title)
  const [prompt, setPrompt] = React.useState(schedule.prompt)
  const [newSession, setNewSession] = React.useState(schedule.newSession ?? false)
  const [sessionId, setSessionId] = React.useState(schedule.sessionId ?? schedulableSessions[0]?.id ?? '')
  const [channelId, setChannelId] = React.useState(schedule.channelId)
  const [runtime, setRuntime] = React.useState<'proma' | 'ai-sdk'>(schedule.runtime)
  const [enabled, setEnabled] = React.useState(schedule.enabled)
  const [kind, setKind] = React.useState<'at' | 'interval' | 'cron'>(schedule.schedule.type)
  const [runAt, setRunAt] = React.useState(schedule.schedule.type === 'at' ? toLocalDateTime(schedule.schedule.runAt) : toLocalDateTime(Date.now() + 60_000))
  const [intervalMinutes, setIntervalMinutes] = React.useState(schedule.schedule.type === 'interval' ? String(schedule.schedule.intervalMs / 60_000) : '5')
  const [cronExpression, setCronExpression] = React.useState(schedule.schedule.type === 'cron' ? schedule.schedule.expression : '0 9 * * 1-5')
  const [cronTimezone, setCronTimezone] = React.useState(schedule.schedule.type === 'cron' ? schedule.schedule.timezone : 'Asia/Shanghai')
  const [saving, setSaving] = React.useState(false)

  const save = async (): Promise<void> => {
    const session = schedulableSessions.find((item) => item.id === sessionId)
    const targetChannelId = newSession ? channelId : session?.channelId
    const channel = channels.find((item) => item.id === targetChannelId && item.enabled)
    if (!title.trim() || !prompt.trim() || !channel) {
      toast.error(newSession ? '请填写名称、内容并选择已启用渠道' : '请填写名称、内容并选择有效目标会话')
      return
    }
    const modelId = schedule.modelId ?? channel.models.find((model) => model.enabled)?.id ?? channel.models[0]?.id
    if (!modelId) { toast.error('所选渠道没有可用模型'); return }
    const nextSchedule = kind === 'at'
      ? { type: 'at' as const, runAt: new Date(runAt).getTime() }
      : kind === 'interval'
        ? { type: 'interval' as const, intervalMs: Number(intervalMinutes) * 60_000 }
        : { type: 'cron' as const, expression: cronExpression.trim(), timezone: cronTimezone.trim() }
    setSaving(true)
    try {
      await window.electronAPI.updateProactiveSchedule(schedule.id, {
        title: title.trim(), prompt: prompt.trim(), schedule: nextSchedule,
        sessionId: newSession ? undefined : session?.id,
        workspaceId: newSession ? schedule.workspaceId : session?.workspaceId,
        channelId: channel.id, modelId, runtime: newSession ? runtime : session!.agentRuntime,
        newSession, routineInstanceId: schedule.routineInstanceId,
        permissionMode: schedule.permissionMode, enabled,
      })
      toast.success('定时任务已更新；运行历史保持不变')
      await onSaved()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新定时任务失败')
    } finally {
      setSaving(false)
    }
  }

  return <Dialog open onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>编辑定时任务</DialogTitle><DialogDescription>保存后重新计算下次运行时间；既有运行历史不会被修改。</DialogDescription></DialogHeader>
      <div className="grid gap-3 py-2">
        <label className="grid gap-1.5 text-sm text-muted-foreground">名称<Input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-1.5 text-sm text-muted-foreground">执行目标<Select value={newSession ? 'new' : 'existing'} onValueChange={(value) => setNewSession(value === 'new')}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="existing">复用已有会话</SelectItem><SelectItem value="new">新建会话执行</SelectItem></SelectContent></Select></label>
          <label className="grid gap-1.5 text-sm text-muted-foreground">运行方式<Select value={kind} onValueChange={(value: 'at' | 'interval' | 'cron') => setKind(value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="at">一次性执行</SelectItem><SelectItem value="interval">固定间隔</SelectItem><SelectItem value="cron">Cron 计划</SelectItem></SelectContent></Select></label>
        </div>
        {newSession ? <div className="grid gap-3 md:grid-cols-2"><label className="grid gap-1.5 text-sm text-muted-foreground">渠道<Select value={channelId} onValueChange={setChannelId}><SelectTrigger><SelectValue placeholder="选择已启用渠道" /></SelectTrigger><SelectContent>{channels.filter((item) => item.enabled).map((channel) => <SelectItem key={channel.id} value={channel.id}>{channel.name} · {channel.provider}</SelectItem>)}</SelectContent></Select></label><label className="grid gap-1.5 text-sm text-muted-foreground">Runtime<Select value={runtime} onValueChange={(value: 'proma' | 'ai-sdk') => setRuntime(value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="proma">Gravitas</SelectItem><SelectItem value="ai-sdk">AI SDK</SelectItem></SelectContent></Select></label></div> : <label className="grid gap-1.5 text-sm text-muted-foreground">目标会话<Select value={sessionId} onValueChange={setSessionId}><SelectTrigger><SelectValue placeholder="选择会话" /></SelectTrigger><SelectContent>{schedulableSessions.map((session) => <SelectItem key={session.id} value={session.id}>{session.title} · {session.agentRuntime}</SelectItem>)}</SelectContent></Select></label>}
        {kind === 'at' && <label className="grid gap-1.5 text-sm text-muted-foreground">执行时间<Input type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.target.value)} /></label>}
        {kind === 'interval' && <label className="grid gap-1.5 text-sm text-muted-foreground">间隔（分钟，至少 1）<Input type="number" min="1" value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} /></label>}
        {kind === 'cron' && <div className="grid gap-3 md:grid-cols-2"><label className="grid gap-1.5 text-sm text-muted-foreground">Cron 表达式<Input value={cronExpression} onChange={(event) => setCronExpression(event.target.value)} /></label><label className="grid gap-1.5 text-sm text-muted-foreground">IANA 时区<Input value={cronTimezone} onChange={(event) => setCronTimezone(event.target.value)} /></label></div>}
        <label className="grid gap-1.5 text-sm text-muted-foreground">任务内容<Input value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
        <label className="grid gap-1.5 text-sm text-muted-foreground">状态<Select value={enabled ? 'enabled' : 'paused'} onValueChange={(value) => setEnabled(value === 'enabled')}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="enabled">启用</SelectItem><SelectItem value="paused">暂停</SelectItem></SelectContent></Select></label>
        {schedule.routineInstanceId && <p className="text-xs text-muted-foreground">已绑定 Routine；编辑会保留该绑定。</p>}
      </div>
      <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button onClick={() => void save()} disabled={saving}>{saving ? '保存中…' : '保存修改'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
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
