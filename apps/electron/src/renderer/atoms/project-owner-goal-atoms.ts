/** Owner 草案编辑状态：按项目/任务隔离；本地文本与已保存快照分开。 */
import { atom, type Getter, type Setter } from 'jotai'
import type { ProjectOwnerGoalApi, ProjectOwnerGoalDraft, ProjectOwnerGoalSubject } from '@gravitas/shared'

export interface OwnerGoalEditor {
  snapshot: ProjectOwnerGoalDraft | null
  objective: string
  constraintsText: string
  criteriaText: string
  dirty: boolean
  loaded: boolean
  loading: boolean
  saving: boolean
  conflict: boolean
  requiresReview: boolean
  editVersion: number
  error: string
}

const emptyEditor: OwnerGoalEditor = {
  snapshot: null, objective: '', constraintsText: '', criteriaText: '', dirty: false,
  loaded: false, loading: false, saving: false, conflict: false, requiresReview: false, editVersion: 0, error: '',
}
const subjectKey = (subject: ProjectOwnerGoalSubject) => JSON.stringify([subject.projectId, subject.taskId ?? null])
export const ownerGoalEditorsAtom = atom(new Map<string, OwnerGoalEditor>())
export const ownerGoalApiAtom = atom<ProjectOwnerGoalApi>({
  getOwnerGoalDraft: (subject) => window.electronAPI.paa.project.getOwnerGoalDraft(subject),
  saveOwnerGoalDraft: (request) => window.electronAPI.paa.project.saveOwnerGoalDraft(request),
})

export function getOwnerGoalEditor(entries: ReadonlyMap<string, OwnerGoalEditor>, subject: ProjectOwnerGoalSubject): OwnerGoalEditor {
  return entries.get(subjectKey(subject)) ?? emptyEditor
}
export function canSaveOwnerGoal(editor: OwnerGoalEditor): boolean {
  return editor.loaded && !editor.loading && !editor.saving && !editor.conflict && !editor.requiresReview
    && editor.dirty && Boolean(editor.objective.trim())
}
function read(get: Getter, subject: ProjectOwnerGoalSubject): OwnerGoalEditor {
  return getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject)
}
function update(get: Getter, set: Setter, subject: ProjectOwnerGoalSubject, patch: Partial<OwnerGoalEditor>): void {
  const entries = new Map(get(ownerGoalEditorsAtom))
  entries.set(subjectKey(subject), { ...read(get, subject), ...patch })
  set(ownerGoalEditorsAtom, entries)
}
function textFields(snapshot: ProjectOwnerGoalDraft | null) {
  return {
    objective: snapshot?.goal.objective ?? '',
    constraintsText: snapshot?.goal.constraints.join('\n') ?? '',
    criteriaText: snapshot?.goal.acceptanceCriteria.join('\n') ?? '',
  }
}
function assertResponseSubject(snapshot: ProjectOwnerGoalDraft | null, subject: ProjectOwnerGoalSubject): void {
  if (snapshot && (snapshot.goal.projectId !== subject.projectId || snapshot.goal.taskId !== subject.taskId)) {
    throw new Error('服务器返回的草案主体与当前项目/任务不匹配')
  }
}
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : '目标草案操作失败'

export const editOwnerGoalAtom = atom(null, (get, set, payload: {
  subject: ProjectOwnerGoalSubject
  patch: Partial<Pick<OwnerGoalEditor, 'objective' | 'constraintsText' | 'criteriaText'>>
}) => {
  update(get, set, payload.subject, { ...payload.patch, dirty: true, editVersion: read(get, payload.subject).editVersion + 1 })
})

export const loadOwnerGoalAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject) => {
  const before = read(get, subject)
  if (before.loading || before.saving) return
  update(get, set, subject, { loading: true, error: '' })
  try {
    const response = await get(ownerGoalApiAtom).getOwnerGoalDraft(subject)
    if (!response.ok) throw new Error(response.error.message)
    assertResponseSubject(response.value, subject)
    const current = read(get, subject)
    const changed = (current.snapshot?.revision ?? 0) !== (response.value?.revision ?? 0)
    update(get, set, subject, {
      snapshot: response.value, loaded: true, conflict: false,
      requiresReview: current.requiresReview || (current.dirty && changed),
      ...(current.dirty ? {} : textFields(response.value)),
    })
  } catch (cause) {
    update(get, set, subject, { error: errorText(cause) })
  } finally { update(get, set, subject, { loading: false }) }
})

/** 加载最新后先展示服务器与本地差异；明确比较确认不执行保存。 */
export const acknowledgeOwnerGoalComparisonAtom = atom(null, (get, set, subject: ProjectOwnerGoalSubject) => {
  const current = read(get, subject)
  if (current.loaded && current.requiresReview && !current.loading && !current.saving) {
    update(get, set, subject, { requiresReview: false, error: '' })
  }
})

export const saveOwnerGoalAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject) => {
  const before = read(get, subject)
  if (!canSaveOwnerGoal(before)) return
  update(get, set, subject, { saving: true, error: '' })
  const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean)
  try {
    const response = await get(ownerGoalApiAtom).saveOwnerGoalDraft({
      ...subject, expectedRevision: before.snapshot?.revision ?? 0,
      input: { objective: before.objective, constraints: lines(before.constraintsText), acceptanceCriteria: lines(before.criteriaText) },
    })
    if (!response.ok) {
      update(get, set, subject, { error: response.error.message, conflict: response.error.code === 'conflict' })
      return
    }
    assertResponseSubject(response.value, subject)
    const editedWhileSaving = read(get, subject).editVersion !== before.editVersion
    update(get, set, subject, {
      snapshot: response.value, loaded: true, dirty: editedWhileSaving, conflict: false, requiresReview: false,
      ...(editedWhileSaving ? {} : textFields(response.value)),
    })
  } catch (cause) { update(get, set, subject, { error: errorText(cause) }) }
  finally { update(get, set, subject, { saving: false }) }
})
