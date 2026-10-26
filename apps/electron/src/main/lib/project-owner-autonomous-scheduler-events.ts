type ScheduleWakeListener = (projectId: string) => void
const listeners = new Set<ScheduleWakeListener>()
export function onOwnerAutonomousScheduleWake(listener: ScheduleWakeListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
/** 权威状态事务完成后异步唤醒；不会从 Renderer/页面 mount 触发派发。 */
export function requestOwnerAutonomousScheduleWake(projectId: string): void {
  if (!projectId) return
  queueMicrotask(() => {
    for (const listener of listeners) {
      try { listener(projectId) }
      catch (error) { console.error('[Owner Scheduler] 唤醒监听失败:', error) }
    }
  })
}
