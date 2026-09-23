/**
 * M5-03 compaction 触发策略。
 *
 * 只做廉价阈值判断（budget / 轮数 / retry），在 turn boundary 调用；
 * 绝不做每 turn 全量 scorer 或熵计算。
 */

export interface CompactionTriggerInput {
  tokenEstimate: number
  tokenBudget: number
  turnsSinceLastCompaction?: number
  /** 默认 20 轮。 */
  turnThreshold?: number
  retryCount?: number
  /** 默认 3 次。 */
  retryThreshold?: number
}

export interface CompactionTriggerDecision {
  trigger: boolean
  reasons: string[]
}

const DEFAULT_TURN_THRESHOLD = 20
const DEFAULT_RETRY_THRESHOLD = 3

export function shouldTriggerCompaction(input: CompactionTriggerInput): CompactionTriggerDecision {
  const reasons: string[] = []
  if (input.tokenBudget > 0 && input.tokenEstimate >= input.tokenBudget) {
    reasons.push(`token estimate ${input.tokenEstimate} reached budget ${input.tokenBudget}`)
  }
  const turnThreshold = input.turnThreshold ?? DEFAULT_TURN_THRESHOLD
  if ((input.turnsSinceLastCompaction ?? 0) >= turnThreshold) {
    reasons.push(`turns since last compaction (${input.turnsSinceLastCompaction ?? 0}) reached threshold ${turnThreshold}`)
  }
  const retryThreshold = input.retryThreshold ?? DEFAULT_RETRY_THRESHOLD
  if ((input.retryCount ?? 0) >= retryThreshold) {
    reasons.push(`retry count (${input.retryCount ?? 0}) reached threshold ${retryThreshold}`)
  }
  return { trigger: reasons.length > 0, reasons }
}
