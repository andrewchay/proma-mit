/** 计划审阅仅保存内容；按项目/任务隔离，绝不创建执行或调用模型。 */
import { atom, type Getter, type Setter } from 'jotai'
import type { ProjectOwnerGoalSubject, ProjectOwnerPlanApi, ProjectOwnerPlanDraft, ProjectOwnerPlanningContext, ProjectOwnerPlanStep } from '@gravitas/shared'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from './project-owner-goal-atoms'

export interface OwnerPlanEditor {
  snapshot: ProjectOwnerPlanDraft | null
  context: ProjectOwnerPlanningContext | null
  history: ProjectOwnerPlanDraft[]
  summary: string
  assumptions: string[]
  risks: string[]
  steps: ProjectOwnerPlanStep[]
  changeReason: string
  loaded: boolean
  loading: boolean
  saving: boolean
  historyLoading: boolean
  historyLoaded: boolean
  historyError: string
  dirty: boolean
  conflict: boolean
  requiresReview: boolean
  editVersion: number
  error: string
}
const empty: OwnerPlanEditor = { snapshot: null, context: null, history: [], summary: '', assumptions: [], risks: [], steps: [], changeReason: '', loaded: false, loading: false, saving: false, historyLoading: false, historyLoaded: false, historyError: '', dirty: false, conflict: false, requiresReview: false, editVersion: 0, error: '' }
const key = (s: ProjectOwnerGoalSubject) => JSON.stringify([s.projectId, s.taskId ?? null])
export const ownerPlanEditorsAtom = atom(new Map<string, OwnerPlanEditor>())
/** 延迟到调用时才访问 window，兼容 SSR 和旧版目标 API 替身。 */
function currentPlanApi(): ProjectOwnerPlanApi {
  const api = typeof window === 'undefined' ? undefined : window.electronAPI?.paa?.project
  if (!api || typeof api.getOwnerPlanningContext !== 'function' || typeof api.getOwnerPlanDraft !== 'function'
    || typeof api.listOwnerPlanHistory !== 'function' || typeof api.saveOwnerPlanDraft !== 'function'
    || typeof api.confirmOwnerPlanDraft !== 'function') throw new Error('当前应用未提供完整Owner计划接口，请更新后再加载计划')
  return api
}
export const ownerPlanApiAtom = atom<ProjectOwnerPlanApi>({
  getOwnerPlanningContext: s => currentPlanApi().getOwnerPlanningContext(s),
  getOwnerPlanDraft: s => currentPlanApi().getOwnerPlanDraft(s),
  listOwnerPlanHistory: s => currentPlanApi().listOwnerPlanHistory(s),
  saveOwnerPlanDraft: r => currentPlanApi().saveOwnerPlanDraft(r),
  confirmOwnerPlanDraft: r => currentPlanApi().confirmOwnerPlanDraft(r),
})
export function getOwnerPlanEditor(entries: ReadonlyMap<string, OwnerPlanEditor>, subject: ProjectOwnerGoalSubject): OwnerPlanEditor { return entries.get(key(subject)) ?? empty }
function read(get: Getter, subject: ProjectOwnerGoalSubject) { return getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject) }
function update(get: Getter, set: Setter, subject: ProjectOwnerGoalSubject, patch: Partial<OwnerPlanEditor>) {
  const entries = new Map(get(ownerPlanEditorsAtom)); entries.set(key(subject), { ...read(get, subject), ...patch }); set(ownerPlanEditorsAtom, entries)
}
function fields(snapshot: ProjectOwnerPlanDraft | null) {
  return { summary: snapshot?.proposal.summary ?? '', assumptions: [...(snapshot?.proposal.assumptions ?? [])], risks: [...(snapshot?.proposal.risks ?? [])], steps: snapshot?.proposal.steps.map(s => ({ ...s, acceptanceCriteria: [...s.acceptanceCriteria], dependencies: [...s.dependencies] })) ?? [], changeReason: '' }
}
function assertSubject(value: ProjectOwnerGoalSubject, subject: ProjectOwnerGoalSubject) { if (value.projectId !== subject.projectId || value.taskId !== subject.taskId) throw new Error('计划响应主体与当前项目/任务不匹配') }
const errorText = (error: unknown) => error instanceof Error ? error.message : '计划操作失败'
export function ownerPlanGoalReady(get: Getter, subject: ProjectOwnerGoalSubject): boolean {
  const goal = getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject)
  const context = read(get, subject).context
  return goal.loaded && Boolean(goal.snapshot) && !goal.dirty && !goal.conflict && !goal.requiresReview && !goal.loading && !goal.saving && Boolean(context) && goal.snapshot?.revision === context?.goal.revision
}
function ready(get: Getter, subject: ProjectOwnerGoalSubject): boolean {
  const e = read(get, subject)
  return e.loaded && Boolean(e.snapshot) && !e.loading && !e.saving && !e.conflict && !e.requiresReview && ownerPlanGoalReady(get, subject)
}
const cleanLines = (lines: string[]) => lines.map(line => line.trim()).filter(Boolean)
function validDependencies(steps: ProjectOwnerPlanStep[]): boolean {
  const visited = new Set<string>(); const visiting = new Set<string>()
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return false
    if (visited.has(key)) return true
    const step = steps.find(s => s.key === key); if (!step) return false
    visiting.add(key)
    if (!cleanLines(step.dependencies).every(visit)) return false
    visiting.delete(key); visited.add(key); return true
  }
  return steps.every(step => visit(step.key))
}
function validText(value: string, max = 2000): boolean { return Boolean(value.trim()) && value.length <= max }
function validLines(lines: string[], minimum = 0): boolean {
  const values = cleanLines(lines)
  return values.length >= minimum && values.length <= 32 && values.every(value => validText(value)) && new Set(values).size === values.length
}
export function canSaveOwnerPlan(get: Getter, subject: ProjectOwnerGoalSubject): boolean {
  const e = read(get, subject)
  const roles = e.context?.sources.roles.map(r => r.key) ?? []
  const keys = e.steps.map(s => s.key)
  return ready(get, subject) && e.dirty && validText(e.summary) && validText(e.changeReason)
    && validLines(e.assumptions) && validLines(e.risks) && e.steps.length > 0 && e.steps.length <= 32
    && new Set(keys).size === keys.length
    && e.steps.every(s => validText(s.key, 200) && validText(s.title, 300) && validText(s.outcome)
      && validLines(s.acceptanceCriteria, 1) && roles.includes(s.roleKey) && validLines(s.dependencies)
      && cleanLines(s.dependencies).every(d => d !== s.key && keys.includes(d))) && validDependencies(e.steps)
}
export function canConfirmOwnerPlan(get: Getter, subject: ProjectOwnerGoalSubject): boolean {
  const e = read(get, subject)
  return ready(get, subject) && !e.dirty && e.snapshot?.state === 'proposed' && e.snapshot.contextFingerprint === e.context?.fingerprint && e.snapshot.goalRevision === e.context?.goal.revision
}
export const editOwnerPlanAtom = atom(null, (get, set, payload: { subject: ProjectOwnerGoalSubject; patch: Partial<Pick<OwnerPlanEditor, 'summary' | 'assumptions' | 'risks' | 'steps' | 'changeReason'>> }) => {
  update(get, set, payload.subject, { ...payload.patch, dirty: true, editVersion: read(get, payload.subject).editVersion + 1 })
})
export const loadOwnerPlanAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject) => {
  const before = read(get, subject); if (before.loading || before.saving) return
  update(get, set, subject, { loading: true, error: '' })
  try {
    const api = get(ownerPlanApiAtom); const response = await api.getOwnerPlanDraft(subject)
    if (!response.ok) throw new Error(response.error.message)
    if (response.value) { assertSubject(response.value, subject); assertSubject(response.value.proposal, subject) }
    const contextResponse = response.value ? await api.getOwnerPlanningContext(subject) : null
    if (contextResponse && !contextResponse.ok) throw new Error(contextResponse.error.message)
    const context = contextResponse?.ok ? contextResponse.value : null
    if (context) assertSubject(context.goal.goal, subject)
    const current = read(get, subject)
    const changed = current.snapshot?.revision !== response.value?.revision || current.context?.fingerprint !== context?.fingerprint
    update(get, set, subject, { snapshot: response.value, context, loaded: true, conflict: false, requiresReview: current.requiresReview || current.conflict || (current.dirty && changed), ...(current.dirty ? {} : fields(response.value)) })
  } catch (cause) { update(get, set, subject, { error: errorText(cause), loaded: false }) }
  finally { update(get, set, subject, { loading: false }) }
})
export const acknowledgeOwnerPlanComparisonAtom = atom(null, (get, set, subject: ProjectOwnerGoalSubject) => {
  const e = read(get, subject)
  if (e.loaded && e.requiresReview && !e.loading && !e.saving && !e.conflict) update(get, set, subject, { requiresReview: false, error: '' })
})
export const loadOwnerPlanHistoryAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject) => {
  if (read(get, subject).historyLoading) return
  update(get, set, subject, { historyLoading: true, historyError: '' })
  try {
    const response = await get(ownerPlanApiAtom).listOwnerPlanHistory(subject)
    if (!response.ok) throw new Error(response.error.message)
    for (const entry of response.value) { assertSubject(entry, subject); assertSubject(entry.proposal, subject) }
    update(get, set, subject, { history: response.value, historyLoaded: true })
  } catch (cause) { update(get, set, subject, { historyError: errorText(cause) }) }
  finally { update(get, set, subject, { historyLoading: false }) }
})
async function writePlan(get: Getter, set: Setter, subject: ProjectOwnerGoalSubject, confirm: boolean) {
  if (!(confirm ? canConfirmOwnerPlan(get, subject) : canSaveOwnerPlan(get, subject))) return
  const before = read(get, subject); const snapshot = before.snapshot; const context = before.context
  if (!snapshot || !context) return
  update(get, set, subject, { saving: true, error: '' })
  try {
    const request = { ...subject, expectedGoalRevision: context.goal.revision, expectedRevision: snapshot.revision }
    const api = get(ownerPlanApiAtom)
    const response = confirm ? await api.confirmOwnerPlanDraft(request) : await api.saveOwnerPlanDraft({ ...request, input: { expectedContextFingerprint: context.fingerprint, summary: before.summary, assumptions: cleanLines(before.assumptions), risks: cleanLines(before.risks), steps: before.steps.map(step => ({ ...step, acceptanceCriteria: cleanLines(step.acceptanceCriteria), dependencies: cleanLines(step.dependencies) })), changeReason: before.changeReason } })
    if (!response.ok) { update(get, set, subject, { error: response.error.message, conflict: response.error.code === 'conflict' }); return }
    assertSubject(response.value, subject); assertSubject(response.value.proposal, subject)
    const edited = read(get, subject).editVersion !== before.editVersion
    update(get, set, subject, { snapshot: response.value, dirty: edited, conflict: false, requiresReview: false, historyLoaded: false, ...(edited ? {} : fields(response.value)) })
  } catch (cause) { update(get, set, subject, { error: errorText(cause) }) }
  finally { update(get, set, subject, { saving: false }) }
}
export const saveOwnerPlanAtom = atom(null, (get, set, subject: ProjectOwnerGoalSubject) => writePlan(get, set, subject, false))
export const confirmOwnerPlanAtom = atom(null, (get, set, subject: ProjectOwnerGoalSubject) => writePlan(get, set, subject, true))
