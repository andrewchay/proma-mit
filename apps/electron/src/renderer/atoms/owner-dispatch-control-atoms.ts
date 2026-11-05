import { atom } from 'jotai'
import type { OwnerDispatchControl, OwnerDispatchControlEvent, ProjectOwnerGoalSubject } from '@gravitas/shared'

interface DispatchControlEditor { control: OwnerDispatchControl | null; loading: boolean; busy: boolean; error: string }
interface DispatchEventEditor { events: OwnerDispatchControlEvent[]; loading: boolean; loaded: boolean; reload: boolean; error: string }
const emptyControl: DispatchControlEditor = { control: null, loading: false, busy: false, error: '' }
const emptyEvents: DispatchEventEditor = { events: [], loading: false, loaded: false, reload: false, error: '' }
const subjectKey = (subject: ProjectOwnerGoalSubject) => JSON.stringify([subject.projectId, subject.taskId ?? null])
const controlKey = (projectId: string, grantId: string) => JSON.stringify([projectId, grantId])
export const ownerDispatchControlsAtom = atom(new Map<string, DispatchControlEditor>())
export const ownerDispatchEventsAtom = atom(new Map<string, DispatchEventEditor>())
export const getOwnerDispatchEditor = (entries: ReadonlyMap<string, DispatchControlEditor>, projectId: string, grantId: string) => entries.get(controlKey(projectId, grantId)) ?? emptyControl
export const getOwnerDispatchEvents = (entries: ReadonlyMap<string, DispatchEventEditor>, subject: ProjectOwnerGoalSubject) => entries.get(subjectKey(subject)) ?? emptyEvents

export const loadOwnerDispatchEventsAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject) => {
  const key = subjectKey(subject), read = () => getOwnerDispatchEvents(get(ownerDispatchEventsAtom), subject)
  const update = (patch: Partial<DispatchEventEditor>) => { const entries = new Map(get(ownerDispatchEventsAtom)); entries.set(key, { ...read(), ...patch }); set(ownerDispatchEventsAtom, entries) }
  if (read().loading) { update({ reload: true }); return }
  update({ loading: true, error: '' })
  try {
    const result = await window.electronAPI.paa.project.listOwnerDispatchControlEvents(subject)
    if (!result.ok) throw new Error(result.error.message)
    if (result.value.some(event => event.projectId !== subject.projectId)) throw new Error('派工记录主体不匹配')
    update({ events: result.value, loaded: true })
  } catch (error) { update({ error: error instanceof Error ? error.message : '读取派工记录失败' }) }
  finally { const reload = read().reload; update({ loading: false, reload: false }); if (reload) void set(loadOwnerDispatchEventsAtom, subject) }
})

export const loadOwnerDispatchControlAtom = atom(null, async (get, set, input: { projectId: string; grantId: string }) => {
  const key = controlKey(input.projectId, input.grantId), read = () => getOwnerDispatchEditor(get(ownerDispatchControlsAtom), input.projectId, input.grantId)
  const update = (patch: Partial<DispatchControlEditor>) => { const entries = new Map(get(ownerDispatchControlsAtom)); entries.set(key, { ...read(), ...patch }); set(ownerDispatchControlsAtom, entries) }
  if (read().loading || read().busy) return
  update({ loading: true, error: '' })
  try {
    const result = await window.electronAPI.paa.project.getOwnerDispatchControl(input)
    if (!result.ok) throw new Error(result.error.message)
    if (result.value.projectId !== input.projectId || result.value.grantId !== input.grantId) throw new Error('派工控制主体不匹配')
    update({ control: result.value })
  } catch (error) { update({ error: error instanceof Error ? error.message : '读取派工控制失败' }) }
  finally { update({ loading: false }) }
})

export const setOwnerDispatchControlAtom = atom(null, async (get, set, input: { subject: ProjectOwnerGoalSubject; grantId: string; paused: boolean }) => {
  const { subject, grantId } = input, key = controlKey(subject.projectId, grantId), read = () => getOwnerDispatchEditor(get(ownerDispatchControlsAtom), subject.projectId, grantId)
  const update = (patch: Partial<DispatchControlEditor>) => { const entries = new Map(get(ownerDispatchControlsAtom)); entries.set(key, { ...read(), ...patch }); set(ownerDispatchControlsAtom, entries) }
  const control = read().control
  if (!control || read().busy || read().loading) return false
  update({ busy: true, error: '' })
  try {
    const result = await window.electronAPI.paa.project.setOwnerDispatchControl({ projectId: subject.projectId, grantId, paused: input.paused, expectedRevision: control.revision })
    if (!result.ok) throw new Error(result.error.message)
    if (result.value.projectId !== subject.projectId || result.value.grantId !== grantId) throw new Error('派工控制主体不匹配')
    update({ control: result.value })
    await set(loadOwnerDispatchEventsAtom, subject)
    return true
  } catch (error) { update({ error: error instanceof Error ? error.message : '更新派工控制失败' }); return false }
  finally { update({ busy: false }) }
})
