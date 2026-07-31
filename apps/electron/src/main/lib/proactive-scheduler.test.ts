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
      schedule: { type: 'at', runAt: 2_990_000 }, permissionMode: 'safe', enabled: true, consecutiveFailures: 0, nextRunAt: 2_990_000,
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

  test('given a cron schedule with an IANA timezone when created then it persists the matching next run', () => {
    const time = new Date('2026-07-29T00:00:00.000Z').getTime()
    const scheduler = createScheduler(() => time)
    const schedule = scheduler.create({
      title: '上海晨报', sessionId: 'session-6', channelId: 'channel-1', runtime: 'ai-sdk', prompt: '生成晨报',
      schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
    })
    expect(schedule.nextRunAt).toBe(new Date('2026-07-29T01:00:00.000Z').getTime())
    scheduler.dispose()
  })

  test('given an invalid cron schedule when created then it is rejected without persistence', () => {
    const scheduler = createScheduler(() => new Date('2026-07-29T00:00:00.000Z').getTime())
    expect(() => scheduler.create({
      title: '无效计划', sessionId: 'session-7', channelId: 'channel-1', runtime: 'ai-sdk', prompt: '不执行',
      schedule: { type: 'cron', expression: 'not a cron', timezone: 'Mars/Olympus' },
    })).toThrow('Cron 计划无效')
    expect(scheduler.listSchedules()).toHaveLength(0)
    scheduler.dispose()
  })

  test('given a due cron schedule when recovering then it runs once and calculates the following matching run', async () => {
    let time = new Date('2026-07-29T00:00:00.000Z').getTime()
    const scheduler = createScheduler(() => time)
    const schedule = scheduler.create({
      title: '每日晨报', sessionId: 'session-8', channelId: 'channel-1', runtime: 'ai-sdk', prompt: '生成晨报',
      schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
    })
    scheduler.setRunner(async () => ({ outputSummary: '晨报完成' }))
    time = new Date('2026-07-29T01:00:00.000Z').getTime()
    await scheduler.recover()

    expect(scheduler.listRuns()[0]).toMatchObject({ sourceId: schedule.id, status: 'success', trigger: 'recovery' })
    expect(scheduler.listSchedules()[0]).toMatchObject({
      enabled: true,
      lastRunAt: time,
      nextRunAt: new Date('2026-07-30T01:00:00.000Z').getTime(),
    })
    scheduler.dispose()
  })

  test('given three consecutive scheduled failures when recovering then it auto-pauses until explicitly resumed', async () => {
    let time = 7_000_000
    const scheduler = createScheduler(() => time)
    const schedule = scheduler.create({
      title: '失败保护', sessionId: 'session-9', channelId: 'channel-1', runtime: 'ai-sdk', prompt: '检查状态',
      schedule: { type: 'interval', intervalMs: 60_000 },
    })
    scheduler.setRunner(async () => { throw new Error('渠道不可用') })

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      time = 7_000_000 + attempt * 60_000
      await scheduler.recover()
    }

    const paused = scheduler.listSchedules().find((item) => item.id === schedule.id)
    expect(paused).toMatchObject({ enabled: false, consecutiveFailures: 3 })
    expect(scheduler.resume(schedule.id)).toMatchObject({ enabled: true, consecutiveFailures: 0 })
    scheduler.dispose()
  })
})
