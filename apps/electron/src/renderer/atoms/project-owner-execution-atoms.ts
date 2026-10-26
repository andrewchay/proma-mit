/** 暂停准备的本地输入，不是业务授权或额度账本。 */
import { atom, type Getter, type Setter } from 'jotai'
import type {
  OwnerExecutionPreparationInput,
  OwnerExecutionPreparationPreview,
  OwnerExecutionPreparationRecord,
  OwnerExecutionPreparationView,
  ProjectOwnerExecutionPreparationApi,
  ProjectOwnerGoalSubject,
} from '@gravitas/shared'
import {
  getOwnerPlanEditor,
  ownerPlanEditorsAtom,
  ownerPlanGoalReady,
} from './project-owner-plan-atoms'
export interface OwnerExecutionEditor {
  view: OwnerExecutionPreparationView | null
  preview: OwnerExecutionPreparationPreview | null
  history: OwnerExecutionPreparationRecord[]
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
  selectedStepKeys: string[]
  executionKind: 'development' | 'controlled'
  executorEmployeeId: string
  reviewerEmployeeId: string
  workspaceId: string
  knowledgeSourceIds: string[]
  targetPathsText: string
  allowedPathsText: string
  verificationCommandsText: string
  maxCostMicrosText: string
  maxRunsText: string
  maxReworkText: string
  expiresAtText: string
  changeReason: string
}
const empty: OwnerExecutionEditor = {
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
  selectedStepKeys: [],
  executionKind: 'controlled',
  executorEmployeeId: '',
  reviewerEmployeeId: '',
  workspaceId: '',
  knowledgeSourceIds: [],
  targetPathsText: '',
  allowedPathsText: '',
  verificationCommandsText: '',
  maxCostMicrosText: '',
  maxRunsText: '',
  maxReworkText: '',
  expiresAtText: '',
  changeReason: '',
}
const key = (s: ProjectOwnerGoalSubject) => JSON.stringify([s.projectId, s.taskId ?? null])
export const ownerExecutionEditorsAtom = atom(new Map<string, OwnerExecutionEditor>())
export function getOwnerExecutionEditor(
  entries: ReadonlyMap<string, OwnerExecutionEditor>,
  subject: ProjectOwnerGoalSubject,
) {
  return entries.get(key(subject)) ?? empty
}
const read = (get: Getter, s: ProjectOwnerGoalSubject) =>
  getOwnerExecutionEditor(get(ownerExecutionEditorsAtom), s)
function update(
  get: Getter,
  set: Setter,
  s: ProjectOwnerGoalSubject,
  patch: Partial<OwnerExecutionEditor>,
) {
  const entries = new Map(get(ownerExecutionEditorsAtom))
  entries.set(key(s), { ...read(get, s), ...patch })
  set(ownerExecutionEditorsAtom, entries)
}
function api(): ProjectOwnerExecutionPreparationApi {
  const value = typeof window === 'undefined' ? undefined : window.electronAPI?.paa?.project
  if (
    !value ||
    typeof value.getOwnerExecutionPreparation !== 'function' ||
    typeof value.listOwnerExecutionPreparationHistory !== 'function' ||
    typeof value.previewOwnerExecutionPreparation !== 'function' ||
    typeof value.saveOwnerExecutionPreparation !== 'function'
  )
    throw new Error('当前应用缺少执行准备接口，请更新后重试')
  return value
}
export const ownerExecutionApiAtom = atom<ProjectOwnerExecutionPreparationApi>({
  getOwnerExecutionPreparation: (s) => api().getOwnerExecutionPreparation(s),
  listOwnerExecutionPreparationHistory: (s) => api().listOwnerExecutionPreparationHistory(s),
  previewOwnerExecutionPreparation: (r) => api().previewOwnerExecutionPreparation(r),
  saveOwnerExecutionPreparation: (r) => api().saveOwnerExecutionPreparation(r),
})
export type OwnerExecutionEdit = Partial<
  Pick<
    OwnerExecutionEditor,
    | 'selectedStepKeys'
    | 'executionKind'
    | 'executorEmployeeId'
    | 'reviewerEmployeeId'
    | 'workspaceId'
    | 'knowledgeSourceIds'
    | 'targetPathsText'
    | 'allowedPathsText'
    | 'verificationCommandsText'
    | 'maxCostMicrosText'
    | 'maxRunsText'
    | 'maxReworkText'
    | 'expiresAtText'
    | 'changeReason'
  >
