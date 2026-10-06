/**
 * 主张与稿件应用服务（M5.1）
 *
 * 关键约束：
 * - 证据关联必须指向本项目内真实存在的对象（证据/产物/运行/观察）
 * - 人工确认（researcher_verified）由 access-guard 注入 actor，
 *   且必须满足 claim-rules 的形式条件（≥1 支持、0 反对）
 * - 源/证据/运行变化时把相关主张标 stale，保留历史不抹除
 */

import { randomUUID } from 'node:crypto'
import type {
  ApprovalActor,
  Claim,
  ClaimStatus,
  ClaimType,
  EvidenceLink,
  EvidenceRelation,
  ManuscriptSection,
  ManuscriptVersion,
  ResearchProject,
} from '@gravitas/shared'
import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'
import {
  assertClaimTransition,
  assertClaimVerifiable,
  claimsAffectedByChange,
  exportPreflight,
  summarizeLinks,
  validateClaimInput,
  validateEvidenceLink,
  type ExportPreflightItem,
} from '@gravitas/core/services/academic'
import { appendEvent, loadProjectState, readProjectEvents } from './research-store'
import { assertProjectAccess, currentActor } from './access-guard'

async function loadProject(id: string): Promise<ResearchProject | null> {
  const state = await loadProjectState(id)
  return state.project
}

/** 从事件流重建主张与链接 */
async function replayClaims(
  projectId: string,
): Promise<{ claims: Claim[]; links: EvidenceLink[] }> {
  const events = await readProjectEvents(projectId)
  const claims = new Map<string, Claim>()
  const links: EvidenceLink[] = []

  for (const envelope of events) {
    const p = envelope.payload
    if (p.type === 'claim_recorded') claims.set(p.claim.id, p.claim)
    if (p.type === 'evidence_linked') links.push(p.link)
    if (p.type === 'claim_status_changed') {
      const claim = claims.get(p.claimId)
      if (claim) {
        claim.status = p.status
        claim.updatedAt = envelope.at
        if (p.status === 'stale') claim.staleReason = p.staleReason
        if (p.status !== 'stale') claim.staleReason = undefined
        if (p.status === 'researcher_verified' && p.verifiedBy) {
          claim.verification = { verifiedBy: p.verifiedBy, verifiedAt: envelope.at, note: p.note }
        } else {
          claim.verification = undefined
        }
      }
    }
  }

  return { claims: [...claims.values()], links }
}

export interface ClaimView extends Claim {
  links: EvidenceLink[]
  summary: ReturnType<typeof summarizeLinks>
}

/** 列出主张（含链接与支持汇总） */
export async function listClaims(projectId: string): Promise<ClaimView[]> {
  await assertProjectAccess(projectId, loadProject)
  const { claims, links } = await replayClaims(projectId)
  return claims
    .map((claim) => {
      const own = links.filter((l) => l.claimId === claim.id)
      return { ...claim, links: own, summary: summarizeLinks(own) }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** 创建主张 */
export async function createClaim(
  projectId: string,
  input: { text: string; type: ClaimType; scope?: string; sectionRef?: string },
): Promise<Claim> {
  await assertProjectAccess(projectId, loadProject)
  validateClaimInput(input)

  const now = new Date().toISOString()
  const claim: Claim = {
    id: randomUUID(),
    projectId,
    text: input.text.trim(),
    type: input.type,
    status: 'draft',
    scope: input.scope?.trim() || undefined,
    sectionRef: input.sectionRef?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  }

  await appendEvent(projectId, {
    commandId: `claim-${randomUUID()}`,
    payload: { type: 'claim_recorded', claim },
  })
  return claim
}

/**
 * 关联证据。
 *
 * 指向的对象必须真实存在于本项目（证据台账/运行/产物/观察）。
 */
export async function linkEvidence(
  projectId: string,
  input: {
    claimId: string
    relation: EvidenceRelation
    evidenceId?: string
    artifactId?: string
    runId?: string
    observationId?: string
    note?: string
  },
): Promise<EvidenceLink> {
  await assertProjectAccess(projectId, loadProject)
  validateEvidenceLink(input)

  const { claims } = await replayClaims(projectId)
  if (!claims.some((c) => c.id === input.claimId)) {
    throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `主张不存在: ${input.claimId}`)
  }

  // 引用对象存在性校验（按类型分别查）
  if (input.evidenceId) {
    const { listEvidence } = await import('./evidence-service')
    const evidence = await listEvidence(projectId)
    if (!evidence.some((e) => e.id === input.evidenceId)) {
      throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `证据片段不存在: ${input.evidenceId}`)
    }
  }
  if (input.runId || input.artifactId) {
    const { listRuns, listArtifacts } = await import('./run-service')
    const runs = await listRuns(projectId)
    if (input.runId && !runs.some((r) => r.id === input.runId)) {
      throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `运行记录不存在: ${input.runId}`)
    }
    if (input.artifactId) {
      const artifacts = await listArtifacts(projectId)
      if (!artifacts.some((a) => a.id === input.artifactId)) {
        throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `产物不存在: ${input.artifactId}`)
      }
    }
  }
  if (input.observationId) {
    const { listObservations } = await import('./run-service')
    const observations = await listObservations(projectId)
    if (!observations.some((o) => o.id === input.observationId)) {
      throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `观察记录不存在: ${input.observationId}`)
    }
  }

  const link: EvidenceLink = {
    id: randomUUID(),
    claimId: input.claimId,
    relation: input.relation,
    evidenceId: input.evidenceId,
    artifactId: input.artifactId,
    runId: input.runId,
    observationId: input.observationId,
    note: input.note?.trim() || undefined,
    createdBy: currentActor(),
    createdAt: new Date().toISOString(),
  }

  await appendEvent(projectId, {
    commandId: `link-${randomUUID()}`,
    payload: { type: 'evidence_linked', link },
  })
  return link
}

