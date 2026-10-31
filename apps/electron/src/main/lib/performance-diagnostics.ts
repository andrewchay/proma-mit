import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

/** 仅在显式指定路径时记录临时性能数据，不记录路径、消息或工具参数。 */
export function startPerformanceDiagnostic(operation: string): ((status: 'ok' | 'error', counts?: Record<string, number>) => void) | undefined {
  const destination = process.env.GRAVITAS_PERF_DIAGNOSTICS_PATH
  if (!destination) return undefined
  const id = randomUUID()
  const startedAt = Date.now()
  const start = performance.now()
  const cpu = process.cpuUsage()
  const write = (value: object): void => {
    try { appendFileSync(destination, `${JSON.stringify(value)}\n`, 'utf8') } catch { /* 诊断不能影响正常运行 */ }
  }
  write({ id, operation, event: 'start', timestamp: startedAt })
  return (status, counts) => {
    const used = process.cpuUsage(cpu)
    write({ id, operation, event: 'end', timestamp: Date.now(), elapsedMs: Math.round(performance.now() - start), processCpuMs: Math.round((used.user + used.system) / 1000), status, ...counts })
  }
}
