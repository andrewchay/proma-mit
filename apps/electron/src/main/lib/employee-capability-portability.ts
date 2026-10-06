/**
 * AI 员工能力演化包的导出与导入。
 *
 * 默认脱敏导出：只含版本化元数据、候选元数据、评分摘要与内容 hash。
 * 不导出生产会话、附件、绝对路径、密钥与样本摘要正文。
 *
 * 导入只接受 schema 版本与 hash 校验通过的包；不接受任何可自动激活的内容。
 */

import { createHash } from 'node:crypto'
import * as store from './project-sqlite-store'
import { listApprovals } from './approval-service'

export const EVOLUTION_PACKAGE_SCHEMA = 'gravitas.employee-capability-package'
export const EVOLUTION_PACKAGE_VERSION = 1

export interface EvolutionPackageVersionEntry {
  versionId: string
  parentVersionId?: string
  versionNumber: number
  scope: 'role' | 'workspace'
  workspaceId?: string
  status: string
  source: string
  contentHash: string
  createdAt: number
  activatedAt?: number
  retiredAt?: number
}

export interface EvolutionPackageCandidateEntry {
  approvalId: string
  status: string
  scope: 'role' | 'workspace'
  parentVersionId?: string
  versionNumber: number
  contentHash: string
  trainingScore?: number
  heldOutScore?: number
  evidenceSampleCount: number
  createdAt: number
}

export interface EvolutionPackageSampleEntry {
  sampleId: string
  outcome: string
  privacyStatus: string
  capabilityVersionIds: string[]
  createdAt: number
}

export interface EvolutionPackage {
  schema: typeof EVOLUTION_PACKAGE_SCHEMA
  schemaVersion: typeof EVOLUTION_PACKAGE_VERSION
  exportedAt: number
  /** 脱敏模式标记；true 表示不含样本摘要正文。 */
  redacted: true
  agents: Array<{
    agentId: string
    name: string
    scope: 'role' | 'workspace'
    versions: EvolutionPackageVersionEntry[]
    candidates: EvolutionPackageCandidateEntry[]
    samples: EvolutionPackageSampleEntry[]
  }>
  /** 内容 hash：覆盖除本字段外的全部内容，用于导入时检测篡改。 */
  checksum: string
}

