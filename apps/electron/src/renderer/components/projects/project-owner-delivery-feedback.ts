import { atom } from 'jotai'
import type { ProjectOwnerGoalSubject } from '@gravitas/shared'
import { editOwnerGoalAtom, getOwnerGoalEditor, loadOwnerGoalAtom, ownerGoalEditorsAtom } from '@/atoms/project-owner-goal-atoms'

const MAX_FEEDBACK_LENGTH = 1800
const MAX_CONSTRAINTS = 32
const FEEDBACK_PREFIX = 'Owner交付修改意见'

export type OwnerDeliveryFeedbackResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'too_long' | 'too_many' | 'goal_unavailable' }

/** 将意见作为有来源标记的未保存Goal约束，便于用户检查后决定是否保存。 */
export function applyOwnerDeliveryFeedback(current: readonly string[], commandId: string, rawFeedback: string): OwnerDeliveryFeedbackResult & { constraints?: string[] } {
  if (!Array.isArray(current) || current.some(value => typeof value !== 'string')
    || typeof commandId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(commandId)
    || typeof rawFeedback !== 'string') return { ok: false, reason: 'invalid' }
  const feedback = rawFeedback.trim().replace(/\s+/g, ' ')
  if (!feedback) return { ok: false, reason: 'invalid' }
  const prefix = `${FEEDBACK_PREFIX}（命令 ${commandId}）：`
  const entry = `${prefix}${feedback}`
  if (entry.length > 2000 || feedback.length > MAX_FEEDBACK_LENGTH) return { ok: false, reason: 'too_long' }
  const remaining = current.filter(value => !value.startsWith(prefix))
  if (remaining.length >= MAX_CONSTRAINTS) return { ok: false, reason: 'too_many' }
  remaining.push(entry)
  return { ok: true, constraints: remaining }
}

/** 用户明确提交后，只改精确Task的未保存Goal草案，不保存、不准备、不启动。 */
export const addOwnerDeliveryFeedbackToGoalAtom = atom(null, async (get, set, input: ProjectOwnerGoalSubject & { commandId: string; feedback: string; delivery?: { title: string; acceptanceCriteria: string[] } }): Promise<OwnerDeliveryFeedbackResult> => {
  const subject: ProjectOwnerGoalSubject = { projectId: input.projectId, ...(input.taskId === undefined ? {} : { taskId: input.taskId }) }
  let goal = getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject)
  if (!goal.loaded) {
    await set(loadOwnerGoalAtom, subject)
    goal = getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject)
  }
  if (!goal.loaded || goal.loading || goal.saving || goal.conflict || goal.requiresReview) return { ok: false, reason: 'goal_unavailable' }
  const seed = !goal.snapshot && !goal.objective.trim() && input.taskId && input.delivery
    && input.delivery.title.trim() && input.delivery.acceptanceCriteria.every(value => typeof value === 'string') ? input.delivery : null
  if (!goal.snapshot && !goal.objective.trim() && !seed) return { ok: false, reason: 'goal_unavailable' }
  const current = goal.constraintsText.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  const result = applyOwnerDeliveryFeedback(current, input.commandId, input.feedback)
  if (!result.ok || !result.constraints) return result
  set(editOwnerGoalAtom, { subject, patch: { constraintsText: result.constraints.join('\n'), ...(seed ? { objective: seed.title, criteriaText: goal.criteriaText.trim() ? goal.criteriaText : seed.acceptanceCriteria.join('\n') } : {}) } })
  return { ok: true }
})
