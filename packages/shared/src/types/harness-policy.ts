/**
 * Harness 策略（P01）：版本化配置 + 保证强度 + 只收紧约束。
 *
 * 硬底线（权限硬拒绝、Web Bridge 逐次确认、Pilot fail-closed）是代码常量，
 * 不在策略内——策略任何取值都不可能放宽它们；策略只在其自身保证集合上
 * 单调收紧（off → preferred → required），revision 单调递增。
 */

import type { AgentRuntime, AgentRuntimeCapabilities } from './agent'

export type GuaranteeStrength = 'off' | 'preferred' | 'required'

export const GUARANTEE_STRENGTH_RANK: Record<GuaranteeStrength, number> = {
  off: 0,
  preferred: 1,
  required: 2,
}

export interface HarnessGuarantees {
  /** 调用级费用超额停止阈值（超额后停止，不保证最终费用绝不超阈值） */
  budgetStop: GuaranteeStrength
  /** 本进程内工具调度冲突串行化（锁域=本进程，不宣称跨进程安全） */
  toolScheduling: GuaranteeStrength
  /** Plan 模式写范围限制（只允许既有 plan 写范围） */
  planWriteScope: GuaranteeStrength
}

export const HARNESS_GUARANTEE_KEYS = ['budgetStop', 'toolScheduling', 'planWriteScope'] as const
export type HarnessGuaranteeKey = (typeof HARNESS_GUARANTEE_KEYS)[number]

export const HARNESS_GUARANTEE_LABELS: Record<HarnessGuaranteeKey, string> = {
  budgetStop: '调用级费用超额停止',
  toolScheduling: '进程内工具调度串行化',
  planWriteScope: 'Plan 模式写范围',
}

export interface HarnessPolicy {
  policyVersion: 1
  /** 单调递增的修订号 */
  revision: number
  guarantees: HarnessGuarantees
}

export class HarnessPolicyError extends Error {
  constructor(
    message: string,
    readonly reasons: readonly string[],
  ) {
    super(message)
    this.name = 'HarnessPolicyError'
  }
}

/** 默认策略：不引入新拒绝面；plan 写范围是既有行为，required 只是把它固化为底线。 */
export const DEFAULT_HARNESS_POLICY: HarnessPolicy = {
  policyVersion: 1,
  revision: 1,
  guarantees: {
    budgetStop: 'off',
    toolScheduling: 'preferred',
    planWriteScope: 'required',
  },
}

const VALID_STRENGTHS = new Set<GuaranteeStrength>(['off', 'preferred', 'required'])

/**
 * 严格解析：版本不符、字段缺失/多余、强度非法、revision 非法都拒绝。
 * 未知字段一律拒绝——调用方必须保留原件并拒绝受控运行，不得静默忽略。
 */
export function parseHarnessPolicy(raw: unknown): HarnessPolicy {
  const reasons: string[] = []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HarnessPolicyError('Harness 策略必须是对象', ['策略必须是对象'])
  }
  const record = raw as Record<string, unknown>
  const allowedTopKeys = new Set(['policyVersion', 'revision', 'guarantees'])
  for (const key of Object.keys(record)) {
    if (!allowedTopKeys.has(key)) reasons.push(`未知字段: ${key}`)
  }
  if (record.policyVersion !== 1) reasons.push(`policyVersion 不支持: ${String(record.policyVersion)}`)
  if (typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 1) {
    reasons.push('revision 必须为不小于 1 的整数')
  }
  const guarantees = record.guarantees
  if (typeof guarantees !== 'object' || guarantees === null || Array.isArray(guarantees)) {
    reasons.push('guarantees 必须是对象')
  } else {
    const g = guarantees as Record<string, unknown>
    for (const key of Object.keys(g)) {
      if (!(HARNESS_GUARANTEE_KEYS as readonly string[]).includes(key)) reasons.push(`guarantees 未知字段: ${key}`)
    }
    for (const key of HARNESS_GUARANTEE_KEYS) {
      const value = g[key]
      if (typeof value !== 'string' || !VALID_STRENGTHS.has(value as GuaranteeStrength)) {
        reasons.push(`guarantees.${key} 必须是 off|preferred|required`)
      }
    }
  }
  if (reasons.length > 0) throw new HarnessPolicyError(`Harness 策略无效: ${reasons.join('；')}`, reasons)
  const g = guarantees as Record<string, unknown>
  return {
    policyVersion: 1,
    revision: record.revision as number,
    guarantees: {
      budgetStop: g.budgetStop as GuaranteeStrength,
      toolScheduling: g.toolScheduling as GuaranteeStrength,
      planWriteScope: g.planWriteScope as GuaranteeStrength,
    },
  }
}

/** 策略只能收紧：revision 必须递增，每项保证强度不得下降。 */
export function assertPolicyTightensOnly(prev: HarnessPolicy, next: HarnessPolicy): void {
  if (next.revision <= prev.revision) {
    throw new HarnessPolicyError('策略 revision 必须单调递增', [`revision ${prev.revision} -> ${next.revision}`])
  }
  const reasons: string[] = []
  for (const key of HARNESS_GUARANTEE_KEYS) {
    if (GUARANTEE_STRENGTH_RANK[next.guarantees[key]] < GUARANTEE_STRENGTH_RANK[prev.guarantees[key]]) {
      reasons.push(`${key} 不得放宽（${prev.guarantees[key]} -> ${next.guarantees[key]}）`)
    }
  }
  if (reasons.length > 0) throw new HarnessPolicyError(`策略不允许放宽: ${reasons.join('；')}`, reasons)
}

/** required 保证与 Runtime 能力的映射；新保证必须在此登记，否则视同不支持。 */
const GUARANTEE_CAPABILITY_CHECKS: Record<HarnessGuaranteeKey, (caps: AgentRuntimeCapabilities) => boolean> = {
  budgetStop: (caps) => caps.supportsBudgetStopThreshold,
  toolScheduling: (caps) => caps.supportsInProcessToolScheduling,
  planWriteScope: (caps) => caps.supportsPlanMode,
}

/** 返回运行时无法满足的 required 保证清单（空数组 = 可满足）。 */
export function requiredGuaranteeGaps(caps: AgentRuntimeCapabilities, policy: HarnessPolicy): HarnessGuaranteeKey[] {
  return HARNESS_GUARANTEE_KEYS.filter((key) => policy.guarantees[key] === 'required' && !GUARANTEE_CAPABILITY_CHECKS[key](caps))
}

/** 在调用 Provider 前断言：required 保证得不到支持时拒绝。 */
export function assertRuntimeSatisfiesPolicy(
  runtime: AgentRuntime,
  caps: AgentRuntimeCapabilities,
  policy: HarnessPolicy,
): void {
  const gaps = requiredGuaranteeGaps(caps, policy)
  if (gaps.length === 0) return
  throw new HarnessPolicyError(
    `Runtime ${runtime} 不满足策略要求的保证: ${gaps.map((key) => HARNESS_GUARANTEE_LABELS[key]).join('、')}`,
    gaps.map((key) => `${key}=required 但 runtime 不支持`),
  )
}
