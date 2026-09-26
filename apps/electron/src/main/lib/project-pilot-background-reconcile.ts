import { listProjects } from './project-sqlite-store'
import { reconcilePilotOverview } from './project-pilot-intent-store'
import { dispatchReadyPilotIntents } from './project-pilot-dispatch'
import { getPilotControlSnapshot } from './project-pilot-control'
import { onTaskChange } from './project-service'
import { onProjectChainChange } from './project-chain-service'

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
  let rerunRequested = false
  const reconcile = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (running) {
      rerunRequested = true
      return running
    }
    running = (async () => {
      do {
        rerunRequested = false
        try {
          await reconcileAllPilotProjects(controller.signal)
        } catch (error) {
          // 扫描失败时仍兑现运行期间收到的任务事件；没有补跑请求则交给调用方记录错误。
          if (!rerunRequested || stopped) throw error
          console.warn('[Pilot] 对账失败，收到任务变化后重试', error)
        }
      } while (rerunRequested && !stopped)
    })().finally(() => { running = null })
    return running
  }
  // 任务事件即时唤醒；运行中的扫描只追加一次补跑，周期扫描继续补偿删除等缺项目身份的事件。
  const unsubscribe = onTaskChange((task) => {
    if (!task || stopped) return
    void reconcile().catch((error) => {
      if (!controller.signal.aborted) console.warn(`[Pilot] 任务事件对账或受控派发失败 project=${task.projectId}`, error)
    })
  })
  const unsubscribeChain = onProjectChainChange((projectId) => {
    if (stopped) return
    void reconcile().catch((error) => {
      if (!controller.signal.aborted) console.warn(`[Pilot] 项目链事件对账或受控派发失败 project=${projectId}`, error)
    })
  })
  // 启动时补偿上次关闭后的变更，后续周期性重读权威数据。
  void reconcile().catch((error) => console.warn('[Pilot] 启动对账或受控派发失败', error))
  const timer = setInterval(() => {
    void reconcile().catch((error) => console.warn('[Pilot] 定期对账或受控派发失败', error))
  }, RECONCILE_INTERVAL_MS)
  timer.unref()
  return () => { stopped = true; controller.abort(); clearInterval(timer); unsubscribe(); unsubscribeChain() }
}
