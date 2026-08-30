import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMonitor,
  resetMonitorServiceForTests,
  setMonitorRunner,
  triggerMonitorEvent,
  receiveWebhookEvent,
} from './monitor-service'
import { ProactiveSchedulerStore } from './proactive-scheduler-store'

const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const configDir = await mkdtemp(join(tmpdir(), 'gravitas-monitor-service-'))
process.env.PROMA_TEST_CONFIG_DIR = configDir

afterAll(async () => {
  resetMonitorServiceForTests()
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
  await rm(configDir, { recursive: true, force: true })
})

beforeEach(async () => {
  resetMonitorServiceForTests()
  await rm(join(configDir, 'proactive'), { recursive: true, force: true })
})

async function waitForRun(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (new ProactiveSchedulerStore().listRuns().length > 0) return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待 Monitor run 超时')
}

describe('MonitorService', () => {
  test('given an event monitor when it fires then it persists an auditable successful run through the injected runner', async () => {
    const monitor = createMonitor({
      title: '配置变更检查',
      routineId: 'test:routine',
      execution: {
        sessionId: 'session-1',
        channelId: 'channel-1',
        runtime: 'proma',
        prompt: '检查配置变更',
      },
      trigger: { type: 'file', path: '/tmp/monitor-test', events: ['modify'] },
      debounceMs: 0,
    })
    setMonitorRunner(async (receivedMonitor, run, eventData) => {
      expect(receivedMonitor.id).toBe(monitor.id)
      expect(run.sourceType).toBe('monitor')
      expect(eventData).toEqual({ path: 'settings.json', event: 'modify' })
      return { outputSummary: '已检查', sessionId: 'session-1' }
    })

    triggerMonitorEvent(monitor.id, { path: 'settings.json', event: 'modify' })
    await waitForRun()

    expect(new ProactiveSchedulerStore().listRuns()).toEqual([
      expect.objectContaining({
        sourceId: monitor.id,
        sourceType: 'monitor',
        trigger: 'event',
        status: 'success',
        outputSummary: '已检查',
        sessionId: 'session-1',
      }),
    ])
  })

  test('given a reused-session monitor without a target session when created then it is rejected', () => {
    expect(() => createMonitor({
      title: '无效监听',
      routineId: 'test:routine',
      execution: { channelId: 'channel-1', runtime: 'proma', prompt: '检查状态' },
      trigger: { type: 'command', command: 'true', intervalMs: 60_000 },
    })).toThrow('复用会话的 Monitor 缺少目标会话')
  })

  test('given a Routine instance binding when a monitor is created then it is persisted with the controlled execution target', () => {
    const monitor = createMonitor({
      title: 'Routine 监听', routineId: 'memory-daily', routineInstanceId: 'routine-instance-1',
      execution: { sessionId: 'session-1', channelId: 'channel-1', runtime: 'proma', prompt: '整理变化' },
      trigger: { type: 'file', path: '/tmp/routine-monitor', events: ['modify'] },
    })

    expect(monitor).toEqual(expect.objectContaining({ routineInstanceId: 'routine-instance-1', execution: expect.objectContaining({ permissionMode: 'safe' }) }))
  })

  test('given a signed webhook event when received then it enters the monitored execution pipeline', async () => {
    const monitor = createMonitor({
      title: '部署完成', routineId: 'test:webhook',
      execution: { sessionId: 'session-1', channelId: 'channel-1', runtime: 'proma', prompt: '检查部署结果' },
      trigger: { type: 'webhook', endpoint: 'deploy', secret: 'test-secret' }, debounceMs: 0,
    })
    setMonitorRunner(async () => ({ outputSummary: '部署已检查' }))
    const payload = '{"deployment":"ok"}'
    const { createHmac } = await import('node:crypto')
    const signature = createHmac('sha256', 'test-secret').update(payload).digest('hex')

    expect(receiveWebhookEvent(monitor.id, payload, signature)).toEqual({ accepted: true })
    await waitForRun()
    expect(new ProactiveSchedulerStore().listRuns().some((run) => run.sourceId === monitor.id && run.status === 'success')).toBeTrue()
    expect(receiveWebhookEvent(monitor.id, payload, 'bad')).toEqual({ accepted: false, error: 'Webhook 签名无效' })
  })
})
