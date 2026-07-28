import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProactiveScheduler } from './proactive-scheduler'
import { ProactiveSchedulerStore } from './proactive-scheduler-store'

const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const configDir = await mkdtemp(join(tmpdir(), 'proma-proactive-scheduler-'))
process.env.PROMA_TEST_CONFIG_DIR = configDir

afterAll(async () => {
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
  await rm(configDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(join(configDir, 'proactive'), { recursive: true, force: true })
})

function createScheduler(now: () => number): ProactiveScheduler {
  return new ProactiveScheduler(new ProactiveSchedulerStore(), now)
}

describe('Proactive Scheduler', () => {
  test('given an interval schedule when created then it defaults to safe and can pause or resume', () => {
    let time = 1_000_000
    const scheduler = createScheduler(() => time)
    const schedule = scheduler.create({
      title: '每日回顾', sessionId: 'session-1', channelId: 'channel-1', runtime: 'ai-sdk', prompt: '总结今天',
      schedule: { type: 'interval', intervalMs: 60_000 },
    })
    expect(schedule.permissionMode).toBe('safe')
    expect(schedule.nextRunAt).toBe(1_060_000)
    expect(scheduler.pause(schedule.id).enabled).toBeFalse()
    time = 1_100_000
    expect(scheduler.resume(schedule.id).nextRunAt).toBe(1_160_000)
    scheduler.dispose()
  })

  test('given a due interval schedule on recovery then it runs once and persists a successful TaskRun', async () => {
    let time = 2_000_000
    const scheduler = createScheduler(() => time)
    const schedule = scheduler.create({
      title: '定期检查', sessionId: 'session-2', channelId: 'channel-1', runtime: 'proma', prompt: '检查状态',
      schedule: { type: 'interval', intervalMs: 60_000 },
    })
    scheduler.setRunner(async (current) => ({ outputSummary: `${current.title} 完成` }))
    time = 2_060_000
    await scheduler.recover()

    const [run] = scheduler.listRuns()
    const recovered = scheduler.listSchedules().find((item) => item.id === schedule.id)
    expect(run).toMatchObject({ sourceId: schedule.id, status: 'success', trigger: 'recovery', outputSummary: '定期检查 完成' })
    expect(recovered).toMatchObject({ enabled: true, lastRunAt: 2_060_000, nextRunAt: 2_120_000 })
    scheduler.dispose()
  })

  test('given a past one-time schedule in persisted storage when recovering then it runs once and disables itself', async () => {
    let time = 3_000_000
    const scheduler = createScheduler(() => time)
    const store = new ProactiveSchedulerStore()
    store.saveSchedule({
      id: 'once-1', title: '一次提醒', sessionId: 'session-3', channelId: 'channel-1', runtime: 'ai-sdk', prompt: '提醒我',
      schedule: { type: 'at', runAt: 2_990_000 }, permissionMode: 'safe', enabled: true, nextRunAt: 2_990_000,
      createdAt: 2_900_000, updatedAt: 2_900_000,
    })
    scheduler.setRunner(async () => ({}))
    await scheduler.recover()

    expect(scheduler.listRuns()[0]).toMatchObject({ sourceId: 'once-1', status: 'success', trigger: 'recovery' })
    const recovered = scheduler.listSchedules().find((item) => item.id === 'once-1')
    expect(recovered?.enabled).toBeFalse()
    expect(recovered?.nextRunAt).toBeUndefined()
    scheduler.dispose()
  })

  test('given a paused schedule when deleted then it is removed from durable storage', () => {
    const scheduler = createScheduler(() => 4_000_000)
    const schedule = scheduler.create({
      title: '可删除任务', sessionId: 'session-4', channelId: 'channel-1', runtime: 'ai-sdk', prompt: '检查状态',
      schedule: { type: 'interval', intervalMs: 60_000 },
    })
    scheduler.pause(schedule.id)
    scheduler.delete(schedule.id)
    expect(scheduler.listSchedules()).toHaveLength(0)
    scheduler.dispose()
  })

  test('given a future one-time schedule when manually run then its scheduled execution remains pending', async () => {
    let time = 5_000_000
    const scheduler = createScheduler(() => time)
    const schedule = scheduler.create({
      title: '未来提醒', sessionId: 'session-5', channelId: 'channel-1', runtime: 'ai-sdk', prompt: '提醒我',
      schedule: { type: 'at', runAt: 5_120_000 },
    })
    scheduler.setRunner(async () => ({}))
    await scheduler.runNow(schedule.id)
    expect(scheduler.listSchedules()[0]).toMatchObject({ enabled: true, nextRunAt: 5_120_000 })
    time = 5_120_000
    await scheduler.recover()
    expect(scheduler.listSchedules()[0]?.enabled).toBeFalse()
    scheduler.dispose()
  })
})
