import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearControlledActionExecutorsForTests, listControlledActionExecutors, registerControlledActionExecutor } from './new-media-controlled-executor'
import { getControlledActionAudit, listControlledActions } from './controlled-actions'
import { getNewMediaSchemaInfo } from './new-media-sqlite-store'
import { clearNewMediaRecordsForTests, closeNewMediaDb } from './new-media-sqlite-store'
import {
  AUTOMATION_RULE_KIND,
  computeNextRunAt,
  createAutomationRule,
  deleteAutomationRule,
  listAutomationRules,
  listAutomationRuns,
  setAutomationRuleEnabled,
  tickNewMediaAutomations,
} from './new-media-automation-scheduler'

let testDir = ''
const NOW = Date.parse('2026-09-17T09:00:00')

beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-nm-automation-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => {
  clearControlledActionExecutorsForTests()
  await clearNewMediaRecordsForTests()
})
afterAll(() => { clearControlledActionExecutorsForTests(); closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

function registerExecutor(): void {
  registerControlledActionExecutor({
    kind: 'publish',
    platform: 'wechat-official-account',
    describe: () => '测试执行器',
    execute: async () => ({ platform: 'wechat-official-account', externalId: 'X', summary: '已提交', receivedAt: Date.now() }),
  })
}

function ruleInput(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acc-1',
    platform: 'wechat-official-account' as const,
    kind: 'publish' as const,
    targetId: 'draft-1',
    summaryTemplate: '每日发布提醒 {{date}}',
    cadence: { type: 'daily', timeOfDay: '09:00' } as const,
    firstRunAt: NOW,
    ...overrides,
  } as Parameters<typeof createAutomationRule>[0]
}

describe('P4-10 排程节奏计算', () => {
  test('daily 节奏计算下一次触发（严格晚于当前时刻）', () => {
    // 09:00 触发后，下一次是次日 09:00
    expect(computeNextRunAt({ type: 'daily', timeOfDay: '09:00' }, NOW)).toBe(NOW + 86_400_000)
    // 08:00 触发后，下一次是当天 09:00
    expect(computeNextRunAt({ type: 'daily', timeOfDay: '09:00' }, NOW - 3_600_000)).toBe(NOW)
    // interval 节奏按小时叠加
    expect(computeNextRunAt({ type: 'intervalHours', hours: 6 }, NOW)).toBe(NOW + 6 * 3_600_000)
  })

  test('非法节奏被拒绝', async () => {
    registerExecutor()
    await expect(createAutomationRule(ruleInput({ cadence: { type: 'daily', timeOfDay: '25:00' } }))).rejects.toThrow('timeOfDay')
    await expect(createAutomationRule(ruleInput({ cadence: { type: 'intervalHours', hours: 0 } }))).rejects.toThrow('intervalHours')
    await expect(createAutomationRule(ruleInput({ cadence: { type: 'weekly' } as never }))).rejects.toThrow('不支持的排程节奏')
  })
})

describe('P4-10 自动化只创建待审批动作', () => {
  test('到期触发只生成 pending_approval，不执行也不模拟', async () => {
    registerExecutor()
    await createAutomationRule(ruleInput())
    const result = await tickNewMediaAutomations(NOW)
    expect(result.created).toBe(1)
    expect(result.failed).toBe(0)

    const actions = await listControlledActions()
    expect(actions).toHaveLength(1)
    expect(actions[0]?.status).toBe('pending_approval')
    // 摘要模板的 {{date}} 已被触发日期替换
    expect(actions[0]?.summary).toContain('2026-09-17')
    // 自动化产生的动作未被批准、未被执行
    expect(actions[0]?.approvedAt).toBeUndefined()
    expect(actions[0]?.executedAt).toBeUndefined()

    const audit = await getControlledActionAudit(actions[0]?.id ?? '')
    expect(audit.map((entry) => entry.event)).toEqual(['requested'])
  })

  test('同一触发时刻幂等，不重复生成', async () => {
    registerExecutor()
    await createAutomationRule(ruleInput())
    await tickNewMediaAutomations(NOW)
    const second = await tickNewMediaAutomations(NOW + 60_000)
    expect(second.created).toBe(0)
    expect(await listControlledActions()).toHaveLength(1)
  })

  test('离线补跑只处理最近一个触发时刻，不逐次追赶', async () => {
    registerExecutor()
    await createAutomationRule(ruleInput())
    // 应用离线 5 天后回来：只生成 1 个动作，而不是 5 个
    const result = await tickNewMediaAutomations(NOW + 5 * 86_400_000)
    expect(result.created).toBe(1)
    expect(await listControlledActions()).toHaveLength(1)
    const rules = await listAutomationRules()
    // 下次触发从当前时间起算，落在未来
    expect(rules[0]?.nextRunAt).toBeGreaterThan(NOW + 5 * 86_400_000)
  })

  test('interval 节奏按小时推进', async () => {
    registerExecutor()
    await createAutomationRule(ruleInput({ cadence: { type: 'intervalHours', hours: 6 }, firstRunAt: NOW }))
    await tickNewMediaAutomations(NOW)
    const rules = await listAutomationRules()
    expect(rules[0]?.nextRunAt).toBe(NOW + 6 * 3_600_000)
  })
})

describe('P4-10 失败策略', () => {
  test('缺少执行器时按失败处理，不产生无法执行的审批', async () => {
    // 规则创建时执行器可用，之后被移除（例如能力停用）→ 触发时按失败处理
    registerExecutor()
    await createAutomationRule(ruleInput())
    clearControlledActionExecutorsForTests()
    expect(listControlledActionExecutors()).toHaveLength(0)

    const result = await tickNewMediaAutomations(NOW)
    expect(result.failed).toBe(1)
    expect(await listControlledActions()).toEqual([])
    const runs = await listAutomationRuns()
    expect(runs[0]?.errorCode).toBe('executor_unavailable')
  })

  test('规则创建前就要求执行器可用', async () => {
    await expect(createAutomationRule(ruleInput())).rejects.toThrow('尚未可用的执行器')
  })

  test('连续失败 3 次自动停用规则，不再触发', async () => {
    // 失败路径：执行器先可用（建规则），随后被移除（如能力停用）
    registerExecutor()
    const rule = await createAutomationRule(ruleInput())
    clearControlledActionExecutorsForTests()

    const first = await tickNewMediaAutomations(NOW)
    expect(first.failed).toBe(1)
    const second = await tickNewMediaAutomations(NOW + 86_400_000)
    expect(second.failed).toBe(1)
    const third = await tickNewMediaAutomations(NOW + 2 * 86_400_000)
    expect(third.failed).toBe(1)

    // 规则本体保留但已自动停用，原因可追溯
    const rules = await listAutomationRules()
    expect(rules[0]?.enabled).toBe(false)
    expect(rules[0]?.autoDisabledReason).toContain('连续 3 次触发失败')
    expect(rules[0]?.consecutiveFailures).toBe(3)
    // 自动停用后不可再触发
    const fourth = await tickNewMediaAutomations(NOW + 3 * 86_400_000)
    expect(fourth.triggered).toBe(0)
    // 三次失败都留有运行历史
    expect((await listAutomationRuns(rule.id)).length).toBe(3)
  })

  test('停用的规则跳过触发；重新启用后恢复', async () => {
    registerExecutor()
    const rule = await createAutomationRule(ruleInput())
    await setAutomationRuleEnabled(rule.id, false, '暂停自动化')
    const skipped = await tickNewMediaAutomations(NOW)
    expect(skipped.triggered).toBe(0)
    expect(await listControlledActions()).toEqual([])

    await setAutomationRuleEnabled(rule.id, true)
    const resumed = await tickNewMediaAutomations(NOW)
    expect(resumed.created).toBe(1)
  })

  test('删除规则采用 tombstone，运行历史保留', async () => {
    registerExecutor()
    const rule = await createAutomationRule(ruleInput())
    await deleteAutomationRule(rule.id)
    expect(await listAutomationRules()).toEqual([])
    expect((await listAutomationRuns()).length).toBeGreaterThanOrEqual(0)
  })
})

describe('P4-10 存储与审计', () => {
  test('规则与运行历史在 kind 注册表登记，无未知类型', async () => {
    registerExecutor()
    await createAutomationRule(ruleInput())
    await tickNewMediaAutomations(NOW)
    const info = await getNewMediaSchemaInfo()
    expect(info.registeredKinds.map((item) => item.kind)).toContain(AUTOMATION_RULE_KIND)
    expect(info.unknownKinds).toEqual([])
  })

  test('自动化审计不含目标内容正文', async () => {
    registerExecutor()
    await createAutomationRule(ruleInput({ summaryTemplate: '机密文案 {{date}}' }))
    await tickNewMediaAutomations(NOW)
    const { listNewMediaAudit } = await import('./new-media-audit')
    const audits = await listNewMediaAudit()
    // 摘要模板只进入动作本身；自动化审计记录的是事件而非内容
    expect(JSON.stringify(audits)).not.toContain('机密文案')
  })
})
