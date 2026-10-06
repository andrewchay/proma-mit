/**
 * 主张与证据关联规则（M5.1，纯函数无 IO）
 *
 * 核心原则（方案 §6.3、§11.4）：
 * - 状态是**分离的多个事实**，不是一个质量总分：是否有支持证据、
 *   是否有反对证据、是否经人工确认，各自独立。
 * - `researcher_verified` 只能由人给出，且**必须至少有一条支持链接**；
 *   存在反对链接时必须标 `contested` 而不是 verified。
 * - 源/证据/运行发生变化时，相关主张标 `stale`（保留历史，不抹除结论）。
 * - 不把 DOI 存在、原文含某句话、LLM 相关分数当作充分结论。
 */

import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'
import type {
  Claim,
  ClaimStatus,
  ClaimType,
  EvidenceLink,
  EvidenceRelation,
} from '@gravitas/shared'

export const CLAIM_TYPES: readonly ClaimType[] = [
  'empirical',
  'methodological',
  'theoretical',
  'limitation',
  'clinical-implication',
]

export const EVIDENCE_RELATIONS: readonly EvidenceRelation[] = ['supports', 'opposes', 'qualifies']

/** 合法状态迁移 */
const VALID_CLAIM_TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  draft: ['machine_checked', 'needs_review', 'unsupported', 'contested', 'stale'],
  machine_checked: ['needs_review', 'researcher_verified', 'unsupported', 'contested', 'stale'],
  needs_review: ['researcher_verified', 'contested', 'unsupported', 'stale'],
  researcher_verified: ['contested', 'stale', 'needs_review'],
  unsupported: ['needs_review', 'draft', 'stale'],
  contested: ['needs_review', 'stale'],
  stale: ['needs_review', 'draft'],
}

export function assertClaimTransition(from: ClaimStatus, to: ClaimStatus): void {
  if (!VALID_CLAIM_TRANSITIONS[from]?.includes(to)) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_TRANSITION,
      `非法主张状态迁移: ${from} → ${to}`,
    )
  }
}

export function validateClaimInput(input: { text: string; type: ClaimType }): void {
  if (!input.text?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '主张陈述不能为空')
  }
  if (input.text.trim().length > 2000) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '主张过长（≤2000 字符）；请拆分为多条可独立验证的陈述')
  }
  if (!CLAIM_TYPES.includes(input.type)) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `未知主张类型: ${String(input.type)}`)
  }
}

/**
 * 校验证据关联。
 *
 * 必须至少指向一个真实对象；不允许「只有自由文本依据」的关联。
 */
export function validateEvidenceLink(input: {
  relation: EvidenceRelation
  evidenceId?: string
  artifactId?: string
  runId?: string
  observationId?: string
}): void {
  if (!EVIDENCE_RELATIONS.includes(input.relation)) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `未知证据关系: ${String(input.relation)}`)
  }
  const refs = [input.evidenceId, input.artifactId, input.runId, input.observationId].filter(Boolean)
  if (refs.length === 0) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      '证据关联必须指向真实对象（证据片段/产物/运行/观察记录）；不接受只有文字说明的「依据」',
    )
  }
}

export interface ClaimSupportSummary {
  supports: number
  opposes: number
  qualifies: number
  /** 是否具备人工确认的形式条件 */
  canBeVerified: boolean
}

export function summarizeLinks(links: Array<Pick<EvidenceLink, 'relation'>>): ClaimSupportSummary {
  const supports = links.filter((l) => l.relation === 'supports').length
  const opposes = links.filter((l) => l.relation === 'opposes').length
  const qualifies = links.filter((l) => l.relation === 'qualifies').length
  return { supports, opposes, qualifies, canBeVerified: supports > 0 && opposes === 0 }
}

/**
 * 校验「确认主张」动作。
 *
 * 两条硬约束：
 * 1. 必须至少一条支持链接——无证据的确认就是无根据的断言
 * 2. 存在反对链接时不得确认，应标 contested
 */
export function assertClaimVerifiable(
  links: Array<Pick<EvidenceLink, 'relation'>>,
): void {
  const summary = summarizeLinks(links)
  if (summary.supports === 0) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      '该主张没有任何支持证据，不能标为已确认；请先关联证据或改标 unsupported',
    )
  }
  if (summary.opposes > 0) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      `该主张存在 ${summary.opposes} 条反对证据，应标为 contested 而不是已确认`,
    )
  }
}

/** 依据链接关系建议的主张状态（机器建议，人工可覆盖） */
export function suggestedClaimStatus(links: Array<Pick<EvidenceLink, 'relation'>>): ClaimStatus {
  const summary = summarizeLinks(links)
  if (summary.opposes > 0) return 'contested'
  if (summary.supports === 0) return 'unsupported'
  return 'needs_review'
}

/**
 * 失效传播：给定变化的对象，找出需要标 stale 的主张。
 *
 * 触发源（任一命中即失效）：
 * - 证据片段被撤回/删除
 * - 产物或运行被重新生成（内容变化）
 * - 来源版本更新（通过 evidenceId 间接命中）
 */
export function claimsAffectedByChange(
  claims: Claim[],
  links: EvidenceLink[],
  change: {
    evidenceIds?: string[]
    artifactIds?: string[]
    runIds?: string[]
    observationIds?: string[]
  },
): string[] {
  const evidenceSet = new Set(change.evidenceIds ?? [])
  const artifactSet = new Set(change.artifactIds ?? [])
  const runSet = new Set(change.runIds ?? [])
  const observationSet = new Set(change.observationIds ?? [])

  const affected = new Set<string>()
  for (const link of links) {
    const hit =
      (link.evidenceId && evidenceSet.has(link.evidenceId)) ||
      (link.artifactId && artifactSet.has(link.artifactId)) ||
      (link.runId && runSet.has(link.runId)) ||
      (link.observationId && observationSet.has(link.observationId))
    if (hit) affected.add(link.claimId)
  }

  // 已失效的（stale）以及草稿不重复标记；其余需复核
  return [...affected].filter((id) => {
    const claim = claims.find((c) => c.id === id)
    return claim !== undefined && claim.status !== 'stale'
  })
}

/** 导出预检：逐条列出缺证据/未确认的主张 */
export interface ExportPreflightItem {
  claimId: string
  text: string
  status: ClaimStatus
  issue: string
}

export function exportPreflight(
  claims: Claim[],
  links: EvidenceLink[],
): { ok: boolean; items: ExportPreflightItem[] } {
  const items: ExportPreflightItem[] = []
  for (const claim of claims) {
    const own = links.filter((l) => l.claimId === claim.id)
    const summary = summarizeLinks(own)

    if (claim.status === 'stale') {
      items.push({ claimId: claim.id, text: claim.text, status: claim.status, issue: '主张已失效：依据的对象发生变化，需复核' })
      continue
    }
    if (summary.supports === 0) {
      items.push({ claimId: claim.id, text: claim.text, status: claim.status, issue: '没有支持证据' })
      continue
    }
    if (claim.status !== 'researcher_verified') {
      items.push({
        claimId: claim.id,
        text: claim.text,
        status: claim.status,
        issue: claim.status === 'contested' ? '存在反对证据，未解决' : '尚未经研究者确认',
      })
    }
  }
  return { ok: items.length === 0, items }
}
