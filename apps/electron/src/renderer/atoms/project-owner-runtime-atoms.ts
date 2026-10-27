/** 每个目标主体隔离，无自动准备/费用调用；只读刷新不丢未保存绑定输入。 */
import { atom } from 'jotai'
import type { AgentEmployeeResult, AgentWorkspace, OwnerRuntimeBinding, ProjectOwnerGoalResult, ProjectOwnerGoalSubject, ProjectOwnerPlanningContext, ProjectOwnerRunView, ProjectOwnerRuntimeApi, ProjectOwnerPlanApi, ProjectWorkspaceBinding } from '@gravitas/shared'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from './project-owner-goal-atoms'
import { getOwnerPlanEditor, ownerPlanEditorsAtom, ownerPlanGoalReady } from './project-owner-plan-atoms'
export interface OwnerRuntimeDataApi extends ProjectOwnerRuntimeApi {
  getOwnerPlanningContext: ProjectOwnerPlanApi['getOwnerPlanningContext']
  listEmployees: () => Promise<AgentEmployeeResult[]>
  listWorkspaces: () => Promise<AgentWorkspace[]>
  listWorkspaceBindings: (projectId: string) => Promise<ProjectWorkspaceBinding[]>
}
export const ownerRuntimeApiAtom = atom<OwnerRuntimeDataApi | null>(null)
function runtimeApi(override: OwnerRuntimeDataApi | null): OwnerRuntimeDataApi {
  if (override) return override
  const api = window.electronAPI.paa.project
  if (!api.getOwnerRuntimeBinding || !api.listOwnerPlanningRuns || !api.saveOwnerRuntimeBinding || !api.prepareOwnerPlanning) throw new Error('当前应用缺少完整Owner规划配置接口，请更新后使用')
  return { ...api, listEmployees: () => window.electronAPI.paa.agentEmployees.list(), listWorkspaces: () => window.electronAPI.listAgentWorkspaces(), listWorkspaceBindings: projectId => window.electronAPI.paa.projectWorkspace.listByProject(projectId) }
}
export interface OwnerRuntimeEditor {
  binding: OwnerRuntimeBinding | null
  employees: AgentEmployeeResult[]
  workspaces: AgentWorkspace[]
  boundWorkspaceIds: string[]
  runs: ProjectOwnerRunView[]
  context: ProjectOwnerPlanningContext | null
  ownerName: string
  carrierId: string
  workspaceId: string
  changeReason: string
  dirty: boolean
  loading: boolean
  saving: boolean
  generation: number
  prepareRequestId: string | null
  prepareSignature: string | null
  error: string
}
const initial: OwnerRuntimeEditor = { binding: null, employees: [], workspaces: [], boundWorkspaceIds: [], runs: [], context: null, ownerName: '项目Owner', carrierId: '', workspaceId: '', changeReason: '', dirty: false, loading: false, saving: false, generation: 0, prepareRequestId: null, prepareSignature: null, error: '' }
export const ownerRuntimeEditorsAtom = atom(new Map<string, OwnerRuntimeEditor>())
const key = (subject: ProjectOwnerGoalSubject) => JSON.stringify([subject.projectId, subject.taskId ?? null])
export const getOwnerRuntimeEditor = (entries: ReadonlyMap<string, OwnerRuntimeEditor>, subject: ProjectOwnerGoalSubject): OwnerRuntimeEditor => entries.get(key(subject)) ?? initial
function value<T>(response: ProjectOwnerGoalResult<T>): T { if (!response.ok) throw new Error(response.error.message); return response.value }
type ReadResult<T> = { ok: true; value: T } | { ok: false; error: string }
async function read<T>(request: () => Promise<T>): Promise<ReadResult<T>> {
  try { return { ok: true, value: await request() } }
  catch (cause) { return { ok: false, error: cause instanceof Error ? cause.message : String(cause) } }
}
export const editOwnerRuntimeAtom = atom(null, (get, set, input: { subject: ProjectOwnerGoalSubject; patch: Partial<Pick<OwnerRuntimeEditor, 'ownerName' | 'carrierId' | 'workspaceId' | 'changeReason'>> }) => {
  const entries = new Map(get(ownerRuntimeEditorsAtom)); const old = getOwnerRuntimeEditor(entries, input.subject)
  entries.set(key(input.subject), { ...old, ...input.patch, dirty: true, prepareRequestId: null, prepareSignature: null }); set(ownerRuntimeEditorsAtom, entries)
})
export const loadOwnerRuntimeAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject) => {
  const old = getOwnerRuntimeEditor(get(ownerRuntimeEditorsAtom), subject)
  if (old.saving) return
  const generation = old.generation + 1
  const update = (patch: Partial<OwnerRuntimeEditor>) => { const entries = new Map(get(ownerRuntimeEditorsAtom)); entries.set(key(subject), { ...getOwnerRuntimeEditor(entries, subject), ...patch }); set(ownerRuntimeEditorsAtom, entries) }
  update({ loading: true, generation, error: '' })
  try {
    const api = runtimeApi(get(ownerRuntimeApiAtom))
    const [bindingRead, runsRead, employeesRead, workspacesRead, bindingsRead, contextRead] = await Promise.all([
      read(() => api.getOwnerRuntimeBinding({ projectId: subject.projectId })),
      read(() => api.listOwnerPlanningRuns(subject)),
      read(() => api.listEmployees()),
      read(() => api.listWorkspaces()),
      read(() => api.listWorkspaceBindings(subject.projectId)),
      read(() => api.getOwnerPlanningContext(subject)),
    ])
    if (getOwnerRuntimeEditor(get(ownerRuntimeEditorsAtom), subject).generation !== generation) return
    const current = getOwnerRuntimeEditor(get(ownerRuntimeEditorsAtom), subject)
    const runs = runsRead.ok ? runsRead.value : { ok: false as const, error: { message: runsRead.error } }
    const context = contextRead.ok ? contextRead.value : { ok: false as const, error: { message: contextRead.error } }
    const messages = [
      !bindingRead.ok ? `Owner绑定读取失败：${bindingRead.error}` : !bindingRead.value.ok ? `Owner绑定读取失败：${bindingRead.value.error.message}` : '',
      !runs.ok ? `Run记录读取失败：${runs.error.message}；保留记录待核查，载体配置仍可单独查看或修复。` : '',
      !employeesRead.ok ? `员工候选读取失败：${employeesRead.error}；保留上次成功列表。` : '',
      !workspacesRead.ok ? `工作区候选读取失败：${workspacesRead.error}；保留上次成功列表。` : '',
      !bindingsRead.ok ? `项目工作区授权读取失败：${bindingsRead.error}；保留上次成功列表。` : '',
      !context.ok && getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject).snapshot ? `规划来源：${context.error.message}` : '',
    ].filter(Boolean)
    const stored = bindingRead.ok && bindingRead.value.ok ? bindingRead.value.value : current.binding
    update({ binding: stored, runs: runs.ok ? runs.value : current.runs, employees: employeesRead.ok ? employeesRead.value : current.employees, workspaces: workspacesRead.ok ? workspacesRead.value : current.workspaces, boundWorkspaceIds: bindingsRead.ok ? bindingsRead.value.map(item => item.workspaceId) : current.boundWorkspaceIds, context: context.ok ? context.value : null, error: messages.join(' '), ...(!current.dirty ? { ownerName: stored?.ownerName ?? '项目Owner', carrierId: stored?.carrierId ?? '', workspaceId: stored?.workspaceId ?? '', changeReason: '' } : {}) })
  } catch (cause) { if (getOwnerRuntimeEditor(get(ownerRuntimeEditorsAtom), subject).generation === generation) update({ error: cause instanceof Error ? cause.message : String(cause) }) }
  finally { if (getOwnerRuntimeEditor(get(ownerRuntimeEditorsAtom), subject).generation === generation) update({ loading: false }) }
})
export const saveOwnerRuntimeAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject) => {
  const old = getOwnerRuntimeEditor(get(ownerRuntimeEditorsAtom), subject)
  if (old.loading || old.saving || !old.dirty || !old.ownerName.trim() || !old.carrierId || !old.workspaceId || !old.changeReason.trim()) return
  const update = (patch: Partial<OwnerRuntimeEditor>) => { const entries = new Map(get(ownerRuntimeEditorsAtom)); entries.set(key(subject), { ...getOwnerRuntimeEditor(entries, subject), ...patch }); set(ownerRuntimeEditorsAtom, entries) }
  update({ saving: true, error: '' })
  try {
    const binding = value(await runtimeApi(get(ownerRuntimeApiAtom)).saveOwnerRuntimeBinding({ projectId: subject.projectId, expectedRevision: old.binding?.revision ?? 0, input: { ownerName: old.ownerName, carrierId: old.carrierId, workspaceId: old.workspaceId, changeReason: old.changeReason } }))
    update({ binding, dirty: false, changeReason: '', prepareRequestId: null, prepareSignature: null, saving: false }); await set(loadOwnerRuntimeAtom, subject)
  } catch (cause) { update({ error: cause instanceof Error ? cause.message : String(cause) }) }
  finally { update({ saving: false }) }
})
export const prepareOwnerRuntimeAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject) => {
  const old = getOwnerRuntimeEditor(get(ownerRuntimeEditorsAtom), subject), goal = getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject), plan = getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject)
  if (old.loading || old.saving || old.dirty || !old.binding || !old.context || !ownerPlanGoalReady(get, subject) || !plan.loaded || plan.loading || plan.saving || plan.dirty || plan.conflict || plan.requiresReview || old.context.goal.revision !== goal.snapshot?.revision) return
  const update = (patch: Partial<OwnerRuntimeEditor>) => { const entries = new Map(get(ownerRuntimeEditorsAtom)); entries.set(key(subject), { ...getOwnerRuntimeEditor(entries, subject), ...patch }); set(ownerRuntimeEditorsAtom, entries) }
  const prepareSignature = JSON.stringify([old.binding.revision, goal.snapshot!.revision, plan.snapshot?.revision ?? 0, old.context.fingerprint])
  const requestId = old.prepareSignature === prepareSignature && old.prepareRequestId ? old.prepareRequestId : crypto.randomUUID()
  update({ saving: true, prepareRequestId: requestId, prepareSignature, error: '' })
  try {
    value(await runtimeApi(get(ownerRuntimeApiAtom)).prepareOwnerPlanning({ projectId: subject.projectId, input: { requestId, ...(subject.taskId === undefined ? {} : { taskId: subject.taskId }), expectedBindingRevision: old.binding.revision, expectedGoalRevision: goal.snapshot!.revision, expectedPlanRevision: plan.snapshot?.revision ?? 0, expectedContextFingerprint: old.context.fingerprint } }))
    update({ saving: false, prepareRequestId: null, prepareSignature: null }); await set(loadOwnerRuntimeAtom, subject)
  } catch (cause) { update({ error: cause instanceof Error ? cause.message : String(cause) }) }
  finally { update({ saving: false }) }
})