/**
 * 设置主张状态。
 *
 * researcher_verified 必须由人确认（actor 由主进程注入）且满足形式条件。
 */
export async function setClaimStatus(
  projectId: string,
  claimId: string,
  status: ClaimStatus,
  options: { note?: string; staleReason?: string } = {},
): Promise<Claim> {
  await assertProjectAccess(projectId, loadProject)
  const { claims, links } = await replayClaims(projectId)
  const claim = claims.find((c) => c.id === claimId)
  if (!claim) {
    throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `主张不存在: ${claimId}`)
  }

  // 先查证据条件再查状态机：若两条都不满足，用户更需要知道的是
  // 「没有支持证据」而不是「非法状态迁移」（前者可行动）。
  let verifiedBy: ApprovalActor | undefined
  if (status === 'researcher_verified') {
    const own = links.filter((l) => l.claimId === claimId)
    assertClaimVerifiable(own)
    verifiedBy = currentActor()
  }

  assertClaimTransition(claim.status, status)

  await appendEvent(projectId, {
    commandId: `claim-status-${randomUUID()}`,
    payload: { type: 'claim_status_changed', claimId, status, staleReason: options.staleReason, verifiedBy, note: options.note },
  })

  const refreshed = (await replayClaims(projectId)).claims.find((c) => c.id === claimId)!
  return refreshed
}

/**
 * 传播失效：源/证据/运行/产物变化时，把相关主张标 stale。
 */
export async function propagateInvalidation(
  projectId: string,
  change: { evidenceIds?: string[]; artifactIds?: string[]; runIds?: string[]; observationIds?: string[]; reason: string },
): Promise<{ affectedClaimIds: string[] }> {
  await assertProjectAccess(projectId, loadProject)
  if (!change.reason?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '失效传播必须说明原因')
  }

  const { claims, links } = await replayClaims(projectId)
  const affected = claimsAffectedByChange(claims, links, change)

  for (const claimId of affected) {
    await appendEvent(projectId, {
      commandId: `claim-stale-${randomUUID()}`,
      payload: { type: 'claim_status_changed', claimId, status: 'stale', staleReason: change.reason.trim() },
    })
  }
  return { affectedClaimIds: affected }
}

/** 导出预检：逐条列出问题 */
export async function runExportPreflight(
  projectId: string,
): Promise<{ ok: boolean; items: ExportPreflightItem[] }> {
  await assertProjectAccess(projectId, loadProject)
  const { claims, links } = await replayClaims(projectId)
  return exportPreflight(claims, links)
}

// ===== 稿件版本 =====

/** 列出稿件版本（按版本号升序） */
export async function listManuscripts(projectId: string): Promise<ManuscriptVersion[]> {
  await assertProjectAccess(projectId, loadProject)
  const events = await readProjectEvents(projectId)
  return events
    .filter((e) => e.payload.type === 'manuscript_version_recorded')
    .map((e) => (e.payload as { manuscript: ManuscriptVersion }).manuscript)
    .sort((a, b) => a.version - b.version)
}

export interface ManuscriptDraft {
  title: string
  sections: Array<{ heading: string; content: string; claimIds?: string[]; citationRefs?: string[] }>
  changeReason?: string
}

/**
 * 创建稿件版本。
 *
 * version > 1 时必须给变更理由；章节引用的主张必须存在于本项目。
 */
export async function createManuscriptVersion(
  projectId: string,
  draft: ManuscriptDraft,
): Promise<ManuscriptVersion> {
  await assertProjectAccess(projectId, loadProject)

  if (!draft.title?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '稿件标题不能为空')
  }
  if (!Array.isArray(draft.sections) || draft.sections.length === 0) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '稿件至少需要一个章节')
  }

  const existing = await listManuscripts(projectId)
  const version = existing.length === 0 ? 1 : Math.max(...existing.map((m) => m.version)) + 1
  if (version > 1 && !draft.changeReason?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '稿件新版必须说明变更理由')
  }

  // 引用的主张必须存在
  const { claims } = await replayClaims(projectId)
  const claimIds = new Set(claims.map((c) => c.id))
  for (const section of draft.sections) {
    for (const claimId of section.claimIds ?? []) {
      if (!claimIds.has(claimId)) {
        throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `章节引用的主张不存在: ${claimId}`)
      }
    }
  }

  const sections: ManuscriptSection[] = draft.sections.map((s) => ({
    id: randomUUID(),
    heading: s.heading.trim(),
    content: s.content,
    claimIds: s.claimIds ?? [],
    citationRefs: s.citationRefs ?? [],
  }))

  const manuscript: ManuscriptVersion = {
    id: randomUUID(),
    projectId,
    version,
    title: draft.title.trim(),
    sections,
    changeReason: draft.changeReason?.trim() || undefined,
    createdBy: currentActor(),
    createdAt: new Date().toISOString(),
  }

  await appendEvent(projectId, {
    commandId: `manuscript-${randomUUID()}`,
    payload: { type: 'manuscript_version_recorded', manuscript },
  })
  return manuscript
}

/** 当前稿件（最高版本） */
export async function getLatestManuscript(projectId: string): Promise<ManuscriptVersion | null> {
  const all = await listManuscripts(projectId)
  return all.length > 0 ? all[all.length - 1]! : null
}
