/**
 * 审查与修订回复服务（M7.3）
 *
 * 两部分：
 * 1. **审查发现**：把规则检查与模型建议分别落库，来源标签不可混用
 *    （模型建议强制降级为 warning，见 review-attribution）
 * 2. **修订回复**：外部审稿意见 → 作者逐条回复（含状态与变更引用），
 *    可生成 response-to-reviewers 草稿。回复状态只表示作者声明，
 *    **不代表审稿人认可**（方案 §11.4）。
 */

import { randomUUID } from 'node:crypto'
import type { ApprovalActor, ExternalReviewerComment, ManuscriptVersion, ResearchProject } from '@gravitas/shared'
import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'
import {
  diffManuscriptVersions,
  makeLlmFinding,
  makeRuleFinding,
  summarizeFindings,
  type ReviewFinding,
} from '@gravitas/core/services/academic'
import { appendEvent, loadProjectState, readProjectEvents } from './research-store'
import { assertProjectAccess, currentActor } from './access-guard'

/** 外部审稿意见（来自期刊/合作者；不冒充系统检查） */
export interface ReviewerComment {
  id: string
  projectId: string
  /** 审稿人标识（姓名或编号，由用户提供） */
  reviewerName: string
  /** 意见原文 */
  content: string
  /** 目标章节（可选） */
  targetSection?: string
  severity: 'major' | 'minor' | 'suggestion'
  recordedAt: string
}

/** 作者对某条意见的回复 */
export type RevisionResponseStatus = 'addressed' | 'partially-addressed' | 'rejected' | 'pending'

export interface RevisionResponse {
  id: string
  projectId: string
  commentId: string
  status: RevisionResponseStatus
  /** 回复正文（如何处理的说明） */
  response: string
  /** 关联的稿件版本（若修改体现在某版本） */
  manuscriptVersionId?: string
  /** 关联的主张 id（若涉及主张调整） */
  claimIds: string[]
  /** 回应人（主进程确定） */
  respondedBy: ApprovalActor
  respondedAt: string
}

async function loadProject(id: string): Promise<ResearchProject | null> {
  const state = await loadProjectState(id)
  return state.project
}

// ===== 审查发现 =====

/** 记录规则检查发现（确定性，可标 error） */
export async function recordRuleFinding(
  projectId: string,
  input: { message: string; rule: string; measured: string; expected?: string; severity?: ReviewFinding['severity']; location?: string },
): Promise<ReviewFinding> {
  await assertProjectAccess(projectId, loadProject)
  const finding = makeRuleFinding({ id: randomUUID(), ...input })
  await appendEvent(projectId, {
    commandId: `review-rule-${randomUUID()}`,
    payload: { type: 'review_finding_recorded', finding },
  })
  return finding
}

/**
 * 记录模型建议。
 *
 * 强制要求模型标识与理由；severity 会被降级（不得为 error）。
 */
export async function recordLlmFinding(
  projectId: string,
  input: { message: string; model: string; rationale: string; severity?: ReviewFinding['severity']; location?: string; promptRef?: string },
): Promise<ReviewFinding> {
  await assertProjectAccess(projectId, loadProject)
  const finding = makeLlmFinding({ id: randomUUID(), ...input })
  await appendEvent(projectId, {
    commandId: `review-llm-${randomUUID()}`,
    payload: { type: 'review_finding_recorded', finding },
  })
  return finding
}

/** 列出审查发现（按来源分组，附带分别计数） */
export async function listReviewFindings(projectId: string): Promise<{
  findings: ReviewFinding[]
  summary: ReturnType<typeof summarizeFindings>
}> {
  await assertProjectAccess(projectId, loadProject)
  const events = await readProjectEvents(projectId)
  const findings = events
    .filter((e) => e.payload.type === 'review_finding_recorded')
    .map((e) => (e.payload as { finding: ReviewFinding }).finding)
  return { findings, summary: summarizeFindings(findings) }
}

// ===== 审稿意见与修订回复 =====

/** 登记外部审稿意见 */
export async function recordReviewerComment(
  projectId: string,
  input: { reviewerName: string; content: string; severity: ExternalReviewerComment['severity']; targetSection?: string },
): Promise<ExternalReviewerComment> {
  await assertProjectAccess(projectId, loadProject)
  if (!input.reviewerName?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '审稿意见必须标明来源审稿人')
  }
  if (!input.content?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '审稿意见内容不能为空')
  }

  const comment: ExternalReviewerComment = {
    id: randomUUID(),
    projectId,
    reviewerName: input.reviewerName.trim(),
    content: input.content.trim(),
    targetSection: input.targetSection?.trim() || undefined,
    severity: input.severity,
    recordedAt: new Date().toISOString(),
  }
  await appendEvent(projectId, {
    commandId: `reviewer-comment-${randomUUID()}`,
    payload: { type: 'reviewer_comment_recorded', comment },
  })
  return comment
}

export async function listReviewerComments(projectId: string): Promise<ExternalReviewerComment[]> {
  await assertProjectAccess(projectId, loadProject)
  const events = await readProjectEvents(projectId)
  return events
    .filter((e) => e.payload.type === 'reviewer_comment_recorded')
    .map((e) => (e.payload as { comment: ExternalReviewerComment }).comment)
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
}

