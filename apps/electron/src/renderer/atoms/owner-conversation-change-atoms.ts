import { atom } from 'jotai'
import type { DecideOwnerConversationChangeRequest, ProjectOwnerGoalSubject } from '@gravitas/shared'
import { getOwnerManagementEditor, loadOwnerManagementAtom, ownerManagementApiAtom, ownerManagementEditorsAtom } from './project-owner-management-atoms'
import { loadOwnerGoalAtom } from './project-owner-goal-atoms'
import { loadOwnerPlanAtom } from './project-owner-plan-atoms'
import { loadOwnerRuntimeAtom } from './project-owner-runtime-atoms'

interface ChangeEditor { busy: boolean; pending: DecideOwnerConversationChangeRequest | null; error: string }
const empty: ChangeEditor = { busy: false, pending: null, error: '' }
export const ownerConversationChangeEditorsAtom = atom(new Map<string, ChangeEditor>())
const key = (projectId: string, id: string) => JSON.stringify([projectId, id])
export const getOwnerConversationChangeEditor = (entries: ReadonlyMap<string, ChangeEditor>, projectId: string, id: string) => entries.get(key(projectId, id)) ?? empty
export const decideOwnerConversationChangeAtom = atom(null, async (get, set, input: { subject: ProjectOwnerGoalSubject; changeId: string; action: 'apply' | 'dismiss' }): Promise<boolean> => {
  const { subject } = input, read = () => getOwnerConversationChangeEditor(get(ownerConversationChangeEditorsAtom), subject.projectId, input.changeId)
  const before = read(), proposal = getOwnerManagementEditor(get(ownerManagementEditorsAtom), subject.projectId).view?.changes?.find(item => item.id === input.changeId && item.taskId === subject.taskId)
  if (before.busy || !proposal || proposal.projectId !== subject.projectId || (proposal.state !== 'pending' && !before.pending) || (before.pending && before.pending.action !== input.action)) return false
  const request = before.pending ?? { projectId: subject.projectId, changeId: proposal.id, requestId: crypto.randomUUID(), action: input.action, previewHash: proposal.previewHash }
  const update = (patch: Partial<ChangeEditor>) => { const entries = new Map(get(ownerConversationChangeEditorsAtom)); entries.set(key(subject.projectId, input.changeId), { ...read(), ...patch }); set(ownerConversationChangeEditorsAtom, entries) }
  const refresh = async () => {
    await set(loadOwnerGoalAtom, subject)
    await Promise.all([set(loadOwnerManagementAtom, subject.projectId), set(loadOwnerPlanAtom, subject), set(loadOwnerRuntimeAtom, subject)])
  }
  update({ busy: true, pending: request, error: '' })
  try {
    const api = get(ownerManagementApiAtom) ?? window.electronAPI.paa.project
    if (!api.decideOwnerConversationChange) throw new Error('当前版本尚未提供Owner理解确认接口')
    const result = await api.decideOwnerConversationChange(request)
    if (!result.ok) { update({ pending: null }); throw new Error(result.error.message) }
    const value = result.value
    if (value.changeId !== proposal.id || value.action !== input.action || (input.action === 'apply' ? !value.goal || value.goal.goal.projectId !== subject.projectId || value.goal.goal.taskId !== subject.taskId : value.goal !== undefined)) throw new Error('Owner理解裁决回执不匹配，请核对原记录')
    update({ pending: null }); await refresh(); return true
  } catch (cause) {
    // 回包丢失先读权威裁决；仅精确同摘要的已提交决定可以恢复成功。
    await set(loadOwnerManagementAtom, subject.projectId)
    const recovered = getOwnerManagementEditor(get(ownerManagementEditorsAtom), subject.projectId).view?.changes?.find(item => item.id === proposal.id && item.projectId === subject.projectId && item.taskId === subject.taskId && item.previewHash === request.previewHash)
    if (recovered?.state === (input.action === 'apply' ? 'applied' : 'dismissed')) { update({ pending: null, error: '' }); await refresh(); return true }
    update({ error: cause instanceof Error ? cause.message : '内容确认尚未核实，原请求已保留' }); return false
  } finally { update({ busy: false }) }
})
