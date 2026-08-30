import * as React from 'react'
import { CalendarClock, Play, Plus, Power, Trash2, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { AgentSessionMeta } from '@gravitas/shared'

interface RoutineManifestView { id: string; name: string; description: string }
interface RoutineInstanceView { id: string; manifestId: string; title: string; enabled: boolean }
type SchedulableSession = AgentSessionMeta & { channelId: string; agentRuntime: 'proma' | 'ai-sdk' }

export function RoutinesTab(): React.ReactElement {
  const [manifests, setManifests] = React.useState<RoutineManifestView[]>([])
  const [instances, setInstances] = React.useState<RoutineInstanceView[]>([])
  const [sessions, setSessions] = React.useState<SchedulableSession[]>([])
  const [sessionId, setSessionId] = React.useState('')
  const [runningId, setRunningId] = React.useState<string | null>(null)
  const refresh = React.useCallback(async (): Promise<void> => {
    const [nextManifests, nextInstances, nextSessions] = await Promise.all([
      window.electronAPI.proactive?.listRoutineManifests?.() ?? Promise.resolve([]),
      window.electronAPI.proactive?.listRoutineInstances?.() ?? Promise.resolve([]),
      window.electronAPI.listAgentSessions(),
    ])
    setManifests(nextManifests.filter(isManifest))
    setInstances(nextInstances.filter(isInstance))
    const eligible = nextSessions.filter(isSchedulableSession)
    setSessions(eligible)
    setSessionId((current) => eligible.some((session) => session.id === current) ? current : eligible[0]?.id ?? '')
  }, [])
  React.useEffect(() => { void refresh() }, [refresh])
  const create = async (manifest: RoutineManifestView): Promise<void> => {
    await window.electronAPI.proactive?.createRoutineInstance?.({ manifestId: manifest.id, title: manifest.name })
    toast.success('Routine 实例已创建；请在目标会话中配置并运行')
    await refresh()
  }
  const run = async (instance: RoutineInstanceView): Promise<void> => {
    const session = sessions.find((item) => item.id === sessionId)
    if (!session) { toast.error('请选择已配置渠道的 Proma 或 AI SDK 会话'); return }
    setRunningId(instance.id)
    try {
      await window.electronAPI.proactive?.runRoutineInstance?.(instance.id, { sessionId: session.id, workspaceId: session.workspaceId, channelId: session.channelId, modelId: session.modelId, runtime: session.agentRuntime, prompt: '按 Routine 生成可审计结果；涉及长期记忆时仅输出 proma-memory-items 候选。', permissionMode: 'safe' })
      toast.success('Routine 已完成；结果已写入运行记录')
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Routine 运行失败') } finally { setRunningId(null) }
  }
  const setEnabled = async (instance: RoutineInstanceView): Promise<void> => {
    const updated = await window.electronAPI.proactive?.setRoutineInstanceEnabled?.(instance.id, !instance.enabled)
    if (!updated) { toast.error('Routine 状态更新失败'); return }
    toast.success(instance.enabled ? 'Routine 已停用' : 'Routine 已启用')
    await refresh()
  }
  const remove = async (instance: RoutineInstanceView): Promise<void> => {
    const deleted = await window.electronAPI.proactive?.deleteRoutineInstance?.(instance.id)
    if (!deleted) { toast.error('Routine 删除失败'); return }
    toast.success('Routine 已删除')
    await refresh()
  }
  const scheduleDaily = async (instance: RoutineInstanceView): Promise<void> => {
    const session = sessions.find((item) => item.id === sessionId)
    if (!session) { toast.error('请选择已配置渠道的会话'); return }
    try {
      await window.electronAPI.createProactiveSchedule({ title: `${instance.title}（每日）`, sessionId: session.id, workspaceId: session.workspaceId, channelId: session.channelId, modelId: session.modelId, runtime: session.agentRuntime, prompt: '按绑定 Routine 生成可审计结果；涉及长期记忆时仅输出候选。', routineInstanceId: instance.id, schedule: { type: 'cron', expression: '0 23 * * *', timezone: 'Asia/Shanghai' }, permissionMode: 'safe' })
      toast.success('已创建每日安全调度，可在 Schedules 中调整')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建 Routine 调度失败')
    }
  }
  return <div className="p-4 space-y-4 max-w-4xl mx-auto"><section className="rounded-xl border border-border/50 bg-background shadow-sm p-4"><label className="grid gap-1.5 text-sm text-muted-foreground">运行目标会话<Select value={sessionId} onValueChange={setSessionId}><SelectTrigger><SelectValue placeholder="选择会话" /></SelectTrigger><SelectContent>{sessions.map((session) => <SelectItem key={session.id} value={session.id}>{session.title} · {session.agentRuntime}</SelectItem>)}</SelectContent></Select></label></section><section className="rounded-xl border border-border/50 bg-background shadow-sm"><div className="px-4 py-3 border-b border-border/50"><h3 className="text-sm font-medium flex gap-2 items-center"><Workflow size={14} className="text-primary" />可用 Routine</h3></div><div className="p-4 space-y-2">{manifests.map((manifest) => <div key={manifest.id} className="flex gap-3 items-center p-3 rounded-lg bg-foreground/[0.02]"><div className="flex-1"><p className="text-sm font-medium">{manifest.name}</p><p className="text-xs text-muted-foreground">{manifest.description}</p></div><Button size="sm" onClick={() => void create(manifest)}><Plus className="size-3.5 mr-1" />添加</Button></div>)}</div></section><section className="rounded-xl border border-border/50 bg-background shadow-sm"><div className="px-4 py-3 border-b border-border/50"><h3 className="text-sm font-medium">已创建实例 ({instances.length})</h3></div><div className="p-4 space-y-2">{instances.length === 0 ? <p className="text-sm text-muted-foreground py-6 text-center">尚未创建 Routine 实例。</p> : instances.map((instance) => <div key={instance.id} className="flex gap-3 items-center text-sm p-3 rounded-lg bg-foreground/[0.02]"><div className="flex-1"><p>{instance.title}</p><p className="text-xs text-muted-foreground">{instance.enabled ? '已启用' : '已停用'} · {instance.manifestId}</p></div><Button size="sm" variant="outline" disabled={!instance.enabled} onClick={() => void scheduleDaily(instance)}><CalendarClock className="size-3.5 mr-1" />每日调度</Button><Button size="sm" variant="outline" onClick={() => void setEnabled(instance)}><Power className="size-3.5 mr-1" />{instance.enabled ? '停用' : '启用'}</Button><Button size="sm" disabled={!instance.enabled || runningId === instance.id} onClick={() => void run(instance)}><Play className="size-3.5 mr-1" />运行</Button><Button size="icon" variant="ghost" className="text-muted-foreground hover:text-destructive" aria-label={`删除 ${instance.title}`} onClick={() => void remove(instance)}><Trash2 className="size-3.5" /></Button></div>)}</div></section></div>
}
function isSchedulableSession(value: AgentSessionMeta): value is SchedulableSession { return Boolean(value.channelId) && (value.agentRuntime === 'proma' || value.agentRuntime === 'ai-sdk') }
function isManifest(value: unknown): value is RoutineManifestView { return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).id === 'string' && typeof (value as Record<string, unknown>).name === 'string' && typeof (value as Record<string, unknown>).description === 'string' }
function isInstance(value: unknown): value is RoutineInstanceView { return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).id === 'string' && typeof (value as Record<string, unknown>).manifestId === 'string' && typeof (value as Record<string, unknown>).title === 'string' && typeof (value as Record<string, unknown>).enabled === 'boolean' }
