import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalCoordinator } from './goal-coordinator'
import { ElectronGoalStore } from './goal-store'

const testDirs: string[] = []

afterEach(() => {
  while (testDirs.length > 0) {
    const dir = testDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function createCoordinator(): GoalCoordinator {
  const dir = mkdtempSync(join(tmpdir(), 'proma-goal-test-'))
  testDirs.push(dir)
  process.env.PROMA_TEST_CONFIG_DIR = dir
  return new GoalCoordinator(new ElectronGoalStore())
}

describe('GoalCoordinator', () => {
  test('given immediate checkpoint when turn finishes then schedules exactly one continuation', async () => {
    const coordinator = createCoordinator()
    const requests: string[] = []
    coordinator.setContinuationRunner(async ({ prompt }) => { requests.push(prompt); return true })
    const goal = coordinator.create({
      sessionId: 'session-1',
      channelId: 'channel-1',
      runtime: 'ai-sdk',
      objective: '补完 Goal Runtime',
    })

    await coordinator.submitCheckpoint('session-1', {
      outcome: 'continue',
      summary: '共享类型已完成',
      completed: ['共享类型'],
      evidence: [{ kind: 'file', value: 'packages/shared/src/types/agent.ts' }],
      nextAction: '接入 AI SDK Runtime',
      wakeTrigger: { type: 'immediate' },
    })
    expect(requests).toEqual([])

    await coordinator.onTurnFinished('session-1')
    await Bun.sleep(0)

    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain('接入 AI SDK Runtime')
    expect(coordinator.get(goal.id)?.status).toBe('active')
  })

  test('given acceptance criteria when complete checkpoint has no evidence then rejects completion', async () => {
    const coordinator = createCoordinator()
    coordinator.create({
      sessionId: 'session-2',
      runtime: 'proma',
      objective: '验证持续跟进',
      acceptanceCriteria: ['行为测试通过'],
    })

    await expect(coordinator.submitCheckpoint('session-2', {
      outcome: 'complete',
      summary: '看起来完成了',
      completed: ['实现'],
      evidence: [],
    })).rejects.toThrow('必须提供 evidence')
  })

  test('given an immediate continuation when user writes then queued continuation is suppressed', async () => {
    const coordinator = createCoordinator()
    const requests: string[] = []
    coordinator.setContinuationRunner(async ({ prompt }) => { requests.push(prompt); return true })
    coordinator.create({ sessionId: 'session-3', runtime: 'proma', objective: '持续推进' })
    await coordinator.submitCheckpoint('session-3', {
      outcome: 'continue', summary: '准备继续', completed: [], evidence: [],
      nextAction: '继续执行', wakeTrigger: { type: 'immediate' },
    })
    coordinator.pauseForUserInput('session-3')
    await coordinator.onTurnFinished('session-3')
    await Bun.sleep(0)

    expect(requests).toEqual([])
    expect(coordinator.getActiveBySession('session-3')?.checkpoint?.wakeTrigger).toEqual({ type: 'user_input' })
  })
})
