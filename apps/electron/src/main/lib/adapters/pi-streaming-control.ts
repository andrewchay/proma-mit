export interface PartialMessageCoalescer<T> {
  schedule(value: T): void
  flush(): void
  dispose(): void
}

/**
 * Pi 的 message_update 携带累计文本。只保留时间窗口内最新快照，避免每个 token
 * 都重复穿越主进程、IPC 与 React 渲染链路；message_end 前必须 flush 最后一帧。
 */
export function createPartialMessageCoalescer<T>(
  emit: (value: T) => void,
  intervalMs: number,
): PartialMessageCoalescer<T> {
  let pending: T | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastEmittedAt = 0
  let disposed = false

  const emitPending = (): void => {
    timer = undefined
    if (disposed || pending === undefined) return
    const value = pending
    pending = undefined
    lastEmittedAt = Date.now()
    emit(value)
  }

  return {
    schedule(value) {
      if (disposed) return
      pending = value
      if (timer) return
      const elapsed = Date.now() - lastEmittedAt
      timer = setTimeout(emitPending, Math.max(0, intervalMs - elapsed))
    },
    flush() {
      if (timer) clearTimeout(timer)
      timer = undefined
      emitPending()
    },
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = undefined
      pending = undefined
    },
  }
}
