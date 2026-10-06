/**
 * 选题候选规则（M3.2，纯函数无 IO）
 *
 * 方案 §5、§13.3 的硬要求：**选题质量不承诺统一自动评分**。
 * 因此本模块只做形式门禁与「如实记录」检查，不做打分：
 *
 * 1. 必须声明 gap 类型——笼统的「很新颖」不是类型
 * 2. 必须记录查新范围（检索词、库、时间、最接近工作、局限），
 *    否则无法排除伪新颖
 * 3. 必须给出 gap 论证：为什么既有工作不能解决它
 * 4. 反证与反例不强制非空，但**必须显式声明已检索**（避免只写有利证据）
 * 5. 支持证据必须真实存在于项目证据台账
 */

import type { ResearchGapType, TopicProposal } from '@gravitas/shared'
import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'

export const GAP_TYPES: readonly ResearchGapType[] = [
  'unstudied-population',
  'unstudied-comparison',
  'methodological',
  'contradictory-evidence',
  'context-transfer',
  'conceptual',
]

export interface TopicProposalDraft {
  title: string
  question: string
  gapType: ResearchGapType
  gapRationale: string
  supportingEvidenceIds: string[]
  contradictingEvidenceIds: string[]
  counterarguments: string[]
  noveltyCheck: {
    queries: string[]
    databases: string[]
    checkedAt: string
    closestSourceIds: string[]
    limitations: string[]
  }
  plannedDatabases?: string[]
}

/** 校验选题候选草稿 */
export function validateTopicProposal(
  draft: TopicProposalDraft,
  knownEvidenceIds: string[],
): void {
  if (!draft.title?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '选题标题不能为空')
  }
  if (!draft.question?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '研究问题不能为空')
  }
  if (!GAP_TYPES.includes(draft.gapType)) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      `未知 gap 类型: ${String(draft.gapType)}；可选 ${GAP_TYPES.join(', ')}`,
    )
  }
  if (!draft.gapRationale?.trim()) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      '必须说明 gap 论证：既有工作为什么不能解决该问题',
    )
  }

  // 查新范围必须完整，否则无法排除伪新颖
  const novelty = draft.noveltyCheck
  if (!novelty || !Array.isArray(novelty.queries) || novelty.queries.filter((q) => q.trim()).length === 0) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '查新范围必须记录至少一条检索词')
  }
  if (!Array.isArray(novelty.databases) || novelty.databases.filter((d) => d.trim()).length === 0) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '查新范围必须记录检索过的数据库')
  }
  if (!novelty.checkedAt?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '查新范围必须记录检索时间')
  }
  if (!Array.isArray(novelty.limitations)) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '查新范围必须声明检索局限（可为空数组但不可缺省）')
  }

  // 支持证据必须真实存在于台账
  for (const id of draft.supportingEvidenceIds ?? []) {
    if (!knownEvidenceIds.includes(id)) {
      throw new ResearchError(
        RESEARCH_ERROR_CODES.INVALID_INPUT,
        `支持证据不存在于本项目证据台账: ${id}`,
      )
    }
  }
  for (const id of draft.contradictingEvidenceIds ?? []) {
    if (!knownEvidenceIds.includes(id)) {
      throw new ResearchError(
        RESEARCH_ERROR_CODES.INVALID_INPUT,
        `反证证据不存在于本项目证据台账: ${id}`,
      )
    }
  }

  if (!Array.isArray(draft.counterarguments)) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '反例/替代解释须显式记录（可为空数组但不可缺省）')
  }
}

/**
 * 选题的「如实记录」检查（阻断选定，除非显式 force）。
 *
 * 只保留**能证明已做过工作**的硬缺口：选题依据是否落到原文片段、
 * 查新是否记录最接近工作与局限。
 *
 * 反证与反例**不计入硬缺口**：检索后确实未发现反证是合法结果，
 * 强制非空会诱导编造。它们作为提示项由 advisoryNotes 返回。
 */
export function topicRecordednessGaps(proposal: Pick<TopicProposal,
  'supportingEvidenceIds' | 'contradictingEvidenceIds' | 'counterarguments' | 'noveltyCheck'
>): string[] {
  const gaps: string[] = []
  if (proposal.supportingEvidenceIds.length === 0) {
    gaps.push('尚无支持证据关联：选题依据未落到原文片段')
  }
  if (proposal.noveltyCheck.closestSourceIds.length === 0) {
    gaps.push('查新未记录最接近的既有工作：伪新颖风险未排除')
  }
  if (proposal.noveltyCheck.limitations.length === 0) {
    gaps.push('未声明检索局限（如未覆盖商业库/非英文文献）')
  }
  return gaps
}

/**
 * 非阻断提示：提醒研究者主动检查反证与替代解释。
 *
 * 这些不计入门禁（见 topicRecordednessGaps 的说明），只在 UI 展示。
 */
export function topicAdvisoryNotes(proposal: Pick<TopicProposal,
  'contradictingEvidenceIds' | 'counterarguments'
>): string[] {
  const notes: string[] = []
  if (proposal.contradictingEvidenceIds.length === 0) {
    notes.push('未记录反证：请确认已主动检索与假设相矛盾的证据（如确无，可保持为空）')
  }
  if (proposal.counterarguments.length === 0) {
    notes.push('未记录反例或替代解释')
  }
  return notes
}

/** 选题选择的形状校验（actor 由主进程注入，不在此校验身份） */
export function assertTopicSelectable(status: TopicProposal['status']): void {
  if (status === 'selected') {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '该选题已被选定')
  }
  if (status === 'rejected') {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '该选题已被否决，不能选定')
  }
}
