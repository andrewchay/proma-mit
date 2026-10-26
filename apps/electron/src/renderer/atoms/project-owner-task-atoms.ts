/** AO06仅材料化暂停Task；本地状态不能把冻结来源转成授权。 */
import { atom, type Getter, type Setter } from 'jotai'
import type {
  OwnerTaskMaterializationInput,
  OwnerTaskMaterializationPreview,
  OwnerTaskMaterializationRecord,
  OwnerTaskMaterializationView,
  ProjectOwnerGoalSubject,
  ProjectOwnerTaskMaterializationApi,
} from '@gravitas/shared'
import {
  getOwnerExecutionEditor,
  ownerExecutionEditorsAtom,
  ownerExecutionPlanReady,
} from './project-owner-execution-atoms'
import { getOwnerPlanEditor, ownerPlanEditorsAtom } from './project-owner-plan-atoms'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from './project-owner-goal-atoms'
import { setProjectTasksAtom, type ProjectTaskAtom } from './project-atoms'
export interface OwnerTaskEditor {
  view: OwnerTaskMaterializationView | null
  preview: OwnerTaskMaterializationPreview | null
  history: OwnerTaskMaterializationRecord[]
  loaded: boolean
  loading: boolean
  previewing: boolean
  saving: boolean
  refreshing: boolean
  historyLoading: boolean
  historyLoaded: boolean
  historyError: string
  requiresReview: boolean
  error: string
  refreshError: string
  requestId: string
  sourceStamp: string
}
const empty: OwnerTaskEditor = {
  view: null,
  preview: null,
  history: [],
  loaded: false,
  loading: false,
  previewing: false,
  saving: false,
  refreshing: false,
  historyLoading: false,
  historyLoaded: false,
  historyError: '',
  requiresReview: false,
  error: '',
  refreshError: '',
  requestId: '',
  sourceStamp: '',
}
const key = (s: ProjectOwnerGoalSubject) => JSON.stringify([s.projectId, s.taskId ?? null])
function sourceStamp(get: Getter, s: ProjectOwnerGoalSubject): string {
  const e = getOwnerExecutionEditor(get(ownerExecutionEditorsAtom), s)
  const p = getOwnerPlanEditor(get(ownerPlanEditorsAtom), s)
  const g = getOwnerGoalEditor(get(ownerGoalEditorsAtom), s)
  // 不把历史读取或诊断文本当版本；任何来源/本地编辑变化立即废预览。
  return JSON.stringify([
    e.view,
    e.loaded,
    e.loading,
    e.saving,
    e.dirty,
    e.requiresReview,
    e.editVersion,
    p.snapshot,
    p.context,
    p.loaded,
    p.loading,
    p.saving,
    p.dirty,
    p.conflict,
    p.requiresReview,
    p.editVersion,
    g.snapshot,
    g.loaded,
    g.loading,
    g.saving,
    g.dirty,
    g.conflict,
    g.requiresReview,
    g.editVersion,
  ])
}
const taskEntriesAtom = atom(new Map<string, OwnerTaskEditor>())
/** 派生读取确保不依赖React effect才废弃旧预览；来源改动同一同步读取即生效。 */
export const ownerTaskEditorsAtom = atom(
  (get) => {
    const entries = new Map(get(taskEntriesAtom))
    for (const [entryKey, e] of entries) {
      const [projectId, taskId] = JSON.parse(entryKey) as [string, string | null]
      const s = { projectId, ...(taskId === null ? {} : { taskId }) }
      if (e.sourceStamp && e.sourceStamp !== sourceStamp(get, s))
        entries.set(entryKey, { ...e, preview: null, requiresReview: true })
    }
    return entries
  },
  (_get, set, entries: Map<string, OwnerTaskEditor>) => set(taskEntriesAtom, entries),
)
export function getOwnerTaskEditor(
  entries: ReadonlyMap<string, OwnerTaskEditor>,
  s: ProjectOwnerGoalSubject,
): OwnerTaskEditor {
  return entries.get(key(s)) ?? empty
}
const read = (get: Getter, s: ProjectOwnerGoalSubject) =>
  getOwnerTaskEditor(get(ownerTaskEditorsAtom), s)
