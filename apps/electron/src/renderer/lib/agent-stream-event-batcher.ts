import type { AgentStreamEvent } from '@gravitas/shared'

export interface AgentStreamEventBatcherOptions {
  dispatch: (event: AgentStreamEvent) => void
  requestFrame?: (callback: FrameRequestCallback) => number
  cancelFrame?: (handle: number) => void
  scheduleFallback?: (callback: () => void, delayMs: number) => number
  cancelFallback?: (handle: number) => void
  fallbackDelayMs?: number
}

function isPartialAssistantEvent(event: AgentStreamEvent): boolean {
  return event.payload.kind === 'sdk_message'
    && (event.payload.message as Record<string, unknown>)._partial === true
}

/**
 * 每帧至多交付每个会话最新的累计 partial；终态和交互事件立即交付。
 * timeout 是后台窗口 rAF 被节流时的兜底，不改变同会话事件顺序。
 */
export function createAgentStreamEventBatcher(options: AgentStreamEventBatcherOptions) {
  const pending = new Map<string, AgentStreamEvent>()
  const requestFrame = options.requestFrame ?? window.requestAnimationFrame
  const cancelFrame = options.cancelFrame ?? window.cancelAnimationFrame
  const scheduleFallback = options.scheduleFallback ?? ((callback, delayMs) => window.setTimeout(callback, delayMs))
  const cancelFallback = options.cancelFallback ?? ((handle) => window.clearTimeout(handle))
  const fallbackDelayMs = options.fallbackDelayMs ?? 100
  let frame: number | null = null
  let fallback: number | null = null

  const cancelScheduledFlush = (): void => {
    if (frame !== null) cancelFrame(frame)
    if (fallback !== null) cancelFallback(fallback)
    frame = null
    fallback = null
  }

  const flush = (): void => {
    cancelScheduledFlush()
    const events = [...pending.values()]
    pending.clear()
    events.forEach(options.dispatch)
  }

  return {
    push(event: AgentStreamEvent): void {
      if (!isPartialAssistantEvent(event)) {
        pending.delete(event.sessionId)
        options.dispatch(event)
        return
      }
      pending.set(event.sessionId, event)
      if (frame === null) {
        frame = requestFrame(flush)
        fallback = scheduleFallback(flush, fallbackDelayMs)
      }
    },
    clear(sessionId: string): void {
      pending.delete(sessionId)
      if (pending.size === 0) cancelScheduledFlush()
    },
    dispose(): void {
      cancelScheduledFlush()
      pending.clear()
    },
  }
}
