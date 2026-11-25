import type { OwnerReviewHistory } from '@gravitas/shared'
import { readOwnerQualityAction } from './project-owner-quality-actions'
import { listOwnerTechnicalReviewEvidence } from './project-owner-technical-review'
import { canRetryOwnerMarkdownReview, readInterruptedOwnerMarkdownReview } from './project-owner-document-review-retry'
import { canSupplementOwnerCounterReview, readOwnerCounterSupplement } from './project-owner-counter-supplement'
import { isOwnerValidationEvidenceExpired } from './development-validation-acceptance'
import * as store from './project-sqlite-store'

interface ReviewRound {
  id: string
  reviewer_id: string | null
  task_id: string
  scope_id: string | null
  ordinal: number
  state: string | null
  execution_status: string | null
  executor_status: string | null
  executor_state: string | null
  executor_delivery_hash: string | null
  executor_completed_at: number | null
  review_completed_at: number | null
}

/** 从同一任务、授权和返工轮次的权威记录构造解释。 */
export function listOwnerReviewHistory(projectId: string): OwnerReviewHistory[] {
  const rounds = store.getProjectDb().prepare(`SELECT x.id, r.id AS reviewer_id, x.source_task_id AS task_id, g.task_id AS scope_id,
    x.rework_ordinal AS ordinal, r.state, re.status AS execution_status, ee.status AS executor_status,
    x.state AS executor_state, x.text_delivery_hash AS executor_delivery_hash,
    ee.completed_at AS executor_completed_at, re.completed_at AS review_completed_at
    FROM project_owner_execution_commands x
    JOIN project_owner_execution_grants g ON g.id=x.grant_id AND g.project_id=x.project_id
    LEFT JOIN project_owner_execution_commands r ON r.project_id=x.project_id AND r.grant_id=x.grant_id
      AND r.source_task_id=x.source_task_id AND r.source_step_link_id=x.source_step_link_id AND r.rework_ordinal=x.rework_ordinal AND r.role='reviewer'
      AND NOT EXISTS (SELECT 1 FROM project_owner_document_review_retries d
        JOIN project_owner_execution_commands q ON q.id=d.reviewer_id WHERE d.previous_reviewer_id=r.id)
    LEFT JOIN agent_executions re ON re.id=r.execution_id AND re.project_id=r.project_id AND re.owner_command_id=r.id
    LEFT JOIN agent_executions ee ON ee.id=x.execution_id AND ee.project_id=x.project_id AND ee.owner_command_id=x.id
    WHERE x.project_id=? AND x.role='executor' AND (
      x.id IN (SELECT recent.id FROM project_owner_execution_commands recent
        WHERE recent.project_id=x.project_id AND recent.role='executor' ORDER BY recent.created_at DESC, recent.id LIMIT 12)
      OR x.id=(SELECT latest.id FROM project_owner_execution_commands latest
        WHERE latest.project_id=x.project_id AND latest.source_task_id=x.source_task_id AND latest.role='executor'
        ORDER BY latest.created_at DESC, latest.id LIMIT 1)
    )
    ORDER BY x.created_at DESC, x.id`).all(projectId) as ReviewRound[]
  if (!rounds.length) return []
  let reviews: ReturnType<typeof listOwnerTechnicalReviewEvidence>
  try { reviews = listOwnerTechnicalReviewEvidence(projectId, undefined, rounds.flatMap(round => round.reviewer_id ? [round.reviewer_id] : []), false) } catch { reviews = [] }
  const reviewByCommand = new Map(reviews.map(review => [review.reviewerCommandId, review]))
  return rounds.map(round => {
    const review = round.reviewer_id ? reviewByCommand.get(round.reviewer_id) : undefined
    const verified = review?.artifactVerified === true
    const steps: OwnerReviewHistory['steps'] = [
      { label: '员工交付', ...(round.executor_completed_at === null ? {} : { at: round.executor_completed_at }), detail: round.executor_status === 'completed' && round.executor_state === 'settled'
        ? verified || round.executor_delivery_hash ? '成果版本已保存。' : '员工执行已结束，完整成果版本待核对。'
        : round.executor_status === 'running' ? '员工正在执行。'
        : round.executor_status === 'queued' ? '等待员工开始。' : '员工成果或结算待核对。' },
      { label: '独立评审', ...(round.review_completed_at === null ? {} : { at: round.review_completed_at }), detail: round.state === 'needs_reconcile' ? '评审运行或费用待核对。'
        : verified ? `${review.verdict === 'approved' ? '通过' : review.verdict === 'changes_requested' ? '建议返工' : '存在阻塞'}。\n${review.blockerReason ?? review.summary}`
        : round.execution_status === 'completed' ? '评审运行已结束，回执或成果版本待核对。'
        : round.execution_status === 'running' ? '正在评审。' : '等待可核验的评审回执。' },
    ]
    let decision = verified ? '等待 Owner 根据本轮评审作出决定。' : '等待独立评审及成果证据通过核对。'
    let decidedAt: number | undefined
    let qualityState: OwnerReviewHistory['qualityState']
    try {
      const action = round.reviewer_id ? readOwnerQualityAction(round.reviewer_id) : null
      if (action) { decision = `${action.detail}\n${action.decision.reason}`; decidedAt = action.createdAt; qualityState = action.state }
    } catch { decision = 'Owner 决定记录待核对。' }
    let counterSupplementReviewerId: string | undefined
    if (review && ['blocked', 'escalated'].includes(qualityState ?? '') && canSupplementOwnerCounterReview(review)) {
      try {
        const supplement = readOwnerCounterSupplement(review.reviewerCommandId)
        if (!supplement || isOwnerValidationEvidenceExpired(supplement.validation)) counterSupplementReviewerId = review.reviewerCommandId
        else steps.push({ label: '浏览器补测', detail: '原成果已通过初值、加一和重置验证，等待 Owner 核对。', at: supplement.validation.finishedAt })
      } catch { steps.push({ label: '浏览器补测', detail: '补测记录需要核对。' }) }
    }
    const markdownRetry = review && ['blocked', 'escalated'].includes(qualityState ?? '') && canRetryOwnerMarkdownReview(review)
      && !store.getProjectDb().prepare(`SELECT 1 FROM project_owner_document_review_retries retry
        JOIN project_owner_execution_commands c ON c.id=retry.reviewer_id WHERE retry.previous_reviewer_id=?`).get(review.reviewerCommandId)
      ? review.reviewerCommandId : undefined
    let interruptedMarkdownReview = false
    if (round.reviewer_id && round.state === 'needs_reconcile' && round.execution_status === 'failed') {
      try { interruptedMarkdownReview = Boolean(readInterruptedOwnerMarkdownReview(projectId, round.reviewer_id)) } catch { /* 证据无法核验时保留原暂停状态。 */ }
    }
    steps.push({ label: 'Owner 决定', detail: decision, ...(decidedAt === undefined ? {} : { at: decidedAt }) })
    return { id: round.id, ...(round.scope_id ? { taskId: round.scope_id } : {}), businessTaskId: round.task_id, ...(qualityState ? { qualityState } : {}), ...(counterSupplementReviewerId ? { counterSupplementReviewerId } : {}), ...(markdownRetry || interruptedMarkdownReview ? { markdownRetryReviewerId: markdownRetry ?? round.reviewer_id! } : {}), ...(interruptedMarkdownReview ? { interruptedMarkdownReview: true as const } : {}), title: store.getTask(round.task_id)?.title ?? '项目任务', reworkOrdinal: round.ordinal, steps }
  })
}
