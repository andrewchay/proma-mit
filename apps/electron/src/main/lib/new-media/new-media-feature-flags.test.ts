import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listNewMediaAudit } from './new-media-audit'
import {
  approveControlledAction,
  executeControlledAction,
  listControlledActions,
  requestControlledAction,
  resetControlledActionsForTests,
} from './controlled-actions'
import {
  clearControlledActionExecutorsForTests,
  registerControlledActionExecutor,
} from './new-media-controlled-executor'
import {
  evaluateCapabilityFlag,
  getCachedCapabilityFlags,
  isCapabilityActive,
  listCapabilityFlagHistory,
  listCapabilityFlags,
  restoreCapabilityFlag,
  setCapabilityFlag,
} from './new-media-feature-flags'
import { clearNewMediaRecordsForTests, closeNewMediaDb } from './new-media-sqlite-store'

let testDir = ''
beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-nm-flags-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { clearControlledActionExecutorsForTests(); await clearNewMediaRecordsForTests() })
afterAll(() => { clearControlledActionExecutorsForTests(); closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

describe('P4-13 能力开关判定', () => {
  test('无覆盖时默认启用', () => {
    const decision = evaluateCapabilityFlag({ capability: 'controlled-outbound', platform: 'wechat-official-account', accountId: 'acc-1' }, [])
    expect(decision.active).toBe(true)
    expect(decision.reason).toContain('默认启用')
  })

  test('平台级 kill switch 关闭后该平台全部账号不可用', async () => {
    await setCapabilityFlag({ capability: 'controlled-outbound', platform: 'wechat-official-account', stage: 'off', note: '发布链路故障', updatedBy: 'Carol' })
    const decision = evaluateCapabilityFlag({ capability: 'controlled-outbound', platform: 'wechat-official-account', accountId: 'acc-1' }, await listCapabilityFlags())
    expect(decision.active).toBe(false)
    expect(decision.reason).toContain('发布链路故障')
    // 其它平台不受影响
    expect(isCapabilityActive({ capability: 'controlled-outbound', platform: 'xiaohongshu', accountId: 'acc-1' }, await listCapabilityFlags())).toBe(true)
  })

  test('账号级覆盖优先于平台级', async () => {
    await setCapabilityFlag({ capability: 'controlled-outbound', platform: 'wechat-official-account', stage: 'off', updatedBy: 'Carol' })
    // 平台级关闭，但给灰度账号单独放行
    await setCapabilityFlag({ capability: 'controlled-outbound', platform: 'wechat-official-account', accountId: 'acc-pilot', stage: 'all', updatedBy: 'Carol' })
    const flags = await listCapabilityFlags()
    expect(isCapabilityActive({ capability: 'controlled-outbound', platform: 'wechat-official-account', accountId: 'acc-pilot' }, flags)).toBe(true)
    expect(isCapabilityActive({ capability: 'controlled-outbound', platform: 'wechat-official-account', accountId: 'acc-normal' }, flags)).toBe(false)
  })

  test('allowlist 阶段仅名单内账号可用，空名单被拒绝', async () => {
    await expect(setCapabilityFlag({ capability: 'content-operations', stage: 'allowlist', allowlist: [], updatedBy: 'Carol' })).rejects.toThrow('allowlist 阶段必须提供至少一个账号')
    await setCapabilityFlag({ capability: 'content-operations', stage: 'allowlist', allowlist: ['acc-a', 'acc-b'], updatedBy: 'Carol' })
    const flags = await listCapabilityFlags()
    expect(isCapabilityActive({ capability: 'content-operations', accountId: 'acc-a' }, flags)).toBe(true)
    expect(isCapabilityActive({ capability: 'content-operations', accountId: 'acc-c' }, flags)).toBe(false)
  })
})

describe('P4-13 回滚与审计保留', () => {
  test('恢复能力回到默认启用，历史记录与审计不删除', async () => {
    await setCapabilityFlag({ capability: 'trend-radar', platform: 'xiaohongshu', stage: 'off', note: '数据源异常', updatedBy: 'Carol' })
    const restored = await restoreCapabilityFlag({ capability: 'trend-radar', platform: 'xiaohongshu', updatedBy: 'Carol' })
    expect(restored.removed).toBe(true)
    expect(isCapabilityActive({ capability: 'trend-radar', platform: 'xiaohongshu', accountId: 'acc-1' }, await listCapabilityFlags())).toBe(true)

    // 历史记录保留（tombstone），审计事件完整
    const history = await listCapabilityFlagHistory()
    expect(history.filter((flag) => flag.capability === 'trend-radar').length).toBeGreaterThanOrEqual(1)
    const audits = await listNewMediaAudit()
    const flagAudits = audits.filter((entry) => entry.detail.includes('能力开关变更') || entry.detail.includes('能力恢复'))
    expect(flagAudits.length).toBe(2)
  })

  test('恢复不存在的开关是无操作', async () => {
    expect(await restoreCapabilityFlag({ capability: 'nonexistent', updatedBy: 'Carol' })).toEqual({ removed: false })
  })

  test('插件同步读取开关快照（工具注入路径）', async () => {
    await setCapabilityFlag({ capability: 'trend-radar', stage: 'off', updatedBy: 'Carol' })
    // 快照在变更时刷新，插件可同步读取
    const cached = getCachedCapabilityFlags()
    expect(cached.length).toBeGreaterThan(0)
    expect(isCapabilityActive({ capability: 'trend-radar' }, cached)).toBe(false)
  })
})

describe('P4-13 执行门控联动', () => {
  test('外发能力被关闭时拒绝执行，动作保持原状态', async () => {
    registerControlledActionExecutor({
      kind: 'publish',
      platform: 'wechat-official-account',
      describe: () => '测试执行器',
      execute: async () => ({ platform: 'wechat-official-account', externalId: 'X', summary: '已提交', receivedAt: 1 }),
    })
    const action = await requestControlledAction({ kind: 'publish', platform: 'wechat-official-account', targetId: 'draft-1', accountId: 'acc-1', summary: '待发布' })
    await approveControlledAction(action.id)
    await setCapabilityFlag({ capability: 'controlled-outbound', platform: 'wechat-official-account', stage: 'off', note: '平台故障回滚', updatedBy: 'Carol' })

    const error: Error = await executeControlledAction(action.id).then(
      () => { throw new Error('预期执行被开关拒绝') },
      (caught: Error) => caught,
    )
    expect(error.message).toContain('外发能力当前已被关闭')
    expect(error.message).toContain('平台故障回滚')

    // 动作保持 approved，开关恢复后可执行
    const actions = await listControlledActions()
    expect(actions[0]?.status).toBe('approved')
    await restoreCapabilityFlag({ capability: 'controlled-outbound', platform: 'wechat-official-account', updatedBy: 'Carol' })
    const executed = await executeControlledAction(action.id)
    expect(executed.status).toBe('executed')
  })
})
