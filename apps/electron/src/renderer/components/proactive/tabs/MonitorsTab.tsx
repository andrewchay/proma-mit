import * as React from 'react'
import { useAtom } from 'jotai'
import { FileCheck, GitBranch, Monitor, Pause, Play, Plus, Terminal, Trash2, Webhook } from 'lucide-react'
import { toast } from 'sonner'
import type { AgentSessionMeta, ProactiveMonitor } from '@gravitas/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { proactiveLoadingAtom, proactiveMonitorsAtom } from '@/atoms/proactive-data'
import { proactiveRecommendationsAtom } from '@/atoms/proactive-data'
import { proactiveConfigurationRecommendationAtom } from '@/atoms/proactive-center'

type MonitorKind = 'file' | 'session' | 'github' | 'command'
interface RoutineInstanceView {
  id: string
  manifestId: string
  title: string
  enabled: boolean
}
type SchedulableSession = AgentSessionMeta & {
  channelId: string
  agentRuntime: 'proma' | 'ai-sdk'
}

const TYPE_META: Record<ProactiveMonitor['trigger']['type'], { label: string; icon: React.ElementType }> = {
  file: { label: '文件变更', icon: FileCheck },
  session: { label: '会话超时', icon: Monitor },
  github: { label: 'GitHub 事件', icon: GitBranch },
  webhook: { label: 'Webhook Bridge', icon: Webhook },
  command: { label: '命令输出变化', icon: Terminal },
}

const SELECTABLE_MONITOR_KINDS: MonitorKind[] = ['file', 'session', 'github', 'command']

function isSchedulableSession(session: AgentSessionMeta): session is SchedulableSession {
  return Boolean(session.channelId) && (session.agentRuntime === 'proma' || session.agentRuntime === 'ai-sdk')
}

