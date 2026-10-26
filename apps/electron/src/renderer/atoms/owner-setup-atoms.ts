/** 对话只组织本地配置；权威写入和逐次模型费用仍由既有主进程服务决定。 */
import { atom } from 'jotai'
import type { AgentEmployeeResult, AgentWorkspace, Channel, CreateAgentEmployeeInput, OwnerRuntimeBinding, ProjectOwnerGoalSubject, ProjectOwnerRuntimeApi, ProjectWorkspaceBinding } from '@gravitas/shared'
import { getOwnerGoalEditor, ownerGoalEditorsAtom, saveOwnerGoalAtom } from './project-owner-goal-atoms'
import { getOwnerPlanEditor, loadOwnerPlanAtom, ownerPlanEditorsAtom } from './project-owner-plan-atoms'
import { getOwnerRuntimeEditor, loadOwnerRuntimeAtom, ownerRuntimeEditorsAtom, prepareOwnerRuntimeAtom } from './project-owner-runtime-atoms'

export interface OwnerSetupChannel extends Pick<Channel, 'id' | 'name' | 'models' | 'enabled' | 'updatedAt'> {}
export interface OwnerSetupFacts {
  channels: OwnerSetupChannel[]
  employees: AgentEmployeeResult[]
  workspaces: AgentWorkspace[]
  bindings: ProjectWorkspaceBinding[]
  binding: OwnerRuntimeBinding | null
}
export interface OwnerSetupApi {
  listChannels(): Promise<OwnerSetupChannel[]>
  listEmployees(): Promise<AgentEmployeeResult[]>
  listWorkspaces(): Promise<AgentWorkspace[]>
  listBindings(projectId: string): Promise<ProjectWorkspaceBinding[]>
  getBinding: ProjectOwnerRuntimeApi['getOwnerRuntimeBinding']
  saveBinding: ProjectOwnerRuntimeApi['saveOwnerRuntimeBinding']
  createWorkspace(name: string): Promise<AgentWorkspace>
  bindWorkspace(projectId: string, workspaceId: string): Promise<unknown>
  createEmployee(input: CreateAgentEmployeeInput): Promise<AgentEmployeeResult>
}
export const ownerSetupApiAtom = atom<OwnerSetupApi | null>(null)
function apiFor(override: OwnerSetupApi | null): OwnerSetupApi {
  if (override) return override
  const api = window.electronAPI
  return {
    // 配置对话不保留渠道凭据或端点。
    listChannels: async () => (await api.listChannels()).map(({ id, name, models, enabled, updatedAt }) => ({ id, name, models, enabled, updatedAt })),
    listEmployees: () => api.paa.agentEmployees.list(), listWorkspaces: () => api.listAgentWorkspaces(),
    listBindings: projectId => api.paa.projectWorkspace.listByProject(projectId),
    getBinding: input => api.paa.project.getOwnerRuntimeBinding(input), saveBinding: input => api.paa.project.saveOwnerRuntimeBinding(input),
    createWorkspace: name => api.createAgentWorkspace(name), bindWorkspace: (projectId, workspaceId) => api.paa.projectWorkspace.bind(projectId, workspaceId),
    createEmployee: input => api.paa.agentEmployees.create(input),
  }
}
export const ownerSetupKey = (subject: ProjectOwnerGoalSubject): string => JSON.stringify([subject.projectId, subject.taskId ?? null])
export const ownerSetupModelKey = (channelId: string, modelId: string): string => JSON.stringify([channelId, modelId])
export function ownerSetupModels(facts: OwnerSetupFacts) {
  return facts.channels.filter(channel => channel.enabled).flatMap(channel => channel.models.filter(model => model.enabled).map(model => ({
    key: ownerSetupModelKey(channel.id, model.id), channelId: channel.id, modelId: model.id, label: `${channel.name} · ${model.name}`,
  })))
}
export function ownerSetupCarriers(facts: OwnerSetupFacts, modelKey: string, workspaceId: string): AgentEmployeeResult[] {
  const model = ownerSetupModels(facts).find(item => item.key === modelKey)
  if (!model || !facts.workspaces.some(item => item.id === workspaceId)) return []
  return facts.employees.filter(item => item.enabled && item.runtime === 'ai-sdk' && item.executionProfile === 'controlled'
    && !item.workflowId && ['safe', 'auto'].includes(item.permissionMode ?? 'safe')
    && item.channelId === model.channelId && item.modelId === model.modelId
    && (item.workspaceIds ?? (item.workspaceId ? [item.workspaceId] : [])).includes(workspaceId))
}
export function ownerSetupBindingAvailable(facts: OwnerSetupFacts): boolean {
  const binding = facts.binding
  return Boolean(binding && facts.bindings.some(item => item.workspaceId === binding.workspaceId)
    && ownerSetupCarriers(facts, ownerSetupModelKey(binding.channelId, binding.modelId), binding.workspaceId).some(item => item.id === binding.carrierId))
}
export interface OwnerSetupState {
  facts: OwnerSetupFacts | null
  modelKey: string
  workspaceId: string
  carrierId: string
  newWorkspace: boolean
  authorizeWorkspace: boolean
  dirty: boolean
  loading: boolean
  saving: boolean
  needsRefresh: boolean
  editingGoal: boolean
  editingConfiguration: boolean
  error: string
}
const initial: OwnerSetupState = { facts: null, modelKey: '', workspaceId: '', carrierId: '', newWorkspace: false, authorizeWorkspace: false, dirty: false, loading: false, saving: false, needsRefresh: false, editingGoal: false, editingConfiguration: false, error: '' }
export const ownerSetupStatesAtom = atom(new Map<string, OwnerSetupState>())
export function getOwnerSetupState(entries: ReadonlyMap<string, OwnerSetupState>, subject: ProjectOwnerGoalSubject): OwnerSetupState { return entries.get(ownerSetupKey(subject)) ?? initial }
export const editOwnerSetupAtom = atom(null, (get, set, { subject, patch }: { subject: ProjectOwnerGoalSubject; patch: Partial<Pick<OwnerSetupState, 'modelKey' | 'workspaceId' | 'carrierId' | 'newWorkspace' | 'authorizeWorkspace' | 'editingGoal' | 'editingConfiguration'>> }) => {
  const current = getOwnerSetupState(get(ownerSetupStatesAtom), subject)
  if (current.saving) return
  const entries = new Map(get(ownerSetupStatesAtom))
  const configurationChanged = (patch.modelKey !== undefined && patch.modelKey !== current.modelKey)
    || (patch.workspaceId !== undefined && patch.workspaceId !== current.workspaceId) || (patch.newWorkspace !== undefined && patch.newWorkspace !== current.newWorkspace)
  const bindingChanged = configurationChanged || (patch.carrierId !== undefined && patch.carrierId !== current.carrierId)
    || (patch.authorizeWorkspace !== undefined && patch.authorizeWorkspace !== current.authorizeWorkspace)
  entries.set(ownerSetupKey(subject), { ...current, ...(configurationChanged ? { carrierId: '', authorizeWorkspace: false } : {}), ...patch, dirty: current.dirty || bindingChanged })
  set(ownerSetupStatesAtom, entries)
})
async function readFacts(api: OwnerSetupApi, projectId: string): Promise<OwnerSetupFacts> {
  const [channels, employees, workspaces, bindings, response] = await Promise.all([
    api.listChannels(), api.listEmployees(), api.listWorkspaces(), api.listBindings(projectId), api.getBinding({ projectId }),
  ])
  if (!response.ok) throw new Error(response.error.message)
  if (bindings.some(binding => binding.projectId !== projectId) || (response.value && response.value.projectId !== projectId)) throw new Error('返回的配置不属于当前项目，已停止配置')
  return { channels, employees, workspaces, bindings, binding: response.value }
}
export const loadOwnerSetupAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject) => {
  const read = () => getOwnerSetupState(get(ownerSetupStatesAtom), subject)
  const update = (patch: Partial<OwnerSetupState>) => { const entries = new Map(get(ownerSetupStatesAtom)); entries.set(ownerSetupKey(subject), { ...read(), ...patch }); set(ownerSetupStatesAtom, entries) }
  if (read().loading || read().saving) return
  update({ loading: true, error: '' })
  try {
    const facts = await readFacts(apiFor(get(ownerSetupApiAtom)), subject.projectId)
    const bound = facts.workspaces.filter(workspace => facts.bindings.some(binding => binding.workspaceId === workspace.id))
    const existing = facts.employees.filter(employee => bound.some(workspace => ownerSetupCarriers(facts, ownerSetupModelKey(employee.channelId, employee.modelId ?? ''), workspace.id).includes(employee)))
    const modelKeys = [...new Set(existing.map(employee => ownerSetupModelKey(employee.channelId, employee.modelId!)))]
    const validBinding = ownerSetupBindingAvailable(facts) ? facts.binding : null
    const current = read()
    const savedSelectionRecovered = validBinding && validBinding.revision > (current.facts?.binding?.revision ?? 0)
      && validBinding.carrierId === current.carrierId && validBinding.workspaceId === current.workspaceId
      && ownerSetupModelKey(validBinding.channelId, validBinding.modelId) === current.modelKey
    update({ facts, needsRefresh: false, ...(savedSelectionRecovered ? { dirty: false, authorizeWorkspace: false } : {}), ...(!current.dirty ? {
      modelKey: validBinding ? ownerSetupModelKey(validBinding.channelId, validBinding.modelId) : modelKeys.length === 1 ? modelKeys[0]! : '',
      workspaceId: validBinding?.workspaceId ?? (bound.length === 1 ? bound[0]!.id : ''), carrierId: validBinding?.carrierId ?? '',
    } : {}) })
  } catch (cause) { update({ needsRefresh: true, error: cause instanceof Error ? cause.message : String(cause) }) }
  finally { update({ loading: false }) }
})

export const saveOwnerSetupGoalAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject) => {
  await set(saveOwnerGoalAtom, subject)
  const goal = getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject)
  if (goal.snapshot && !goal.dirty && !goal.error) set(editOwnerSetupAtom, { subject, patch: { editingGoal: false } })
  await set(loadOwnerSetupAtom, subject)
})

function employeeConfiguration(employee: AgentEmployeeResult): string {
  const { totalTasks: _total, completedTasks: _completed, failureCount: _failures, avgDurationMs: _duration, updatedAt: _updatedAt, ...configuration } = employee
  return JSON.stringify(configuration)
}

/** 用户已确认的同一来源准备只保留一份；不自动发送收费请求或重试未知Run。 */
export const prepareOwnerSetupPlanningAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject) => {
  await set(loadOwnerPlanAtom, subject)
  await set(loadOwnerRuntimeAtom, subject)
  const runtime = getOwnerRuntimeEditor(get(ownerRuntimeEditorsAtom), subject)
  const plan = getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject)
  const goal = getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject)
  const latest = runtime.runs[0]
  if (latest && !latest.executions.length && latest.link.goalRevision === goal.snapshot?.revision
    && latest.link.bindingRevision === runtime.binding?.revision && latest.link.planRevision === (plan.snapshot?.revision ?? 0)
    && latest.link.contextFingerprint === runtime.context?.fingerprint) return
  if (latest?.executions.some(item => ['queued', 'running', 'stale'].includes(item.status))
    || latest?.outcomes.some(item => ['unknown', 'failed', 'stopped'].includes(item.state))) throw new Error('上次规划仍需完成或核对，请先查看调用记录；未重试请求')
  if (!runtime.context || runtime.dirty || !plan.loaded || plan.dirty || plan.conflict || plan.requiresReview) throw new Error(runtime.error || plan.error || '目标或计划来源需要刷新并核对，尚未准备')
  await set(prepareOwnerRuntimeAtom, subject)
  const prepared = getOwnerRuntimeEditor(get(ownerRuntimeEditorsAtom), subject)
  if (prepared.error) throw new Error(prepared.error)
})

