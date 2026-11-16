import type { PerformanceSample } from '../../types/performance-monitor'

export function validateSamples(input: unknown): PerformanceSample[] {
  if (!Array.isArray(input) || input.length > 500) throw new Error('性能记录格式无效')
  const cutoff = Date.now() - 35_000
  return input.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('性能记录格式无效')
    const value = item as Record<string, unknown>
    if (typeof value.kind !== 'string' || !['input', 'long-task', 'frame'].includes(value.kind) || typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp) || value.timestamp < cutoff || value.timestamp > Date.now() + 1000 || typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0 || value.durationMs > 600_000 || typeof value.streaming !== 'boolean') throw new Error('性能记录格式无效')
    return { timestamp: value.timestamp, kind: value.kind as PerformanceSample['kind'], durationMs: value.durationMs, streaming: value.streaming }
  })
}
