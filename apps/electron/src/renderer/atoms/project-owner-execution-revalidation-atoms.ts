/** 材料化后重新验证（v2）本地状态：编辑仅限changeReason；来源/材料化/preparation变化立即废preview。不是授权账本。 */
import { atom, type Getter, type Setter } from 'jotai'
import type {
  OwnerExecutionRevalidationInput,
  OwnerExecutionRevalidationPreview,
  OwnerExecutionRevalidationRecord,
  OwnerExecutionRevalidationView,
  ProjectOwnerExecutionRevalidationApi,
  ProjectOwnerGoalSubject,
} from '@gravitas/shared'
import {
  getOwnerExecutionEditor,
  ownerExecutionEditorsAtom,
} from './project-owner-execution-atoms'
import { getOwnerTaskEditor, ownerTaskEditorsAtom } from './project-owner-task-atoms'
export interface OwnerRevalidationEditor {
  view: OwnerExecutionRevalidationView | null
  preview: OwnerExecutionRevalidationPreview | null
  history: OwnerExecutionRevalidationRecord[]
  historyLoaded: boolean
  historyLoading: boolean
  historyError: string
  loaded: boolean
  loading: boolean
  previewing: boolean
  saving: boolean
  dirty: boolean
  requiresReview: boolean
  error: string
  requestId: string
  editVersion: number
  changeReason: string
  sourceStamp: string
}
const empty: OwnerRevalidationEditor = {
  view: null,
  preview: null,
  history: [],
  historyLoaded: false,
  historyLoading: false,
  historyError: '',
  loaded: false,
  loading: false,
  previewing: false,
  saving: false,
  dirty: false,
  requiresReview: false,
  error: '',
  requestId: '',
  editVersion: 0,
  changeReason: '',
  sourceStamp: '',
}
const key = (s: ProjectOwnerGoalSubject) => JSON.stringify([s.projectId, s.taskId ?? null])
function sourceStamp(get: Getter, s: ProjectOwnerGoalSubject): string {
  const t = getOwnerTaskEditor(get(ownerTaskEditorsAtom), s)
  const e = getOwnerExecutionEditor(get(ownerExecutionEditorsAtom), s)
  // 不把历史读取或诊断文本当版本；材料化或v1准备任何变化立即废v2预览。
  return JSON.stringify([
    t.view,
    t.loaded,
    t.loading,
    t.saving,
    t.previewing,
    t.requiresReview,
    e.view,
    e.loaded,
    e.loading,
    e.saving,
    e.dirty,
    e.requiresReview,
    e.editVersion,
  ])
}
const revalidationEntriesAtom = atom(new Map<string, OwnerRevalidationEditor>())
/** 派生读取确保不依赖React effect才废弃旧预览；上游改动同一同步读取即生效。 */
export const ownerRevalidationEditorsAtom = atom(
  (get) => {
    const entries = new Map(get(revalidationEntriesAtom))
    for (const [entryKey, e] of entries) {
      const [projectId, taskId] = JSON.parse(entryKey) as [string, string | null]
      const s = { projectId, ...(taskId === null ? {} : { taskId }) }
      const stamp = sourceStamp(get, s)
      if (e.sourceStamp && e.sourceStamp !== stamp)
        entries.set(entryKey, { ...e, sourceStamp: stamp, preview: null, requiresReview: true })
    }
    return entries
  },
  (_get, set, entries: Map<string, OwnerRevalidationEditor>) => set(revalidationEntriesAtom, entries),
)
export function getOwnerRevalidationEditor(
  entries: ReadonlyMap<string, OwnerRevalidationEditor>,
  subject: ProjectOwnerGoalSubject,
) {
  return entries.get(key(subject)) ?? empty
}
/** 上游来源版本戳：材料化或v1准备任何变化都会变化；面板据此自动只读重读。 */
export function ownerRevalidationSourceStamp(get: Getter, s: ProjectOwnerGoalSubject): string {
  return sourceStamp(get, s)
}
const read = (get: Getter, s: ProjectOwnerGoalSubject) =>
  getOwnerRevalidationEditor(get(ownerRevalidationEditorsAtom), s)
