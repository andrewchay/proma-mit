/**
 * 选题候选应用服务（M3.2）
 *
 * 创建候选、列举、人工选定/否决。
 * 「选定」是人的决定：actor 由 access-guard 从主进程注入，
 * 调用方（含 Agent）不能指定操作者，也不能传入评分来替代判断。
 */

import { randomUUID } from 'node:crypto'
import type { ResearchProject, TopicProposal } from '@gravitas/shared'
import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'
import {
  assertTopicSelectable,
  topicRecordednessGaps,
  validateTopicProposal,
  type TopicProposalDraft,
} from '@gravitas/core/services/academic'
import { appendEvent, loadProjectState, readProjectEvents } from './research-store'
import { assertProjectAccess, currentActor } from './access-guard'

async function loadProject(id: string): Promise<ResearchProject | null> {
  const state = await loadProjectState(id)
  return state.project
}

/** 列出项目全部选题候选（最近在前） */
export async function listTopicProposals(
  projectId: string,
): Promise<Array<TopicProposal & { recordednessGaps: string[] }>> {
  await assertProjectAccess(projectId, loadProject)
  const events = await readProjectEvents(projectId)

  const proposals = new Map<string, TopicProposal>()
  for (const envelope of events) {
    const payload = envelope.payload
    if (payload.type === 'topic_proposed') proposals.set(payload.proposal.id, payload.proposal)
    if (payload.type === 'topic_rejected') {
      const target = proposals.get(payload.proposalId)
      if (target) target.status = 'rejected'
    }
    if (payload.type === 'topic_selected') {
      const target = proposals.get(payload.proposalId)
      if (target) {
        target.status = 'selected'
        target.selection = {
          selectedBy: payload.selectedBy,
          selectedAt: envelope.at,
          reason: payload.reason,
        }
      }
    }
  }

  return [...proposals.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((p) => ({ ...p, recordednessGaps: topicRecordednessGaps(p) }))
}

/** 创建选题候选 */
export async function createTopicProposal(
  projectId: string,
  draft: TopicProposalDraft,
): Promise<TopicProposal> {
  await assertProjectAccess(projectId, loadProject)

  // 证据必须真实存在于本项目台账
  const { listEvidence } = await import('./evidence-service')
  const evidence = await listEvidence(projectId)
  validateTopicProposal(draft, evidence.map((e) => e.id))

  const proposal: TopicProposal = {
    id: randomUUID(),
    projectId,
    title: draft.title.trim(),
    question: draft.question.trim(),
    gapType: draft.gapType,
    supportingEvidenceIds: draft.supportingEvidenceIds ?? [],
    contradictingEvidenceIds: draft.contradictingEvidenceIds ?? [],
    gapRationale: draft.gapRationale.trim(),
    counterarguments: draft.counterarguments ?? [],
    noveltyCheck: draft.noveltyCheck,
    plannedDatabases: draft.plannedDatabases ?? [],
    status: 'candidate',
    createdAt: new Date().toISOString(),
  }

  await appendEvent(projectId, {
    commandId: `topic-${randomUUID()}`,
    payload: { type: 'topic_proposed', proposal },
  })
  return proposal
}

/**
 * 选定选题（人的决定）。
 *
 * 同时选定多个候选时，其余保持 candidate；研究者可显式否决。
 */
export async function selectTopicProposal(
  projectId: string,
  proposalId: string,
  input: { reason?: string; force?: boolean } = {},
): Promise<TopicProposal> {
  await assertProjectAccess(projectId, loadProject)
  const all = await listTopicProposals(projectId)
  const target = all.find((p) => p.id === proposalId)
  if (!target) {
    throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `选题候选不存在: ${proposalId}`)
  }
  assertTopicSelectable(target.status)

  // 如实记录项是提示而非硬门禁；除非调用方显式 force，否则缺项需先确认
  if (!input.force && target.recordednessGaps.length > 0) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      `选定前请先处理以下记录缺口（或显式 force 确认接受）：${target.recordednessGaps.join('；')}`,
    )
  }

  const actor = currentActor()
  await appendEvent(projectId, {
    commandId: `topic-select-${randomUUID()}`,
    payload: { type: 'topic_selected', proposalId, selectedBy: actor, reason: input.reason },
  })

  const refreshed = (await listTopicProposals(projectId)).find((p) => p.id === proposalId)!
  return refreshed
}

/** 否决选题候选 */
export async function rejectTopicProposal(
  projectId: string,
  proposalId: string,
  reason: string,
): Promise<{ proposalId: string; status: 'rejected' }> {
  await assertProjectAccess(projectId, loadProject)
  if (!reason?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '否决选题必须说明理由')
  }
  const all = await listTopicProposals(projectId)
  const target = all.find((p) => p.id === proposalId)
  if (!target) {
    throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `选题候选不存在: ${proposalId}`)
  }
  if (target.status === 'selected') {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '已选定的选题不能直接否决')
  }
  await appendEvent(projectId, {
    commandId: `topic-reject-${randomUUID()}`,
    payload: { type: 'topic_rejected', proposalId, reason: reason.trim() },
  })
  return { proposalId, status: 'rejected' }
}
