import { atom } from 'jotai'
import { editOwnerGoalAtom, getOwnerGoalEditor, ownerGoalEditorsAtom } from '../../atoms/project-owner-goal-atoms'
import { getOwnerPlanEditor, ownerPlanEditorsAtom } from '../../atoms/project-owner-plan-atoms'
import { getOwnerRuntimeEditor, ownerRuntimeEditorsAtom } from '../../atoms/project-owner-runtime-atoms'
import type { ProjectOwnerGoalSubject } from '@gravitas/shared'

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

/** 只更新Jotai里的未保存Goal输入；不触发保存、准备、费用确认或start。 */
export const applyOwnerClarificationAnswersToGoalAtom = atom(null, (get, set, input: {
  subject: ProjectOwnerGoalSubject
  executionId: string
  linkId: string
  questions: readonly OwnerClarificationQuestionInput[]
  answers: Readonly<Record<string, string>>
}): OwnerClarificationAnswerResult => {
  const goal = getOwnerGoalEditor(get(ownerGoalEditorsAtom), input.subject)
  if (!goal.loaded || !goal.snapshot || goal.loading || goal.saving || goal.conflict || goal.requiresReview) return { ok: false, reason: 'goal_unavailable' }
  const runtime = getOwnerRuntimeEditor(get(ownerRuntimeEditorsAtom), input.subject)
  const plan = getOwnerPlanEditor(get(ownerPlanEditorsAtom), input.subject)
  const run = runtime.runs.find(item => item.link.id === input.linkId)
  const outcome = run?.outcomes.find(item => item.executionId === input.executionId)
  const clarification = outcome?.clarification
  if (!runtime.context || runtime.loading || runtime.saving || runtime.dirty || !run || !clarification
    || outcome?.state !== 'needs_clarification' || clarification.projectId !== input.subject.projectId
    || clarification.taskId !== input.subject.taskId || clarification.goalVersion !== run.link.goalVersion
    || clarification.contextFingerprint !== run.link.contextFingerprint
    || run.link.goalRevision !== goal.snapshot.revision || run.link.goalVersion !== goal.snapshot.goal.goalVersion
    || run.link.planRevision !== (plan.snapshot?.revision ?? 0)
    || runtime.context.goal.revision !== goal.snapshot.revision || runtime.context.fingerprint !== clarification.contextFingerprint
    || JSON.stringify(clarification.questions) !== JSON.stringify(input.questions)) return { ok: false, reason: 'source_stale' }
  const current = goal.constraintsText.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  const result = applyOwnerClarificationAnswers(current, input.questions, input.answers)
  if (!result.ok) return result
  set(editOwnerGoalAtom, { subject: input.subject, patch: { constraintsText: result.constraints.join('\n') } })
  return result
})
