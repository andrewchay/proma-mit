/**
 * Proactive Center 数据同步 Hook
 *
 * 从主进程加载真实数据，保持 atoms 同步。
 * 各来源独立失败：一个来源失败不能清空其它来源的数据，也不能把失败伪装成空列表。
 */

import { useCallback, useEffect, useRef } from 'react'
import { useSetAtom } from 'jotai'
import {
  proactiveSchedulesAtom,
  proactiveRunsAtom,
  proactiveRecommendationsAtom,
  proactiveApprovalsAtom,
  proactiveMonitorsAtom,
  proactiveLoadingAtom,
  proactiveErrorAtom,
} from './proactive-data'

type ProactiveApi = NonNullable<Window['electronAPI']['proactive']>

type SourceKey = 'schedules' | 'runs' | 'recommendations' | 'approvals' | 'monitors'

interface SyncSource {
  key: SourceKey
  label: string
  invoke: (api: ProactiveApi) => (() => Promise<unknown[]>) | undefined
}

const SOURCES: SyncSource[] = [
  { key: 'schedules', label: '定时任务', invoke: (api) => api.listSchedules },
  { key: 'runs', label: '运行记录', invoke: (api) => api.listRuns },
  { key: 'recommendations', label: '推荐', invoke: (api) => api.listRecommendations },
  { key: 'approvals', label: '审批', invoke: (api) => api.listApprovals },
  { key: 'monitors', label: '监听', invoke: (api) => api.listMonitors },
]

const SOURCE_TIMEOUT_MS = 15_000

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}接口响应超时（${SOURCE_TIMEOUT_MS / 1000} 秒）`)), SOURCE_TIMEOUT_MS)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

export function useProactiveDataSync(): () => Promise<void> {
  const setSchedules = useSetAtom(proactiveSchedulesAtom)
  const setRuns = useSetAtom(proactiveRunsAtom)
  const setRecommendations = useSetAtom(proactiveRecommendationsAtom)
  const setApprovals = useSetAtom(proactiveApprovalsAtom)
  const setMonitors = useSetAtom(proactiveMonitorsAtom)
  const setLoading = useSetAtom(proactiveLoadingAtom)
  const setError = useSetAtom(proactiveErrorAtom)
  const inFlight = useRef(false)

  const loadAll = useCallback(async (): Promise<void> => {
      if (inFlight.current) return
      inFlight.current = true
      setLoading(true)
      try {
        const api = window.electronAPI?.proactive
        if (!api) throw new Error('主动任务接口未就绪，请重新启动应用')
        const results = await Promise.allSettled(SOURCES.map((source) => {
          const invoke = source.invoke(api)
          // 方法缺失不能当作空数据：显式标记为来源失败
          if (!invoke) return Promise.reject(new Error('接口未就绪'))
          return withTimeout(invoke.call(api), source.label)
        }))

        const next: Record<SourceKey, unknown[] | undefined> = {
          schedules: undefined, runs: undefined, recommendations: undefined, approvals: undefined, monitors: undefined,
        }
        const failures: string[] = []
        SOURCES.forEach((source, index) => {
          const result = results[index]!
          if (result.status === 'fulfilled' && Array.isArray(result.value)) {
            next[source.key] = result.value
          } else {
            const reason = result.status === 'rejected' ? (result.reason instanceof Error ? result.reason.message : String(result.reason)) : '返回格式无效'
            failures.push(`${source.label}：${reason}`)
          }
        })

        // 成功的来源照常更新；失败的来源保留旧数据，不写成空列表
        if (next.schedules) setSchedules(next.schedules as import('@gravitas/shared').ProactiveSchedule[])
        if (next.runs) setRuns(next.runs as import('@gravitas/shared').ProactiveTaskRun[])
        if (next.recommendations) setRecommendations(next.recommendations as import('@gravitas/shared').ProactiveRecommendation[])
        if (next.approvals) setApprovals(next.approvals as import('@gravitas/shared').ProactiveApproval[])
        if (next.monitors) setMonitors(next.monitors as import('@gravitas/shared').ProactiveMonitor[])
        setError(failures.length > 0 ? `部分数据来源加载失败：${failures.join('；')}` : null)
      } catch (error) {
        setError(error instanceof Error ? error.message : '主动任务数据加载失败')
      } finally { inFlight.current = false; setLoading(false) }
  }, [setApprovals, setError, setLoading, setMonitors, setRecommendations, setRuns, setSchedules])

  useEffect(() => {
    void window.electronAPI.proactive?.refreshRecommendations?.().catch((error) => {
      console.warn('[Proactive] 刷新推荐失败:', error)
    })
    void loadAll()

    // 定期刷新（每 3 秒）
    const interval = setInterval(() => {
      void loadAll()
    }, 3_000)

    return () => {
      clearInterval(interval)
    }
  }, [loadAll])

  return loadAll
}
