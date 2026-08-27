/**
 * ProactiveScheduleCreateDialog — 新建定时任务的 Dialog。
 *
 * 把原本挤在自动化任务页顶部的内联创建表单，迁移到顶部「+ 新建任务」弹出的独立对话框，
 * 让主界面只呈现任务列表。校验与提交逻辑与原内联表单保持一致，复用现有的 Jotai atoms。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import type { Channel } from '@gravitas/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  proactiveIntervalMinutesAtom,
  proactiveCronExpressionAtom,
  proactiveCronTimezoneAtom,
  proactiveLoadingAtom,
  proactivePromptAtom,
  proactiveRunAtAtom,
  proactiveScheduleKindAtom,
  proactiveSelectedSessionIdAtom,
  proactiveNewSessionAtom,
  proactiveSelectedChannelIdAtom,
  proactiveSessionsAtom,
} from '@/atoms/proactive-scheduler'
import type { AgentSessionMeta } from '@gravitas/shared'

type SchedulableSession = AgentSessionMeta & { agentRuntime: 'proma' | 'ai-sdk'; channelId: string }

function eligibleRuntime(session: AgentSessionMeta): session is SchedulableSession {
  return Boolean(session.channelId) && (session.agentRuntime === 'proma' || session.agentRuntime === 'ai-sdk')
}

function isSchedulableRuntime(runtime: string): runtime is 'proma' | 'ai-sdk' {
  return runtime === 'proma' || runtime === 'ai-sdk'
}

interface ProactiveScheduleCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  channels: Channel[]
  sessions: AgentSessionMeta[]
  loading: boolean
  /** 创建成功后的刷新回调（父组件负责重新拉取列表与原子状态） */
  onCreated: () => void
}

