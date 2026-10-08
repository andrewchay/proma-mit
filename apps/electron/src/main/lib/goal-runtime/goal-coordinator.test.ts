import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalCoordinator } from './goal-coordinator'
import { ElectronGoalStore } from './goal-store'

const testDirs: string[] = []
const originalConfig = process.env.PROMA_TEST_CONFIG_DIR

afterEach(() => {
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
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

    const run = coordinator.captureRun('session-1')!
    await run.onCheckpoint({
      outcome: 'continue',
      summary: '共享类型已完成',
      completed: ['共享类型'],
      evidence: [{ kind: 'file', value: 'packages/shared/src/types/agent.ts' }],
      nextAction: '接入 AI SDK Runtime',
      wakeTrigger: { type: 'immediate' },
    })
    expect(requests).toEqual([])

    await run.onFinished(true)
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

    await expect(coordinator.captureRun('session-2')!.onCheckpoint({
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
    const run = coordinator.captureRun('session-3')!
    await run.onCheckpoint({
      outcome: 'continue', summary: '准备继续', completed: [], evidence: [],
      nextAction: '继续执行', wakeTrigger: { type: 'immediate' },
    })
    coordinator.pauseForUserInput('session-3')
    await run.onFinished(true)
    await Bun.sleep(0)

    expect(requests).toEqual([])
    expect(coordinator.getActiveBySession('session-3')?.checkpoint?.wakeTrigger).toEqual({ type: 'user_input' })
  })

  test('given a stopped Goal when a new Goal is created in the same session then the old run no longer blocks it', () => {
    const coordinator = createCoordinator()
    const stopped = coordinator.create({ sessionId: 'session-stop', runtime: 'pi', objective: '旧 Goal' })

    coordinator.setStatus(stopped.id, 'cancelled')
    const replacement = coordinator.create({ sessionId: 'session-stop', runtime: 'pi', objective: '新 Goal' })

    expect(coordinator.get(stopped.id)?.status).toBe('cancelled')
    expect(coordinator.get(stopped.id)?.activeRunId).toBeUndefined()
    expect(replacement.objective).toBe('新 Goal')
  })

  test('given a continuation has been queued when the Goal is paused then it does not start a new run', async () => {
    const coordinator = createCoordinator()
    const requests: string[] = []
    coordinator.setContinuationRunner(async ({ prompt }) => { requests.push(prompt); return true })
    const goal = coordinator.create({ sessionId: 'session-pause', runtime: 'ai-sdk', objective: '暂停不再续跑' })
    const run = coordinator.captureRun('session-pause')!
    await run.onCheckpoint({
      outcome: 'continue', summary: '等待续跑', completed: [], evidence: [],
      nextAction: '继续执行', wakeTrigger: { type: 'immediate' },
    })

    coordinator.setStatus(goal.id, 'waiting')
    await run.onFinished(true)
    await Bun.sleep(0)

    expect(requests).toEqual([])
    expect(coordinator.get(goal.id)?.status).toBe('waiting')
  })
})


describe('Goal主进程调用身份', () => {
  const complete = { outcome: 'complete' as const, summary: '完成', completed: [], evidence: [] }
  const continuing = { outcome: 'continue' as const, summary: '继续', completed: [], evidence: [], nextAction: '验证', wakeTrigger: { type: 'immediate' as const } }

  test('普通调用签发唯一runId并持久，检查点与run关联且不可重复提交', async () => {
    const c = createCoordinator()
    const g = c.create({ sessionId: 's', runtime: 'ai-sdk', objective: '目标' })
    const run = c.captureRun('s')!
    expect(run.goalId).toBe(g.id)
    expect(c.get(g.id)?.activeRunId).toBe(run.runId)
    expect(new ElectronGoalStore().get(g.id)?.activeRunId).toBe(run.runId)
    await run.onCheckpoint(complete)
    expect(c.get(g.id)?.checkpointRunId).toBe(run.runId)
    await expect(run.onCheckpoint(complete)).rejects.toThrow('已失效')
  })

  test('旧run不能更新同会话新Goal', async () => {
    const c = createCoordinator()
    const old = c.create({ sessionId: 's', runtime: 'pi', objective: '旧' })
    const run = c.captureRun('s')!
    c.setStatus(old.id, 'cancelled')
    const next = c.create({ sessionId: 's', runtime: 'pi', objective: '新' })
    await expect(run.onCheckpoint(complete)).rejects.toThrow('已失效')
    await run.onFinished(true)
    expect(c.get(next.id)?.status).toBe('active')
    expect(c.get(next.id)?.version).toBe(1)
  })

  test('新run签发后，旧回调和finally均不能覆盖新run', async () => {
    const c = createCoordinator()
    const g = c.create({ sessionId: 's', runtime: 'ai-sdk', objective: '目标' })
    const old = c.captureRun('s')!
    const next = c.captureRun('s')!
    expect(old.runId).not.toBe(next.runId)
    await expect(old.onCheckpoint(complete)).rejects.toThrow('已失效')
    await old.onFinished(false)
    expect(c.get(g.id)?.activeRunId).toBe(next.runId)
    await next.onCheckpoint(complete)
  })

  test('暂停后恢复不会复活旧回调', async () => {
    const c = createCoordinator()
    const g = c.create({ sessionId: 's', runtime: 'pi', objective: '目标' })
    const old = c.captureRun('s')!
    c.setStatus(g.id, 'waiting')
    c.setStatus(g.id, 'active')
    await expect(old.onCheckpoint(complete)).rejects.toThrow('已失效')
  })

  test('新run无检查点退出不会重放上一轮continue', async () => {
    const c = createCoordinator()
    const g = c.create({ sessionId: 's', runtime: 'ai-sdk', objective: '目标' })
    const requests: string[] = []
    c.setContinuationRunner(async ({ prompt }) => { requests.push(prompt); return true })
    const old = c.captureRun('s')!
    await old.onCheckpoint(continuing)
    const next = c.captureRun('s')!
    await next.onFinished(true)
    await old.onFinished(true)
    await Bun.sleep(0)
    expect(requests).toEqual([])
    expect(c.get(g.id)?.status).toBe('waiting')
    expect(c.get(g.id)?.activeRunId).toBeUndefined()
  })

  test('已提交continue但槽位被停止，结束不自动续跑', async () => {
    const c = createCoordinator()
    const g = c.create({ sessionId: 's', runtime: 'pi', objective: '目标' })
    const requests: string[] = []
    c.setContinuationRunner(async ({ prompt }) => { requests.push(prompt); return true })
    const run = c.captureRun('s')!
    await run.onCheckpoint(continuing)
    await run.onFinished(false)
    await Bun.sleep(0)
    expect(requests).toEqual([])
    expect(c.get(g.id)?.checkpoint?.wakeTrigger?.type).toBe('user_input')
  })

  test('重复finally不产生第二次续跑，回调结束后不再可提交', async () => {
    const c = createCoordinator()
    c.create({ sessionId: 's', runtime: 'ai-sdk', objective: '目标' })
    const requests: string[] = []
    c.setContinuationRunner(async ({ prompt }) => { requests.push(prompt); return true })
    const run = c.captureRun('s')!
    await run.onCheckpoint(continuing)
    await run.onFinished(true)
    await run.onFinished(true)
    await Bun.sleep(0)
    expect(requests).toHaveLength(1)
    await expect(run.onCheckpoint(complete)).rejects.toThrow('已失效')
  })

  test('无Goal或已取消Goal不签发身份', () => {
    const c = createCoordinator()
    expect(c.captureRun('none')).toBeUndefined()
    const g = c.create({ sessionId: 's', runtime: 'pi', objective: '目标' })
    c.setStatus(g.id, 'cancelled')
    expect(c.captureRun('s')).toBeUndefined()
  })
})


describe('续跑启动结果回读', () => {
  const continuing = { outcome: 'continue' as const, summary: '继续', completed: [], evidence: [], nextAction: '下一步', wakeTrigger: { type: 'immediate' as const } }
  test('runner完成新run后再抛错，不回写旧快照覆盖completed', async () => {
    const c = createCoordinator()
    const g = c.create({ sessionId: 's', runtime: 'ai-sdk', objective: '目标' })
    c.setContinuationRunner(async () => {
      await c.captureRun('s')!.onCheckpoint({ outcome: 'complete', summary: '完成', completed: [], evidence: [] })
      throw new Error('fixture迟到错误')
    })
    const run = c.captureRun('s')!
    await run.onCheckpoint(continuing)
    await run.onFinished(true)
    await Bun.sleep(0)
    expect(c.get(g.id)?.status).toBe('completed')
  })

  test('runner已经签发新run但返回false，不清空新身份', async () => {
    const c = createCoordinator()
    const g = c.create({ sessionId: 's', runtime: 'ai-sdk', objective: '目标' })
    let nextId: string | undefined
    c.setContinuationRunner(async () => { nextId = c.captureRun('s')!.runId; return false })
    const run = c.captureRun('s')!
    await run.onCheckpoint(continuing)
    await run.onFinished(true)
    await Bun.sleep(0)
    expect(nextId).toBeDefined()
    expect(c.get(g.id)?.activeRunId).toBe(nextId)
  })
})
