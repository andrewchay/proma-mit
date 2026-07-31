/**
 * 本地 durable Scheduler：负责到期恢复、暂停/恢复和运行记录。
 * Cron 仅用于计算下次执行时间；不启动额外常驻 worker，也不会默认提升 Agent 权限。
 */

import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'
import type {
  CreateProactiveScheduleInput,
  ProactiveSchedule,
  ProactiveTaskRun,
} from '@proma/shared'
import { ProactiveSchedulerStore } from './proactive-scheduler-store'

const MIN_INTERVAL_MS = 60_000
const MAX_TIMER_DELAY_MS = 2_147_483_647
const MAX_CONSECUTIVE_FAILURES = 3

export interface ProactiveRunResult {
  outputSummary?: string
}

export type ProactiveScheduleRunner = (schedule: ProactiveSchedule, run: ProactiveTaskRun) => Promise<ProactiveRunResult>

export class ProactiveScheduler {
  private runner?: ProactiveScheduleRunner
  private timer?: ReturnType<typeof setTimeout>
  private readonly activeScheduleIds = new Set<string>()

  constructor(
    private readonly store = new ProactiveSchedulerStore(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  setRunner(runner: ProactiveScheduleRunner): void { this.runner = runner }

  listSchedules(): ProactiveSchedule[] { return this.store.listSchedules().sort((left, right) => (left.nextRunAt ?? Infinity) - (right.nextRunAt ?? Infinity)) }
  listRuns(): ProactiveTaskRun[] { return this.store.listRuns().sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0)) }

  create(input: CreateProactiveScheduleInput): ProactiveSchedule {
    validateCreateInput(input, this.now())
    const now = this.now()
    const schedule: ProactiveSchedule = {
      id: randomUUID(),
      title: input.title.trim(),
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      modelId: input.modelId,
      runtime: input.runtime,
      prompt: input.prompt.trim(),
      schedule: input.schedule,
      permissionMode: input.permissionMode ?? 'safe',
      enabled: true,
      consecutiveFailures: 0,
      nextRunAt: initialNextRunAt(input.schedule, now),
      createdAt: now,
      updatedAt: now,
    }
    const saved = this.store.saveSchedule(schedule)
    this.arm()
    return saved
  }

  pause(scheduleId: string): ProactiveSchedule { return this.setEnabled(scheduleId, false) }
  resume(scheduleId: string): ProactiveSchedule { return this.setEnabled(scheduleId, true) }

  delete(scheduleId: string): void {
    if (this.activeScheduleIds.has(scheduleId)) throw new Error('定时任务正在运行，无法删除')
    if (!this.store.deleteSchedule(scheduleId)) throw new Error('定时任务不存在')
    this.arm()
  }

  async runNow(scheduleId: string): Promise<ProactiveTaskRun> {
    const schedule = this.requireSchedule(scheduleId)
    return this.execute(schedule, 'manual')
  }

