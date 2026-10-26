import { atom, type Getter, type Setter } from 'jotai'
import type { OwnerExecutionAssignmentInput, OwnerExecutionAssignmentRunView, OwnerPlanningLink, ProjectOwnerExecutionAssignmentApi, ProjectOwnerGoalResult, ProjectOwnerGoalSubject } from '@gravitas/shared'

export interface OwnerExecutionAssignmentEditor {
  generation: number
  runs: OwnerExecutionAssignmentRunView[]
  loaded: boolean
  loading: boolean
  preparing: boolean
  error: string
}
const empty: OwnerExecutionAssignmentEditor = { generation: 0, runs: [], loaded: false, loading: false, preparing: false, error: '' }
const key = (subject: ProjectOwnerGoalSubject) => JSON.stringify([subject.projectId, subject.taskId ?? null])
export const ownerExecutionAssignmentEditorsAtom = atom(new Map<string, OwnerExecutionAssignmentEditor>())
export function getOwnerExecutionAssignmentEditor(entries: ReadonlyMap<string, OwnerExecutionAssignmentEditor>, subject: ProjectOwnerGoalSubject): OwnerExecutionAssignmentEditor {
  return entries.get(key(subject)) ?? empty
}
function read(get: Getter, subject: ProjectOwnerGoalSubject): OwnerExecutionAssignmentEditor {
  return getOwnerExecutionAssignmentEditor(get(ownerExecutionAssignmentEditorsAtom), subject)
}
function update(get: Getter, set: Setter, subject: ProjectOwnerGoalSubject, patch: Partial<OwnerExecutionAssignmentEditor>): void {
  const entries = new Map(get(ownerExecutionAssignmentEditorsAtom))
  entries.set(key(subject), { ...read(get, subject), ...patch })
  set(ownerExecutionAssignmentEditorsAtom, entries)
}
function api(): ProjectOwnerExecutionAssignmentApi {
  const project = typeof window === 'undefined' ? undefined : window.electronAPI?.paa?.project
  if (!project || typeof project.prepareOwnerExecutionAssignment !== 'function' || typeof project.listOwnerExecutionAssignmentRuns !== 'function') throw new Error('当前应用缺少Owner执行安排提案接口，请更新后重试')
  return project
}
export const ownerExecutionAssignmentApiAtom = atom<ProjectOwnerExecutionAssignmentApi>({
  prepareOwnerExecutionAssignment: request => api().prepareOwnerExecutionAssignment(request),
  listOwnerExecutionAssignmentRuns: subject => api().listOwnerExecutionAssignmentRuns(subject),
})
function resolve<T>(result: ProjectOwnerGoalResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
export const loadOwnerExecutionAssignmentRunsAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject): Promise<void> => {
  const generation = read(get, subject).generation + 1
  update(get, set, subject, { generation, loading: true, error: '' })
  try {
    const runs = resolve(await get(ownerExecutionAssignmentApiAtom).listOwnerExecutionAssignmentRuns(subject))
    if (read(get, subject).generation !== generation) return
    update(get, set, subject, { runs, loaded: true })
  } catch (cause) {
    if (read(get, subject).generation === generation) update(get, set, subject, { loaded: true, error: cause instanceof Error ? cause.message : String(cause) })
  } finally {
    if (read(get, subject).generation === generation) update(get, set, subject, { loading: false })
  }
})
export const prepareOwnerExecutionAssignmentAtom = atom(null, async (get, set, { subject, input }: { subject: ProjectOwnerGoalSubject; input: OwnerExecutionAssignmentInput }): Promise<OwnerPlanningLink | null> => {
  update(get, set, subject, { preparing: true, error: '' })
  try {
    const link = resolve(await get(ownerExecutionAssignmentApiAtom).prepareOwnerExecutionAssignment({ ...subject, input }))
    await set(loadOwnerExecutionAssignmentRunsAtom, subject)
    return link
  } catch (cause) {
    update(get, set, subject, { error: cause instanceof Error ? cause.message : String(cause) })
    return null
  } finally {
    update(get, set, subject, { preparing: false })
  }
})
