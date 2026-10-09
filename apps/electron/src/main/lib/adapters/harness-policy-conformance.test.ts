/**
 * P03 跨 Runtime 策略一致性矩阵：claude/pi/ai-sdk/proma 逐项填写
 * support/unsupported/retired；不为测试恢复 retired runtime。
 * 矩阵即声明：任何能力翻转都必须同步修改本表，否则测试失败。
 */
import { describe, expect, test } from 'bun:test'
import {
  AGENT_RUNTIME_CAPABILITIES,
  DEFAULT_HARNESS_POLICY,
  HarnessPolicyError,
  assertRuntimeSatisfiesPolicy,
  isRetiredAgentRuntime,
  requiredGuaranteeGaps,
  type AgentRuntime,
  type HarnessPolicy,
} from '@gravitas/shared'
import { resolveRuntimeBudgetLimitUsd } from '../project-pilot-runtime-budget'

const RUNTIMES: AgentRuntime[] = ['claude', 'proma', 'pi', 'ai-sdk']

interface ConformanceRow {
  readonly retired: boolean
  readonly budgetStop: boolean
  readonly inProcessToolScheduling: boolean
  readonly planWriteScope: boolean
}

/** 一致性矩阵（声明式事实表，改能力必须改这里并说明理由） */
const MATRIX: Record<AgentRuntime, ConformanceRow> = {
  claude: { retired: true, budgetStop: true, inProcessToolScheduling: false, planWriteScope: true },
  proma: { retired: true, budgetStop: false, inProcessToolScheduling: true, planWriteScope: true },
  pi: { retired: false, budgetStop: false, inProcessToolScheduling: true, planWriteScope: true },
  'ai-sdk': { retired: false, budgetStop: true, inProcessToolScheduling: true, planWriteScope: true },
}

const policyWith = (overrides: Partial<HarnessPolicy['guarantees']>): HarnessPolicy => ({
  ...DEFAULT_HARNESS_POLICY,
  revision: DEFAULT_HARNESS_POLICY.revision + 1,
  guarantees: { ...DEFAULT_HARNESS_POLICY.guarantees, ...overrides },
})

describe('P03 Runtime 一致性矩阵', () => {
  test('能力声明与矩阵一致；retired 状态一致', () => {
    for (const runtime of RUNTIMES) {
      const caps = AGENT_RUNTIME_CAPABILITIES[runtime]
      const row = MATRIX[runtime]
      expect(caps.supportsBudgetStopThreshold, `${runtime}.budgetStop`).toBe(row.budgetStop)
      expect(caps.supportsInProcessToolScheduling, `${runtime}.toolScheduling`).toBe(row.inProcessToolScheduling)
      expect(caps.supportsPlanMode, `${runtime}.planWriteScope`).toBe(row.planWriteScope)
      expect(isRetiredAgentRuntime(runtime), `${runtime}.retired`).toBe(row.retired)
    }
  })
  test('默认策略在全部 runtime 上无缺口', () => {
    for (const runtime of RUNTIMES) {
      expect(requiredGuaranteeGaps(AGENT_RUNTIME_CAPABILITIES[runtime], DEFAULT_HARNESS_POLICY), runtime).toEqual([])
    }
  })
  test('required budgetStop：proma/pi 拒绝，claude/ai-sdk 通过', () => {
    const policy = policyWith({ budgetStop: 'required' })
    for (const runtime of RUNTIMES) {
      const caps = AGENT_RUNTIME_CAPABILITIES[runtime]
      if (MATRIX[runtime].budgetStop) {
        expect(() => assertRuntimeSatisfiesPolicy(runtime, caps, policy), runtime).not.toThrow()
      } else {
        expect(() => assertRuntimeSatisfiesPolicy(runtime, caps, policy), runtime).toThrow(HarnessPolicyError)
      }
    }
  })
  test('required toolScheduling：claude 拒绝（SDK 子进程不在锁域），其余通过', () => {
    const policy = policyWith({ toolScheduling: 'required' })
    for (const runtime of RUNTIMES) {
      const caps = AGENT_RUNTIME_CAPABILITIES[runtime]
      if (MATRIX[runtime].inProcessToolScheduling) {
        expect(() => assertRuntimeSatisfiesPolicy(runtime, caps, policy), runtime).not.toThrow()
      } else {
        expect(() => assertRuntimeSatisfiesPolicy(runtime, caps, policy), runtime).toThrow(HarnessPolicyError)
      }
    }
  })
})

describe('P03 撤权/预算/取消一致性（共享层语义与 runtime 无关）', () => {
  test('预算阈值合并语义跨 runtime 一致：不支持→拒绝；支持→取更严格值', () => {
    for (const runtime of RUNTIMES) {
      if (!MATRIX[runtime].budgetStop) {
        expect(() => resolveRuntimeBudgetLimitUsd(runtime, 5, undefined), runtime).toThrow(/不支持调用级费用超额停止阈值/)
        expect(resolveRuntimeBudgetLimitUsd(runtime, undefined, 5), runtime).toBeUndefined()
      } else {
        expect(resolveRuntimeBudgetLimitUsd(runtime, 5, undefined), runtime).toBe(5)
        expect(resolveRuntimeBudgetLimitUsd(runtime, 5, 3), runtime).toBe(3)
        expect(resolveRuntimeBudgetLimitUsd(runtime, 2, 5), runtime).toBe(2)
      }
    }
  })
  test('retired runtime 不为一致性测试恢复：仅做数据级断言，不构造会话', () => {
    // 本测试只读取能力表与纯函数；claude/proma 的任何运行级验收需独立批准。
    expect(MATRIX.claude.retired).toBe(true)
    expect(MATRIX.proma.retired).toBe(true)
  })
})