export const confirmOwnerSetupAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject) => {
  const read = () => getOwnerSetupState(get(ownerSetupStatesAtom), subject)
  const before = read()
  const goal = getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject)
  if (before.loading || before.saving || before.needsRefresh || !before.facts || !goal.loaded || goal.loading || !goal.snapshot || goal.dirty || goal.conflict || goal.requiresReview || goal.saving) return
  const update = (patch: Partial<OwnerSetupState>) => { const entries = new Map(get(ownerSetupStatesAtom)); entries.set(ownerSetupKey(subject), { ...read(), ...patch }); set(ownerSetupStatesAtom, entries) }
  update({ saving: true, error: '' })
  try {
    const api = apiFor(get(ownerSetupApiAtom))
    let facts = await readFacts(api, subject.projectId)
    if ((facts.binding?.revision ?? 0) !== (before.facts.binding?.revision ?? 0)) throw new Error('项目规划配置已被更新，请刷新后比较')
    const model = ownerSetupModels(facts).find(item => item.key === before.modelKey)
    if (!model || facts.channels.find(item => item.id === model.channelId)?.updatedAt !== before.facts.channels.find(item => item.id === model.channelId)?.updatedAt) throw new Error('模型配置已变化，请刷新后重新选择')
    let workspace = facts.workspaces.find(item => item.id === before.workspaceId)
    if (!before.newWorkspace && (!workspace || workspace.rootPath !== before.facts.workspaces.find(item => item.id === before.workspaceId)?.rootPath)) throw new Error('工作区已变化，请刷新后重新选择')
    const selectedWorkspaceId = workspace?.id
    const alreadyBound = !before.newWorkspace && selectedWorkspaceId && facts.bindings.some(item => item.workspaceId === selectedWorkspaceId)
    if ((!alreadyBound || before.newWorkspace) && !before.authorizeWorkspace) throw new Error('请明确允许此项目使用选定的工作区')
    if (before.newWorkspace) {
      workspace = await api.createWorkspace(`Owner-${subject.projectId.slice(0, 8)}-${crypto.randomUUID().slice(0, 6)}`)
      facts = { ...facts, workspaces: [...facts.workspaces, workspace] }
      update({ newWorkspace: false, workspaceId: workspace.id, facts })
    }
    if (!workspace) throw new Error('请选择工作区')
    const carriers = ownerSetupCarriers(facts, model.key, workspace.id)
    const priorCarriers = before.newWorkspace ? [] : ownerSetupCarriers(before.facts, model.key, workspace.id)
    const intendedCarrierId = before.carrierId || (priorCarriers.length === 1 ? priorCarriers[0]!.id : '')
    let carrier = carriers.find(item => item.id === intendedCarrierId)
    if (!before.newWorkspace && JSON.stringify(carriers.map(item => item.id).sort()) !== JSON.stringify(priorCarriers.map(item => item.id).sort())) throw new Error('可用规划配置已变化，请刷新后比较')
    const priorCarrier = priorCarriers.find(item => item.id === intendedCarrierId)
    if (carrier && priorCarrier && employeeConfiguration(carrier) !== employeeConfiguration(priorCarrier)) throw new Error('员工规划配置已变化，请刷新后比较')
    if (!carrier && carriers.length) throw new Error('存在多个配置，请选择要使用的现有规划配置')
    if (before.carrierId && !carrier) throw new Error('选择的规划配置已失效，请刷新后比较')
    if (!alreadyBound) {
      await api.bindWorkspace(subject.projectId, workspace.id)
      facts = { ...facts, bindings: await api.listBindings(subject.projectId) }
      if (!facts.bindings.some(item => item.projectId === subject.projectId && item.workspaceId === workspace?.id)) throw new Error('工作区授权回读不一致，请刷新核对')
    }
    if (!carrier) {
      carrier = await api.createEmployee({ name: `Owner 规划 · ${subject.projectId.slice(0, 8)}`, role: '项目规划', description: '用户在Owner对话中确认创建的规划配置；业务执行仍需单独授权。', runtime: 'ai-sdk', executionProfile: 'controlled', permissionMode: 'safe', channelId: model.channelId, modelId: model.modelId, workspaceIds: [workspace.id] })
      facts = { ...facts, employees: [...facts.employees, carrier] }
      update({ carrierId: carrier.id, facts })
    }
    const currentBinding = facts.binding
    update({ carrierId: carrier.id, facts })
    if (!ownerSetupBindingAvailable(facts) || currentBinding?.carrierId !== carrier.id || currentBinding.workspaceId !== workspace.id || before.dirty) {
      const response = await api.saveBinding({ projectId: subject.projectId, expectedRevision: currentBinding?.revision ?? 0, input: { ownerName: currentBinding?.ownerName ?? '项目Owner', carrierId: carrier.id, workspaceId: workspace.id, changeReason: '用户在Owner对话中确认规划模型与项目工作区' } })
      if (!response.ok) throw new Error(response.error.message)
      facts = { ...facts, binding: response.value }
    }
    update({ facts, dirty: false, carrierId: carrier.id, authorizeWorkspace: false, editingConfiguration: false })
    await set(loadOwnerPlanAtom, subject)
    const currentPlan = getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject).snapshot
    if (!currentPlan || currentPlan.state === 'stale') await set(prepareOwnerSetupPlanningAtom, subject)
    else await set(loadOwnerRuntimeAtom, subject)
  } catch (cause) {
    update({ dirty: true, needsRefresh: true, error: `${cause instanceof Error ? cause.message : String(cause)}。已保存的本地配置会保留，请刷新核对后继续。` })
  } finally { update({ saving: false }) }
})
