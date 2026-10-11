import { describe, expect, test } from 'bun:test'
import { AGENT_RUNTIME_CAPABILITIES } from './agent'
import {
  DEFAULT_HARNESS_POLICY,
  HarnessPolicyError,
  assertPolicyTightensOnly,
  assertRuntimeSatisfiesPolicy,
  parseHarnessPolicy,
  requiredGuaranteeGaps,
  type HarnessPolicy,
} from './harness-policy'

const clone = (policy: HarnessPolicy): HarnessPolicy => JSON.parse(JSON.stringify(policy)) as HarnessPolicy

describe('Harness 策略解析（P01）', () => {
  test('合法策略解析成功；缺省值独立成对象', () => {
    const parsed = parseHarnessPolicy({ policyVersion: 1, revision: 3, guarantees: { budgetStop: 'required', toolScheduling: 'preferred', planWriteScope: 'off' } })
    expect(parsed.revision).toBe(3)
    expect(parsed.guarantees.budgetStop).toBe('required')
    expect(DEFAULT_HARNESS_POLICY.guarantees.planWriteScope).toBe('required')
  })
  test('未知字段/非法强度/非法 revision/版本不符一律拒绝', () => {
    expect(() => parseHarnessPolicy(null)).toThrow(HarnessPolicyError)
    expect(() => parseHarnessPolicy({ policyVersion: 2, revision: 1, guarantees: { budgetStop: 'off', toolScheduling: 'off', planWriteScope: 'off' } })).toThrow(/policyVersion/)
    expect(() => parseHarnessPolicy({ policyVersion: 1, revision: 1, extra: true, guarantees: { budgetStop: 'off', toolScheduling: 'off', planWriteScope: 'off' } })).toThrow(/未知字段: extra/)
    expect(() => parseHarnessPolicy({ policyVersion: 1, revision: 1, guarantees: { budgetStop: 'off', toolScheduling: 'off', planWriteScope: 'off', mystery: 'off' } })).toThrow(/guarantees 未知字段/)
    expect(() => parseHarnessPolicy({ policyVersion: 1, revision: 0, guarantees: { budgetStop: 'off', toolScheduling: 'off', planWriteScope: 'off' } })).toThrow(/revision/)
    expect(() => parseHarnessPolicy({ policyVersion: 1, revision: 1, guarantees: { budgetStop: 'maybe', toolScheduling: 'off', planWriteScope: 'off' } })).toThrow(/budgetStop/)
    expect(() => parseHarnessPolicy({ policyVersion: 1, revision: 1, guarantees: { budgetStop: 'off', toolScheduling: 'off' } })).toThrow(/planWriteScope/)
  })
})

describe('策略只能收紧', () => {
  test('强度提升与持平通过；放宽或 revision 不递增拒绝', () => {
    const prev = clone(DEFAULT_HARNESS_POLICY)
    const tighter = clone(prev)
    tighter.revision = 2
    tighter.guarantees.budgetStop = 'required'
    expect(() => assertPolicyTightensOnly(prev, tighter)).not.toThrow()
    const looser = clone(tighter)
    looser.revision = 3
    looser.guarantees.budgetStop = 'preferred'
    expect(() => assertPolicyTightensOnly(tighter, looser)).toThrow(/不得放宽/)
    const sameRevision = clone(tighter)
    expect(() => assertPolicyTightensOnly(tighter, sameRevision)).toThrow(/单调递增/)
  })
})

describe('Provider 前拒绝（required 保证能力映射）', () => {
  test('ai-sdk 满足默认策略；required budgetStop 在 proma 上产生缺口', () => {
    expect(requiredGuaranteeGaps(AGENT_RUNTIME_CAPABILITIES['ai-sdk'], DEFAULT_HARNESS_POLICY)).toEqual([])
    expect(() => assertRuntimeSatisfiesPolicy('ai-sdk', AGENT_RUNTIME_CAPABILITIES['ai-sdk'], DEFAULT_HARNESS_POLICY)).not.toThrow()
    const policy = clone(DEFAULT_HARNESS_POLICY)
    policy.guarantees.budgetStop = 'required'
    expect(requiredGuaranteeGaps(AGENT_RUNTIME_CAPABILITIES.proma, policy)).toEqual(['budgetStop'])
    expect(() => assertRuntimeSatisfiesPolicy('proma', AGENT_RUNTIME_CAPABILITIES.proma, policy)).toThrow(/费用超额停止/)
  })
  test('required toolScheduling 在 claude 上拒绝（SDK 子进程不在本进程锁域）', () => {
    const policy = clone(DEFAULT_HARNESS_POLICY)
    policy.guarantees.toolScheduling = 'required'
    expect(requiredGuaranteeGaps(AGENT_RUNTIME_CAPABILITIES.claude, policy)).toEqual(['toolScheduling'])
    expect(requiredGuaranteeGaps(AGENT_RUNTIME_CAPABILITIES.pi, policy)).toEqual([])
  })
  test('preferred 保证不产生缺口', () => {
    const policy = clone(DEFAULT_HARNESS_POLICY)
    policy.guarantees.budgetStop = 'preferred'
    policy.guarantees.toolScheduling = 'preferred'
    policy.guarantees.planWriteScope = 'preferred'
    for (const runtime of Object.keys(AGENT_RUNTIME_CAPABILITIES) as Array<keyof typeof AGENT_RUNTIME_CAPABILITIES>) {
      expect(requiredGuaranteeGaps(AGENT_RUNTIME_CAPABILITIES[runtime], policy)).toEqual([])
    }
  })
})
