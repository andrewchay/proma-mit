import { listProjects } from './project-sqlite-store'
import { reconcilePilotIntents } from './project-pilot-intent-store'

const RECONCILE_INTERVAL_MS = 30_000

export async function reconcileAllPilotProjects(signal?: AbortSignal): Promise<void> {
  for (const project of listProjects()) {
    if (signal?.aborted) break
    try {
      await reconcilePilotIntents(project.id, signal)
    } catch (error) {
      if (signal?.aborted) break
      console.warn(`[Pilot] 项目只读对账失败 project=${project.id}`, error)
    }
  }
}

/** 应用存活期间定期对账；不依赖页面，也不派发员工或模型。 */
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
  void reconcile().catch((error) => console.warn('[Pilot] 启动只读对账失败', error))
  const timer = setInterval(() => {
    void reconcile().catch((error) => console.warn('[Pilot] 定期只读对账失败', error))
  }, RECONCILE_INTERVAL_MS)
  timer.unref()
  return () => { stopped = true; controller.abort(); clearInterval(timer) }
}
