import { useEffect, useMemo, useState } from 'react'
import { atom, useAtomValue } from 'jotai'
import { agentStreamingStatesAtom, liveMessagesMapAtom } from '@/atoms/agent-atoms'
import type { OwnerExecutionCommandView, SDKMessage } from '@gravitas/shared'
import { resolveOwnerCommandSession } from './owner-command-session'
import { AgentMessages } from '../agent/AgentMessages'
import { AgentSessionProvider } from '@/contexts/session-context'

/** 留在项目内查看同一执行的工作记录；不挂载输入、审批或执行控制组件。 */
export function OwnerEmployeeMonitor({ projectId, command, onFeedback }: {
  projectId: string
  command: OwnerExecutionCommandView
  onFeedback: () => void
}): React.ReactElement {
  const [snapshot, setSnapshot] = useState<{ sessionId: string; messages: SDKMessage[] } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let disposed = false, inFlight = false
    const refresh = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const [executions, sessions] = await Promise.all([
          window.electronAPI.paa.agentEmployees.listExecutionsByEntity('task', command.taskId),
          window.electronAPI.listAgentSessions(),
        ])
        const session = resolveOwnerCommandSession(projectId, command, executions, sessions)
        const messages = await window.electronAPI.getAgentSessionSDKMessages(session.id)
        if (!disposed) { setSnapshot({ sessionId: session.id, messages }); setError('') }
      } catch (cause) {
        if (!disposed) { setSnapshot(null); setError(cause instanceof Error ? cause.message : '员工记录读取失败') }
      } finally { inFlight = false; if (!disposed) setLoading(false) }
    }
    setSnapshot(null); setLoading(true); setError('')
    void refresh()
    const timer = window.setInterval(() => void refresh(), 4000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [projectId, command])
  const sessionId = snapshot?.sessionId
  const liveView = useMemo(() => atom(get => ({
    state: sessionId ? get(agentStreamingStatesAtom).get(sessionId) : undefined,
    messages: sessionId ? get(liveMessagesMapAtom).get(sessionId) : undefined,
  })), [sessionId])
  const live = useAtomValue(liveView)
  // 实时消息与轮询快照可能包含同一条消息；有 UUID 时优先展示实时版本。
  const liveIds = new Set((live.messages ?? []).flatMap(message => {
    const record = message as unknown as { uuid?: unknown; type?: unknown }
    return typeof record.uuid === 'string' ? [`${record.type}:${record.uuid}`] : []
  }))
  const persisted = (snapshot?.messages ?? []).filter(message => {
    const record = message as unknown as { uuid?: unknown; type?: unknown }
    return typeof record.uuid !== 'string' || !liveIds.has(`${record.type}:${record.uuid}`)
  })
  return <section aria-label={`员工工作监控：${command.taskTitle}`} className="space-y-3 rounded-xl bg-background p-4 shadow-sm">
    <p className="text-sm text-muted-foreground">只读监控：这里展示员工的输出和工具执行记录，不是员工聊天入口。发现问题请反馈给 Owner；权限确认也在 Owner 对话中处理。</p>
    <button type="button" className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground" onClick={onFeedback}>向 Owner 反馈这项工作</button>
    {loading && <p role="status">正在读取员工工作记录…</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {snapshot && <div className="h-[32rem] min-h-0 overflow-hidden rounded-lg bg-muted/20" aria-label="员工只读执行记录">
      <AgentSessionProvider sessionId={snapshot.sessionId}>
        <AgentMessages readOnly sessionId={snapshot.sessionId} messagesLoaded persistedSDKMessages={persisted} streaming={live.state?.running ?? false} streamState={live.state} liveMessages={live.messages} />
      </AgentSessionProvider>
    </div>}
  </section>
}
