import { atom } from 'jotai'
import { editOwnerGoalAtom, getOwnerGoalEditor, ownerGoalEditorsAtom } from '../../atoms/project-owner-goal-atoms'
import { getOwnerPlanEditor, ownerPlanEditorsAtom } from '../../atoms/project-owner-plan-atoms'
import { getOwnerRuntimeEditor, ownerRuntimeEditorsAtom } from '../../atoms/project-owner-runtime-atoms'
import type { ProjectOwnerGoalSubject } from '@gravitas/shared'

import { applyOwnerClarificationAnswers, type OwnerClarificationQuestionInput, type OwnerClarificationAnswerResult } from '@gravitas/shared'
export { applyOwnerClarificationAnswers, type OwnerClarificationQuestionInput, type OwnerClarificationAnswerResult } from '@gravitas/shared'

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
