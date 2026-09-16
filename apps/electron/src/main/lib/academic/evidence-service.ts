/**
 * 证据抽取应用服务（M2 第二批）
 *
 * 片段挂到具体来源版本并落事件流；agent 建议的摘录
 * extractionMode=agent-suggested，需人工确认（M5 消费）。
 */

import { randomUUID } from 'node:crypto'
import type { EvidenceExcerpt, EvidenceLocator, ResearchProject } from '@gravitas/shared'
import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'
import { validateEvidenceExcerpt } from '@gravitas/core/services/academic'
import { appendEvent, loadProjectState } from './research-store'

async function requireProject(projectId: string): Promise<ResearchProject> {
  const state = await loadProjectState(projectId)
  if (!state.project) {
    throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `研究项目不存在: ${projectId}`)
  }
  return state.project
}

/** 抽取一条证据 */
export async function extractEvidence(
  projectId: string,
  input: {
    sourceId: string
    sourceVersionId: string
    text: string
    locator: EvidenceLocator
    note?: string
    extractionMode?: EvidenceExcerpt['extractionMode']
  },
): Promise<EvidenceExcerpt> {
  await requireProject(projectId)

  // 来源必须属于本项目
  const { listSources } = await import('./source-service')
  const sources = await listSources(projectId)
  const source = sources.find((s) => s.id === input.sourceId)
  if (!source) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `来源不属于本项目: ${input.sourceId}`)
  }
  if (!source.versions.some((v) => v.id === input.sourceVersionId)) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      `来源版本不存在: ${input.sourceVersionId}`,
    )
  }

  validateEvidenceExcerpt(
    { text: input.text, locator: input.locator, sourceVersionId: input.sourceVersionId },
    source.versions,
  )

  const evidence: EvidenceExcerpt = {
    id: randomUUID(),
    projectId,
    sourceId: input.sourceId,
    sourceVersionId: input.sourceVersionId,
    text: input.text.trim(),
    locator: input.locator,
    note: input.note?.trim() || undefined,
    extractionMode: input.extractionMode ?? 'manual',
    createdAt: new Date().toISOString(),
  }

  await appendEvent(projectId, {
    commandId: `evidence-${randomUUID()}`,
    payload: { type: 'evidence_extracted', evidence },
  })
  return evidence
}

/** 列出项目全部证据（按时间倒序） */
export async function listEvidence(projectId: string): Promise<EvidenceExcerpt[]> {
  await requireProject(projectId)
  const { readProjectEvents } = await import('./research-store')
  const events = await readProjectEvents(projectId)
  return events
    .filter((e) => e.payload.type === 'evidence_extracted')
    .map((e) => (e.payload as { evidence: EvidenceExcerpt }).evidence)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