export function MonitorsTab(): React.ReactElement {
  const [monitors, setMonitors] = useAtom(proactiveMonitorsAtom)
  const [, setLoading] = useAtom(proactiveLoadingAtom)
  const [sessions, setSessions] = React.useState<SchedulableSession[]>([])
  const [routineInstances, setRoutineInstances] = React.useState<RoutineInstanceView[]>([])
  const [kind, setKind] = React.useState<MonitorKind>('file')
  const [title, setTitle] = React.useState('')
  const [sessionId, setSessionId] = React.useState('')
  const [prompt, setPrompt] = React.useState('')
  const [target, setTarget] = React.useState('')
  const [intervalMinutes, setIntervalMinutes] = React.useState('5')
  const [routineInstanceId, setRoutineInstanceId] = React.useState('manual')
  const [configurationRecommendation, setConfigurationRecommendation] = useAtom(proactiveConfigurationRecommendationAtom)
  const [, setRecommendations] = useAtom(proactiveRecommendationsAtom)

  React.useEffect(() => {
    const recommendation = configurationRecommendation
    const action = recommendation?.action
    if (!recommendation || !isMonitorRecommendationAction(action)) return
    setKind('github')
    setTitle(recommendation.title)
    setTarget(action.trigger.repo)
    setPrompt((current) => current || `检查 ${recommendation.title}，并输出可审计状态摘要`)
  }, [configurationRecommendation])

  const refresh = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [nextMonitors, nextSessions, nextRoutineInstances] = await Promise.all([
        window.electronAPI.proactive?.listMonitors?.() ?? Promise.resolve([]),
        window.electronAPI.listAgentSessions(),
        window.electronAPI.proactive?.listRoutineInstances?.() ?? Promise.resolve([]),
      ])
      setMonitors(nextMonitors)
      const eligibleRoutines = nextRoutineInstances.filter(isRoutineInstance).filter((routine) => routine.enabled)
      setRoutineInstances(eligibleRoutines)
      setRoutineInstanceId((current) => current === 'manual' || eligibleRoutines.some((routine) => routine.id === current) ? current : 'manual')
      const eligible = nextSessions.filter(isSchedulableSession)
      setSessions(eligible)
      setSessionId((current) => eligible.some((session) => session.id === current) ? current : eligible[0]?.id ?? '')
    } catch (error) {
      console.error('[Proactive Monitors] 读取失败:', error)
      toast.error('读取监听任务失败')
    } finally {
      setLoading(false)
    }
  }, [setLoading, setMonitors])

  React.useEffect(() => { void refresh() }, [refresh])

  const create = async (): Promise<void> => {
    const session = sessions.find((item) => item.id === sessionId)
    const routine = routineInstances.find((item) => item.id === routineInstanceId)
    if (!title.trim() || !prompt.trim() || !session) {
      toast.error('请填写名称、执行内容并选择目标会话')
      return
    }
    const trigger = buildTrigger(kind, target.trim(), Number(intervalMinutes))
    if (!trigger) {
      toast.error('请填写当前监听类型所需的目标')
      return
    }
    try {
      await window.electronAPI.proactive?.createMonitor?.({
        title: title.trim(),
        routineId: routine?.manifestId ?? 'manual:monitor',
        routineInstanceId: routine?.id,
        trigger,
        execution: {
          sessionId: session.id,
          workspaceId: session.workspaceId,
          channelId: session.channelId,
          runtime: session.agentRuntime,
          prompt: prompt.trim(),
          permissionMode: 'safe',
        },
      })
      if (configurationRecommendation) {
        const accepted = await window.electronAPI.proactive?.acceptRecommendation?.(configurationRecommendation.id)
        if (accepted) setRecommendations((current) => current.map((item) => item.id === accepted.id ? accepted : item))
        setConfigurationRecommendation(null)
      }
      setTitle('')
      setPrompt('')
      setTarget('')
      toast.success('监听任务已创建')
      await refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建监听任务失败')
    }
  }

  const toggle = async (monitor: ProactiveMonitor): Promise<void> => {
    try {
      await window.electronAPI.proactive?.setMonitorEnabled?.(monitor.id, !monitor.enabled)
      await refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新监听任务失败')
    }
  }

  const remove = async (monitor: ProactiveMonitor): Promise<void> => {
    try {
      await window.electronAPI.proactive?.deleteMonitor?.(monitor.id)
      toast.success('监听任务已删除')
      await refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除监听任务失败')
    }
  }

  const MetaIcon = TYPE_META[kind].icon
  return (
    <div className="p-4 space-y-4 max-w-4xl mx-auto">
      <section className="rounded-xl border border-border/50 bg-background shadow-sm">
        <div className="px-4 py-3 border-b border-border/50">
          <h3 className="text-sm font-medium flex items-center gap-2"><Plus size={14} className="text-primary" />新建监听任务</h3>
        </div>
        <div className="p-4 grid gap-3 md:grid-cols-2">
          <label className="grid gap-1.5 text-sm text-muted-foreground">名称<Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：配置文件变更检查" /></label>
          <label className="grid gap-1.5 text-sm text-muted-foreground">监听类型
            <Select value={kind} onValueChange={(value: MonitorKind) => setKind(value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
              {SELECTABLE_MONITOR_KINDS.map((id) => <SelectItem key={id} value={id}>{TYPE_META[id].label}</SelectItem>)}
            </SelectContent></Select>
          </label>
          <label className="grid gap-1.5 text-sm text-muted-foreground">目标会话
            <Select value={sessionId} onValueChange={setSessionId}><SelectTrigger><SelectValue placeholder="选择已配置渠道的会话" /></SelectTrigger><SelectContent>
              {sessions.map((session) => <SelectItem key={session.id} value={session.id}>{session.title} · {session.agentRuntime}</SelectItem>)}
            </SelectContent></Select>
          </label>
          <label className="grid gap-1.5 text-sm text-muted-foreground">触发后执行
            <Select value={routineInstanceId} onValueChange={setRoutineInstanceId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
              <SelectItem value="manual">自定义执行内容</SelectItem>
              {routineInstances.map((routine) => <SelectItem key={routine.id} value={routine.id}>{routine.title} · Routine</SelectItem>)}
            </SelectContent></Select>
          </label>
          <label className="grid gap-1.5 text-sm text-muted-foreground">触发后执行内容<Input value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="检查变化并给出结论" /></label>
          <label className="grid gap-1.5 text-sm text-muted-foreground md:col-span-2">{targetLabel(kind)}
            <Input value={target} onChange={(event) => setTarget(event.target.value)} placeholder={targetPlaceholder(kind)} />
          </label>
          {(kind === 'command' || kind === 'session') && <label className="grid gap-1.5 text-sm text-muted-foreground">{kind === 'command' ? '轮询间隔（分钟）' : '空闲阈值（分钟）'}<Input type="number" min="1" value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} /></label>}
          <div className="flex items-end"><Button onClick={() => void create()}><MetaIcon className="mr-2 size-4" />创建监听</Button></div>
        </div>
      </section>

      <section className="rounded-xl border border-border/50 bg-background shadow-sm">
        <div className="px-4 py-3 border-b border-border/50"><h3 className="text-sm font-medium">监听任务 ({monitors.length})</h3></div>
        <div className="p-4 space-y-2">
          {monitors.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">暂无监听任务。</p> : monitors.map((monitor) => {
            const Icon = TYPE_META[monitor.trigger.type].icon
            return <div key={monitor.id} className="flex items-center gap-3 p-3 rounded-lg bg-foreground/[0.02] border border-border/40">
              <Icon className="size-4 text-primary" /><div className="flex-1 min-w-0"><p className="text-sm font-medium">{monitor.title}</p><p className="text-xs text-muted-foreground">{TYPE_META[monitor.trigger.type].label} · {monitor.routineInstanceId ? '绑定 Routine' : '自定义执行'} · {monitor.enabled ? '已启用' : '已暂停'}</p></div>
              <Button size="icon" variant="ghost" onClick={() => void toggle(monitor)} aria-label={monitor.enabled ? '暂停监听' : '恢复监听'}>{monitor.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}</Button>
              <Button size="icon" variant="ghost" onClick={() => void remove(monitor)} aria-label="删除监听"><Trash2 className="size-4 text-destructive" /></Button>
            </div>
          })}
        </div>
      </section>
    </div>
  )
}

