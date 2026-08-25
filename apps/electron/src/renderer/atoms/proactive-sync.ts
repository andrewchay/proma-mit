/**
 * Proactive Center 数据同步 Hook
 *
 * 从主进程加载真实数据，保持 atoms 同步
 */

import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import {
  proactiveSchedulesAtom,
  proactiveRunsAtom,
  proactiveRecommendationsAtom,
  proactiveApprovalsAtom,
  proactiveLoadingAtom,
} from './proactive-data'

export function useProactiveDataSync(): void {
  const setSchedules = useSetAtom(proactiveSchedulesAtom)
  const setRuns = useSetAtom(proactiveRunsAtom)
  const setRecommendations = useSetAtom(proactiveRecommendationsAtom)
  const setApprovals = useSetAtom(proactiveApprovalsAtom)
  const setLoading = useSetAtom(proactiveLoadingAtom)

  useEffect(() => {
    let cancelled = false

    async function loadAll(): Promise<void> {
      setLoading(true)
      try {
        // 并行加载所有数据
        const [schedules, runs, recommendations, approvals] = await Promise.all([
          window.electronAPI.proactive?.listSchedules?.() ?? Promise.resolve([]),
          window.electronAPI.proactive?.listRuns?.() ?? Promise.resolve([]),
          window.electronAPI.proactive?.listRecommendations?.() ?? Promise.resolve([]),
          window.electronAPI.proactive?.listApprovals?.() ?? Promise.resolve([]),
        ])

        if (cancelled) return

        setSchedules(schedules)
        setRuns(runs)
        setRecommendations(recommendations)
        setApprovals(approvals)
      } catch (error) {
        console.error('[ProactiveDataSync] 加载数据失败:', error)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadAll()

    // 定期刷新（每 30 秒）
    const interval = setInterval(() => {
      void loadAll()
    }, 30_000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [setSchedules, setRuns, setRecommendations, setApprovals, setLoading])
}
