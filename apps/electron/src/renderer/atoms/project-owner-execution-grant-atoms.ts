/** Owner执行授权账本本地状态：发行/撤权两阶段确认。
 * 发行≠派工启动；确认后无单次费用同意（第3确认在启动时另有）；active期间重验证被阻断属预期。 */
import { atom, type Getter, type Setter } from 'jotai'
import type {
  OwnerExecutionGrant,
  OwnerExecutionGrantIssuePreview,
  OwnerExecutionGrantRevokePreview,
  PreviewOwnerExecutionGrantIssueRequest,
  ProjectOwnerExecutionGrantApi,
  ProjectOwnerGoalSubject,
} from '@gravitas/shared'
export type OwnerGrantIssueInput = PreviewOwnerExecutionGrantIssueRequest['input']
export interface OwnerGrantEditor {
  /** 最新一条授权行（active/paused/needs_reconcile），无授权为null */
  grant: OwnerExecutionGrant | null
  loaded: boolean
  loading: boolean
  /** 发行影响面预览（只读，未落库） */
  preview: OwnerExecutionGrantIssuePreview | null
  /** 撤权影响面预览（只读） */
  revokePreview: OwnerExecutionGrantRevokePreview | null
  previewing: boolean
  /** 发行confirm在途 */
  confirming: boolean
  /** 撤权confirm在途 */
  revoking: boolean
  history: OwnerExecutionGrant[]
  historyLoaded: boolean
  historyLoading: boolean
  historyError: string
  error: string
}
const empty: OwnerGrantEditor = {
  grant: null,
  loaded: false,
  loading: false,
  preview: null,
  revokePreview: null,
  previewing: false,
  confirming: false,
  revoking: false,
  history: [],
  historyLoaded: false,
  historyLoading: false,
  historyError: '',
  error: '',
}
const key = (s: ProjectOwnerGoalSubject) => JSON.stringify([s.projectId, s.taskId ?? null])
/** 按 subject 隔离的账本编辑器表：主体不共享状态，读/写均经本 atom。 */
export const ownerGrantEditorsAtom = atom(new Map<string, OwnerGrantEditor>())
export function getOwnerGrantEditor(
  entries: ReadonlyMap<string, OwnerGrantEditor>,
  subject: ProjectOwnerGoalSubject,
) {
  return entries.get(key(subject)) ?? empty
}
const read = (get: Getter, s: ProjectOwnerGoalSubject) =>
  getOwnerGrantEditor(get(ownerGrantEditorsAtom), s)
