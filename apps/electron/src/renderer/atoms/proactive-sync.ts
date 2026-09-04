/**
 * Proactive Center 数据同步 Hook
 *
 * 从主进程加载真实数据，保持 atoms 同步
 */

import { useCallback, useEffect } from 'react'
import { useSetAtom } from 'jotai'
import {
  proactiveSchedulesAtom,
  proactiveRunsAtom,
  proactiveRecommendationsAtom,
  proactiveApprovalsAtom,
  proactiveMonitorsAtom,
  proactiveLoadingAtom,
} from './proactive-data'

export function useProactiveDataSync(): () => Promise<void> {
  const setSchedules = useSetAtom(proactiveSchedulesAtom)
  const setRuns = useSetAtom(proactiveRunsAtom)
  const setRecommendations = useSetAtom(proactiveRecommendationsAtom)
  const setApprovals = useSetAtom(proactiveApprovalsAtom)
  const setMonitors = useSetAtom(proactiveMonitorsAtom)
  const setLoading = useSetAtom(proactiveLoadingAtom)

  const loadAll = useCallback(async (): Promise<void> => {
      setLoading(true)
      try {
        await window.electronAPI.proactive?.refreshRecommendations?.()
        // 并行加载所有数据
        const [schedules, runs, recommendations, approvals, monitors] = await Promise.all([
          window.electronAPI.proactive?.listSchedules?.() ?? Promise.resolve([]),
          window.electronAPI.proactive?.listRuns?.() ?? Promise.resolve([]),
          window.electronAPI.proactive?.listRecommendations?.() ?? Promise.resolve([]),
          window.electronAPI.proactive?.listApprovals?.() ?? Promise.resolve([]),
          window.electronAPI.proactive?.listMonitors?.() ?? Promise.resolve([]),
        ])

        setSchedules(schedules)
        setRuns(runs)
        setRecommendations(recommendations)
        setApprovals(approvals)
        setMonitors(monitors)
      } catch (error) {
        console.error('[ProactiveDataSync] 加载数据失败:', error)
      } finally { setLoading(false) }
  }, [setApprovals, setLoading, setMonitors, setRecommendations, setRuns, setSchedules])

  useEffect(() => {
    void loadAll()

    // 定期刷新（每 30 秒）
    const interval = setInterval(() => {
      void loadAll()
    }, 30_000)

    return () => {
      clearInterval(interval)
    }
  }, [loadAll])

  return loadAll
}
