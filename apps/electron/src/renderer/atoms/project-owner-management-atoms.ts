import { atom } from 'jotai'
import type { OwnerManagementApi, OwnerManagementDeliveryReference, OwnerManagementView, ProjectOwnerGoalSubject, SendOwnerManagementMessageRequest } from '@gravitas/shared'
import { getOwnerGoalEditor, ownerGoalEditorsAtom, loadOwnerGoalAtom } from './project-owner-goal-atoms'
import { loadOwnerPlanAtom } from './project-owner-plan-atoms'
import { loadOwnerRuntimeAtom } from './project-owner-runtime-atoms'

interface OwnerConversationEditor {
  view: OwnerManagementView | null
  generation: number
  loading: boolean
  savingQuestionId: string | null
  drafts: Record<string, Record<string, string>>
  requestIds: Record<string, string>
  error: string
}
const initial: OwnerConversationEditor = { view: null, generation: 0, loading: false, savingQuestionId: null, drafts: {}, requestIds: {}, error: '' }
export const ownerManagementEditorsAtom = atom(new Map<string, OwnerConversationEditor>())
interface TeamWorkspaceApprovalState { busy: boolean; approved: boolean; error: string }
export const ownerTeamWorkspaceApprovalStatesAtom = atom(new Map<string, TeamWorkspaceApprovalState>())
export const confirmOwnerTeamWorkspaceAccessAtom = atom(null, async (get, set, input: { projectId: string; taskId?: string; messageId: string; workspaceId: string; scopeFingerprint: string }) => {
  const key = input.messageId, states = new Map(get(ownerTeamWorkspaceApprovalStatesAtom)), previous = states.get(key) ?? { busy: false, approved: false, error: '' }
  if (previous.busy || previous.approved) return
  states.set(key, { busy: true, approved: false, error: '' }); set(ownerTeamWorkspaceApprovalStatesAtom, states)
  try {
    const result = await window.electronAPI.paa.project.confirmOwnerTeamWorkspaceAccess(input)
    if (!result.ok) throw new Error(result.error.message)
    const next = new Map(get(ownerTeamWorkspaceApprovalStatesAtom)); next.set(key, { busy: false, approved: true, error: '' }); set(ownerTeamWorkspaceApprovalStatesAtom, next)
    await set(loadOwnerManagementAtom, input.projectId)
  } catch (cause) {
    const next = new Map(get(ownerTeamWorkspaceApprovalStatesAtom)); next.set(key, { busy: false, approved: false, error: cause instanceof Error ? cause.message : '团队工作区授权未完成' }); set(ownerTeamWorkspaceApprovalStatesAtom, next)
  }
})
export const ownerManagementApiAtom = atom<(Pick<OwnerManagementApi, 'getOwnerManagement' | 'answerOwnerManagementQuestion'> & Partial<Pick<OwnerManagementApi, 'sendOwnerManagementMessage' | 'decideOwnerConversationChange' | 'retakeOwnerAssignment'>>) | null>(null)
interface OwnerConversationNotice { messageId: string; title: string; createdAt: number; taskId?: string }
export const ownerConversationNoticesAtom = atom(new Map<string, OwnerConversationNotice>())
export const ownerConversationNavigationAtom = atom<{ projectId: string; taskId?: string; at: number } | null>(null)
export const getOwnerManagementEditor = (entries: ReadonlyMap<string, OwnerConversationEditor>, projectId: string): OwnerConversationEditor => entries.get(projectId) ?? initial
export const editOwnerManagementAnswerAtom = atom(null, (get, set, input: { projectId: string; questionId: string; key: string; value: string }) => {
  const entries = new Map(get(ownerManagementEditorsAtom)), old = getOwnerManagementEditor(entries, input.projectId)
  if (old.savingQuestionId === input.questionId) return
  entries.set(input.projectId, { ...old, drafts: { ...old.drafts, [input.questionId]: { ...old.drafts[input.questionId], [input.key]: input.value } }, requestIds: { ...old.requestIds, [input.questionId]: crypto.randomUUID() }, error: '' })
  set(ownerManagementEditorsAtom, entries)
})
export const loadOwnerManagementAtom = atom(null, async (get, set, projectId: string) => {
  const api = get(ownerManagementApiAtom) ?? window.electronAPI?.paa?.project
  if (!api?.getOwnerManagement) return
  const update = (patch: Partial<OwnerConversationEditor>) => { const entries = new Map(get(ownerManagementEditorsAtom)); entries.set(projectId, { ...getOwnerManagementEditor(entries, projectId), ...patch }); set(ownerManagementEditorsAtom, entries) }
  const generation = getOwnerManagementEditor(get(ownerManagementEditorsAtom), projectId).generation + 1
  update({ generation, loading: true })
  try {
    const result = await api.getOwnerManagement({ projectId })
    if (getOwnerManagementEditor(get(ownerManagementEditorsAtom), projectId).generation !== generation) return
    if (!result.ok) throw new Error(result.error.message)
    if (result.value.manager && result.value.manager.projectId !== projectId) throw new Error('Owner对话项目身份不一致')
    update({ view: result.value, error: '' })
  } catch (cause) {
    if (getOwnerManagementEditor(get(ownerManagementEditorsAtom), projectId).generation === generation) update({ error: cause instanceof Error ? cause.message : '读取Owner对话失败' })
  } finally {
    if (getOwnerManagementEditor(get(ownerManagementEditorsAtom), projectId).generation === generation) update({ loading: false })
  }
})
export const answerOwnerManagementQuestionAtom = atom(null, async (get, set, input: { projectId: string; questionId: string }): Promise<boolean> => {
  const old = getOwnerManagementEditor(get(ownerManagementEditorsAtom), input.projectId)
  const question = old.view?.questions.find(item => item.id === input.questionId && item.state === 'open')
  if (!question || old.savingQuestionId) return false
  const update = (patch: Partial<OwnerConversationEditor>) => { const entries = new Map(get(ownerManagementEditorsAtom)); entries.set(input.projectId, { ...getOwnerManagementEditor(entries, input.projectId), ...patch }); set(ownerManagementEditorsAtom, entries) }
  const requestId = old.requestIds[question.id] ?? crypto.randomUUID()
  update({ savingQuestionId: question.id, generation: old.generation + 1, loading: false, requestIds: { ...old.requestIds, [question.id]: requestId }, error: '' })
  try {
    const api = get(ownerManagementApiAtom) ?? window.electronAPI.paa.project
    const result = await api.answerOwnerManagementQuestion({ projectId: input.projectId, questionId: question.id, requestId, expectedGoalRevision: question.goalRevision, expectedContextFingerprint: question.contextFingerprint, answers: old.drafts[question.id] ?? {} })
    if (!result.ok) throw new Error(result.error.message)
    const subject = { projectId: input.projectId, ...(question.taskId ? { taskId: question.taskId } : {}) }
    await Promise.all([set(loadOwnerManagementAtom, input.projectId), set(loadOwnerGoalAtom, subject), set(loadOwnerPlanAtom, subject), set(loadOwnerRuntimeAtom, subject)])
    return true
  } catch (cause) {
    update({ error: cause instanceof Error ? cause.message : '答复未确认保存，输入已保留' })
    return false
  } finally { update({ savingQuestionId: null }) }
})


