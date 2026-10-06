/**
 * M5-04 compaction 成功边界守卫。
 *
 * 与 Pi 自动压缩的既有约定对齐：中止、报错或没有结果的压缩
 * 不得伪造成功边界（compact_boundary），也不得写成功审计。
 * 本模块只固化判定契约；生产 Pi 路径保持不变（TCC 默认关闭）。
 */

export type CompactionOutcomeStatus = 'ok' | 'aborted' | 'error' | 'empty'

export interface CompactionOutcome {
  status: CompactionOutcomeStatus
  summary?: string
  retainedItemIds?: readonly string[]
  tokenEstimate?: number
}

export interface CompactionBoundaryDecision {
  writeBoundary: boolean
  /** 审计类型；与现有 `pi/automatic` 审计口径一致。 */
  auditKind: 'pi/automatic' | null
  reason: string
}

export function evaluateCompactionBoundary(outcome: CompactionOutcome): CompactionBoundaryDecision {
  switch (outcome.status) {
    case 'aborted':
      return { writeBoundary: false, auditKind: null, reason: 'compaction aborted: no success boundary may be written' }
    case 'error':
      return { writeBoundary: false, auditKind: null, reason: 'compaction errored: no success boundary may be written' }
    case 'empty':
      return { writeBoundary: false, auditKind: null, reason: 'compaction produced no result: no success boundary may be written' }
    case 'ok':
      break
  }
  const hasContent = (outcome.retainedItemIds?.length ?? 0) > 0 && isNonEmptyString(outcome.summary)
  if (!hasContent) {
    return { writeBoundary: false, auditKind: null, reason: 'compaction result is missing summary or retained items: no success boundary may be written' }
  }
  return { writeBoundary: true, auditKind: 'pi/automatic', reason: 'compaction completed with retained content' }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
