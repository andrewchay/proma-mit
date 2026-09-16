/**
 * AI 员工能力治理策略配置中心。
 *
 * 集中管理阈值、冷却、预算、canary 上限与保留期；每次变更写入不可变审计。
 * 治理配置本身不可被演化候选修改：本模块只接受用户显式调用。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import { getProactiveConfigPath } from './config-paths'

const POLICY_FILE = 'employee-capability-governance.json'

export interface EmployeeCapabilityGovernancePolicy {
  /** 评测建议所需的最少已脱敏样本数。 */
  minSanitizedSamples: number
  /** 同一 scope 的建议冷却期（天）。 */
  cooldownDays: number
  /** 每自然日最多创建的建议数。 */
  dailyRecommendationBudget: number
  /** 同一员工或 scope 的并发评测上限。 */
  maxConcurrentEvaluations: number
  /** Canary 允许的最大流量百分比。 */
  maxCanaryPercent: number
  /** 默认失败率上限（0-1）。 */
  defaultMaxFailureRate: number
  /** 默认返工率上限（0-1）。 */
  defaultMaxReworkRate: number
  /** 样本保留期（天）；null 表示不自动清理。 */
  sampleRetentionDays: number | null
  /** 审计保留期（天）；null 表示不自动清理。 */
  auditRetentionDays: number | null
}

export interface EmployeeCapabilityGovernanceAudit {
  id: string
  field: keyof EmployeeCapabilityGovernancePolicy
  previousValue: number | null
  nextValue: number | null
  actorId: string
  createdAt: number
}

interface PolicyFile {
  version: 1
  policy: EmployeeCapabilityGovernancePolicy
  audits: EmployeeCapabilityGovernanceAudit[]
}

export const DEFAULT_GOVERNANCE_POLICY: EmployeeCapabilityGovernancePolicy = {
  minSanitizedSamples: 3,
  cooldownDays: 7,
  dailyRecommendationBudget: 3,
  maxConcurrentEvaluations: 1,
  maxCanaryPercent: 50,
  defaultMaxFailureRate: 0.3,
  defaultMaxReworkRate: 0.4,
  sampleRetentionDays: null,
  auditRetentionDays: null,
}

/** 默认不自动删除任何数据；把 null 视为“未启用清理”。 */
const NUMERIC_BOUNDS: Partial<Record<keyof EmployeeCapabilityGovernancePolicy, { min: number; max: number; integer?: boolean }>> = {
  minSanitizedSamples: { min: 1, max: 50, integer: true },
  cooldownDays: { min: 0, max: 365, integer: true },
  dailyRecommendationBudget: { min: 0, max: 50, integer: true },
  maxConcurrentEvaluations: { min: 1, max: 10, integer: true },
  maxCanaryPercent: { min: 1, max: 100, integer: true },
  defaultMaxFailureRate: { min: 0, max: 1 },
  defaultMaxReworkRate: { min: 0, max: 1 },
  sampleRetentionDays: { min: 1, max: 3650, integer: true },
  auditRetentionDays: { min: 1, max: 3650, integer: true },
}

function filePath(): string {
  return join(getProactiveConfigPath(), POLICY_FILE)
}

function readFile(): PolicyFile {
  if (!existsSync(filePath())) return { version: 1, policy: { ...DEFAULT_GOVERNANCE_POLICY }, audits: [] }
  const parsed = readJsonFileSafe<PolicyFile>(filePath())
  if (!parsed || parsed.version !== 1 || !parsed.policy) return { version: 1, policy: { ...DEFAULT_GOVERNANCE_POLICY }, audits: [] }
  return { version: 1, policy: { ...DEFAULT_GOVERNANCE_POLICY, ...parsed.policy }, audits: Array.isArray(parsed.audits) ? parsed.audits : [] }
}

function writeFile(file: PolicyFile): void {
  writeJsonFileAtomic(filePath(), { ...file, audits: file.audits.slice(-500) })
}

export function getGovernancePolicy(): EmployeeCapabilityGovernancePolicy {
  return readFile().policy
}

export function listGovernanceAudits(): EmployeeCapabilityGovernanceAudit[] {
  return readFile().audits
}

/**
 * 更新治理策略。只接受显式字段，逐项校验范围，并为每个实际变化写入审计。
 * null 显式用于关闭保留期清理。
 */
export function updateGovernancePolicy(patch: Partial<Record<keyof EmployeeCapabilityGovernancePolicy, number | null>>, actorId = 'local-user', now = Date.now()): { policy: EmployeeCapabilityGovernancePolicy; audits: EmployeeCapabilityGovernanceAudit[] } {
  const file = readFile()
  const next: EmployeeCapabilityGovernancePolicy = { ...file.policy }
  const newAudits: EmployeeCapabilityGovernanceAudit[] = []
  for (const [key, rawValue] of Object.entries(patch) as Array<[keyof EmployeeCapabilityGovernancePolicy, number | null | undefined]>) {
    if (rawValue === undefined) continue
    if (!(key in DEFAULT_GOVERNANCE_POLICY)) throw new Error(`未知治理字段: ${key}`)
    if (rawValue === null) {
      if (key !== 'sampleRetentionDays' && key !== 'auditRetentionDays') throw new Error(`${key} 不允许为空`)
    } else {
      const bounds = NUMERIC_BOUNDS[key]
      if (!Number.isFinite(rawValue)) throw new Error(`${key} 必须是数字`)
      if (bounds?.integer && !Number.isInteger(rawValue)) throw new Error(`${key} 必须是整数`)
      if (bounds && (rawValue < bounds.min || rawValue > bounds.max)) throw new Error(`${key} 必须在 ${bounds.min}-${bounds.max} 之间`)
    }
    const previousValue = file.policy[key] as number | null
    if (previousValue === rawValue) continue
    ;(next[key] as number | null) = rawValue
    newAudits.push({ id: randomUUID(), field: key, previousValue, nextValue: rawValue, actorId, createdAt: now })
  }
  writeFile({ version: 1, policy: next, audits: [...file.audits, ...newAudits] })
  return { policy: next, audits: newAudits }
}

/** 仅用于行为测试。 */
export function resetGovernancePolicyForTests(): void {
  writeFile({ version: 1, policy: { ...DEFAULT_GOVERNANCE_POLICY }, audits: [] })
}
