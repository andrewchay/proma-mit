import { useEffect, useMemo, useState } from 'react'
import { atom, useAtomValue } from 'jotai'
import { agentStreamingStatesAtom, liveMessagesMapAtom } from '@/atoms/agent-atoms'
import type { OwnerExecutionCommandView, SDKMessage } from '@gravitas/shared'
import { resolveOwnerCommandSession } from './owner-command-session'

function messageText(message: SDKMessage): string {
  const value = message as unknown as { type?: string; message?: { content?: unknown }; result?: unknown }
  if (value.type === 'result' && typeof value.result === 'string') return value.result
  const content = value.message?.content
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => {
    if (!block || typeof block !== 'object') return []
    const item = block as { type?: unknown; text?: unknown; name?: unknown; input?: unknown; content?: unknown }
    if (item.type === 'text' && typeof item.text === 'string') return [item.text]
    if (item.type === 'tool_use') return [`调用工具：${typeof item.name === 'string' ? item.name : '未命名工具'}`]
    if (item.type === 'tool_result') return [typeof item.content === 'string' ? item.content : '工具已返回结果']
    return []
  }).join('\n')
}

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
  const messages = [...(snapshot?.messages ?? []), ...(live.messages ?? [])]
  const records = [...new Set(messages.map(messageText).filter(Boolean))]
  return <section aria-label={`员工工作监控：${command.taskTitle}`} className="space-y-3 rounded-xl bg-background p-4 shadow-sm">
    <p className="text-sm text-muted-foreground">只读监控：这里展示员工的输出和工具执行记录，不是员工聊天入口。发现问题请反馈给 Owner；权限确认也在 Owner 对话中处理。</p>
    <button type="button" className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground" onClick={onFeedback}>向 Owner 反馈这项工作</button>
    {loading && <p role="status">正在读取员工工作记录…</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {snapshot && <div className="max-h-[32rem] space-y-3 overflow-auto" aria-label="员工只读执行记录">
      {records.map((text, index) => <article key={`${index}-${text.slice(0, 40)}`} className="rounded-lg bg-muted/40 p-3 text-sm"><p className="mb-1 text-xs text-muted-foreground">员工工作记录</p><pre className="whitespace-pre-wrap break-words font-sans">{text}</pre></article>)}
      {live.state?.running && <p role="status" className="text-xs text-muted-foreground">员工正在执行，工作记录会自动更新。</p>}
      {live.state?.content && !records.includes(live.state.content) && <pre aria-label="员工实时输出" className="whitespace-pre-wrap break-words rounded-lg bg-primary/5 p-3 font-sans text-sm">{live.state.content}</pre>}
      {!records.length && !live.state?.content && <p className="text-sm text-muted-foreground">暂无可展示的工作记录。</p>}
    </div>}
  </section>
}
