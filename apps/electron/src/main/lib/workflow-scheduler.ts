/**
 * Workflow 定时调度器。
 *
 * 状态独立存储于 workflows/scheduler-state.json：Definition 发布后不可被 nextRunAt 污染，
 * 应用重启时也不会因内存状态丢失而立即重复执行。
 */

import type { WorkflowDefinition, WorkflowRun, WorkflowScheduleTriggerConfig } from '@gravitas/shared'
import { getWorkflowSchedulerStatePath } from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import { executeWorkflowRun } from './workflow-run-executor'
import { createWorkflowRun, listWorkflowDefinitions, listWorkflowRuns } from './workflow-service'

const TICK_INTERVAL_MS = 30_000

interface WorkflowSchedulerState {
  nextRunAtByWorkflowId: Record<string, number>
}

let timer: ReturnType<typeof setInterval> | null = null
let ticking = false

function readState(): WorkflowSchedulerState {
  return readJsonFileSafe<WorkflowSchedulerState>(getWorkflowSchedulerStatePath()) ?? { nextRunAtByWorkflowId: {} }
}

function writeState(state: WorkflowSchedulerState): void {
  writeJsonFileAtomic(getWorkflowSchedulerStatePath(), state)
}

function parseTime(value?: string): [number, number] {
  const [hour, minute] = (value ?? '09:00').split(':').map(Number)
  return [Number.isFinite(hour) ? hour! : 9, Number.isFinite(minute) ? minute! : 0]
}

/** 计算下次计划时间；该函数无 I/O，便于覆盖日/周/月边界。 */
export function calculateWorkflowNextRunAt(config: WorkflowScheduleTriggerConfig, now = Date.now()): number {
  const current = new Date(now)
  if (config.mode === 'interval') {
    const unit = config.intervalUnit ?? 'minutes'
    return now + (config.interval ?? 1) * (unit === 'hours' ? 3_600_000 : 60_000)
  }
  const [hour, minute] = parseTime(config.time)
  if (config.mode === 'daily') {
    const next = new Date(current.getFullYear(), current.getMonth(), current.getDate(), hour, minute)
    if (next.getTime() <= now) next.setDate(next.getDate() + 1)
    return next.getTime()
  }
  if (config.mode === 'weekly') {
    const next = new Date(current.getFullYear(), current.getMonth(), current.getDate(), hour, minute)
    let days = (config.dayOfWeek ?? 1) - next.getDay()
    if (days <= 0) days += 7
    next.setDate(next.getDate() + days)
    return next.getTime()
  }
  let year = current.getFullYear()
  let month = current.getMonth()
  let next = new Date(year, month, config.dayOfMonth ?? 1, hour, minute)
  if (next.getTime() <= now) {
    month += 1
    if (month > 11) { month = 0; year += 1 }
    next = new Date(year, month, config.dayOfMonth ?? 1, hour, minute)
  }
  return next.getTime()
}

function isActiveRun(run: WorkflowRun): boolean {
  return run.status === 'queued' || run.status === 'running' || run.status === 'waiting_approval' || run.status === 'blocked'
}

async function triggerDefinition(definition: WorkflowDefinition, config: WorkflowScheduleTriggerConfig): Promise<void> {
  if (config.concurrencyPolicy !== 'allow' && listWorkflowRuns(definition.id).some(isActiveRun)) {
    console.warn(`[Workflow Scheduler] 跳过重叠 Run: ${definition.name}`)
    return
  }
  const run = createWorkflowRun(definition.id, config.input ?? {}, 'schedule')
  await executeWorkflowRun(definition.id, run.id, config.channelId, config.modelId)
}

/** 单次 tick 导出给测试与受控启动流程使用。 */
export async function triggerWorkflowSchedulerTick(now = Date.now()): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const state = readState()
    let changed = false
    for (const definition of listWorkflowDefinitions()) {
      if (definition.status !== 'published' || definition.trigger.kind !== 'schedule') continue
      const config = definition.trigger.config as unknown as WorkflowScheduleTriggerConfig
      if (config.enabled === false) continue
      const nextRunAt = state.nextRunAtByWorkflowId[definition.id]
      if (!nextRunAt) {
        state.nextRunAtByWorkflowId[definition.id] = calculateWorkflowNextRunAt(config, now)
        changed = true
        continue
      }
      if (nextRunAt > now) continue
      // 先持久化下一次执行点，再运行副作用节点，避免崩溃后重启重复触发。
      state.nextRunAtByWorkflowId[definition.id] = calculateWorkflowNextRunAt(config, now)
      writeState(state)
      changed = false
      try {
        await triggerDefinition(definition, config)
      } catch (error) {
        console.error(`[Workflow Scheduler] 执行失败: ${definition.name}`, error)
      }
    }
    if (changed) writeState(state)
  } finally {
    ticking = false
  }
}

export function startWorkflowScheduler(): void {
  if (timer) return
  console.log('[Workflow Scheduler] 启动（tick 间隔 30s）')
  void triggerWorkflowSchedulerTick()
  timer = setInterval(() => { void triggerWorkflowSchedulerTick() }, TICK_INTERVAL_MS)
}

export function stopWorkflowScheduler(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
  console.log('[Workflow Scheduler] 已停止')
}