>
export const editOwnerExecutionAtom = atom(
  null,
  (get, set, { subject, patch }: { subject: ProjectOwnerGoalSubject; patch: OwnerExecutionEdit }) =>
    update(get, set, subject, {
      ...patch,
      preview: null,
      requestId: crypto.randomUUID(),
      editVersion: read(get, subject).editVersion + 1,
      dirty: true,
    }),
)
export function parseOwnerExecutionInteger(text: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : null
}
function expiry(text: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return Number.NaN
  const date = new Date(text)
  const [year, month, day, hour, minute] = text.split(/[-T:]/).map(Number)
  if (
    date.getFullYear() !== year ||
    date.getMonth() + 1 !== month ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  )
    return Number.NaN
  return date.getTime()
}
const lines = (text: string) =>
  text
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean)
    .sort()
export function ownerExecutionPlanReady(get: Getter, subject: ProjectOwnerGoalSubject): boolean {
  const p = getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject)
  return (
    ownerPlanGoalReady(get, subject) &&
    p.loaded &&
    !p.loading &&
    !p.saving &&
    !p.dirty &&
    !p.conflict &&
    !p.requiresReview &&
    p.snapshot?.state === 'confirmed' &&
    p.snapshot.contextFingerprint === p.context?.fingerprint
  )
}
export function ownerExecutionInput(
  get: Getter,
  subject: ProjectOwnerGoalSubject,
): OwnerExecutionPreparationInput | null {
  const e = read(get, subject)
  const p = getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject).snapshot
  if (
    !ownerExecutionPlanReady(get, subject) ||
    !p ||
    !e.loaded ||
    !e.view ||
    e.loading ||
    e.requiresReview ||
    !e.requestId
  )
    return null
  const cost = parseOwnerExecutionInteger(e.maxCostMicrosText)
  const runs = parseOwnerExecutionInteger(e.maxRunsText)
  const rework = parseOwnerExecutionInteger(e.maxReworkText)
  const expiresAt = expiry(e.expiresAtText)
  const executor = e.view.choices.employees.find((v) => v.id === e.executorEmployeeId)
  const reviewer = e.view.choices.employees.find((v) => v.id === e.reviewerEmployeeId)
  if (
    !executor ||
    !reviewer ||
    executor.id === reviewer.id ||
    executor.executionProfile !== e.executionKind ||
    reviewer.executionProfile !== e.executionKind ||
    !executor.workspaceIds.includes(e.workspaceId) ||
    !reviewer.workspaceIds.includes(e.workspaceId) ||
    !e.view.choices.workspaces.some((v) => v.id === e.workspaceId) ||
    !executor.modelId ||
    executor.channelId !== reviewer.channelId ||
    executor.modelId !== reviewer.modelId ||
    executor.runtime !== reviewer.runtime
  )
    return null
  const selected = new Set(e.selectedStepKeys)
  if (
    !selected.size ||
    selected.size !== e.selectedStepKeys.length ||
    !e.selectedStepKeys.every((k) => p.proposal.steps.some((s) => s.key === k)) ||
    !p.proposal.steps
      .filter((s) => selected.has(s.key))
      .every((s) => s.dependencies.every((k) => selected.has(k)))
  )
    return null
  if (
    new Set(e.knowledgeSourceIds).size !== e.knowledgeSourceIds.length ||
    !e.knowledgeSourceIds.every((id) => e.view?.choices.knowledgeSources.some((v) => v.id === id))
  )
    return null
  if (
    cost === null ||
    cost <= 0 ||
    runs === null ||
    runs <= 0 ||
    rework === null ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    !e.changeReason.trim()
  )
    return null
  const scope = {
    workspaceId: e.workspaceId,
    targetPaths: lines(e.targetPathsText),
    allowedPaths: lines(e.allowedPathsText),
    verificationCommands: lines(e.verificationCommandsText),
  }
  if (
    e.executionKind === 'development' &&
    (!scope.targetPaths.length || !scope.allowedPaths.length)
  )
    return null
  return {
    requestId: e.requestId,
    expectedPreparationRevision: e.view.revision,
    expectedPolicyRevision: e.view.policyRevision,
    expectedGoalRevision: p.goalRevision,
    expectedPlanRevision: p.revision,
    selectedStepKeys: [...e.selectedStepKeys].sort(),
    executionKind: e.executionKind,
    ...(e.executionKind === 'development' ? { developmentScope: scope } : {}),
    executorEmployeeId: executor.id,
    reviewerEmployeeId: reviewer.id,
    workspaceId: e.workspaceId,
    knowledgeSourceIds: [...e.knowledgeSourceIds].sort(),
    maxCostMicros: cost,
    maxRuns: runs,
    maxRework: rework,
    expiresAt,
    changeReason: e.changeReason.trim(),
  }
}
function sameInput(
  left: OwnerExecutionPreparationInput,
  right: OwnerExecutionPreparationInput,
): boolean {
  const ordered = (input: OwnerExecutionPreparationInput) =>
    JSON.stringify(input, [
      'requestId',
      'expectedPreparationRevision',
      'expectedPolicyRevision',
      'expectedGoalRevision',
      'expectedPlanRevision',
      'selectedStepKeys',
      'executionKind',
      'developmentScope',
      'executorEmployeeId',
      'reviewerEmployeeId',
      'workspaceId',
      'knowledgeSourceIds',
      'maxCostMicros',
      'maxRuns',
      'maxRework',
      'expiresAt',
      'changeReason',
      'targetPaths',
      'allowedPaths',
      'reviewerId',
      'decisionIds',
      'verificationCommands',
    ])
  return ordered(left) === ordered(right)
}
export function canPreviewOwnerExecution(get: Getter, s: ProjectOwnerGoalSubject) {
  const e = read(get, s)
  return !e.previewing && !e.saving && Boolean(ownerExecutionInput(get, s))
}
export function canSaveOwnerExecution(get: Getter, s: ProjectOwnerGoalSubject) {
  const e = read(get, s)
  const input = ownerExecutionInput(get, s)
  return (
    !e.previewing &&
    !e.saving &&
    Boolean(
      e.preview &&
        input &&
        e.preview.planFingerprint ===
          getOwnerPlanEditor(get(ownerPlanEditorsAtom), s).snapshot?.planFingerprint &&
        sameInput(e.preview.input, input),
    )
  )
}
const message = (error: unknown) => (error instanceof Error ? error.message : '执行准备操作失败')
function assertSubject(value: ProjectOwnerGoalSubject, s: ProjectOwnerGoalSubject) {
  if (key(value) !== key(s)) throw new Error('执行准备响应主体不匹配')
}
export const loadOwnerExecutionAtom = atom(null, async (get, set, s: ProjectOwnerGoalSubject) => {
  const before = read(get, s)
  if (before.loading || before.saving || before.previewing) return
  update(get, set, s, { loading: true, preview: null })
  try {
    const result = await get(ownerExecutionApiAtom).getOwnerExecutionPreparation(s)
    if (!result.ok) throw new Error(result.error.message)
    const current = read(get, s)
    const changed = Boolean(
      before.view && JSON.stringify(before.view) !== JSON.stringify(result.value),
    )
    update(get, set, s, {
      view: result.value,
      loaded: true,
      requiresReview: current.requiresReview || (current.dirty && (!before.view || changed)),
      requestId: current.requestId || crypto.randomUUID(),
    })
  } catch (error) {
    update(get, set, s, { error: message(error), loaded: false })
  } finally {
    update(get, set, s, { loading: false })
  }
})
export const compareOwnerExecutionAtom = atom(null, (get, set, s: ProjectOwnerGoalSubject) => {
  const e = read(get, s)
  if (e.loaded && !e.loading && !e.saving && !e.previewing)
    update(get, set, s, {
      requiresReview: false,
      preview: null,
      requestId: crypto.randomUUID(),
      error: '',
    })
})
export const previewOwnerExecutionAtom = atom(
  null,
  async (get, set, s: ProjectOwnerGoalSubject) => {
    if (!canPreviewOwnerExecution(get, s)) return
    const before = read(get, s)
    const input = ownerExecutionInput(get, s)
    if (!input) return
    update(get, set, s, { previewing: true, preview: null, error: '' })
    try {
      const result = await get(ownerExecutionApiAtom).previewOwnerExecutionPreparation({
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
      const currentInput = ownerExecutionInput(get, s)
      if (
        read(get, s).editVersion === before.editVersion &&
        currentInput &&
        sameInput(currentInput, input)
      ) {
        if (!sameInput(result.value.input, input)) throw new Error('预览返回输入不匹配')
        update(get, set, s, { preview: result.value })
      }
    } catch (error) {
      update(get, set, s, { error: message(error) })
    } finally {
      update(get, set, s, { previewing: false })
    }
  },
)
export const saveOwnerExecutionAtom = atom(null, async (get, set, s: ProjectOwnerGoalSubject) => {
  if (!canSaveOwnerExecution(get, s)) return
  const before = read(get, s)
  const input = ownerExecutionInput(get, s)
  if (!input || !before.preview) return
  update(get, set, s, { saving: true, error: '' })
  try {
    const result = await get(ownerExecutionApiAtom).saveOwnerExecutionPreparation({
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
      requiresReview: true,
      view: current.view
        ? {
            ...current.view,
            preparation: result.value,
            revision: result.value.revision,
            policyRevision: result.value.policyRevision,
            status: 'current',
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
})
export const loadOwnerExecutionHistoryAtom = atom(
  null,
  async (get, set, s: ProjectOwnerGoalSubject) => {
    if (read(get, s).historyLoading) return
    update(get, set, s, { historyLoading: true, historyError: '' })
    try {
      const result = await get(ownerExecutionApiAtom).listOwnerExecutionPreparationHistory(s)
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
