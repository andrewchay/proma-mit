import { listProjects } from './project-sqlite-store'
import { reconcilePilotOverview } from './project-pilot-intent-store'
import { dispatchReadyPilotIntents } from './project-pilot-dispatch'
import { getPilotControlSnapshot } from './project-pilot-control'

const RECONCILE_INTERVAL_MS = 30_000

export async function reconcileAllPilotProjects(signal?: AbortSignal): Promise<void> {
  for (const project of listProjects()) {
    if (signal?.aborted) break
    try {
      const snapshot = await reconcilePilotOverview(project.id, signal)
      if (signal?.aborted) break
      const readyIntentIds = snapshot.intents
        .filter((intent) => intent.kind === 'ready_candidate')
        .map((intent) => intent.id)
      if (readyIntentIds.length > 0 && getPilotControlSnapshot(project.id).grantStatus === 'active') {
        await dispatchReadyPilotIntents(project.id, readyIntentIds, signal)
      }
    } catch (error) {
      if (signal?.aborted) break
      console.warn(`[Pilot] 项目对账或受控派发失败 project=${project.id}`, error)
    }
  }
}

/** 应用存活期间定期对账；仅在活动授权和全部硬门禁通过后进入唯一受控派发入口。 */
export function startPilotBackgroundReconcile(): () => void {
  let stopped = false
  const controller = new AbortController()
  let running: Promise<void> | null = null
  const reconcile = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (running) return running
    running = reconcileAllPilotProjects(controller.signal).finally(() => { running = null })
    return running
  }
  // 启动时补偿上次关闭后的变更，后续周期性重读权威数据。
  void reconcile().catch((error) => console.warn('[Pilot] 启动对账或受控派发失败', error))
  const timer = setInterval(() => {
    void reconcile().catch((error) => console.warn('[Pilot] 定期对账或受控派发失败', error))
  }, RECONCILE_INTERVAL_MS)
  timer.unref()
  return () => { stopped = true; controller.abort(); clearInterval(timer) }
}
