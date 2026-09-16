/**
 * AI 员工能力演化建议扫描。
 *
 * 只根据本地权威事实（已脱敏样本、审批、版本审计）判断“是否值得人工触发一次受控评测”。
 * 本模块不调用模型、不创建候选、不激活或回滚版本；用户确认后才由评测服务运行。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonFileAtomic } from './safe-file'
import { getProactiveConfigPath } from './config-paths'
import { createRecommendation } from './recommendation-service'
import { listApprovals } from './approval-service'
import * as store from './project-sqlite-store'
import type { AgentEmployeeCapabilityScope } from './project-types'

const SCAN_STATE_FILE = 'employee-capability-scans.json'
const DAY_MS = 24 * 60 * 60 * 1000

export interface EmployeeCapabilityRecommendationPolicy {
  /** 触发评测建议所需的最少已脱敏样本数。 */
  minSanitizedSamples: number
  /** 同一员工 + scope 的建议冷却期（天）。 */
  cooldownDays: number
  /** 每自然日最多创建的建议数。 */
  dailyRecommendationBudget: number
  /** 同一员工是否允许同时存在待确认建议。 */
  perScopeConcurrency: number
}

export const DEFAULT_EMPLOYEE_RECOMMENDATION_POLICY: EmployeeCapabilityRecommendationPolicy = {
  minSanitizedSamples: 3,
  cooldownDays: 7,
  dailyRecommendationBudget: 3,
  perScopeConcurrency: 1,
}

interface ScanRecord {
  key: string
  lastSuggestedAt: number
}

interface ScanState {
  version: 1
  records: ScanRecord[]
  dailyCounts: Array<{ day: string; count: number }>
}

function statePath(): string {
  return join(getProactiveConfigPath(), SCAN_STATE_FILE)
}

function readState(): ScanState {
  if (!existsSync(statePath())) return { version: 1, records: [], dailyCounts: [] }
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as ScanState
    if (parsed?.version !== 1 || !Array.isArray(parsed.records) || !Array.isArray(parsed.dailyCounts)) throw new Error('invalid')
    return parsed
  } catch {
    return { version: 1, records: [], dailyCounts: [] }
  }
}

function writeState(state: ScanState): void {
  writeJsonFileAtomic(statePath(), { ...state, dailyCounts: state.dailyCounts.slice(-31) })
}

function localDay(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export interface EmployeeCapabilityScanOutcome {
  agentId: string
  scope: AgentEmployeeCapabilityScope
  workspaceId?: string
  skipped?: 'below_threshold' | 'cooldown' | 'pending_duplicate' | 'daily_budget' | 'concurrency'
  recommendationId?: string
}

function scopeKey(agentId: string, scope: AgentEmployeeCapabilityScope, workspaceId?: string): string {
  return `employee-capability:${agentId}:${scope}:${workspaceId ?? 'role'}`
}

/** 扫描单个员工 + scope；只使用本地元数据判断。 */
export function scanEmployeeCapabilityScope(input: {
  agentId: string
  scope: AgentEmployeeCapabilityScope
  workspaceId?: string
  now?: number
  policy?: Partial<EmployeeCapabilityRecommendationPolicy>
}): EmployeeCapabilityScanOutcome {
  const policy = { ...DEFAULT_EMPLOYEE_RECOMMENDATION_POLICY, ...input.policy }
  const now = input.now ?? Date.now()
  const key = scopeKey(input.agentId, input.scope, input.workspaceId)
  const base: EmployeeCapabilityScanOutcome = { agentId: input.agentId, scope: input.scope, workspaceId: input.workspaceId }

  const employee = store.getAgentEmployee(input.agentId)
  if (!employee?.enabled) return { ...base, skipped: 'below_threshold' }

  const sanitized = store.listAgentEmployeeLearningSamples(input.agentId).filter((sample) => sample.privacyStatus === 'sanitized')
  if (sanitized.length < policy.minSanitizedSamples) return { ...base, skipped: 'below_threshold' }

  const state = readState()
  const record = state.records.find((item) => item.key === key)
  if (record && now - record.lastSuggestedAt < policy.cooldownDays * DAY_MS) return { ...base, skipped: 'cooldown' }

  const pendingAgents = new Set(listApprovals().filter((approval) => approval.status === 'pending' && approval.sourceType === 'employee_capability').map((approval) => (approval.proposedChange as { agentId?: string } | undefined)?.agentId).filter(Boolean))
  if (pendingAgents.has(input.agentId)) return { ...base, skipped: 'pending_duplicate' }

  const today = localDay(now)
  const todayCount = state.dailyCounts.find((item) => item.day === today)?.count ?? 0
  if (todayCount >= policy.dailyRecommendationBudget) return { ...base, skipped: 'daily_budget' }

  const sameScopeSuggested = state.records.filter((item) => item.key.startsWith(`employee-capability:${input.agentId}:`) && now - item.lastSuggestedAt < policy.cooldownDays * DAY_MS).length
  if (sameScopeSuggested >= policy.perScopeConcurrency) return { ...base, skipped: 'concurrency' }

  const recommendation = createRecommendation({
    kind: 'schedule',
    title: `建议评测 AI 员工能力：${employee.name}`,
    reason: `已有 ${sanitized.length} 条人工脱敏学习样本。建议运行一次受控评测；评测只生成待审批候选，不会自动激活或回滚版本。`,
    scope: key,
    confidence: 0.7,
    safetyLevel: 'read_only',
    duplicateKey: key,
    evidence: [
      { label: '已脱敏样本', detail: `${sanitized.length} 条（阈值 ${policy.minSanitizedSamples}）` },
      { label: '能力范围', detail: input.scope === 'role' ? '角色级' : `工作区级 · ${input.workspaceId ?? '未指定'}` },
      { label: '冷却期', detail: `${policy.cooldownDays} 天；每日建议上限 ${policy.dailyRecommendationBudget}` },
    ],
    action: { type: 'run_employee_capability_evaluation', agentId: input.agentId, scope: input.scope, workspaceId: input.workspaceId },
  })
  if (!recommendation) return { ...base, skipped: 'pending_duplicate' }

  const nextRecords = [...state.records.filter((item) => item.key !== key), { key, lastSuggestedAt: now }]
  const nextCounts = state.dailyCounts.some((item) => item.day === today)
    ? state.dailyCounts.map((item) => (item.day === today ? { ...item, count: item.count + 1 } : item))
    : [...state.dailyCounts, { day: today, count: 1 }]
  writeState({ version: 1, records: nextRecords.slice(-500), dailyCounts: nextCounts })
  return { ...base, recommendationId: recommendation.id }
}

/** 扫描所有启用员工的角色级能力；工作区级需显式指定，避免静默遍历。 */
export function scanAllEmployeeCapabilityScopes(input: { now?: number; policy?: Partial<EmployeeCapabilityRecommendationPolicy> } = {}): EmployeeCapabilityScanOutcome[] {
  return store.listAgentEmployees()
    .filter((employee) => employee.enabled)
    .map((employee) => scanEmployeeCapabilityScope({ agentId: employee.id, scope: 'role', now: input.now, policy: input.policy }))
}

/** 仅用于行为测试：清理扫描状态。 */
export function resetEmployeeCapabilityScanStateForTests(now = Date.now()): void {
  writeState({ version: 1, records: [], dailyCounts: [{ day: localDay(now), count: 0 }] })
}
