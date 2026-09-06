import type { ContextPacket } from '@gravitas/shared'

export interface ContextCompactionGoldenCase {
  id: string
  requiredFacts?: string[]
  requiredDecisions?: string[]
  requiredOpenTasks?: string[]
}

export interface ContextCompactionEvaluation {
  caseId: string
  passed: boolean
  score: number
  missing: string[]
}

export function evaluateContextPacket(packet: ContextPacket, golden: ContextCompactionGoldenCase): ContextCompactionEvaluation {
  const required = [
    ...(golden.requiredFacts ?? []).map((value) => ({ field: 'facts', value, values: packet.facts })),
    ...(golden.requiredDecisions ?? []).map((value) => ({ field: 'decisions', value, values: packet.decisions })),
    ...(golden.requiredOpenTasks ?? []).map((value) => ({ field: 'openTasks', value, values: packet.openTasks })),
  ]
  const missing = required
    .filter(({ value, values }) => !values.some((item) => item.includes(value)))
    .map(({ field, value }) => `${field}:${value}`)
  return {
    caseId: golden.id,
    passed: missing.length === 0,
    score: required.length === 0 ? 1 : (required.length - missing.length) / required.length,
    missing,
  }
}


export interface ContextCompactionGoldenSetEvaluation {
  passed: boolean
  score: number
  evaluations: ContextCompactionEvaluation[]
}

/** 执行固定 Golden 基线；任意必需事实、决策或待办丢失即阻断质量门。 */
export function evaluateContextCompactionGoldenSet(fixtures: ReadonlyArray<{ golden: ContextCompactionGoldenCase; packet: ContextPacket }>): ContextCompactionGoldenSetEvaluation {
  const evaluations = fixtures.map(({ packet, golden }) => evaluateContextPacket(packet, golden))
  const score = evaluations.length === 0 ? 1 : evaluations.reduce((total, evaluation) => total + evaluation.score, 0) / evaluations.length
  return { passed: evaluations.every((evaluation) => evaluation.passed), score, evaluations }
}
