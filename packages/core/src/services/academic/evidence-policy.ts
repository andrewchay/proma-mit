/**
 * 证据政策（M2 第二批，纯函数无 IO）
 *
 * 方案 §6/§11.4：只有「原文片段 + 定位器」才构成证据；
 * 无定位器的引语不得进入台账；agent 建议的摘录标记为
 * agent-suggested，需人工确认后才能参与后续论证（M5）。
 */

import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'
import type { EvidenceExcerpt, EvidenceLocator, SourceVersion } from '@gravitas/shared'

export type { EvidenceExcerpt, EvidenceLocator }

/** 校验定位器结构合法性 */
export function validateEvidenceLocator(locator: EvidenceLocator): void {
  switch (locator.kind) {
    case 'pdf-page':
    case 'page':
      if (!Number.isInteger(locator.page) || locator.page < 1) {
        throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `页码必须为正整数: ${String((locator as { page: unknown }).page)}`)
      }
      break
    case 'section':
      if (!locator.label?.trim()) {
        throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '章节定位不能为空')
      }
      break
    case 'timestamp': {
      if (!Number.isFinite(locator.startSeconds) || locator.startSeconds < 0) {
        throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '时间戳必须为非负秒数')
      }
      if (locator.endSeconds !== undefined && locator.endSeconds <= locator.startSeconds) {
        throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '结束时间必须晚于开始时间')
      }
      break
    }
    case 'url':
      if (!locator.url?.trim()) {
        throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, 'URL 定位不能为空')
      }
      break
    case 'table':
      if (!locator.tableId?.trim()) {
        throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '表格 ID 不能为空')
      }
      break
    default: {
      const unknown = locator as { kind?: string }
      throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `未知定位器类型: ${String(unknown.kind)}`)
    }
  }
}

/** 校验一条候选证据（片段 + 定位器 + 来源归属） */
export function validateEvidenceExcerpt(
  input: Pick<EvidenceExcerpt, 'text' | 'locator'> & { sourceVersionId: string },
  sourceVersions: SourceVersion[],
): void {
  if (!input.text?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '证据片段不能为空（模型生成的摘要不是证据，必须来自原文）')
  }
  if (input.text.length > 20000) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '证据片段过长（≤20000 字符）——请抽取关键句而非整章')
  }
  validateEvidenceLocator(input.locator)
  if (!sourceVersions.some((v) => v.id === input.sourceVersionId)) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      `证据必须挂到本项目的来源版本上: ${input.sourceVersionId}`,
    )
  }
}

/** 证据的展示状态（M5 主张关联前只有两级） */
export function evidenceConfirmationStatus(
  evidence: Pick<EvidenceExcerpt, 'extractionMode'>,
): 'needs_review' | 'confirmed' {
  return evidence.extractionMode === 'agent-suggested' ? 'needs_review' : 'confirmed'
}

/** 定位器的可读描述（UI 展示） */
export function describeLocator(locator: EvidenceLocator): string {
  switch (locator.kind) {
    case 'pdf-page':
      return `PDF 第 ${locator.page} 页${locator.anchor ? `（${locator.anchor}）` : ''}`
    case 'page':
      return `第 ${locator.page} 页`
    case 'section':
      return `章节「${locator.label}」`
    case 'timestamp': {
      const end = locator.endSeconds !== undefined ? `–${locator.endSeconds}s` : ''
      return `${locator.startSeconds}s${end}`
    }
    case 'url':
      return locator.url
    case 'table':
      return `表格 ${locator.tableId}${locator.row ? ` 行 ${locator.row}` : ''}`
  }
}
