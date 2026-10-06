/**
 * AI 员工能力 Canary 分流治理。
 *
 * 只做确定性分流与暂停判断，不自动回滚、不自动激活：
 * - 默认关闭；必须用户显式启用。
 * - 按 taskId 稳定 hash 分流，可复现，不依赖敏感属性。
 * - 达到失败/返工阈值时只暂停新分流并要求人工处理。
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import { getProactiveConfigPath } from './config-paths'
import { join } from 'node:path'

const CANARY_FILE = 'employee-capability-canary.json'

export interface EmployeeCanaryConfig {
  agentId: string
  scope: 'role' | 'workspace'
  workspaceId?: string
  /** 参与 canary 的新版本；未显式设置时不得分流。 */
  candidateVersionId: string
  /** 0-100 的整数百分比。 */
  percent: number
  enabled: boolean
  /** 失败率上限（0-1）。 */
  maxFailureRate: number
  /** 返工率上限（0-1）。 */
  maxReworkRate: number
  /** 触发暂停后记录的原因与时间。 */
  pausedAt?: number
  pausedReason?: string
  createdAt: number
  updatedAt: number
}

interface CanaryFile {
  version: 1
  configs: EmployeeCanaryConfig[]
}

function filePath(): string {
  return join(getProactiveConfigPath(), CANARY_FILE)
}

function readFile(): CanaryFile {
  if (!existsSync(filePath())) return { version: 1, configs: [] }
  const parsed = readJsonFileSafe<CanaryFile>(filePath())
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.configs)) return { version: 1, configs: [] }
  return parsed
}

function writeFile(value: CanaryFile): void {
  writeJsonFileAtomic(filePath(), value)
}

export function listEmployeeCanaryConfigs(): EmployeeCanaryConfig[] {
  return readFile().configs
}

export function getEmployeeCanaryConfig(agentId: string, scope: 'role' | 'workspace', workspaceId?: string): EmployeeCanaryConfig | undefined {
  return readFile().configs.find((item) => item.agentId === agentId && item.scope === scope && item.workspaceId === workspaceId)
}

/** 显式启用 canary；百分比必须为 1-100，且必须指定候选版本。 */
export function enableEmployeeCanary(input: { agentId: string; scope: 'role' | 'workspace'; workspaceId?: string; candidateVersionId: string; percent: number; maxFailureRate?: number; maxReworkRate?: number; now?: number }): EmployeeCanaryConfig {
  if (!Number.isInteger(input.percent) || input.percent < 1 || input.percent > 100) throw new Error('Canary 百分比必须是 1-100 的整数')
  if (!input.candidateVersionId.trim()) throw new Error('必须显式指定参与 canary 的候选版本')
  const now = input.now ?? Date.now()
  const file = readFile()
  const existing = file.configs.find((item) => item.agentId === input.agentId && item.scope === input.scope && item.workspaceId === input.workspaceId)
  const config: EmployeeCanaryConfig = {
    agentId: input.agentId,
    scope: input.scope,
    workspaceId: input.workspaceId,
    candidateVersionId: input.candidateVersionId,
    percent: input.percent,
    enabled: true,
    maxFailureRate: input.maxFailureRate ?? 0.3,
    maxReworkRate: input.maxReworkRate ?? 0.4,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  writeFile({ version: 1, configs: [...file.configs.filter((item) => item !== existing), config] })
  return config
}

export function disableEmployeeCanary(agentId: string, scope: 'role' | 'workspace', workspaceId?: string, now = Date.now()): EmployeeCanaryConfig | undefined {
  const file = readFile()
  const target = file.configs.find((item) => item.agentId === agentId && item.scope === scope && item.workspaceId === workspaceId)
  if (!target) return undefined
  const updated = { ...target, enabled: false, updatedAt: now }
  writeFile({ version: 1, configs: file.configs.map((item) => (item === target ? updated : item)) })
  return updated
}

/** 达到阈值只暂停新分流，不自动回滚生产版本。 */
export function pauseEmployeeCanary(agentId: string, scope: 'role' | 'workspace', reason: string, workspaceId?: string, now = Date.now()): EmployeeCanaryConfig | undefined {
  const file = readFile()
  const target = file.configs.find((item) => item.agentId === agentId && item.scope === scope && item.workspaceId === workspaceId)
  if (!target) return undefined
  const updated: EmployeeCanaryConfig = { ...target, enabled: false, pausedAt: now, pausedReason: reason, updatedAt: now }
  writeFile({ version: 1, configs: file.configs.map((item) => (item === target ? updated : item)) })
  return updated
}

/** 按 taskId 稳定判断是否走候选版本；可复现且不依赖敏感属性。 */
export function shouldUseCanary(config: Pick<EmployeeCanaryConfig, 'agentId' | 'scope' | 'workspaceId' | 'candidateVersionId' | 'percent' | 'enabled'>, taskId: string): boolean {
  if (!config.enabled) return false
  const bucket = Number.parseInt(createHash('sha256').update(`${config.agentId}:${config.scope}:${config.workspaceId ?? 'role'}:${config.candidateVersionId}:${taskId}`).digest('hex').slice(0, 8), 16) % 100
  return bucket < config.percent
}

export interface CanaryHealthInput {
  failureRate: number | null
  reworkRate: number | null
}

/** 只判断是否需要暂停，不执行任何自动回滚；调用方需人工确认后续动作。 */
export function evaluateCanaryStopCondition(config: EmployeeCanaryConfig, health: CanaryHealthInput): { shouldPause: boolean; reason?: string } {
  if (!config.enabled) return { shouldPause: false }
  if (health.failureRate !== null && health.failureRate > config.maxFailureRate) return { shouldPause: true, reason: `失败率 ${(health.failureRate * 100).toFixed(1)}% 超过上限 ${(config.maxFailureRate * 100).toFixed(0)}%` }
  if (health.reworkRate !== null && health.reworkRate > config.maxReworkRate) return { shouldPause: true, reason: `返工率 ${(health.reworkRate * 100).toFixed(1)}% 超过上限 ${(config.maxReworkRate * 100).toFixed(0)}%` }
  return { shouldPause: false }
}

/** 仅用于行为测试。 */
export function resetEmployeeCanaryForTests(): void {
  writeFile({ version: 1, configs: [] })
}