export function ProactiveScheduleCreateDialog({
  open,
  onOpenChange,
  channels,
  sessions,
  loading,
  onCreated,
}: ProactiveScheduleCreateDialogProps): React.ReactElement {
  const [prompt, setPrompt] = useAtom(proactivePromptAtom)
  const [kind, setKind] = useAtom(proactiveScheduleKindAtom)
  const [runAt, setRunAt] = useAtom(proactiveRunAtAtom)
  const [intervalMinutes, setIntervalMinutes] = useAtom(proactiveIntervalMinutesAtom)
  const [cronExpression, setCronExpression] = useAtom(proactiveCronExpressionAtom)
  const [cronTimezone, setCronTimezone] = useAtom(proactiveCronTimezoneAtom)
  const [sessionId, setSessionId] = useAtom(proactiveSelectedSessionIdAtom)
  const [newSession, setNewSession] = useAtom(proactiveNewSessionAtom)
  const [selectedChannelId, setSelectedChannelId] = useAtom(proactiveSelectedChannelIdAtom)
  const [selectedRuntime, setSelectedRuntime] = React.useState<'proma' | 'ai-sdk'>('proma')

  // 打开时确保「执行时间」默认有一分钟后的默认值
  React.useEffect(() => {
    if (open && !runAt) setRunAt(toLocalDateTime(Date.now() + 60_000))
  }, [open, runAt, setRunAt])

  const submit = async (): Promise<void> => {
    if (!prompt.trim()) {
      toast.error('请填写任务内容')
      return
    }
    const enabledChannels = channels.filter((item) => item.enabled)
    const channel = enabledChannels.find((item) => item.id === selectedChannelId)
    const runtime = newSession ? (selectedRuntime as 'proma' | 'ai-sdk') : undefined
    const session = sessions.find((item) => item.id === sessionId)
    if (newSession) {
      if (!channel || !isSchedulableRuntime(selectedRuntime)) {
        toast.error('请选择已启用渠道和 Gravitas / AI SDK Runtime')
        return
      }
    } else {
      if (!session?.channelId || !eligibleRuntime(session)) {
        toast.error('请选择已配置渠道的 Gravitas 或 AI SDK 会话，并填写任务内容')
        return
      }
    }
    const modelId = channel?.models.find((model) => model.enabled)?.id ?? channel?.models[0]?.id
    if (!modelId) {
      toast.error('所选渠道没有可用模型，请先在模型配置中启用模型')
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
        runtime: newSession ? (selectedRuntime as 'proma' | 'ai-sdk') : ((session?.agentRuntime ?? 'proma') as 'proma' | 'ai-sdk'),
        modelId,
        prompt: prompt.trim(),
        schedule,
        newSession,
      })
      setPrompt('')
      toast.success('定时任务已创建，默认使用安全权限')
      onOpenChange(false)
      onCreated()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建定时任务失败')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>新建定时任务</DialogTitle>
          <DialogDescription>
            任务仅在本机运行；创建属于持久操作，默认安全权限。一次性任务到点最多补跑一次，固定间隔最短为 1 分钟。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1.5 text-sm text-muted-foreground">执行目标
              <Select value={newSession ? 'new' : 'existing'} onValueChange={(value) => setNewSession(value === 'new')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="existing">复用已有会话</SelectItem><SelectItem value="new">新建会话执行</SelectItem></SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm text-muted-foreground">运行方式
              <Select value={kind} onValueChange={(value: 'at' | 'interval' | 'cron') => setKind(value)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="at">一次性执行</SelectItem><SelectItem value="interval">固定间隔</SelectItem><SelectItem value="cron">Cron 计划</SelectItem></SelectContent>
              </Select>
            </label>
          </div>

          {newSession ? (
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-1.5 text-sm text-muted-foreground">渠道
                <Select value={selectedChannelId} onValueChange={setSelectedChannelId} disabled={channels.length === 0}>
                  <SelectTrigger><SelectValue placeholder="选择已启用渠道" /></SelectTrigger>
                  <SelectContent>{channels.filter((item) => item.enabled).map((channel) => <SelectItem key={channel.id} value={channel.id}>{channel.name} · {channel.provider}</SelectItem>)}</SelectContent>
                </Select>
              </label>
              <label className="grid gap-1.5 text-sm text-muted-foreground">Runtime
                <Select value={selectedRuntime} onValueChange={(value: 'proma' | 'ai-sdk') => setSelectedRuntime(value)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="proma">Gravitas</SelectItem><SelectItem value="ai-sdk">AI SDK</SelectItem></SelectContent>
                </Select>
              </label>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-1.5 text-sm text-muted-foreground">目标会话
                <Select value={sessionId} onValueChange={setSessionId} disabled={sessions.length === 0}>
                  <SelectTrigger><SelectValue placeholder="选择已配置渠道的会话" /></SelectTrigger>
                  <SelectContent>{sessions.map((session) => <SelectItem key={session.id} value={session.id}>{session.title} · {session.agentRuntime}</SelectItem>)}</SelectContent>
                </Select>
              </label>
            </div>
          )}

          {kind === 'at' ? (
            <label className="grid gap-1.5 text-sm text-muted-foreground">执行时间
              <Input type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.target.value)} />
            </label>
          ) : kind === 'interval' ? (
            <label className="grid gap-1.5 text-sm text-muted-foreground">间隔（分钟，至少 1）
              <Input type="number" min="1" value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} />
            </label>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-1.5 text-sm text-muted-foreground">Cron 表达式
                <Input value={cronExpression} onChange={(event) => setCronExpression(event.target.value)} placeholder="例如：0 9 * * 1-5" />
              </label>
              <label className="grid gap-1.5 text-sm text-muted-foreground">IANA 时区
                <Input value={cronTimezone} onChange={(event) => setCronTimezone(event.target.value)} placeholder="例如：Asia/Shanghai" />
              </label>
              <p className="md:col-span-2 text-xs text-muted-foreground">采用标准五字段 Cron（分钟 小时 日 月 周）；时区会与任务一同保存。</p>
            </div>
          )}

          <label className="grid gap-1.5 text-sm text-muted-foreground">任务内容
            <Input value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：检查当前工作区的未提交变更并总结" />
          </label>

          {!newSession && sessions.length === 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">没有可复用的 Gravitas / AI SDK 会话；可切换为「新建会话执行」。</p>
          )}
          {newSession && channels.length === 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">请先在模型配置中启用至少一个渠道。</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>取消</Button>
          <Button onClick={() => void submit()} disabled={loading || (newSession ? channels.length === 0 : sessions.length === 0)}>
            <Plus className="mr-2 size-4" />创建安全定时任务
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function toLocalDateTime(value: number): string {
  const date = new Date(value - new Date().getTimezoneOffset() * 60_000)
  return date.toISOString().slice(0, 16)
}