  /** 应用启动后调用；错过的任务最多补跑一次，避免离线期间连发。 */
  async recover(): Promise<void> {
    await this.runDue('recovery')
    this.arm()
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private setEnabled(scheduleId: string, enabled: boolean): ProactiveSchedule {
    const schedule = this.requireSchedule(scheduleId)
    const now = this.now()
    if (enabled && schedule.schedule.type === 'at' && schedule.schedule.runAt <= now) {
      throw new Error('已过期的一次性任务不能恢复；请手动运行或新建任务')
    }
    const saved = this.store.saveSchedule({
      ...schedule,
      enabled,
      consecutiveFailures: enabled ? 0 : schedule.consecutiveFailures ?? 0,
      nextRunAt: enabled ? initialNextRunAt(schedule.schedule, now) : schedule.nextRunAt,
      updatedAt: now,
    })
    this.arm()
    return saved
  }

  private async runDue(trigger: 'scheduled' | 'recovery'): Promise<void> {
    const now = this.now()
    const due = this.listSchedules().filter((schedule) => schedule.enabled && schedule.nextRunAt !== undefined && schedule.nextRunAt <= now)
    for (const schedule of due) await this.execute(schedule, trigger)
  }

  private async execute(schedule: ProactiveSchedule, trigger: ProactiveTaskRun['trigger']): Promise<ProactiveTaskRun> {
    if (this.activeScheduleIds.has(schedule.id)) throw new Error('该定时任务正在运行')
    this.activeScheduleIds.add(schedule.id)
    const startedAt = this.now()
    let run = this.store.saveRun({
      id: randomUUID(), sourceType: trigger === 'manual' ? 'manual' : 'schedule', sourceId: schedule.id,
      sessionId: schedule.sessionId, status: 'running', trigger, startedAt,
    })
    try {
      if (!this.runner) throw new Error('Scheduler 执行器未就绪')
      const result = await this.runner(schedule, run)
      run = this.store.saveRun({ ...run, status: 'success', endedAt: this.now(), outputSummary: result.outputSummary })
      return run
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      run = this.store.saveRun({ ...run, status: 'failed', endedAt: this.now(), error: message })
      return run
    } finally {
      this.activeScheduleIds.delete(schedule.id)
      const current = this.requireSchedule(schedule.id)
      const consumesSchedule = trigger !== 'manual'
      const failedScheduledRun = consumesSchedule && run.status === 'failed'
      const consecutiveFailures = failedScheduledRun
        ? (current.consecutiveFailures ?? 0) + 1
        : consumesSchedule ? 0 : current.consecutiveFailures ?? 0
      const autoPaused = failedScheduledRun && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
      this.store.saveSchedule({
        ...current,
        lastRunAt: startedAt,
        enabled: consumesSchedule && (current.schedule.type === 'at' || autoPaused) ? false : current.enabled,
        consecutiveFailures,
        nextRunAt: consumesSchedule ? nextRunAt(current.schedule, this.now()) : current.nextRunAt,
        updatedAt: this.now(),
      })
      this.arm()
    }
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    const nextRunAt = this.listSchedules().filter((item) => item.enabled && item.nextRunAt !== undefined).map((item) => item.nextRunAt as number).sort((left, right) => left - right)[0]
    if (nextRunAt === undefined) return
    this.timer = setTimeout(() => {
      void this.runDue('scheduled').finally(() => this.arm())
    }, Math.min(Math.max(0, nextRunAt - this.now()), MAX_TIMER_DELAY_MS))
  }

  private requireSchedule(scheduleId: string): ProactiveSchedule {
    const schedule = this.store.getSchedule(scheduleId)
    if (!schedule) throw new Error('定时任务不存在')
    return schedule
  }
}

function validateCreateInput(input: CreateProactiveScheduleInput, now: number): void {
  if (!input.title.trim()) throw new Error('定时任务名称不能为空')
  if (!input.sessionId.trim() || !input.channelId.trim() || !input.prompt.trim()) throw new Error('定时任务缺少会话、渠道或执行内容')
  if (input.schedule.type === 'at' && input.schedule.runAt <= now) throw new Error('一次性任务时间必须在未来')
  if (input.schedule.type === 'interval' && input.schedule.intervalMs < MIN_INTERVAL_MS) throw new Error('定时间隔不得小于 1 分钟')
  if (input.schedule.type === 'cron') {
    if (!input.schedule.expression.trim()) throw new Error('Cron 表达式不能为空')
    try {
      assertValidTimezone(input.schedule.timezone)
      const next = createCron(input.schedule).nextRun(new Date(now))
      if (!next) throw new Error('Cron 表达式没有未来执行时间')
    } catch (error) {
      if (error instanceof Error && error.message === 'Cron 表达式没有未来执行时间') throw error
      throw new Error(`Cron 计划无效：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }
}

function initialNextRunAt(schedule: ProactiveSchedule['schedule'], now: number): number {
  if (schedule.type === 'at') return schedule.runAt
  if (schedule.type === 'interval') return now + schedule.intervalMs
  return requireNextCronRun(schedule, now)
}

function nextRunAt(schedule: ProactiveSchedule['schedule'], now: number): number | undefined {
  if (schedule.type === 'at') return undefined
  if (schedule.type === 'interval') return now + schedule.intervalMs
  return requireNextCronRun(schedule, now)
}

function createCron(schedule: Extract<ProactiveSchedule['schedule'], { type: 'cron' }>): Cron {
  return new Cron(schedule.expression, { timezone: schedule.timezone, paused: true })
}

function requireNextCronRun(schedule: Extract<ProactiveSchedule['schedule'], { type: 'cron' }>, now: number): number {
  const next = createCron(schedule).nextRun(new Date(now))
  if (!next) throw new Error('Cron 表达式没有未来执行时间')
  return next.getTime()
}

function assertValidTimezone(timezone: string): void {
  if (!timezone.trim()) throw new Error('时区不能为空')
  new Intl.DateTimeFormat('en-US', { timeZone: timezone })
}
