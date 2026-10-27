import { useEffect, useState } from 'react'
import { useAtomValue } from 'jotai'
import type { SDKMessage } from '@gravitas/shared'
import { agentSessionStreamingStateAtomFamily, liveMessagesMapAtom } from '@/atoms/agent-atoms'
import { AgentSessionProvider } from '@/contexts/session-context'
import { AgentMessages } from './AgentMessages'

/** 历史标签和侧边栏兼容入口：不挂载任何聊天或审批控件。 */
export function OwnerEmployeeSessionReadOnly({ sessionId }: { sessionId: string }): React.ReactElement {
  const [messages, setMessages] = useState<SDKMessage[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const state = useAtomValue(agentSessionStreamingStateAtomFamily(sessionId))
  const live = useAtomValue(liveMessagesMapAtom).get(sessionId)
  useEffect(() => {
    let disposed = false, pending = false
    const refresh = async (): Promise<void> => {
      if (pending) return
      pending = true
      try {
        const result = await window.electronAPI.getAgentSessionSDKMessages(sessionId)
        if (!disposed) { setMessages(result); setLoaded(true); setError('') }
      } catch { if (!disposed) setError('员工记录读取失败，请返回项目找Owner核查。') }
      finally { pending = false }
    }
    setMessages([]); setLoaded(false); void refresh()
    const timer = window.setInterval(() => void refresh(), 4000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [sessionId])
  return <AgentSessionProvider sessionId={sessionId}><div className="flex h-full min-h-0 flex-col" aria-label="员工会话只读监控">
    <p className="m-4 rounded-xl bg-primary/5 p-4 text-sm">这是Owner管理的员工执行记录，仅供监控。你无需与员工对话；发现问题请返回项目Owner对话提出，权限确认也由Owner页面承载。</p>
    {error && <p role="alert" className="px-4 text-sm text-destructive">{error}</p>}
    <AgentMessages readOnly sessionId={sessionId} messagesLoaded={loaded} persistedSDKMessages={messages} streaming={state?.running ?? false} streamState={state} liveMessages={live} />
  </div></AgentSessionProvider>
}
