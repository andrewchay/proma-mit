import { readOwnerHostAvailableMemory, readOwnerHostCpu, readOwnerHostTotalMemory } from './project-owner-host-resources'
import { requestOwnerAutonomousScheduleWake } from './project-owner-autonomous-scheduler-events'
import { getProjectDb } from './project-sqlite-store'

export const OWNER_LOCAL_COMMAND_LIMIT = 2
export const OWNER_RESOURCE_RETRY_MS = 2500
const SAMPLE_MS = 2000
const MEMORY_SAMPLE_MS = 5000
const MIB = 1024 ** 2

export type OwnerLocalResourceWait = 'concurrency' | 'cpu' | 'memory'

/** 双样本 CPU 滞回；低内存立即阻止新增工作，留出恢复余量。 */
export function createOwnerPressureGate() {
  let cpuBusy = false
  let cpuStreak = 0
  let memoryLow = false
  return (cpu: number | undefined, available: number | null | undefined, totalMemory: number): OwnerLocalResourceWait | null => {
    if (cpu !== undefined) {
      const counts = cpuBusy ? cpu <= 0.70 : cpu >= 0.85
      cpuStreak = counts ? cpuStreak + 1 : 0
      if (cpuStreak >= 2) {
        cpuBusy = !cpuBusy
        cpuStreak = 0
      }
    }
    const reserve = Math.min(768 * MIB, totalMemory * 0.08)
    if (available !== undefined) memoryLow = available !== null && available < reserve * (memoryLow ? 1.25 : 1)
    return memoryLow ? 'memory' : cpuBusy ? 'cpu' : null
  }
}

const pressureGate = createOwnerPressureGate()
let previousCpu = readOwnerHostCpu()
let sampledAt = performance.now()
let memoryRequestedAt = -Infinity
let memorySampledAt = -Infinity
let availableMemory: number | null | undefined
let pressure: ReturnType<typeof pressureGate> = null
let memoryProbe: Promise<void> | undefined

function samplePressure(): OwnerLocalResourceWait | null {
  const now = performance.now()
  if (!memoryProbe && now - memoryRequestedAt >= MEMORY_SAMPLE_MS) {
    memoryRequestedAt = now
    memoryProbe = readOwnerHostAvailableMemory().then(value => {
      // 单次取样不可用时保留最近有效值，不把探针错误记成项目错误。
      if (value !== undefined) {
        availableMemory = value
        memorySampledAt = performance.now()
      } else if (now - memorySampledAt > 20000) availableMemory = null
      pressure = pressureGate(undefined, availableMemory, readOwnerHostTotalMemory())
    }).finally(() => { memoryProbe = undefined })
  }
  if (now - sampledAt >= SAMPLE_MS) {
    const cpu = readOwnerHostCpu()
    const total = cpu.total - previousCpu.total
    const busy = total > 0 ? Math.max(0, Math.min(1, 1 - (cpu.idle - previousCpu.idle) / total)) : undefined
    // 隔很久没有 Owner 工作时重建基线，避免把整个空闲期计作即时负载。
    pressure = pressureGate(now - sampledAt <= 10000 ? busy : undefined, availableMemory, readOwnerHostTotalMemory())
    previousCpu = cpu
    sampledAt = now
  }
  return pressure
}

/** 第一批派工等到首次内存探针结束；正常路径无异步等待。 */
export function prepareOwnerLocalResourceSample(): Promise<void> | undefined {
  samplePressure()
  return availableMemory === undefined ? memoryProbe : undefined
}

const waitingProjects = new Set<string>()
let retry: ReturnType<typeof setTimeout> | undefined

function scheduleResourceRecheck(): void {
  if (retry) return
  retry = setTimeout(() => {
    retry = undefined
    try {
      if (readOwnerLocalResourceWait()) {
        scheduleResourceRecheck()
        return
      }
    } catch {
      // 数据库关闭时保留任务的持久队列，下一次启动会重新扫。
      waitingProjects.clear()
      return
    }
    const pending = [...waitingProjects]
    waitingProjects.clear()
    for (const id of pending) requestOwnerAutonomousScheduleWake(id)
  }, OWNER_RESOURCE_RETRY_MS)
  retry.unref()
}

export function recheckOwnerLocalResources(projectId: string): void {
  waitingProjects.add(projectId)
  scheduleResourceRecheck()
}

export function isOwnerWaitingForLocalResources(projectId: string): boolean {
  return waitingProjects.has(projectId)
}

const starting = new Set<string>()

export function readOwnerLocalResourceWait(): OwnerLocalResourceWait | null {
  const pressure = samplePressure()
  if (pressure) return pressure
  const rows = getProjectDb().prepare(`SELECT e.id FROM agent_executions e
    WHERE e.status='running' AND (e.owner_command_id IS NOT NULL OR (e.entity_type='task' AND EXISTS (
      SELECT 1 FROM project_owner_planning_links p WHERE p.planning_task_id=e.entity_id AND p.project_id=e.project_id
    ))) LIMIT ?`).all(OWNER_LOCAL_COMMAND_LIMIT) as { id: string }[]
  const active = new Set([...starting, ...rows.map(row => row.id)])
  return active.size >= OWNER_LOCAL_COMMAND_LIMIT ? 'concurrency' : null
}

/** 跨项目共享，覆盖认领前的异步启动窗口。落库 running 后由数据库占用名额。 */
export function claimOwnerLocalStart(executionId: string): (() => void) | null {
  if (starting.has(executionId) || readOwnerLocalResourceWait()) return null
  starting.add(executionId)
  return () => { starting.delete(executionId) }
}

export const OWNER_LOCAL_RESOURCE_LABELS: Record<OwnerLocalResourceWait, string> = {
  concurrency: '本机的 Owner 并发名额已用满',
  cpu: '本机 CPU 持续繁忙',
  memory: '本机可用内存不足',
}
