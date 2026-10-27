import { atom } from 'jotai'
import type { OwnerManagementDelegationInput, OwnerManagementDelegationPreview, OwnerManagementDelegationView } from '@gravitas/shared'
import { loadOwnerManagementAtom } from './project-owner-management-atoms'
import { loadOwnerPlanAtom } from './project-owner-plan-atoms'
import { loadOwnerRuntimeAtom } from './project-owner-runtime-atoms'
interface Subject { projectId: string; taskId?: string }
interface Editor {
  view: OwnerManagementDelegationView | null
  preview: OwnerManagementDelegationPreview | null
  budgetUsd: string
  hours: string
  busy: boolean
  generation: number
  error: string
}
const initial: Editor = { view: null, preview: null, budgetUsd: '1.5', hours: '24', busy: false, generation: 0, error: '' }
const AUTONOMOUS_REQUEST_CEILING = Number.MAX_SAFE_INTEGER
const key = (subject: Subject): string => JSON.stringify([subject.projectId, subject.taskId ?? null])
export const ownerDelegationEditorsAtom = atom(new Map<string, Editor>())
export const getOwnerDelegationEditor = (entries: ReadonlyMap<string, Editor>, subject: Subject): Editor => entries.get(key(subject)) ?? initial
export const editOwnerDelegationAtom = atom(null, (get, set, input: { subject: Subject; patch: Partial<Pick<Editor, 'budgetUsd' | 'hours'>> }) => {
  const entries = new Map(get(ownerDelegationEditorsAtom)), old = getOwnerDelegationEditor(entries, input.subject)
  if (old.busy) return
  entries.set(key(input.subject), { ...old, ...input.patch, preview: null, error: '' }); set(ownerDelegationEditorsAtom, entries)
})
export const loadOwnerDelegationAtom = atom(null, async (get, set, subject: Subject): Promise<OwnerManagementDelegationView | null> => {
  const api = window.electronAPI?.paa?.project
  if (!api?.getOwnerManagementDelegation) return null
  const entries = new Map(get(ownerDelegationEditorsAtom)), old = getOwnerDelegationEditor(entries, subject), generation = old.generation + 1
  entries.set(key(subject), { ...old, generation, error: '' }); set(ownerDelegationEditorsAtom, entries)
  try {
    const result = await api.getOwnerManagementDelegation(subject)
    if (!result.ok) throw new Error(result.error.message)
    const next = new Map(get(ownerDelegationEditorsAtom)), current = getOwnerDelegationEditor(next, subject)
    if (current.generation !== generation) return current.view
    next.set(key(subject), { ...current, view: result.value, ...(result.value.state === 'stale' ? { preview: null } : {}) }); set(ownerDelegationEditorsAtom, next)
    return result.value
  } catch (cause) {
    const next = new Map(get(ownerDelegationEditorsAtom)), current = getOwnerDelegationEditor(next, subject)
    if (current.generation !== generation) return current.view
    next.set(key(subject), { ...current, error: cause instanceof Error ? cause.message : '读取管理委托失败' }); set(ownerDelegationEditorsAtom, next)
    return null
  }
})
export const actOwnerDelegationAtom = atom(null, async (get, set, input: { subject: Subject; action: 'preview' | 'confirm' | 'revoke' }) => {
  const old = getOwnerDelegationEditor(get(ownerDelegationEditorsAtom), input.subject)
  if (old.busy) return
  const update = (patch: Partial<Editor>) => { const entries = new Map(get(ownerDelegationEditorsAtom)); entries.set(key(input.subject), { ...getOwnerDelegationEditor(entries, input.subject), ...patch }); set(ownerDelegationEditorsAtom, entries) }
  update({ busy: true, error: '', generation: old.generation + 1 })
  try {
    const api = window.electronAPI.paa.project
    if (input.action === 'preview') {
      const binding = await api.ensureOwnerRuntimeBinding({ projectId: input.subject.projectId })
      if (!binding.ok) throw new Error(binding.error.message)
      if (!binding.value) throw new Error('Owner尚无有效模型和项目工作区配置；请先完成本地配置')
      const request: OwnerManagementDelegationInput = { ...input.subject, requestId: crypto.randomUUID(), maxRequests: AUTONOMOUS_REQUEST_CEILING, autonomousExecution: true, maxCostMicros: Math.round(Number(old.budgetUsd) * 1000000), expiresAt: Date.now() + Number(old.hours) * 3600000 }
      const result = await api.previewOwnerManagementDelegation(request)
      if (!result.ok) throw new Error(result.error.message)
      update({ preview: result.value })
    } else if (input.action === 'confirm') {
      if (!old.preview) throw new Error('请先审阅本次管理范围')
      const { projectId, taskId, requestId, maxRequests, autonomousExecution, maxCostMicros, expiresAt, previewHash } = old.preview
      const result = await api.confirmOwnerManagementDelegation({ input: { projectId, ...(taskId ? { taskId } : {}), requestId, maxRequests, autonomousExecution, maxCostMicros, expiresAt }, previewHash })
      if (!result.ok) throw new Error(result.error.message)
      update({ preview: null })
      await Promise.all([
        set(loadOwnerDelegationAtom, input.subject),
        set(loadOwnerManagementAtom, input.subject.projectId),
        set(loadOwnerPlanAtom, input.subject),
        set(loadOwnerRuntimeAtom, input.subject),
      ])
    } else {
      if (!old.view?.delegation) return
      const result = await api.revokeOwnerManagementDelegation({ projectId: input.subject.projectId, delegationId: old.view.delegation.id })
      if (!result.ok) throw new Error(result.error.message)
      update({ view: result.value, preview: null, generation: getOwnerDelegationEditor(get(ownerDelegationEditorsAtom), input.subject).generation + 1 })
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '管理委托未确认成功，请核对当前状态'
    if (input.action === 'confirm' && /(配置、资料或价格已变化|目标内容已变化|目标已人工修订)/.test(message)) {
      update({ preview: null })
      await set(loadOwnerDelegationAtom, input.subject)
    } else update({ error: message })
  }
  finally { update({ busy: false }) }
})