function isMonitorRecommendationAction(value: unknown): value is { type: 'create_monitor'; trigger: { type: 'github'; repo: string } } {
  if (typeof value !== 'object' || value === null) return false
  const action = value as Record<string, unknown>
  if (action.type !== 'create_monitor' || typeof action.trigger !== 'object' || action.trigger === null) return false
  const trigger = action.trigger as Record<string, unknown>
  return trigger.type === 'github' && typeof trigger.repo === 'string'
}

function isRoutineInstance(value: unknown): value is RoutineInstanceView {
  if (typeof value !== 'object' || value === null) return false
  const instance = value as Record<string, unknown>
  return typeof instance.id === 'string'
    && typeof instance.manifestId === 'string'
    && typeof instance.title === 'string'
    && typeof instance.enabled === 'boolean'
}

function buildTrigger(kind: MonitorKind, target: string, intervalMinutes: number): import('@gravitas/shared').MonitorTrigger | null {
  const intervalMs = Math.max(1, Number.isFinite(intervalMinutes) ? intervalMinutes : 1) * 60_000
  if (kind === 'file' && target) return { type: 'file', path: target, events: ['modify'] }
  if (kind === 'session') return { type: 'session', condition: 'stale', maxIdleMs: intervalMs }
  if (kind === 'github' && target) return { type: 'github', repo: target, events: ['ReleaseEvent'] }
  if (kind === 'command' && target) return { type: 'command', command: target, intervalMs }
  return null
}

function targetLabel(kind: MonitorKind): string {
  return kind === 'file' ? '文件或目录路径' : kind === 'github' ? '仓库（owner/repo）' : kind === 'command' ? '检测命令' : '会话空闲检测'
}

function targetPlaceholder(kind: MonitorKind): string {
  return kind === 'file' ? '/path/to/watch' : kind === 'github' ? 'owner/repository' : kind === 'command' ? 'git status --short' : '无需填写'
}
