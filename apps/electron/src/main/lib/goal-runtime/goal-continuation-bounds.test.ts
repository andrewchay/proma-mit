/**
 * V04：有界修复续跑。
 *
 * - 连续自动续跑计数持久化在 Goal 记录：应用重启后不可绕过；
 * - 续跑准入（预算/撤权等外部策略）可注入：拒绝或抛错都 fail-closed 转 waiting 并给原因；
 * - blocked（用户暂停）不发起续跑；续跑 prompt 不携带上一轮 evidence 正文，
 *   并要求重新核验外部状态（未知副作用不重放）。
 */

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

async function fixture(options: ConstructorParameters<typeof GoalCoordinator>[1] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'proma-goal-v04-'))
  testDirs.push(dir)
  process.env.PROMA_TEST_CONFIG_DIR = dir
  const store = new ElectronGoalStore()
  const coordinator = new GoalCoordinator(store, options)
  const prompts: string[] = []
  coordinator.setContinuationRunner(async ({ prompt }) => { prompts.push(prompt); return true })
  coordinator.create({ sessionId: 's', runtime: 'ai-sdk', objective: '目标' })
  return { coordinator, store, prompts }
}

const PREPARED = { runtime: 'ai-sdk' as const, workspaceId: undefined, channelId: 'fixture-channel', requestedModelId: undefined, provider: 'openai' as const, cwd: '/fixture' }

/** 一轮续跑：新 run 句柄 + 固定上下文 + continue 检查点 + 结束。 */
async function continueImmediate(coordinator: GoalCoordinator, summary: string, evidence = true) {
  const run = coordinator.captureRun('s')!
  await run.onPrepared(PREPARED)
  await run.onCheckpoint({
    outcome: 'continue', summary, completed: [],
    evidence: evidence ? [{ kind: 'file' as const, value: '/secret/evidence.txt' }] : [],
    nextAction: '继续执行', wakeTrigger: { type: 'immediate' },
  })
  await run.onFinished(true)
  await Bun.sleep(0)
}

describe('V04：有界修复续跑', () => {
  test('连续续跑计数持久化：同 store 新协调器（模拟重启）不重置计数', async () => {
    const { coordinator, store, prompts } = await fixture()
    // 第 1..3 次 immediate 续跑被允许；计数持久化。
    for (let i = 1; i <= 3; i += 1) {
      coordinator.setStatus(store.list()[0]!.id, 'active')
      await continueImmediate(coordinator, `轮次 ${i}`)
    }
    expect(prompts).toHaveLength(3)
    // 第 4 次：超限转 waiting，计数=4。
    coordinator.setStatus(store.list()[0]!.id, 'active')
    await continueImmediate(coordinator, '轮次 4')
    expect(prompts).toHaveLength(3)
    expect(store.list()[0]!.status).toBe('waiting')
    expect(store.list()[0]!.continuationCount).toBe(4)

    // 模拟重启：同 store、新协调器实例。计数不可绕过。
    const restarted = new GoalCoordinator(store)
    restarted.setContinuationRunner(async () => true)
    restarted.setStatus(store.list()[0]!.id, 'active')
    await continueImmediate(restarted, '重启后尝试')
    expect(prompts).toHaveLength(3)
    expect(store.list()[0]!.status).toBe('waiting')
    expect(store.list()[0]!.continuationCount).toBe(5)
  })

  test('续跑准入拒绝：转 waiting 并给原因；抛错 fail-closed', async () => {
    const denied = await fixture({ canContinue: () => ({ allowed: false, reason: '预算已撤销' }) })
    await continueImmediate(denied.coordinator, '尝试续跑')
    expect(denied.store.list()[0]!.status).toBe('waiting')
    expect(denied.store.list()[0]!.checkpoint?.blocker).toContain('预算已撤销')
    expect(denied.prompts).toEqual([])

    const throwing = await fixture({ canContinue: () => { throw new Error('pilot store 不可读') } })
    await continueImmediate(throwing.coordinator, '尝试续跑')
    expect(throwing.store.list()[0]!.status).toBe('waiting')
    expect(throwing.store.list()[0]!.checkpoint?.blocker).toContain('续跑准入检查失败')
    expect(throwing.prompts).toEqual([])
  })

  test('blocked（用户暂停）不发起续跑；续跑 prompt 不携带 evidence 正文并要求重新核验', async () => {
    // 排队后、onFinished 前暂停：schedule 看到 blocked 直接跳过。
    const paused = await fixture()
    const pausedRun = paused.coordinator.captureRun('s')!
    await pausedRun.onPrepared(PREPARED)
    await pausedRun.onCheckpoint({
      outcome: 'continue', summary: '暂停期间进展', completed: [], evidence: [], nextAction: '继续', wakeTrigger: { type: 'immediate' },
    })
    paused.coordinator.setStatus(paused.store.list()[0]!.id, 'blocked')
    await pausedRun.onFinished(true)
    await Bun.sleep(0)
    expect(paused.prompts).toEqual([])
    expect(paused.store.list()[0]!.status).toBe('blocked')

    // 恢复 active 后新排队：prompt 不含 evidence 正文，含重新核验指令。
    const fresh = await fixture()
    const freshRun = fresh.coordinator.captureRun('s')!
    await freshRun.onPrepared(PREPARED)
    await freshRun.onCheckpoint({
      outcome: 'continue', summary: '恢复后进展', completed: [], evidence: [{ kind: 'file', value: '/secret/evidence.txt' }],
      nextAction: '继续执行', wakeTrigger: { type: 'immediate' },
    })
    await freshRun.onFinished(true)
    await Bun.sleep(0)
    expect(fresh.prompts).toHaveLength(1)
    const prompt = fresh.prompts[0]!
    expect(prompt).not.toContain('/secret/evidence.txt')
    expect(prompt).toContain('重新核验')
  })
})
