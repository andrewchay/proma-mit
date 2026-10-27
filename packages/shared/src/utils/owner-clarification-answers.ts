export interface OwnerClarificationQuestionInput {
  key: string
  question: string
}
export type OwnerClarificationAnswerResult =
  | { ok: true; constraints: string[] }
  | { ok: false; reason: 'invalid' | 'incomplete' | 'too_long' | 'too_many' | 'goal_unavailable' | 'source_stale' }
const MAX_CONSTRAINTS = 32
const MAX_CONSTRAINT_LENGTH = 2000
const ANSWER_PREFIX = 'Owner澄清答复'

/** 纯转换：只返回可由用户审阅的Goal约束草案，不写IPC或数据库。 */
export function applyOwnerClarificationAnswers(
  currentConstraints: readonly string[],
  questions: readonly OwnerClarificationQuestionInput[],
  answers: Readonly<Record<string, string>>,
): OwnerClarificationAnswerResult {
  if (!Array.isArray(currentConstraints) || !Array.isArray(questions) || questions.length === 0
    || currentConstraints.some(item => typeof item !== 'string') || !answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return { ok: false, reason: 'invalid' }
  }
  if (new Set(questions.map(item => item.key)).size !== questions.length
    || new Set(questions.map(item => item.question?.trim())).size !== questions.length
    || questions.some(item => typeof item.key !== 'string' || !item.key.trim() || typeof item.question !== 'string' || !item.question.trim())) {
    return { ok: false, reason: 'invalid' }
  }
  const next = [...currentConstraints]
  for (const item of questions) {
    const rawAnswer = answers[item.key]
    if (typeof rawAnswer !== 'string' || !rawAnswer.trim()) return { ok: false, reason: 'incomplete' }
    const answer = rawAnswer.trim().replace(/\s+/g, ' ')
    const prefix = `${ANSWER_PREFIX}（${item.question.trim()}）：`
    const constraint = `${prefix}${answer}`
    if (constraint.length > MAX_CONSTRAINT_LENGTH) return { ok: false, reason: 'too_long' }
    const remaining = next.filter(existing => !existing.startsWith(prefix))
    if (remaining.length >= MAX_CONSTRAINTS) return { ok: false, reason: 'too_many' }
    remaining.push(constraint)
    next.splice(0, next.length, ...remaining)
  }
  if (next.length > MAX_CONSTRAINTS) return { ok: false, reason: 'too_many' }
  return { ok: true, constraints: next }
}