function update(
  get: Getter,
  set: Setter,
  s: ProjectOwnerGoalSubject,
  patch: Partial<OwnerTaskEditor>,
) {
  const entries = new Map(get(ownerTaskEditorsAtom))
  entries.set(key(s), { ...read(get, s), ...patch })
  set(ownerTaskEditorsAtom, entries)
}
function api(): ProjectOwnerTaskMaterializationApi {
  const value = typeof window === 'undefined' ? undefined : window.electronAPI?.paa?.project
  if (
    !value ||
    typeof value.getOwnerTaskMaterialization !== 'function' ||
    typeof value.listOwnerTaskMaterializationHistory !== 'function' ||
    typeof value.previewOwnerTaskMaterialization !== 'function' ||
    typeof value.materializeOwnerTasks !== 'function'
  )
    throw new Error('当前应用缺少暂停任务落地接口，请更新后重试')
  return value
}
export const ownerTaskApiAtom = atom<ProjectOwnerTaskMaterializationApi>({
  getOwnerTaskMaterialization: (s) => api().getOwnerTaskMaterialization(s),
  listOwnerTaskMaterializationHistory: (s) => api().listOwnerTaskMaterializationHistory(s),
  previewOwnerTaskMaterialization: (r) => api().previewOwnerTaskMaterialization(r),
  materializeOwnerTasks: (r) => api().materializeOwnerTasks(r),
})
function isProjectTask(value: unknown): value is ProjectTaskAtom {
  if (!value || typeof value !== 'object') return false
  const t = value as Record<string, unknown>
  return (
    typeof t.id === 'string' &&
    typeof t.projectId === 'string' &&
    typeof t.title === 'string' &&
    typeof t.description === 'string' &&
    typeof t.status === 'string' &&
    ['low', 'medium', 'high', 'critical'].includes(String(t.priority)) &&
    typeof t.sortOrder === 'number' &&
    typeof t.createdAt === 'number' &&
    typeof t.updatedAt === 'number'
  )
}
/** 只读列表已重拉的专用信号；导航可订阅它刷新局部TaskList，不经过TaskChange。 */
export const ownerTaskListRefreshSignalAtom = atom<{ projectId: string; revision: number } | null>(
  null,
)
function applyTaskRefresh(get: Getter, set: Setter, projectId: string, tasks: ProjectTaskAtom[]) {
  set(setProjectTasksAtom, { projectId, tasks })
  set(ownerTaskListRefreshSignalAtom, {
    projectId,
    revision: (get(ownerTaskListRefreshSignalAtom)?.revision ?? 0) + 1,
  })
}
/** 专用只读刷新，不调用TaskChange、任务更新或派工API。 */
export const ownerTaskRefreshAtom = atom<{
  listTasks: (projectId: string) => Promise<ProjectTaskAtom[] | void>
}>({
  listTasks: async (projectId) => {
    const tasks = await window.electronAPI.paa.project.listTasks(projectId)
    if (
      !Array.isArray(tasks) ||
      !tasks.every(isProjectTask) ||
      tasks.some((t) => t.projectId !== projectId)
    )
      throw new Error('权威任务列表响应不匹配')
    return tasks
  },
})
export function ownerTaskInput(
  get: Getter,
  s: ProjectOwnerGoalSubject,
): OwnerTaskMaterializationInput | null {
  const e = read(get, s)
  const execution = getOwnerExecutionEditor(get(ownerExecutionEditorsAtom), s)
  const preparation = execution.view?.preparation
  const plan = getOwnerPlanEditor(get(ownerPlanEditorsAtom), s).snapshot
  if (
    !e.loaded ||
    e.loading ||
    e.requiresReview ||
    !e.view ||
    e.view.materialization ||
    !e.requestId ||
    !ownerExecutionPlanReady(get, s) ||
    !execution.loaded ||
    execution.loading ||
    execution.saving ||
    execution.dirty ||
    execution.requiresReview ||
    execution.view?.status !== 'current' ||
    !preparation ||
    !plan ||
    preparation.source.planFingerprint !== plan.planFingerprint ||
    preparation.source.planRevision !== plan.revision ||
    preparation.source.contextFingerprint !== plan.contextFingerprint ||
    preparation.input.expiresAt <= Date.now() ||
    execution.view.policyRevision !== preparation.policyRevision
  )
    return null
  if (s.taskId) {
    const selected = preparation.source.selectedStepKeys
    const step = preparation.source.plan.proposal.steps.find((value) => value.key === selected[0])
    if (selected.length !== 1 || !step || step.dependencies.length) return null
  }
  return {
    requestId: e.requestId,
    expectedMaterializationRevision: e.view.revision,
    expectedPreparationId: preparation.id,
    expectedPreparationRevision: preparation.revision,
    expectedPreparationHash: preparation.integrityHash,
    expectedPolicyRevision: preparation.policyRevision,
  }
}
function sameInput(a: OwnerTaskMaterializationInput, b: OwnerTaskMaterializationInput) {
  return (
    a.requestId === b.requestId &&
    a.expectedMaterializationRevision === b.expectedMaterializationRevision &&
    a.expectedPreparationId === b.expectedPreparationId &&
    a.expectedPreparationRevision === b.expectedPreparationRevision &&
    a.expectedPreparationHash === b.expectedPreparationHash &&
    a.expectedPolicyRevision === b.expectedPolicyRevision
  )
}
export function canPreviewOwnerTasks(get: Getter, s: ProjectOwnerGoalSubject) {
  const e = read(get, s)
  return !e.previewing && !e.saving && Boolean(ownerTaskInput(get, s))
}
export function canMaterializeOwnerTasks(get: Getter, s: ProjectOwnerGoalSubject) {
  const e = read(get, s)
  const input = ownerTaskInput(get, s)
  return (
    !e.previewing && !e.saving && Boolean(e.preview && input && sameInput(e.preview.input, input))
  )
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : '暂停任务落地操作失败'
function assertSubject(value: ProjectOwnerGoalSubject, s: ProjectOwnerGoalSubject) {
  if (key(value) !== key(s)) throw new Error('暂停任务响应主体不匹配')
}
function assertRecord(record: OwnerTaskMaterializationRecord, s: ProjectOwnerGoalSubject) {
  assertSubject(record, s)
  assertSubject(record.preview, s)
  assertSubject(record.preview.preparation, s)
  assertSubject(record.preview.preparation.source, s)
  if (
    record.stage !== 'paused_materialized_needs_revalidation' ||
    record.purpose !== 'owner_business_task_materialization'
  )
    throw new Error('暂停任务记录阶段不匹配')
  for (const link of record.links) {
    if (
      link.projectId !== s.projectId ||
      link.subjectKey !== (s.taskId ? `task:${s.taskId}` : 'project') ||
      link.materializationId !== record.id
    )
      throw new Error('Task步骤关联主体不匹配')
  }
}
function assertPreview(
  preview: OwnerTaskMaterializationPreview,
  s: ProjectOwnerGoalSubject,
  input: OwnerTaskMaterializationInput,
  preparation: OwnerTaskMaterializationPreview['preparation'],
) {
  assertSubject(preview, s)
  assertSubject(preview.preparation, s)
  assertSubject(preview.preparation.source, s)
  if (
    !sameInput(preview.input, input) ||
    JSON.stringify(preview.preparation) !== JSON.stringify(preparation)
  )
    throw new Error('暂停任务预览返回输入或准备来源不匹配')
}
export const loadOwnerTasksAtom = atom(null, async (get, set, s: ProjectOwnerGoalSubject) => {
  const before = read(get, s)
  if (before.loading || before.previewing || before.saving) return
  const stamp = sourceStamp(get, s)
  update(get, set, s, { loading: true, preview: null })
  try {
    const result = await get(ownerTaskApiAtom).getOwnerTaskMaterialization(s)
    if (!result.ok) throw new Error(result.error.message)
    if (result.value.materialization) assertRecord(result.value.materialization, s)
    const current = read(get, s)
    update(get, set, s, {
      view: result.value,
      loaded: true,
      requiresReview:
        current.requiresReview ||
        stamp !== sourceStamp(get, s) ||
        Boolean(before.view && JSON.stringify(before.view) !== JSON.stringify(result.value)),
      sourceStamp: stamp,
      requestId: current.requestId || crypto.randomUUID(),
    })
  } catch (error) {
    update(get, set, s, { error: message(error), loaded: false })
  } finally {
    update(get, set, s, { loading: false })
  }
})
export const compareOwnerTasksAtom = atom(null, (get, set, s: ProjectOwnerGoalSubject) => {
  const e = read(get, s)
  // 冲突必须先显式读取最新版本；比较不调用后端，不沿用预览。
  if (e.loaded && !e.loading && !e.previewing && !e.saving)
    update(get, set, s, {
      requiresReview: false,
      sourceStamp: sourceStamp(get, s),
      preview: null,
      requestId: crypto.randomUUID(),
      error: '',
    })
})
export const previewOwnerTasksAtom = atom(null, async (get, set, s: ProjectOwnerGoalSubject) => {
  if (!canPreviewOwnerTasks(get, s)) return
  const input = ownerTaskInput(get, s)
  const preparation = getOwnerExecutionEditor(get(ownerExecutionEditorsAtom), s).view?.preparation
  if (!input || !preparation) return
  const stamp = sourceStamp(get, s)
  update(get, set, s, { previewing: true, preview: null, error: '', sourceStamp: stamp })
  try {
    const result = await get(ownerTaskApiAtom).previewOwnerTaskMaterialization({ ...s, input })
    if (!result.ok) {
      update(get, set, s, {
        error: result.error.message,
        ...(result.error.code === 'conflict' ? { requiresReview: true, loaded: false } : {}),
      })
      return
    }
    assertPreview(result.value, s, input, preparation)
    const current = ownerTaskInput(get, s)
    if (stamp === sourceStamp(get, s) && current && sameInput(input, current))
      update(get, set, s, { preview: result.value })
  } catch (error) {
    update(get, set, s, { error: message(error) })
  } finally {
    update(get, set, s, { previewing: false })
  }
})
export const materializeOwnerTasksAtom = atom(
  null,
  async (get, set, s: ProjectOwnerGoalSubject) => {
    if (!canMaterializeOwnerTasks(get, s)) return
    const before = read(get, s)
    const input = ownerTaskInput(get, s)
    if (!input || !before.preview) return
    update(get, set, s, { saving: true, error: '', refreshError: '' })
    try {
      const result = await get(ownerTaskApiAtom).materializeOwnerTasks({
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
      assertRecord(result.value, s)
      assertPreview(result.value.preview, s, input, before.preview.preparation)
      if (
        !sameInput(result.value.input, input) ||
        result.value.preview.previewFingerprint !== before.preview.previewFingerprint
      )
        throw new Error('暂停任务保存返回输入或预览指纹不匹配')
      // 已提交记录即使晚到也保留；不写上游AO05输入/来源，不伪造重新验证成功。
      update(get, set, s, {
        preview: null,
        historyLoaded: false,
        requiresReview: true,
        loaded: false,
        view: {
          revision: result.value.revision,
          materialization: result.value,
          status: 'needs_revalidation',
          blockers: ['暂停任务已落地，需要重新验证来源及真实Task关联；未发行执行许可'],
        },
      })
      try {
        const tasks = await get(ownerTaskRefreshAtom).listTasks(s.projectId)
        if (tasks) applyTaskRefresh(get, set, s.projectId, tasks)
      } catch (error) {
        update(get, set, s, {
          refreshError: `暂停任务保存成功，权威任务列表刷新失败：${message(error)}。已保存记录未回滚，请只读刷新，不要重复提交。`,
        })
      }
    } catch (error) {
      update(get, set, s, {
        error: message(error),
        preview: null,
        loaded: false,
        requiresReview: true,
      })
    } finally {
      update(get, set, s, { saving: false })
    }
  },
)
export const refreshOwnerTaskListAtom = atom(null, async (get, set, s: ProjectOwnerGoalSubject) => {
  if (read(get, s).saving || read(get, s).refreshing) return
  update(get, set, s, { refreshing: true })
  try {
    const tasks = await get(ownerTaskRefreshAtom).listTasks(s.projectId)
    if (tasks) applyTaskRefresh(get, set, s.projectId, tasks)
    update(get, set, s, { refreshError: '' })
  } catch (error) {
    update(get, set, s, {
      refreshError: `权威任务列表刷新失败：${message(error)}。已有暂停任务保存未回滚。`,
    })
  } finally {
    update(get, set, s, { refreshing: false })
  }
})
export const loadOwnerTaskHistoryAtom = atom(null, async (get, set, s: ProjectOwnerGoalSubject) => {
  if (read(get, s).historyLoading) return
  update(get, set, s, { historyLoading: true, historyError: '' })
  try {
    const result = await get(ownerTaskApiAtom).listOwnerTaskMaterializationHistory(s)
    if (!result.ok) throw new Error(result.error.message)
    for (const record of result.value) assertRecord(record, s)
    update(get, set, s, { history: result.value, historyLoaded: true })
  } catch (error) {
    update(get, set, s, { historyError: message(error) })
  } finally {
    update(get, set, s, { historyLoading: false })
  }
})
