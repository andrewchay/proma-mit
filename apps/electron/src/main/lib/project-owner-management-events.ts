/** 此总线仅提示后台重读持久事件；不能作为已提交事实或执行许可。 */
const listeners = new Set<(projectId: string) => void>()
export function onOwnerManagementWake(listener: (projectId: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function requestOwnerManagementWake(projectId: string): void {
  queueMicrotask(() => {
    for (const listener of listeners) {
      try { listener(projectId) }
      catch (cause) { console.warn('[Owner管理] 唤醒监听失败', cause) }
    }
  })
}

export interface OwnerManagementChanged { projectId: string; messageId?: string }
const changeListeners = new Set<(change: OwnerManagementChanged) => void>()
export function onOwnerManagementChanged(listener: (change: OwnerManagementChanged) => void): () => void {
  changeListeners.add(listener)
  return () => { changeListeners.delete(listener) }
}
/** 调用方提供落库证明；事务回滚后的临时消息不触发通知。 */
export function requestOwnerManagementChanged(change: OwnerManagementChanged, committed: () => boolean): void {
  queueMicrotask(() => {
    try {
      if (!committed()) return
      for (const listener of changeListeners) {
        try { listener(change) }
        catch (cause) { console.warn('[Owner管理] 消息监听失败', cause) }
      }
    } catch { /* 应用退出或数据库已关闭时，不发送过期通知。 */ }
  })
}
