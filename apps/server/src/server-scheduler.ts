import type { AgentRuntimeWebServer } from '@gravitas/shared/utils'
import { nextRunForSchedule } from './scheduler-store.ts'
import type { PostgresServerSchedulerStore } from './scheduler-store.ts'

/** 每个 API worker 都可运行；数据库 claim 保证同一 schedule 不会被重复启动。 */
export class ServerScheduler {
  private timer?: ReturnType<typeof setInterval>
  constructor(private readonly store: PostgresServerSchedulerStore, private readonly runtime: AgentRuntimeWebServer, private readonly workerId: string) {}

  start(intervalMs = 5_000): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, intervalMs)
    void this.tick()
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }

  async tick(): Promise<void> {
    const due = await this.store.listDue()
    for (const schedule of due) {
      const run = await this.store.claimDue(schedule, this.workerId, nextRunForSchedule(schedule.schedule))
      if (!run) continue
      try {
        const task = await this.runtime.startSessionTask({ tenantId: run.tenantId, userId: run.userId, sessionId: run.sessionId, prompt: run.prompt, permissionMode: 'safe' })
        const completed = await this.runtime.taskRunner.waitForTask(task.taskId)
        await this.store.finish(run, completed.status === 'completed' ? 'success' : 'failed', completed.error)
      } catch (error) {
        await this.store.finish(run, 'failed', error instanceof Error ? error.message : '未知错误')
      }
    }
  }
}