export async function listRevisionResponses(projectId: string): Promise<RevisionResponse[]> {
  await assertProjectAccess(projectId, loadProject)
  const events = await readProjectEvents(projectId)
  return events
    .filter((e) => e.payload.type === 'revision_response_recorded')
    .map((e) => (e.payload as { response: RevisionResponse }).response)
}

/**
 * 回复审稿意见。
 *
 * 约束：
 * - 意见必须存在
 * - `addressed` / `partially-addressed` 必须指出修改体现在哪个稿件版本
 *   （否则「已处理」无从核对）
 * - 关联的稿件版本与本项目主张必须真实存在
 */
export async function respondToReviewerComment(
  projectId: string,
  input: {
    commentId: string
    status: RevisionResponseStatus
    response: string
    manuscriptVersionId?: string
    claimIds?: string[]
  },
): Promise<RevisionResponse> {
  await assertProjectAccess(projectId, loadProject)

  if (!input.response?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '回复内容不能为空')
  }

  const comments = await listReviewerComments(projectId)
  if (!comments.some((c) => c.id === input.commentId)) {
    throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `审稿意见不存在: ${input.commentId}`)
  }

  const needsManuscriptRef =
    input.status === 'addressed' || input.status === 'partially-addressed'
  if (needsManuscriptRef && !input.manuscriptVersionId) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      `状态「${input.status}」必须指出修改体现在哪个稿件版本，否则无法核对`,
    )
  }

  if (input.manuscriptVersionId) {
    const { listManuscripts } = await import('./claim-service')
    const manuscripts = await listManuscripts(projectId)
    if (!manuscripts.some((m: ManuscriptVersion) => m.id === input.manuscriptVersionId)) {
      throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `稿件版本不存在: ${input.manuscriptVersionId}`)
    }
  }

  if (input.claimIds && input.claimIds.length > 0) {
    const { listClaims } = await import('./claim-service')
    const claims = await listClaims(projectId)
    const known = new Set(claims.map((c) => c.id))
    for (const claimId of input.claimIds) {
      if (!known.has(claimId)) {
        throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `主张不存在: ${claimId}`)
      }
    }
  }

  const response: RevisionResponse = {
    id: randomUUID(),
    projectId,
    commentId: input.commentId,
    status: input.status,
    response: input.response.trim(),
    manuscriptVersionId: input.manuscriptVersionId,
    claimIds: input.claimIds ?? [],
    respondedBy: currentActor(),
    respondedAt: new Date().toISOString(),
  }

  await appendEvent(projectId, {
    commandId: `revision-response-${randomUUID()}`,
    payload: { type: 'revision_response_recorded', response },
  })
  return response
}

/**
 * 比较两个稿件版本（供修订回复引用「改在哪里」）。
 *
 * 任一版本不存在则拒绝；两个版本可以是任意两个历史版本，
 * 不限于相邻版本。
 */
export async function compareManuscriptVersions(
  projectId: string,
  fromVersionId: string,
  toVersionId: string,
): Promise<ReturnType<typeof diffManuscriptVersions>> {
  await assertProjectAccess(projectId, loadProject)
  const { listManuscripts } = await import('./claim-service')
  const manuscripts = await listManuscripts(projectId)

  const from = manuscripts.find((m) => m.id === fromVersionId)
  const to = manuscripts.find((m) => m.id === toVersionId)
  if (!from) throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `稿件版本不存在: ${fromVersionId}`)
  if (!to) throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `稿件版本不存在: ${toVersionId}`)

  return diffManuscriptVersions(from, to)
}

/**
 * 生成 response-to-reviewers 草稿。
 *
 * 逐条对应，未回复的明确标为待处理——**不隐藏未处理项**。
 * 草稿结尾声明：状态为作者声明，不代表审稿人认可。
 */
export async function buildResponseToReviewersDraft(projectId: string): Promise<{
  items: Array<{
    commentId: string
    reviewerName: string
    comment: string
    severity: ExternalReviewerComment['severity']
    status: RevisionResponseStatus | 'no-response'
    response?: string
    manuscriptVersionId?: string
  }>
  pendingCount: number
  disclaimer: string
}> {
  await assertProjectAccess(projectId, loadProject)
  const [comments, responses] = await Promise.all([
    listReviewerComments(projectId),
    listRevisionResponses(projectId),
  ])

  const items = comments.map((comment) => {
    const response = responses.find((r) => r.commentId === comment.id)
    return {
      commentId: comment.id,
      reviewerName: comment.reviewerName,
      comment: comment.content,
      severity: comment.severity,
      status: (response?.status ?? 'no-response') as RevisionResponseStatus | 'no-response',
      response: response?.response,
      manuscriptVersionId: response?.manuscriptVersionId,
    }
  })

  return {
    items,
    pendingCount: items.filter((i) => i.status === 'no-response' || i.status === 'pending').length,
    disclaimer:
      '本回复状态为作者声明（已处理/部分处理/未采纳），不代表审稿人认可；稿件质量仍需同行评审确认。',
  }
}
