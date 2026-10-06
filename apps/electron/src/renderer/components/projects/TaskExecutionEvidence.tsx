import { useMemo } from 'react'
import { atom, useAtom, useStore } from 'jotai'
import type { AgentExecutionResult } from '@gravitas/shared'
import { activeViewAtom } from '@/atoms/active-view'
import { appModeAtom } from '@/atoms/app-mode'
import { agentSessionsAtom, currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { activeTabIdAtom, openTab, tabsAtom } from '@/atoms/tab-atoms'

/** 通过项目任务的精确 ID 读取真实执行证据，不把运行终态解释为交付物验收。 */
export function TaskExecutionEvidence({ taskId }: { taskId: string }): React.ReactElement {
  const stateAtom = useMemo(
    () => atom<{ runs?: AgentExecutionResult[]; error?: string; loading: boolean }>({ loading: false }),
    [],
  )
  const [state, setState] = useAtom(stateAtom)
  const store = useStore()
  async function load(): Promise<void> {
    setState((current) => ({ ...current, loading: true, error: undefined }))
    try {
      const runs = await window.electronAPI.paa.agentEmployees.listExecutionsByEntity('task', taskId)
      setState({ runs, loading: false })
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: String(error) }))
    }
  }
  async function openSession(sessionId: string): Promise<void> {
    if (sessionId.startsWith('workflow:')) return
    const sessions = await window.electronAPI.listAgentSessions()
    const session = sessions.find((item) => item.id === sessionId)
    if (!session) throw new Error('该 Agent 会话暂不可用')
    store.set(agentSessionsAtom, sessions)
    const result = openTab(store.get(tabsAtom), { type: 'agent', sessionId, title: session.title })
    store.set(tabsAtom, result.tabs)
    store.set(activeTabIdAtom, result.activeTabId)
    store.set(currentAgentSessionIdAtom, sessionId)
    store.set(appModeAtom, 'agent')
    store.set(activeViewAtom, 'conversations')
  }
  async function stop(runId: string): Promise<void> {
    setState((current) => ({ ...current, loading: true, error: undefined }))
    try {
      await window.electronAPI.paa.agentEmployees.cancelExecution(runId)
      await load()
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: String(error) }))
    }
  }
  return (
    <div className="mt-3 text-sm">
      <button disabled={state.loading} className="text-primary" onClick={() => void load()}>
        {state.loading ? '加载执行记录…' : '查看任务的 Agent 执行记录'}
      </button>
      {state.error && (
        <p role="alert" className="text-destructive">
          {state.error}
        </p>
      )}
      {state.runs?.length === 0 && <p className="text-muted-foreground">该任务暂无 Agent 执行记录。</p>}
      {state.runs?.map((run) => (
        <details key={run.id} className="mt-2 rounded-lg bg-muted/50 p-3">
          <summary>
            {new Date(run.startedAt).toLocaleString()} · {run.status}
          </summary>
          <p>Agent：{run.agentId}</p>
          <p className="break-all">会话 / Workflow：{run.sessionId}</p>
          {run.capabilityVersionIds?.length ? <p className="break-all text-xs text-muted-foreground">冻结能力版本：{run.capabilityVersionIds.join(' · ')}{run.capabilityContentHash ? ` · ${run.capabilityContentHash.slice(0, 12)}` : ''}</p> : <p className="text-xs text-muted-foreground">能力快照：旧记录（未冻结能力版本）</p>}
          <p className="text-xs text-muted-foreground">能力快照只说明该次执行采用的策略，不表示任务已通过业务验收。</p>
          {!run.sessionId.startsWith('workflow:') && (
            <button className="mt-2 text-primary" onClick={() => void openSession(run.sessionId).catch((error) => setState((current) => ({ ...current, error: String(error) })))}>
              {run.status === 'running' ? '查看实时输出' : '查看执行会话'}
            </button>
          )}
          <p className="whitespace-pre-wrap">{run.resultSummary ?? run.error ?? '暂无结果摘要'}</p>
          {(run.status === 'queued' || run.status === 'running') && (
            <button
              className="mt-2 rounded bg-destructive px-2 py-1 text-xs text-destructive-foreground disabled:opacity-50"
              disabled={state.loading}
              onClick={() => void stop(run.id)}
            >
              停止执行
            </button>
          )}
          {run.outputFiles.map((file) => (
            <p key={file} className="break-all">
              产物：{file}
            </p>
          ))}
        </details>
      ))}
    </div>
  )
}