function update(
  get: Getter,
  set: Setter,
  s: ProjectOwnerGoalSubject,
  patch: Partial<OwnerGrantEditor>,
) {
  const entries = new Map(get(ownerGrantEditorsAtom))
  entries.set(key(s), { ...read(get, s), ...patch })
  set(ownerGrantEditorsAtom, entries)
}
function api(): ProjectOwnerExecutionGrantApi {
  const value = typeof window === 'undefined' ? undefined : window.electronAPI?.paa?.project
  if (
    !value ||
    typeof value.getOwnerExecutionGrant !== 'function' ||
    typeof value.listOwnerExecutionGrantHistory !== 'function' ||
    typeof value.previewOwnerExecutionGrantIssue !== 'function' ||
    typeof value.confirmOwnerExecutionGrantIssue !== 'function' ||
    typeof value.previewOwnerExecutionGrantRevoke !== 'function' ||
    typeof value.confirmOwnerExecutionGrantRevoke !== 'function'
  )
    throw new Error('当前应用缺少授权账本接口，请更新后重试')
  return value
}
export const ownerGrantApiAtom = atom<ProjectOwnerExecutionGrantApi>({
  getOwnerExecutionGrant: (s) => api().getOwnerExecutionGrant(s),
  listOwnerExecutionGrantHistory: (s) => api().listOwnerExecutionGrantHistory(s),
  previewOwnerExecutionGrantIssue: (r) => api().previewOwnerExecutionGrantIssue(r),
  confirmOwnerExecutionGrantIssue: (r) => api().confirmOwnerExecutionGrantIssue(r),
  previewOwnerExecutionGrantRevoke: (r) => api().previewOwnerExecutionGrantRevoke(r),
  confirmOwnerExecutionGrantRevoke: (r) => api().confirmOwnerExecutionGrantRevoke(r),
})
const message = (error: unknown) => (error instanceof Error ? error.message : '授权账本操作失败')
function assertSubject(value: { projectId: string; taskId?: string }, s: ProjectOwnerGoalSubject) {
  if (key(value) !== key(s)) throw new Error('授权账本响应主体不匹配')
}
export const loadOwnerGrantAtom = atom(null, async (get, set, s: ProjectOwnerGoalSubject) => {
  if (read(get, s).loading) return
  update(get, set, s, { loading: true, error: '' })
  try {
    const result = await get(ownerGrantApiAtom).getOwnerExecutionGrant(s)
    if (!result.ok) throw new Error(result.error.message)
    if (result.value) assertSubject(result.value, s)
    update(get, set, s, { grant: result.value, loaded: true })
  } catch (error) {
    update(get, set, s, { error: message(error), loaded: false })
  } finally {
    update(get, set, s, { loading: false })
  }
})
export const loadOwnerGrantHistoryAtom = atom(
  null,
  async (get, set, s: ProjectOwnerGoalSubject) => {
    if (read(get, s).historyLoading) return
    update(get, set, s, { historyLoading: true, historyError: '' })
    try {
      const result = await get(ownerGrantApiAtom).listOwnerExecutionGrantHistory(s)
      if (!result.ok) throw new Error(result.error.message)
      for (const record of result.value) assertSubject(record, s)
      update(get, set, s, { history: result.value, historyLoaded: true })
    } catch (error) {
      update(get, set, s, { historyError: message(error) })
    } finally {
      update(get, set, s, { historyLoading: false })
    }
  },
)
/** 发行preview：只读影响面；预览不落库，任何在途confirm/preview互斥。 */
export const previewOwnerGrantIssueAtom = atom(
  null,
  async (
    get,
    set,
    { subject, input }: { subject: ProjectOwnerGoalSubject; input: OwnerGrantIssueInput },
  ) => {
    if (read(get, subject).previewing || read(get, subject).confirming) return
    update(get, set, subject, { previewing: true, preview: null, revokePreview: null, error: '' })
    try {
      const result = await get(ownerGrantApiAtom).previewOwnerExecutionGrantIssue({
        ...subject,
        input,
      })
      if (!result.ok) {
        update(get, set, subject, { error: result.error.message })
        return
      }
      assertSubject(result.value, subject)
      update(get, set, subject, { preview: result.value })
    } catch (error) {
      update(get, set, subject, { error: message(error) })
    } finally {
      update(get, set, subject, { previewing: false })
    }
  },
)
/** 发行confirm：指纹三重校验在服务端；成功后清预览并重读授权与历史。 */
export const confirmOwnerGrantIssueAtom = atom(
  null,
  async (
    get,
    set,
    {
      subject,
      input,
      confirmedFingerprint,
    }: { subject: ProjectOwnerGoalSubject; input: OwnerGrantIssueInput; confirmedFingerprint: string },
  ) => {
    const before = read(get, subject)
    if (before.confirming || !before.preview) return
    if (before.preview.approvalFingerprint !== confirmedFingerprint) {
      update(get, set, subject, { error: '确认指纹与预览不符，请重新预览' })
      return
    }
    update(get, set, subject, { confirming: true, error: '' })
    try {
      const result = await get(ownerGrantApiAtom).confirmOwnerExecutionGrantIssue({
        ...subject,
        input,
        preview: before.preview,
        confirmedFingerprint,
      })
      if (!result.ok) {
        update(get, set, subject, { error: result.error.message, preview: null })
        return
      }
      assertSubject(result.value, subject)
      update(get, set, subject, {
        grant: result.value,
        preview: null,
        loaded: true,
        historyLoaded: false,
      })
    } catch (error) {
      update(get, set, subject, { error: message(error), preview: null })
    } finally {
      update(get, set, subject, { confirming: false })
    }
  },
)
export const previewOwnerGrantRevokeAtom = atom(
  null,
  async (
    get,
    set,
    { subject, grantId }: { subject: ProjectOwnerGoalSubject; grantId: string },
  ) => {
    if (read(get, subject).revoking || read(get, subject).previewing) return
    update(get, set, subject, { revoking: true, revokePreview: null, preview: null, error: '' })
    try {
      const result = await get(ownerGrantApiAtom).previewOwnerExecutionGrantRevoke({
        ...subject,
        grantId,
      })
      if (!result.ok) {
        update(get, set, subject, { error: result.error.message })
        return
      }
      update(get, set, subject, { revokePreview: result.value })
    } catch (error) {
      update(get, set, subject, { error: message(error) })
    } finally {
      update(get, set, subject, { revoking: false })
    }
  },
)
/** 撤权confirm：state active→paused，不删行；paused无复活路径。 */
export const confirmOwnerGrantRevokeAtom = atom(
  null,
  async (
    get,
    set,
    {
      subject,
      grantId,
      confirmedFingerprint,
    }: { subject: ProjectOwnerGoalSubject; grantId: string; confirmedFingerprint: string },
  ) => {
    const before = read(get, subject)
    if (before.revoking || !before.revokePreview) return
    if (before.revokePreview.fingerprint !== confirmedFingerprint) {
      update(get, set, subject, { error: '撤权指纹与预览不符，请重新预览' })
      return
    }
    update(get, set, subject, { revoking: true, error: '' })
    try {
      const result = await get(ownerGrantApiAtom).confirmOwnerExecutionGrantRevoke({
        ...subject,
        grantId,
        confirmedFingerprint,
      })
      if (!result.ok) {
        update(get, set, subject, { error: result.error.message, revokePreview: null })
        return
      }
      assertSubject(result.value, subject)
      update(get, set, subject, {
        grant: result.value,
        revokePreview: null,
        loaded: true,
        historyLoaded: false,
      })
    } catch (error) {
      update(get, set, subject, { error: message(error), revokePreview: null })
    } finally {
      update(get, set, subject, { revoking: false })
    }
  },
)