function update(
  get: Getter,
  set: Setter,
  s: ProjectOwnerGoalSubject,
  patch: Partial<OwnerRevalidationEditor>,
) {
  const entries = new Map(get(ownerRevalidationEditorsAtom))
  entries.set(key(s), { ...read(get, s), ...patch, sourceStamp: sourceStamp(get, s) })
  set(ownerRevalidationEditorsAtom, entries)
}
function api(): ProjectOwnerExecutionRevalidationApi {
  const value = typeof window === 'undefined' ? undefined : window.electronAPI?.paa?.project
  if (
    !value ||
    typeof value.getOwnerExecutionRevalidation !== 'function' ||
    typeof value.listOwnerExecutionRevalidationHistory !== 'function' ||
    typeof value.previewOwnerExecutionRevalidation !== 'function' ||
    typeof value.saveOwnerExecutionRevalidation !== 'function'
  )
    throw new Error('当前应用缺少重新验证接口，请更新后重试')
  return value
}
export const ownerRevalidationApiAtom = atom<ProjectOwnerExecutionRevalidationApi>({
  getOwnerExecutionRevalidation: (s) => api().getOwnerExecutionRevalidation(s),
  listOwnerExecutionRevalidationHistory: (s) => api().listOwnerExecutionRevalidationHistory(s),
  previewOwnerExecutionRevalidation: (r) => api().previewOwnerExecutionRevalidation(r),
  saveOwnerExecutionRevalidation: (r) => api().saveOwnerExecutionRevalidation(r),
})
export type OwnerRevalidationEdit = Partial<Pick<OwnerRevalidationEditor, 'changeReason'>>
/** 编辑仅限changeReason文本；任何编辑立即废preview、更换幂等requestId。 */
export const editOwnerRevalidationAtom = atom(
  null,
  (get, set, { subject, patch }: { subject: ProjectOwnerGoalSubject; patch: OwnerRevalidationEdit }) =>
    update(get, set, subject, {
      ...patch,
      preview: null,
      requestId: crypto.randomUUID(),
      editVersion: read(get, subject).editVersion + 1,
      dirty: true,
    }),
)
/** v2输入：预算/期限从上游原样携带，不在此重开授权窗口；材料化必须needs_revalidation且准备已登记。 */
export function ownerRevalidationInput(
  get: Getter,
  s: ProjectOwnerGoalSubject,
): OwnerExecutionRevalidationInput | null {
  const e = read(get, s)
  const t = getOwnerTaskEditor(get(ownerTaskEditorsAtom), s)
  const preparation = getOwnerExecutionEditor(get(ownerExecutionEditorsAtom), s).view
  const m = t.view?.materialization
  if (
    !e.loaded ||
    !e.view ||
    e.loading ||
    e.saving ||
    e.previewing ||
    !e.requestId ||
    !e.changeReason.trim()
  )
    return null
  if (t.view?.status !== 'needs_revalidation' || !m) return null
  if (!preparation?.preparation || preparation.policyRevision === null) return null
  return {
    requestId: e.requestId,
    expectedRevalidationRevision: e.view.revision,
    expectedMaterializationId: m.id,
    expectedMaterializationRevision: m.revision,
    expectedMaterializationHash: m.integrityHash,
    expectedPolicyRevision: preparation.policyRevision,
    changeReason: e.changeReason.trim(),
  }
}
function sameInput(
  left: OwnerExecutionRevalidationInput,
  right: OwnerExecutionRevalidationInput,
): boolean {
  const ordered = (input: OwnerExecutionRevalidationInput) =>
    JSON.stringify(input, [
      'requestId',
      'expectedRevalidationRevision',
      'expectedMaterializationId',
      'expectedMaterializationRevision',
      'expectedMaterializationHash',
      'expectedPolicyRevision',
      'changeReason',
    ])
  return ordered(left) === ordered(right)
}
export function canPreviewOwnerRevalidation(get: Getter, s: ProjectOwnerGoalSubject) {
  const e = read(get, s)
  return !e.previewing && !e.saving && Boolean(ownerRevalidationInput(get, s))
}
export function canSaveOwnerRevalidation(get: Getter, s: ProjectOwnerGoalSubject) {
  const e = read(get, s)
  const input = ownerRevalidationInput(get, s)
  return (
    !e.previewing &&
    !e.saving &&
    Boolean(e.preview && input && sameInput(e.preview.input, input))
  )
}
const message = (error: unknown) => (error instanceof Error ? error.message : '重新验证操作失败')
function assertSubject(value: ProjectOwnerGoalSubject, s: ProjectOwnerGoalSubject) {
  if (key(value) !== key(s)) throw new Error('重新验证响应主体不匹配')
}
export const loadOwnerRevalidationAtom = atom(
  null,
  async (get, set, s: ProjectOwnerGoalSubject) => {
    const before = read(get, s)
    if (before.loading || before.saving || before.previewing) return
    update(get, set, s, { loading: true, preview: null, sourceStamp: sourceStamp(get, s) })
    try {
      const result = await get(ownerRevalidationApiAtom).getOwnerExecutionRevalidation(s)
      if (!result.ok) throw new Error(result.error.message)
      if (result.value.revalidation) {
        assertSubject(result.value.revalidation, s)
        assertSubject(result.value.revalidation.source, s)
      }
      update(get, set, s, {
        view: result.value,
        loaded: true,
        requiresReview: false,
        error: '',
        requestId: read(get, s).requestId || crypto.randomUUID(),
      })
    } catch (error) {
      update(get, set, s, { error: message(error), loaded: false })
    } finally {
      update(get, set, s, { loading: false })
    }
  },
)
export const previewOwnerRevalidationAtom = atom(
  null,
  async (get, set, s: ProjectOwnerGoalSubject) => {
    if (!canPreviewOwnerRevalidation(get, s)) return
    const before = read(get, s)
    const input = ownerRevalidationInput(get, s)
    if (!input) return
    update(get, set, s, { previewing: true, preview: null, error: '' })
    try {
      const result = await get(ownerRevalidationApiAtom).previewOwnerExecutionRevalidation({
        ...s,
        input,
      })
      if (!result.ok) {
        update(get, set, s, {
          error: result.error.message,
          requiresReview: result.error.code === 'conflict',
          loaded: result.error.code !== 'conflict',
        })
        return
      }
      assertSubject(result.value, s)
      if (read(get, s).editVersion === before.editVersion && sameInput(result.value.input, input))
        update(get, set, s, { preview: result.value })
    } catch (error) {
      update(get, set, s, { error: message(error) })
    } finally {
      update(get, set, s, { previewing: false })
    }
  },
)
export const saveOwnerRevalidationAtom = atom(
  null,
  async (get, set, s: ProjectOwnerGoalSubject) => {
    if (!canSaveOwnerRevalidation(get, s)) return
    const before = read(get, s)
    const input = ownerRevalidationInput(get, s)
    if (!input || !before.preview) return
    update(get, set, s, { saving: true, error: '' })
    try {
      const result = await get(ownerRevalidationApiAtom).saveOwnerExecutionRevalidation({
        ...s,
        input,
        previewFingerprint: before.preview.previewFingerprint,
      })
      if (!result.ok) {
        update(get, set, s, {
          error: result.error.message,
          preview: null,
          requiresReview: true,
          loaded: false,
        })
        return
      }
      assertSubject(result.value, s)
      assertSubject(result.value.source, s)
      if (!sameInput(result.value.input, input)) throw new Error('保存返回输入不匹配')
      const current = read(get, s)
      update(get, set, s, {
        preview: null,
        loaded: false,
        historyLoaded: false,
        dirty: current.editVersion !== before.editVersion,
        requiresReview: false,
        sourceStamp: '',
        view: current.view
          ? {
              ...current.view,
              revision: result.value.revision,
              revalidation: result.value,
              status: 'current',
              blockers: result.value.source.blockers,
            }
          : null,
      })
    } catch (error) {
      update(get, set, s, {
        error: message(error),
        preview: null,
        requiresReview: true,
        loaded: false,
      })
    } finally {
      update(get, set, s, { saving: false })
    }
  },
)
/** 唯一动作：只读预览通过后原样保存；预览失败即停，不自动重试。 */
export const revalidateOwnerExecutionAtom = atom(null, async (get, set, s: ProjectOwnerGoalSubject) => {
  await set(previewOwnerRevalidationAtom, s)
  const e = read(get, s)
  if (!e.preview || e.error) return
  await set(saveOwnerRevalidationAtom, s)
})
export const loadOwnerRevalidationHistoryAtom = atom(
  null,
  async (get, set, s: ProjectOwnerGoalSubject) => {
    if (read(get, s).historyLoading) return
    update(get, set, s, { historyLoading: true, historyError: '' })
    try {
      const result = await get(ownerRevalidationApiAtom).listOwnerExecutionRevalidationHistory(s)
      if (!result.ok) throw new Error(result.error.message)
      for (const record of result.value) {
        assertSubject(record, s)
        assertSubject(record.source, s)
      }
      update(get, set, s, { history: result.value, historyLoaded: true })
    } catch (error) {
      update(get, set, s, { historyError: message(error) })
    } finally {
      update(get, set, s, { historyLoading: false })
    }
  },
)
