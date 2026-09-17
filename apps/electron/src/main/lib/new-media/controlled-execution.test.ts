import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { NewMediaPlatform } from '@gravitas/shared'
import {
  ControlledExecutionError,
  clearControlledActionExecutorsForTests,
  listControlledActionExecutors,
  registerControlledActionExecutor,
  type ControlledExecutionInput,
  type ControlledExecutionReceipt,
} from './new-media-controlled-executor'
import {
  approveControlledAction,
  executeControlledAction,
  getClaimedActionCount,
  getControlledActionAudit,
  listControlledActions,
  reconcileControlledExecution,
  rejectControlledAction,
  requestControlledAction,
  resetControlledActionsForTests,
  retryControlledExecution,
  simulateControlledAction,
} from './controlled-actions'
import { clearNewMediaRecordsForTests, closeNewMediaDb } from './new-media-sqlite-store'

let testDir = ''
beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-nm-exec-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { clearControlledActionExecutorsForTests(); await clearNewMediaRecordsForTests() })
afterAll(() => { clearControlledActionExecutorsForTests(); closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

/** 可编排的假执行器，记录调用并可返回成功、失败或抛错。 */
function fakeExecutor(platform: NewMediaPlatform = 'wechat-official-account') {
  const calls: ControlledExecutionInput[] = []
  let behavior: (input: ControlledExecutionInput) => Promise<ControlledExecutionReceipt> = async () => ({
    platform,
    externalId: 'PUBLISH-1',
    platformStatus: 'publishing',
    summary: '已提交发布，等待平台异步结果',
    receivedAt: 1_000,
  })
  registerControlledActionExecutor({
    kind: 'publish',
    platform,
    describe: () => '测试用发布执行器：只在本进程内返回预置结果。',
    execute: async (input) => {
      calls.push(input)
      return behavior(input)
    },
  })
  return {
    calls,
    setBehavior(next: (input: ControlledExecutionInput) => Promise<ControlledExecutionReceipt>) { behavior = next },
  }
}

async function approvedAction(platform: NewMediaPlatform = 'wechat-official-account') {
  const action = await requestControlledAction({ kind: 'publish', platform, targetId: 'draft-1', summary: '秋日新品发布' })
  return approveControlledAction(action.id, 'Carol')
}

describe('P2-06 执行器注册表', () => {
  test('默认没有任何执行器，真实外发无法触发', () => {
    expect(listControlledActionExecutors()).toEqual([])
  })

  test('重复注册被拒绝，注册后可被查询', () => {
    const executor = { kind: 'publish' as const, platform: 'wechat-official-account' as const, describe: () => 'x', execute: async () => ({ platform: 'wechat-official-account' as const, summary: 'x', receivedAt: 1 }) }
    registerControlledActionExecutor(executor)
    expect(() => registerControlledActionExecutor(executor)).toThrow('执行器重复注册')
    expect(listControlledActionExecutors()).toHaveLength(1)
  })
})

describe('P2-06 审批门控', () => {
  test('未经审批不得执行，也不会调用执行器', async () => {
    const executor = fakeExecutor()
    const action = await requestControlledAction({ kind: 'publish', platform: 'wechat-official-account', targetId: 'draft-1', summary: '未审批' })
    await expect(executeControlledAction(action.id)).rejects.toThrow('尚未批准')
    expect(executor.calls).toHaveLength(0)
    expect((await listControlledActions())[0]?.status).toBe('pending_approval')
  })

  test('缺少执行器时保持已批准状态并明确报错，不退回模拟成功', async () => {
    const action = await approvedAction()
    const error: Error = await executeControlledAction(action.id).then(
      () => { throw new Error('预期执行失败') },
      (caught: Error) => caught,
    )
    expect(error.message).toContain('尚未可用的执行器')
    const reloaded = (await listControlledActions())[0]
    expect(reloaded?.status).toBe('approved')
    expect(reloaded?.attempts).toBe(0)
    expect(reloaded?.receipt).toBeUndefined()
    expect(getClaimedActionCount()).toBe(0)
  })

  test('已拒绝的请求不能执行', async () => {
    fakeExecutor()
    const action = await requestControlledAction({ kind: 'publish', platform: 'wechat-official-account', targetId: 'draft-1', summary: '被拒绝' })
    await rejectControlledAction(action.id, 'Carol', '文案需要复核')
    await expect(executeControlledAction(action.id)).rejects.toThrow('已拒绝的请求不能执行')
  })

  test('模拟路径与真实执行路径互斥', async () => {
    fakeExecutor()
    const simulated = await approvedAction()
    await simulateControlledAction(simulated.id)
    await expect(executeControlledAction(simulated.id)).rejects.toThrow('已走本地模拟路径')

    const live = await approvedAction()
    await executeControlledAction(live.id)
    await expect(simulateControlledAction(live.id)).rejects.toThrow('尚未批准')
  })
})

describe('P2-06 单次授权', () => {
  test('执行成功后同一审批不能重复执行', async () => {
    const executor = fakeExecutor()
    const action = await approvedAction()
    const executed = await executeControlledAction(action.id)

    expect(executor.calls).toHaveLength(1)
    expect(executed.status).toBe('executed')
    expect(executed.executionMode).toBe('live')
    expect(executed.receipt?.externalId).toBe('PUBLISH-1')
    expect(executed.receipt?.platformStatus).toBe('publishing')
    expect(executed.attempts).toBe(1)
    expect(executed.executedAt).toBeDefined()

    await expect(executeControlledAction(action.id)).rejects.toThrow('已执行完成')
    expect(executor.calls).toHaveLength(1)
  })

  test('并发执行只有一个能取得执行权', async () => {
    const executor = fakeExecutor()
    const action = await approvedAction()
    const results = await Promise.allSettled([
      executeControlledAction(action.id),
      executeControlledAction(action.id),
      executeControlledAction(action.id),
    ])
    const fulfilled = results.filter((item) => item.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1)
    expect(executor.calls).toHaveLength(1)
    expect((await listControlledActions())[0]?.attempts).toBe(1)
    expect(getClaimedActionCount()).toBe(0)
  })

  test('审计完整记录申请、批准、执行声明与平台回执', async () => {
    fakeExecutor()
    const action = await approvedAction()
    await executeControlledAction(action.id)
    const audit = await getControlledActionAudit(action.id)
    expect(audit.map((entry) => entry.event)).toEqual(['requested', 'approved', 'executing', 'executed'])
    expect(audit.at(-1)?.detail).toContain('PUBLISH-1'.slice(0, 0) || '平台执行器返回结果')
    expect(audit[2]?.detail).toContain('单次执行权')
    // 审计不含摘要以外的敏感内容
    expect(JSON.stringify(audit)).not.toContain('access_token')
  })
})

describe('P2-06 失败分类与重试边界', () => {
  test('结果未知的失败禁止直接重试，必须先对账', async () => {
    const executor = fakeExecutor()
    const action = await approvedAction()
    executor.setBehavior(async () => { throw new ControlledExecutionError('unknown', 'network_timeout', '请求已发出但未收到确认') })

    await expect(executeControlledAction(action.id)).rejects.toThrow('请求已发出但未收到确认')
    const failed = (await listControlledActions())[0]
    expect(failed?.status).toBe('failed')
    expect(failed?.failureOutcome).toBe('unknown')
    expect(failed?.retryRequiresReconciliation).toBe(true)
    expect(failed?.attempts).toBe(1)

    await expect(retryControlledExecution(action.id)).rejects.toThrow('请先对账确认后再重试')
    expect(executor.calls).toHaveLength(1)

    // 对账确认平台未接收 → 允许重试
    await reconcileControlledExecution(action.id, { actor: 'Carol', platformAccepted: false, note: '平台后台未找到该次发布' })
    executor.setBehavior(async () => ({ platform: 'wechat-official-account', externalId: 'PUBLISH-2', platformStatus: 'publishing', summary: '重试已提交', receivedAt: 2_000 }))
    const retried = await retryControlledExecution(action.id, 'Carol')
    expect(retried.status).toBe('executed')
    expect(retried.attempts).toBe(2)
    expect(executor.calls).toHaveLength(2)
  })

  test('对账确认平台已接收时直接判定为已完成', async () => {
    const executor = fakeExecutor()
    const action = await approvedAction()
    executor.setBehavior(async () => { throw new ControlledExecutionError('unknown', 'network_timeout', '超时') })
    await executeControlledAction(action.id).catch(() => undefined)

    const reconciled = await reconcileControlledExecution(action.id, { actor: 'Carol', platformAccepted: true, note: '平台后台已看到发布中' })
    expect(reconciled.status).toBe('executed')
    expect(reconciled.receipt?.platformStatus).toBe('accepted_by_platform')
    expect(reconciled.reconciledBy).toBe('Carol')

    await expect(executeControlledAction(action.id)).rejects.toThrow('已执行完成')
    expect(executor.calls).toHaveLength(1)
    const audit = await getControlledActionAudit(action.id)
    expect(audit.map((entry) => entry.event)).toContain('execution_reconciled')
  })

  test('明确未开始或平台明确拒绝的失败可直接重试', async () => {
    const executor = fakeExecutor()
    const notStarted = await approvedAction()
    executor.setBehavior(async () => { throw new ControlledExecutionError('not_started', 'precheck_failed', '本地预检未通过') })
    await expect(executeControlledAction(notStarted.id)).rejects.toThrow('本地预检未通过')
    const failedNotStarted = (await listControlledActions()).find((item) => item.id === notStarted.id)
    expect(failedNotStarted?.retryRequiresReconciliation).toBe(false)
    executor.setBehavior(async () => ({ platform: 'wechat-official-account', externalId: 'PUBLISH-3', summary: '已提交', receivedAt: 3_000 }))
    expect((await retryControlledExecution(notStarted.id)).status).toBe('executed')

    const rejected = await approvedAction()
    executor.setBehavior(async () => { throw new ControlledExecutionError('confirmed_failure', 'platform_rejected', '平台审核拒绝') })
    await expect(executeControlledAction(rejected.id)).rejects.toThrow('平台审核拒绝')
    expect((await listControlledActions()).find((item) => item.id === rejected.id)?.retryRequiresReconciliation).toBe(false)
  })

  test('非受控异常按结果未知处理，避免盲目重试', async () => {
    const executor = fakeExecutor()
    const action = await approvedAction()
    executor.setBehavior(async () => { throw new Error('未预期的内部错误') })
    await expect(executeControlledAction(action.id)).rejects.toThrow('未预期的内部错误')
    const failed = (await listControlledActions())[0]
    expect(failed?.failureOutcome).toBe('unknown')
    expect(failed?.failureCode).toBe('unexpected_error')
    expect(failed?.retryRequiresReconciliation).toBe(true)
  })

  test('只有失败的请求可以重试与对账', async () => {
    fakeExecutor()
    const action = await approvedAction()
    await expect(retryControlledExecution(action.id)).rejects.toThrow('只有失败的请求可以重试')
    await expect(reconcileControlledExecution(action.id, { actor: 'Carol', platformAccepted: true, note: 'x' })).rejects.toThrow('只有失败的请求需要对账')
  })
})
