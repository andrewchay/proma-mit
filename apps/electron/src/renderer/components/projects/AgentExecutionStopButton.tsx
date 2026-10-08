import { useEffect, useMemo, useRef } from 'react'
import { atom, useAtom } from 'jotai'
import type { AgentExecutionResult } from '@gravitas/shared'
import { executionStopMessage } from './project-task-execution-state'

/** 只取消这一条权威执行；员工停用开关不等于停止正在运行的任务。 */
export function AgentExecutionStopButton({ execution, onChanged }: {
  execution: AgentExecutionResult
  onChanged: () => void | Promise<void>
}): React.ReactElement | null {
  // biome-ignore lint/correctness/useExhaustiveDependencies: 执行身份切换必须重置局部停止反馈，不能沿用另一执行的状态。
  const stateAtom = useMemo(() => atom({ busy: false, requested: false, message: '' }), [execution.id])
  const [state, setState] = useAtom(stateAtom)
  const inFlight = useRef(false)
  const active = execution.status === 'queued' || execution.status === 'running'
  useEffect(() => {
    if (!state.requested || !active) return
    let cancelled = false
    let loading = false
    const timer = window.setInterval(async () => {
      if (loading) return
      loading = true
      try {
        const runs = await window.electronAPI.paa.agentEmployees.listExecutionsByEntity(execution.entityType, execution.entityId)
        const current = runs.find((run) => run.id === execution.id)
        if (!cancelled && current && current.status !== 'running' && current.status !== 'queued') await onChanged()
      } catch (error) {
        if (!cancelled) setState((value) => ({ ...value, message: `停止后刷新失败：${String(error)}` }))
      } finally { loading = false }
    }, 2000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [active, state.requested, execution.id, execution.entityType, execution.entityId, onChanged, setState])
  async function stop(): Promise<void> {
    if (inFlight.current) return
    inFlight.current = true
    setState((value) => ({ ...value, busy: true, message: '' }))
    try {
      const result = await window.electronAPI.paa.agentEmployees.cancelExecution(execution.id)
      setState({ busy: true, requested: Boolean(result.stopRequested), message: executionStopMessage(result) })
      await onChanged()
    } catch (error) {
      setState((value) => ({ ...value, message: `停止请求失败：${String(error)}` }))
    } finally { inFlight.current = false; setState((value) => ({ ...value, busy: false })) }
  }
  if (!active && !state.message) return null
  return <div className="mt-2">
    {active && <button type="button" disabled={state.busy} onClick={() => void stop()} className="rounded bg-destructive/10 px-2 py-1 text-xs text-destructive disabled:opacity-50">
      {state.busy ? '发送停止请求…' : state.requested ? '再次请求停止' : '停止此执行'}
    </button>}
    {state.message && <p role="status" className="mt-1 text-xs text-muted-foreground">{state.requested && !active ? `执行记录已更新为${execution.status}；底层操作与费用以执行证据为准。` : state.message}</p>}
  </div>
}
