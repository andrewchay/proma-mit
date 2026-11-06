import { atom } from 'jotai'
import type { OwnerManagementDeliveryReference, ProjectOwnerGoalSubject, SendOwnerManagementMessageRequest } from '@gravitas/shared'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from './project-owner-goal-atoms'
import { getOwnerManagementEditor, loadOwnerManagementAtom, ownerManagementApiAtom, ownerManagementEditorsAtom } from './project-owner-management-atoms'

interface DecisionState { busy: boolean; error: string; confirmed?: boolean; deferred?: boolean; pending?: SendOwnerManagementMessageRequest }
export const ownerDeliveryDecisionStatesAtom = atom(new Map<string, DecisionState>())
export const ownerDeliveryDecisionKey = (subject: ProjectOwnerGoalSubject, reference: OwnerManagementDeliveryReference): string => JSON.stringify([subject.projectId, subject.taskId ?? null, reference.messageId, reference.stepKey, reference.artifactHash])

export const reloadOwnerDeliveryDecisionAtom = atom(null, async (get, set, input: { subject: ProjectOwnerGoalSubject; reference: OwnerManagementDeliveryReference }) => {
  const key = ownerDeliveryDecisionKey(input.subject, input.reference)
  if (!await set(loadOwnerManagementAtom, input.subject.projectId)) return
  const current = get(ownerDeliveryDecisionStatesAtom).get(key)
  if (current?.confirmed && current.deferred) {
    const states = new Map(get(ownerDeliveryDecisionStatesAtom))
    states.set(key, { busy: false, error: '' })
    set(ownerDeliveryDecisionStatesAtom, states)
  }
})

/** 未收到回执时保留同一请求，以便安全重试。 */
export const submitOwnerDeliveryDecisionAtom = atom(null, async (get, set, input: { subject: ProjectOwnerGoalSubject; reference: OwnerManagementDeliveryReference; decision: 'accepted' | 'changes_requested' | 'deferred'; note: string }): Promise<boolean> => {
  const key = ownerDeliveryDecisionKey(input.subject, input.reference)
  const existing = get(ownerDeliveryDecisionStatesAtom).get(key)
  if (existing?.busy || existing?.confirmed) return false
  const manager = getOwnerManagementEditor(get(ownerManagementEditorsAtom), input.subject.projectId).view?.manager
  const goalEditor = getOwnerGoalEditor(get(ownerGoalEditorsAtom), input.subject)
  const goal = goalEditor.loaded && !goalEditor.loading && !goalEditor.saving && !goalEditor.dirty && !goalEditor.conflict && !goalEditor.requiresReview ? goalEditor.snapshot : null
  if (!manager || !goal) return false
  const content = [input.decision === 'accepted' ? '我认可这个成果版本。' : input.decision === 'deferred' ? '我稍后决定，暂时保持这个成果版本待审阅。' : '这个成果版本需要修改。', input.note.trim()].filter(Boolean).join('\n\n')
  if (!existing?.pending && (content.length > 4000 || (input.decision === 'changes_requested' && !input.note.trim()))) return false
  const request = existing?.pending ?? { ...input.subject, conversationId: manager.conversationId, requestId: crypto.randomUUID(), expectedGoalRevision: goal.revision, content, deliveryReference: input.reference, deliveryReviewDecision: input.decision }
  const update = (value: DecisionState) => { const states = new Map(get(ownerDeliveryDecisionStatesAtom)); states.set(key, value); set(ownerDeliveryDecisionStatesAtom, states) }
  update({ busy: true, error: '', pending: request })
  try {
    const api = get(ownerManagementApiAtom) ?? window.electronAPI.paa.project
    if (!api.sendOwnerManagementMessage) throw new Error('当前版本尚未提供 Owner 对话发送接口')
    const result = await api.sendOwnerManagementMessage(request)
    if (!result.ok) { update({ busy: false, error: result.error.message }); return false }
    const message = result.value
    if (message.projectId !== request.projectId || message.taskId !== request.taskId || message.conversationId !== request.conversationId || message.goalRevision !== request.expectedGoalRevision || message.role !== 'user' || message.kind !== 'conversation' || message.content !== request.content || message.deliveryReviewDecision !== request.deliveryReviewDecision || JSON.stringify(message.deliveryReference) !== JSON.stringify(request.deliveryReference)) throw new Error('决定的保存回执不匹配，请重试原请求')
    update({ busy: false, error: '', confirmed: true, deferred: request.deliveryReviewDecision === 'deferred' })
    const refreshed = await set(loadOwnerManagementAtom, input.subject.projectId)
    if (!refreshed) update({ busy: false, confirmed: true, deferred: request.deliveryReviewDecision === 'deferred', error: '决定已保存，但对话刷新失败，请重新读取' })
    else if (request.deliveryReviewDecision === 'deferred') update({ busy: false, error: '' })
    return true
  } catch (error) { update({ busy: false, pending: request, error: error instanceof Error ? error.message : '决定尚未确认保存，请重试' }); return false }
})
