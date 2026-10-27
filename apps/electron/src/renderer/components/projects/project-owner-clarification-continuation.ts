import { atom } from 'jotai'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from '@/atoms/project-owner-goal-atoms'
import { getOwnerPlanEditor, ownerPlanEditorsAtom } from '@/atoms/project-owner-plan-atoms'
import { getOwnerRuntimeEditor, ownerRuntimeEditorsAtom, prepareOwnerRuntimeAtom } from '@/atoms/project-owner-runtime-atoms'
import { shouldPrepareOwnerClarificationFollowUp } from './project-owner-planning-flow'

/** 新目标已经保存且来源复核通过时，只做无费准备；不调用模型。 */
export const resumeOwnerClarificationAfterSaveAtom = atom(null, async (get, set, input: { projectId: string; taskId?: string; linkId: string; executionId: string }): Promise<boolean> => {
  const subject = { projectId: input.projectId, ...(input.taskId === undefined ? {} : { taskId: input.taskId }) }
  const goal = getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject)
  const plan = getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject)
  const runtime = getOwnerRuntimeEditor(get(ownerRuntimeEditorsAtom), subject)
  const run = runtime.runs.find(item => item.link.id === input.linkId)
  const clarification = run?.outcomes.find(item => item.executionId === input.executionId && item.state === 'needs_clarification')?.clarification
  if (!run || !clarification || !goal.snapshot || !runtime.binding
    || goal.loading || goal.saving || goal.dirty || goal.conflict || goal.requiresReview
    || plan.loading || plan.saving || plan.dirty || plan.conflict || plan.requiresReview
    || runtime.loading || runtime.saving || runtime.dirty || !runtime.context) return false
  const eligible = shouldPrepareOwnerClarificationFollowUp({
    goal: { revision: goal.snapshot.revision, goalVersion: goal.snapshot.goal.goalVersion, constraints: goal.snapshot.goal.constraints },
    clarification: { goalRevision: run.link.goalRevision, goalVersion: run.link.goalVersion, planRevision: run.link.planRevision, bindingRevision: run.link.bindingRevision, questions: clarification.questions },
    planRevision: plan.snapshot?.revision ?? 0,
    bindingRevision: runtime.binding.revision,
    context: { goalRevision: runtime.context.goal.revision, fingerprint: runtime.context.fingerprint },
    runs: runtime.runs.map(item => ({ goalRevision: item.link.goalRevision, contextFingerprint: item.link.contextFingerprint })),
  })
  if (!eligible) return false
  await set(prepareOwnerRuntimeAtom, subject)
  return true
})
