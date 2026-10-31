/**
 * 一次扫描的判断编排：解析 → 确定性去重 → 落账本。
 *
 * 这里不碰网络，只处理"模型已经返回了什么"。任何一环不成立都降级为
 * insufficient_evidence 并保留原因，不抛到调度层、不伪造结论。
 */
import type { ProjectWebChangeObservation, WebChangeJudgment } from '@gravitas/shared'
import {
  applyDeterministicDedup,
  recordProjectWebChangeObservation,
  type RecordWebChangeObservationInput,
} from './project-web-change-observations'
import {
  buildWebObservationRecordInput,
  insufficientEvidenceCandidate,
  parseWebObservationResponse,
  type WebObservationCandidate,
} from './project-web-observation-parse'
import type { WebObservationSource } from './project-web-observation-prompt'
import { isObservationMuted } from './project-web-observation-feedback'

export interface JudgeWebObservationInput {
  projectId: string
  runId: string
  /** 模型原始响应；调用失败时传 null 并给 failureReason。 */
  rawResponse: string | null
  /** 模型调用本身失败的原因（超时、HTTP 错误等）；与解析失败区分记录。 */
  callFailureReason?: string | null
  sources: WebObservationSource[]
  topics: string[]
  goalRevision: number | null
  contextFingerprint: string | null
  modelId: string | null
  promptVersion: number
  sourcesCount: number
  truncated: boolean
  /** 账本中可用于 duplicate 指向的既有观察 id。 */
  existingObservationIds?: string[]
  createdAt?: number
}

export interface JudgeWebObservationResult {
  observation: ProjectWebChangeObservation | null
  judgment: WebChangeJudgment
  /** 非空表示这次判断没有按模型结论完成，原因同时写进观察记录。 */
  failureReason: string | null
  repeatedSourceIds: string[]
}

function dedupCandidate(candidate: WebObservationCandidate, dedup: ReturnType<typeof applyDeterministicDedup>): WebObservationCandidate {
  return {
    ...candidate,
    judgment: dedup.judgment,
    duplicateOf: dedup.duplicateOf,
    duplicateReason: dedup.duplicateReason,
    relatedObservationIds: dedup.relatedObservationIds,
  }
}

/** 判断并落账；返回值里的 judgment 是最终写进账本的判定（可能被去重层改写）。 */
export function judgeAndRecordWebObservation(input: JudgeWebObservationInput): JudgeWebObservationResult {
  let candidate: WebObservationCandidate
  let failureReason: string | null = null

  if (input.rawResponse === null) {
    failureReason = input.callFailureReason?.trim() || '模型调用未返回内容'
    candidate = insufficientEvidenceCandidate(failureReason)
  } else {
    const parsed = parseWebObservationResponse(input.rawResponse, {
      sources: input.sources,
      existingObservationIds: input.existingObservationIds ?? [],
    })
    if (parsed.ok) {
      candidate = parsed.candidate
    } else {
      failureReason = parsed.failureReason
      candidate = insufficientEvidenceCandidate(parsed.failureReason)
    }
  }

  const dedup = applyDeterministicDedup({
    projectId: input.projectId,
    judgment: candidate.judgment,
    facts: candidate.facts,
    sources: input.sources,
    relatedObservationIds: candidate.relatedObservationIds,
    duplicateOf: candidate.duplicateOf,
    duplicateReason: candidate.duplicateReason,
  })

  // 用户已把这类来源标记为不相关或暂不关注时，不再占用注意力，但记录仍保留。
  const muted = dedup.judgment !== 'duplicate'
    && (dedup.judgment === 'attention' || dedup.judgment === 'decision_required')
    && isObservationMuted(input.projectId, dedupCandidate(candidate, dedup).facts)
  const finalCandidate = muted
    ? {
      ...dedupCandidate(candidate, dedup),
      judgment: 'record_only' as const,
      uncertainty: '该来源已被你标记为不相关或暂不提醒，本次只记录不提醒。',
    }
    : dedupCandidate(candidate, dedup)

  const recordInput: RecordWebChangeObservationInput = buildWebObservationRecordInput({
    projectId: input.projectId,
    runId: input.runId,
    candidate: finalCandidate,
    sources: input.sources,
    topics: input.topics,
    goalRevision: input.goalRevision,
    contextFingerprint: input.contextFingerprint,
    modelId: input.modelId,
    promptVersion: input.promptVersion,
    sourcesCount: input.sourcesCount,
    truncated: input.truncated,
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
  })

  try {
    const observation = recordProjectWebChangeObservation(recordInput)
    return { observation, judgment: finalCandidate.judgment, failureReason, repeatedSourceIds: dedup.repeatedSourceIds }
  } catch (error) {
    // 账本拒绝也要可追溯：再试一次纯降级记录，仍失败则如实返回空观察。
    const reason = error instanceof Error ? error.message : String(error)
    const fallback = buildWebObservationRecordInput({
      projectId: input.projectId, runId: input.runId, candidate: insufficientEvidenceCandidate(`观察记录被拒绝：${reason}`),
      sources: [], topics: input.topics, goalRevision: input.goalRevision, contextFingerprint: input.contextFingerprint,
      modelId: input.modelId, promptVersion: input.promptVersion, sourcesCount: input.sourcesCount, truncated: input.truncated,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
    try {
      const observation = recordProjectWebChangeObservation(fallback)
      return { observation, judgment: 'insufficient_evidence', failureReason: `观察记录被拒绝：${reason}`, repeatedSourceIds: [] }
    } catch {
      return { observation: null, judgment: 'insufficient_evidence', failureReason: `观察记录被拒绝：${reason}`, repeatedSourceIds: [] }
    }
  }
}
