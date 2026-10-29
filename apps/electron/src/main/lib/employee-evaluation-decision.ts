export type EmployeeEvaluationDecision = 'candidate_created' | 'no_accepted_candidate' | 'judge_not_independent' | 'held_out_unavailable' | 'held_out_regression'

/** 缺失或非有限的 held-out 证据不能代入零分，也不能据此比较或推广。 */
export function decideEmployeeEvaluation(input: { judgeIndependent: boolean; heldOutBaseline: number | null; heldOutFinal: number | null; acceptedRounds: number; content?: string }): EmployeeEvaluationDecision {
  if (!input.judgeIndependent) return 'judge_not_independent'
  if (input.heldOutBaseline === null || input.heldOutFinal === null || !Number.isFinite(input.heldOutBaseline) || !Number.isFinite(input.heldOutFinal) || input.heldOutBaseline < 0 || input.heldOutBaseline > 100 || input.heldOutFinal < 0 || input.heldOutFinal > 100) return 'held_out_unavailable'
  if (input.heldOutFinal < input.heldOutBaseline) return 'held_out_regression'
  if (!input.content || !Number.isSafeInteger(input.acceptedRounds) || input.acceptedRounds <= 0) return 'no_accepted_candidate'
  return 'candidate_created'
}
