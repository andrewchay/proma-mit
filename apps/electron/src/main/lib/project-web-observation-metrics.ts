/**
 * 外部变化观察的质量汇总：给真实项目观察期用的只读统计。
 *
 * 只聚合账本里已有的事实，不做推断，也不把"未确认"补成数字。
 */
import type { WebChangeJudgment } from '@gravitas/shared'
import { listProjectWebChangeObservations } from './project-web-change-observations'
import { listWebObservationFeedback } from './project-web-observation-feedback'

export interface WebObservationQualitySummary {
  observations: number
  byJudgment: Record<WebChangeJudgment, number>
  /** 重复判定占比；没有观察时为 null，不写成 0。 */
  duplicateRate: number | null
  insufficientRate: number | null
  /** 事实条数与其中发布时间无法确认的条数；后者占比用于评估时间可靠性。 */
  factsTotal: number
  factsWithoutPublishedAt: number
  inferencesTotal: number
  /** 被截断的判断轮次：上下文超限时模型只能看到部分来源。 */
  truncatedObservations: number
  feedback: { helpful: number; irrelevant: number; snooze: number }
}

const EMPTY_BY_JUDGMENT: Record<WebChangeJudgment, number> = {
  record_only: 0,
  attention: 0,
  decision_required: 0,
  insufficient_evidence: 0,
  duplicate: 0,
}

export function summarizeWebObservationQuality(projectId: string, since = 0, limit = 200): WebObservationQualitySummary {
  const observations = listProjectWebChangeObservations(projectId, limit).filter((item) => item.createdAt >= since)
  const byJudgment = { ...EMPTY_BY_JUDGMENT }
  let factsTotal = 0
  let factsWithoutPublishedAt = 0
  let inferencesTotal = 0
  let truncatedObservations = 0
  for (const observation of observations) {
    byJudgment[observation.judgment] += 1
    if (observation.evaluation.truncated) truncatedObservations += 1
    for (const fact of observation.facts) {
      if (fact.isInference) { inferencesTotal += 1; continue }
      factsTotal += 1
      if (!fact.publishedAt) factsWithoutPublishedAt += 1
    }
  }
  const total = observations.length
  const feedback = { helpful: 0, irrelevant: 0, snooze: 0 }
  for (const item of listWebObservationFeedback(projectId, 50)) {
    if (item.createdAt < since) continue
    feedback[item.verdict] += 1
  }
  return {
    observations: total,
    byJudgment,
    duplicateRate: total ? byJudgment.duplicate / total : null,
    insufficientRate: total ? byJudgment.insufficient_evidence / total : null,
    factsTotal,
    factsWithoutPublishedAt,
    inferencesTotal,
    truncatedObservations,
    feedback,
  }
}
