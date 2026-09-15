/**
 * Proactive Center 数据同步 Hook
 *
 * 从主进程加载真实数据，保持 atoms 同步
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
        if (!window.electronAPI.proactive) throw new Error('主动任务接口未就绪，请重新启动应用')
        // 并行加载所有数据
        const [schedules, runs, recommendations, approvals, monitors] = await Promise.all([
          window.electronAPI.proactive?.listSchedules?.() ?? Promise.resolve([]),
          window.electronAPI.proactive?.listRuns?.() ?? Promise.resolve([]),
          window.electronAPI.proactive?.listRecommendations?.() ?? Promise.resolve([]),
          window.electronAPI.proactive?.listApprovals?.() ?? Promise.resolve([]),
          window.electronAPI.proactive?.listMonitors?.() ?? Promise.resolve([]),
        ])

        setError(null)
        setSchedules(schedules)
        setRuns(runs)
        setRecommendations(recommendations)
        setApprovals(approvals)
        setMonitors(monitors)
      } catch (error) {
        setError(error instanceof Error ? error.message : '主动任务数据加载失败')
      } finally { inFlight.current = false; setLoading(false) }
  }, [setApprovals, setError, setLoading, setMonitors, setRecommendations, setRuns, setSchedules])

  useEffect(() => {
    void window.electronAPI.proactive?.refreshRecommendations?.().then(loadAll).catch(console.error)
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
