export interface PerformanceSample {
  timestamp: number
  kind: 'input' | 'long-task' | 'frame'
  durationMs: number
  streaming: boolean
}

export interface PerformanceSnapshotResult {
  saved: boolean
  path?: string
}