interface OwnerMessageComposer { text: string; requestId: string; sending: boolean; pending: SendOwnerManagementMessageRequest | null; error: string; deliveryReference?: OwnerManagementDeliveryReference }
const emptyComposer: OwnerMessageComposer = { text: '', requestId: '', sending: false, pending: null, error: '' }
const composerKey = (subject: ProjectOwnerGoalSubject) => JSON.stringify([subject.projectId, subject.taskId ?? null])
export const ownerMessageComposersAtom = atom(new Map<string, OwnerMessageComposer>())
export const getOwnerMessageComposer = (entries: ReadonlyMap<string, OwnerMessageComposer>, subject: ProjectOwnerGoalSubject) => entries.get(composerKey(subject)) ?? emptyComposer
export const editOwnerMessageAtom = atom(null, (get, set, input: { subject: ProjectOwnerGoalSubject; text: string; deliveryReference?: OwnerManagementDeliveryReference | null }) => {
  const entries = new Map(get(ownerMessageComposersAtom)), old = getOwnerMessageComposer(entries, input.subject)
  if (old.sending || old.pending) return
  const deliveryReference = input.deliveryReference === null ? undefined : input.deliveryReference ?? old.deliveryReference
  entries.set(composerKey(input.subject), { ...old, text: input.text, requestId: crypto.randomUUID(), error: '', ...(deliveryReference ? { deliveryReference } : { deliveryReference: undefined }) }); set(ownerMessageComposersAtom, entries)
})
/** 网络结果不明保留原请求；再次发送只重读/补交同一消息，不创建新的模型请求。 */
export const sendOwnerMessageAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject): Promise<boolean> => {
  const old = getOwnerMessageComposer(get(ownerMessageComposersAtom), subject)
  const manager = getOwnerManagementEditor(get(ownerManagementEditorsAtom), subject.projectId).view?.manager
  const editor = getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject)
  const goal = editor.loaded && !editor.loading && !editor.saving && !editor.dirty && !editor.requiresReview && !editor.conflict ? editor.snapshot : null
  if (old.sending || !manager || !goal || !old.text.trim()) return false
  const input = old.pending ?? { ...subject, conversationId: manager.conversationId, requestId: old.requestId || crypto.randomUUID(), expectedGoalRevision: goal.revision, content: old.text.trim(), ...(old.deliveryReference ? { deliveryReference: old.deliveryReference } : {}) }
  const update = (patch: Partial<OwnerMessageComposer>) => { const entries = new Map(get(ownerMessageComposersAtom)); entries.set(composerKey(subject), { ...getOwnerMessageComposer(entries, subject), ...patch }); set(ownerMessageComposersAtom, entries) }
  update({ sending: true, pending: input, requestId: input.requestId, error: '' })
  try {
    const api = get(ownerManagementApiAtom) ?? window.electronAPI.paa.project
    if (!api.sendOwnerManagementMessage) throw new Error('当前版本尚未提供Owner对话发送接口')
    const result = await api.sendOwnerManagementMessage(input)
    if (!result.ok) { update({ pending: null }); throw new Error(result.error.message) }
    const message = result.value
    if (message.projectId !== subject.projectId || message.taskId !== subject.taskId || message.conversationId !== input.conversationId || message.goalRevision !== input.expectedGoalRevision || message.content !== input.content || JSON.stringify(message.deliveryReference) !== JSON.stringify(input.deliveryReference) || message.role !== 'user' || message.kind !== 'conversation') throw new Error('Owner消息保存回执不匹配，请核对原请求')
    update({ text: '', requestId: '', pending: null, deliveryReference: undefined })
    await set(loadOwnerManagementAtom, subject.projectId)
    return true
  } catch (cause) { update({ error: cause instanceof Error ? cause.message : '消息尚未确认保存，原输入已保留' }); return false }
  finally { update({ sending: false }) }
})

/** 用户显式重排人员：仅在已确认方案与有效授权下由主进程校验，重复点击按请求ID幂等。 */
export const retakeOwnerAssignmentAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject): Promise<{ ok: boolean; message: string }> => {
  const api = get(ownerManagementApiAtom) ?? window.electronAPI?.paa?.project
  if (!api?.retakeOwnerAssignment) return { ok: false, message: '当前版本未提供重排入口' }
  const result = await api.retakeOwnerAssignment({ ...subject, requestId: crypto.randomUUID() })
  if (!result.ok) return { ok: false, message: result.error.message }
  await set(loadOwnerManagementAtom, subject.projectId)
  return { ok: true, message: result.value.enqueued ? '已按当前已确认方案重新安排人员；进度会在这里更新。' : '已有管理请求正在运行，未重复排队。' }
})