function hashPayload(payload: Omit<EvolutionPackage, 'checksum'>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/**
 * 导出脱敏演化包。
 * 注意：sampleSelector 只允许选择样本元数据，本函数从不读取 evidence_summary 正文。
 */
export function exportEvolutionPackage(input: { agentIds?: string[]; now?: number } = {}): EvolutionPackage {
  const employees = store.listAgentEmployees().filter((employee) => !input.agentIds || input.agentIds.includes(employee.id))
  const agents = employees.map((employee) => {
    const versions = store.listAgentEmployeeCapabilityVersions(employee.id)
    const samples = store.listAgentEmployeeLearningSamples(employee.id)
    const approvals = listApprovals().filter((approval) => approval.sourceType === 'employee_capability' && (approval.proposedChange as { agentId?: string } | undefined)?.agentId === employee.id)
    return {
      agentId: employee.id,
      name: employee.name,
      scope: 'role' as const,
      versions: versions.map((version) => ({
        versionId: version.id,
        parentVersionId: version.parentVersionId,
        versionNumber: version.versionNumber,
        scope: version.scope,
        workspaceId: version.workspaceId,
        status: version.status,
        source: version.source,
        contentHash: version.contentHash,
        createdAt: version.createdAt,
        activatedAt: version.activatedAt,
        retiredAt: version.retiredAt,
      })),
      candidates: approvals.map((approval) => {
        const change = approval.proposedChange as { scope?: 'role' | 'workspace'; parentVersionId?: string; versionNumber?: number; contentHash?: string; trainingScore?: number; heldOutScore?: number; evidenceSampleIds?: string[] } | undefined
        return {
          approvalId: approval.id,
          status: approval.status,
          scope: change?.scope ?? 'role',
          parentVersionId: change?.parentVersionId,
          versionNumber: change?.versionNumber ?? 0,
          contentHash: change?.contentHash ?? '',
          trainingScore: change?.trainingScore,
          heldOutScore: change?.heldOutScore,
          evidenceSampleCount: change?.evidenceSampleIds?.length ?? 0,
          createdAt: approval.createdAt,
        }
      }),
      samples: samples.map((sample) => ({
        sampleId: sample.id,
        outcome: sample.outcome,
        privacyStatus: sample.privacyStatus,
        capabilityVersionIds: sample.capabilityVersionIds,
        createdAt: sample.createdAt,
      })),
    }
  })
  const payload = { schema: EVOLUTION_PACKAGE_SCHEMA as typeof EVOLUTION_PACKAGE_SCHEMA, schemaVersion: EVOLUTION_PACKAGE_VERSION as typeof EVOLUTION_PACKAGE_VERSION, exportedAt: input.now ?? Date.now(), redacted: true as const, agents }
  return { ...payload, checksum: hashPayload(payload) }
}

export type EvolutionPackageValidation =
  | { ok: true; package: EvolutionPackage }
  | { ok: false; reason: string }

const FORBIDDEN_KEYS = ['evidenceSummary', 'evidence_summary', 'sessionId', 'session_id', 'prompt', 'content', 'apiKey', 'api_key', 'absolutePath', 'path']

/** 递归检查是否混入了不应导出的敏感字段。 */
function findForbiddenKey(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenKey(item, depth + 1)
      if (found) return found
    }
    return undefined
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.includes(key)) return key
    const found = findForbiddenKey(child, depth + 1)
    if (found) return found
  }
  return undefined
}

/** 校验导入包：schema、版本、checksum 与敏感字段。 */
export function validateEvolutionPackage(input: unknown): EvolutionPackageValidation {
  if (!input || typeof input !== 'object') return { ok: false, reason: '导入包不是合法对象' }
  const candidate = input as Partial<EvolutionPackage>
  if (candidate.schema !== EVOLUTION_PACKAGE_SCHEMA) return { ok: false, reason: '导入包 schema 不匹配' }
  if (candidate.schemaVersion !== EVOLUTION_PACKAGE_VERSION) return { ok: false, reason: `不支持的 schema 版本: ${String(candidate.schemaVersion)}` }
  if (typeof candidate.checksum !== 'string' || !candidate.checksum) return { ok: false, reason: '导入包缺少 checksum' }
  if (!Array.isArray(candidate.agents)) return { ok: false, reason: '导入包缺少 agents' }
  const forbidden = findForbiddenKey(candidate.agents)
  if (forbidden) return { ok: false, reason: `导入包包含不应存在的敏感字段: ${forbidden}` }
  const { checksum, ...payload } = candidate as EvolutionPackage
  const expected = hashPayload(payload as Omit<EvolutionPackage, 'checksum'>)
  if (expected !== checksum) return { ok: false, reason: '导入包校验失败：内容与 checksum 不一致' }
  return { ok: true, package: candidate as EvolutionPackage }
}

/**
 * 导入包只作为只读参考资料：不激活版本、不创建候选、不写入任何生产能力。
 */
export function summarizeEvolutionPackageForReview(pkg: EvolutionPackage): { agentCount: number; versionCount: number; candidateCount: number; sanitizedSampleCount: number; note: string } {
  return {
    agentCount: pkg.agents.length,
    versionCount: pkg.agents.reduce((sum, agent) => sum + agent.versions.length, 0),
    candidateCount: pkg.agents.reduce((sum, agent) => sum + agent.candidates.length, 0),
    sanitizedSampleCount: pkg.agents.reduce((sum, agent) => sum + agent.samples.filter((sample) => sample.privacyStatus === 'sanitized').length, 0),
    note: '导入内容仅供人工参考，不会自动激活版本或创建可批准候选。',
  }
}
