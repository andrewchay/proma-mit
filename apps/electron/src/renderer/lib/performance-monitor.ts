import type { PerformanceSample } from '../../types/performance-monitor'

const samples: PerformanceSample[] = []
const WINDOW_MS = 30_000
const MAX_SAMPLES = 500
let streaming = false
let started = false
let lastAutoCapture = 0

export function setPerformanceStreaming(value: boolean): void { streaming = value }

function record(kind: PerformanceSample['kind'], durationMs: number): void {
  const timestamp = Date.now()
  samples.push({ timestamp, kind, durationMs: Math.round(durationMs), streaming })
  while (samples.length > MAX_SAMPLES || (samples[0]?.timestamp ?? timestamp) < timestamp - WINDOW_MS) samples.shift()
}

export function getPerformanceSamples(): PerformanceSample[] {
  const cutoff = Date.now() - WINDOW_MS
  return samples.filter(sample => sample.timestamp >= cutoff)
}

function scheduleAutomaticSnapshot(reason: 'main' | 'renderer'): void {
  if (Date.now() - lastAutoCapture < 60_000) return
  lastAutoCapture = Date.now()
  setTimeout(() => { void window.electronAPI.saveAutomaticPerformanceSnapshot(getPerformanceSamples(), reason).catch(() => {}) }, 5000)
}

/** 不读取输入内容或 DOM，只测量输入事件至下一帧回调的时间。 */
export function startPerformanceMonitor(): void {
  if (started) return
  started = true
  window.electronAPI.onPerformanceMainStall(() => scheduleAutomaticSnapshot('main'))
  document.addEventListener('input', () => {
    const start = performance.now()
    requestAnimationFrame(() => record('input', performance.now() - start))
  }, { capture: true, passive: true })
  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        record('long-task', entry.duration)
        if (entry.duration >= 200) scheduleAutomaticSnapshot('renderer')
      }
    })
    observer.observe({ type: 'longtask', buffered: false })
  }
  let previous = performance.now()
  document.addEventListener('visibilitychange', () => { previous = performance.now() })
  const frame = (now: number): void => {
    if (document.visibilityState === 'visible' && now - previous >= 100) record('frame', now - previous)
    previous = now
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}
