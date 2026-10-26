/** 对话只组织本地配置；权威写入和逐次模型费用仍由既有主进程服务决定。 */
import { atom } from 'jotai'
import { getAgentProviderProtocol, type AgentEmployeeResult, type AgentWorkspace, type Channel, type CreateAgentEmployeeInput, type OwnerManagementDelegation, type OwnerManagementDelegationInput, type OwnerRuntimeBinding, type ProjectOwnerGoalSubject, type ProjectOwnerRuntimeApi, type ProjectWorkspaceBinding } from '@gravitas/shared'
import { getOwnerGoalEditor, ownerGoalEditorsAtom, saveOwnerGoalAtom } from './project-owner-goal-atoms'
import { getOwnerPlanEditor, loadOwnerPlanAtom, ownerPlanEditorsAtom } from './project-owner-plan-atoms'
import { getOwnerRuntimeEditor, loadOwnerRuntimeAtom, ownerRuntimeEditorsAtom, prepareOwnerRuntimeAtom } from './project-owner-runtime-atoms'

export interface OwnerSetupChannel extends Pick<Channel, 'id' | 'name' | 'provider' | 'models' | 'enabled' | 'updatedAt'> {}
interface OwnerSetupDefaults {
  agentChannelId?: string
  agentModelId?: string
  agentWorkspaceId?: string
}
export interface OwnerSetupFacts {
  channels: OwnerSetupChannel[]
  employees: AgentEmployeeResult[]
  workspaces: AgentWorkspace[]
  bindings: ProjectWorkspaceBinding[]
  binding: OwnerRuntimeBinding | null
  defaultModelKey?: string
  defaultWorkspaceId?: string
}
export interface OwnerSetupApi {
  listChannels(): Promise<OwnerSetupChannel[]>
  listEmployees(): Promise<AgentEmployeeResult[]>
  listWorkspaces(): Promise<AgentWorkspace[]>
  listBindings(projectId: string): Promise<ProjectWorkspaceBinding[]>
  getBinding: ProjectOwnerRuntimeApi['getOwnerRuntimeBinding']
  ensureBinding: ProjectOwnerRuntimeApi['ensureOwnerRuntimeBinding']
  saveBinding: ProjectOwnerRuntimeApi['saveOwnerRuntimeBinding']
  createWorkspace(name: string): Promise<AgentWorkspace>
  bindWorkspace(projectId: string, workspaceId: string): Promise<unknown>
  createEmployee(input: CreateAgentEmployeeInput): Promise<AgentEmployeeResult>
  authorizeOwnerManagement(input: OwnerManagementDelegationInput): Promise<{ ok: true; value: OwnerManagementDelegation } | { ok: false; error: { message: string } }>
  getSettings?(): Promise<OwnerSetupDefaults>
}
export const ownerSetupApiAtom = atom<OwnerSetupApi | null>(null)
function apiFor(override: OwnerSetupApi | null): OwnerSetupApi {
  if (override) return override
  const api = window.electronAPI
  return {
    // 配置对话不保留渠道凭据或端点。
    listChannels: async () => (await api.listChannels()).map(({ id, name, provider, models, enabled, updatedAt }) => ({ id, name, provider, models, enabled, updatedAt })),
    listEmployees: () => api.paa.agentEmployees.list(), listWorkspaces: () => api.listAgentWorkspaces(),
    listBindings: projectId => api.paa.projectWorkspace.listByProject(projectId),
    getBinding: input => api.paa.project.getOwnerRuntimeBinding(input), ensureBinding: input => api.paa.project.ensureOwnerRuntimeBinding(input), saveBinding: input => api.paa.project.saveOwnerRuntimeBinding(input),
    createWorkspace: name => api.createAgentWorkspace(name), bindWorkspace: (projectId, workspaceId) => api.paa.projectWorkspace.bind(projectId, workspaceId),
    createEmployee: input => api.paa.agentEmployees.create(input),
    authorizeOwnerManagement: async input => {
      const preview = await api.paa.project.previewOwnerManagementDelegation(input)
      if (!preview.ok) return preview
      return api.paa.project.confirmOwnerManagementDelegation({ input, previewHash: preview.value.previewHash })
    },
    getSettings: () => api.getSettings(),
  }
}
export const ownerSetupKey = (subject: ProjectOwnerGoalSubject): string => JSON.stringify([subject.projectId, subject.taskId ?? null])
export const ownerSetupModelKey = (channelId: string, modelId: string): string => JSON.stringify([channelId, modelId])
export function ownerSetupModels(facts: OwnerSetupFacts) {
  return facts.channels.filter(channel => channel.enabled && getAgentProviderProtocol(channel.provider, 'ai-sdk') === 'openai-chat').flatMap(channel => channel.models.filter(model => model.enabled).map(model => ({
    key: ownerSetupModelKey(channel.id, model.id), channelId: channel.id, modelId: model.id, label: `${channel.name} · ${model.name}`,
  })))
}
export function chooseOwnerSetupModel(channels: OwnerSetupChannel[], defaults: OwnerSetupDefaults): string {
  const eligible = channels.filter(channel => channel.enabled && getAgentProviderProtocol(channel.provider, 'ai-sdk') === 'openai-chat')
  const preferred = [...eligible].sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)).find(channel => channel.provider === 'zhipu' && channel.models.some(model => model.enabled && model.id === 'glm-5.3-flash'))
  if (preferred) return ownerSetupModelKey(preferred.id, 'glm-5.3-flash')
  const configured = eligible.find(channel => channel.id === defaults.agentChannelId)?.models.find(model => model.enabled && model.id === defaults.agentModelId)
  if (configured && defaults.agentChannelId) return ownerSetupModelKey(defaults.agentChannelId, configured.id)
  return ''
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
function isDedicatedOwnerCarrier(employee: AgentEmployeeResult, projectId: string, channelId: string, modelId: string, workspaceId: string): boolean {
  return employee.name === `Owner 规划 · ${projectId.slice(0, 8)}` && employee.role === '项目规划'
    && employee.description === 'Owner专属受控规划载体；业务执行仍需单独授权。'
    && employee.enabled && employee.runtime === 'ai-sdk' && employee.executionProfile === 'controlled'
    && employee.permissionMode === 'safe' && !employee.workflowId && employee.channelId === channelId && employee.modelId === modelId
    && (employee.workspaceIds ?? (employee.workspaceId ? [employee.workspaceId] : [])).includes(workspaceId)
}
function isOwnerSetupWorkspace(workspace: AgentWorkspace, projectId: string): boolean {
  return !workspace.rootPath && workspace.name.startsWith(`Owner-${projectId.slice(0, 8)}-`)
    && /^[\da-f]{6}$/i.test(workspace.name.slice(-6)) && workspace.slug === workspace.name.toLowerCase()
}
function resolvePreferredBoundWorkspace(facts: OwnerSetupFacts): AgentWorkspace | undefined {
  const bound = facts.workspaces.filter(workspace => facts.bindings.some(binding => binding.workspaceId === workspace.id))
  return bound.find(workspace => workspace.id === facts.defaultWorkspaceId)
    ?? [...bound].sort((left, right) => (facts.bindings.find(binding => binding.workspaceId === right.id)?.createdAt ?? 0)
      - (facts.bindings.find(binding => binding.workspaceId === left.id)?.createdAt ?? 0) || left.id.localeCompare(right.id))[0]
}
export interface OwnerSetupState {
  facts: OwnerSetupFacts | null
  modelKey: string
  /** 用户手选后不再被默认建议覆盖。 */
  modelExplicit: boolean
  workspaceId: string
  carrierId: string
  newWorkspace: boolean
  authorizeWorkspace: boolean
  budgetUsd: string
  hours: string
  authorizePlanning: boolean
  dirty: boolean
  loading: boolean
  saving: boolean
  needsRefresh: boolean
  editingGoal: boolean
  editingConfiguration: boolean
  error: string
}
const initial: OwnerSetupState = { facts: null, modelKey: '', modelExplicit: false, workspaceId: '', carrierId: '', newWorkspace: false, authorizeWorkspace: false, budgetUsd: '5', hours: '24', authorizePlanning: false, dirty: false, loading: false, saving: false, needsRefresh: false, editingGoal: false, editingConfiguration: false, error: '' }
export const ownerSetupStatesAtom = atom(new Map<string, OwnerSetupState>())
export function getOwnerSetupState(entries: ReadonlyMap<string, OwnerSetupState>, subject: ProjectOwnerGoalSubject): OwnerSetupState { return entries.get(ownerSetupKey(subject)) ?? initial }
export const editOwnerSetupAtom = atom(null, (get, set, { subject, patch }: { subject: ProjectOwnerGoalSubject; patch: Partial<Pick<OwnerSetupState, 'modelKey' | 'workspaceId' | 'carrierId' | 'newWorkspace' | 'authorizeWorkspace' | 'budgetUsd' | 'hours' | 'authorizePlanning' | 'editingGoal' | 'editingConfiguration' | 'error'>> }) => {
  const current = getOwnerSetupState(get(ownerSetupStatesAtom), subject)
  if (current.saving) return
  const entries = new Map(get(ownerSetupStatesAtom))
  const configurationChanged = (patch.modelKey !== undefined && patch.modelKey !== current.modelKey)
    || (patch.workspaceId !== undefined && patch.workspaceId !== current.workspaceId) || (patch.newWorkspace !== undefined && patch.newWorkspace !== current.newWorkspace)
  const bindingChanged = configurationChanged || (patch.carrierId !== undefined && patch.carrierId !== current.carrierId)
    || (patch.authorizeWorkspace !== undefined && patch.authorizeWorkspace !== current.authorizeWorkspace)
  entries.set(ownerSetupKey(subject), { ...current, ...(configurationChanged ? { carrierId: '', authorizeWorkspace: false } : {}), ...patch, ...(patch.modelKey !== undefined ? { modelExplicit: true } : {}), dirty: current.dirty || bindingChanged })
  set(ownerSetupStatesAtom, entries)
})
async function readFacts(api: OwnerSetupApi, projectId: string): Promise<OwnerSetupFacts> {
  const defaults: OwnerSetupDefaults = {}
  const [channels, employees, workspaces, bindings, response, settings] = await Promise.all([
    api.listChannels(), api.listEmployees(), api.listWorkspaces(), api.listBindings(projectId), api.getBinding({ projectId }), api.getSettings?.() ?? Promise.resolve(defaults),
  ])
  if (!response.ok) throw new Error(response.error.message)
  if (bindings.some(binding => binding.projectId !== projectId) || (response.value && response.value.projectId !== projectId)) throw new Error('返回的配置不属于当前项目，已停止配置')
  const defaultModelKey = chooseOwnerSetupModel(channels, settings) || undefined
  const boundWorkspaceIds = new Set(bindings.map(binding => binding.workspaceId))
  const defaultWorkspaceId = settings.agentWorkspaceId && boundWorkspaceIds.has(settings.agentWorkspaceId) && workspaces.some(workspace => workspace.id === settings.agentWorkspaceId)
    ? settings.agentWorkspaceId
    : undefined
  return { channels, employees, workspaces, bindings, binding: response.value, defaultModelKey, defaultWorkspaceId }
}
export const loadOwnerSetupAtom = atom(null, async (get, set, subject: ProjectOwnerGoalSubject) => {
  const read = () => getOwnerSetupState(get(ownerSetupStatesAtom), subject)
  const update = (patch: Partial<OwnerSetupState>) => { const entries = new Map(get(ownerSetupStatesAtom)); entries.set(ownerSetupKey(subject), { ...read(), ...patch }); set(ownerSetupStatesAtom, entries) }
  if (read().loading || read().saving) return
  update({ loading: true, error: '' })
  try {
    const facts = await readFacts(apiFor(get(ownerSetupApiAtom)), subject.projectId)
    const bound = facts.workspaces.filter(workspace => facts.bindings.some(binding => binding.workspaceId === workspace.id))
    const preferredBoundWorkspace = resolvePreferredBoundWorkspace(facts)
    const validBinding = ownerSetupBindingAvailable(facts) ? facts.binding : null
    const current = read()
    const savedSelectionRecovered = validBinding && validBinding.revision > (current.facts?.binding?.revision ?? 0)
      && validBinding.carrierId === current.carrierId && validBinding.workspaceId === current.workspaceId
      && ownerSetupModelKey(validBinding.channelId, validBinding.modelId) === current.modelKey
    const automaticModelChanged = !validBinding && !current.modelExplicit && current.dirty && current.modelKey !== (facts.defaultModelKey ?? '')
    const automaticWorkspaceChanged = !validBinding && current.dirty && !current.newWorkspace
      && current.workspaceId !== (preferredBoundWorkspace?.id ?? '')
    update({ facts, needsRefresh: false, ...(savedSelectionRecovered ? { dirty: false, authorizeWorkspace: false } : {}), ...(automaticModelChanged ? { modelKey: facts.defaultModelKey ?? '', carrierId: '' } : {}), ...(automaticWorkspaceChanged ? { workspaceId: preferredBoundWorkspace?.id ?? '', carrierId: '' } : {}), ...(!current.dirty ? {
      modelKey: validBinding ? ownerSetupModelKey(validBinding.channelId, validBinding.modelId) : (facts.defaultModelKey ?? ''),
      workspaceId: validBinding?.workspaceId ?? preferredBoundWorkspace?.id ?? '', newWorkspace: !validBinding && bound.length === 0, carrierId: validBinding?.carrierId ?? '',
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

/** 兼容既有显式持续管理授权路径；首次目标对话不再调用此入口。 */
export const startOwnerPlanningWithBudgetAtom = atom(null, async (get, set, input: {
  subject: ProjectOwnerGoalSubject
  budgetUsd: string
  hours: string
  authorizePlanning: boolean
}) => {
  const { subject } = input
  if (!input.authorizePlanning) throw new Error('请明确允许Owner在项目总预算内规划并推进')
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(input.budgetUsd) || Number(input.budgetUsd) <= 0 || Number(input.budgetUsd) > 100) throw new Error('项目总预算须为0.01至100美元，最多两位小数')
  if (!Number.isInteger(Number(input.hours)) || Number(input.hours) < 1 || Number(input.hours) > 168) throw new Error('授权期限须为1至168小时')
  await set(saveOwnerGoalAtom, subject)
  const goal = getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject)
  if (!goal.snapshot || goal.dirty || goal.error || goal.conflict || goal.requiresReview) throw new Error(goal.error || '目标未成功保存，请核对后重试')
  await set(confirmOwnerSetupAtom, { ...subject, preparePlanning: false })
  const setup = getOwnerSetupState(get(ownerSetupStatesAtom), subject)
  if (setup.error || setup.dirty || setup.needsRefresh || !setup.facts?.binding || !ownerSetupBindingAvailable(setup.facts)) throw new Error(setup.error || 'Owner规划资料范围尚未准备完成')
  const result = await apiFor(get(ownerSetupApiAtom)).authorizeOwnerManagement({
    ...subject,
    requestId: crypto.randomUUID(),
    maxRequests: 12,
    maxCostMicros: Math.round(Number(input.budgetUsd) * 1_000_000),
    expiresAt: Date.now() + Number(input.hours) * 3_600_000,
  })
  if (!result.ok) throw new Error(result.error.message)
})

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

export const confirmOwnerSetupAtom = atom(null, async (get, set, input: ProjectOwnerGoalSubject & { preparePlanning?: boolean }) => {
  const { preparePlanning = true, ...subject } = input
  const read = () => getOwnerSetupState(get(ownerSetupStatesAtom), subject)
  const before = read()
  const goal = getOwnerGoalEditor(get(ownerGoalEditorsAtom), subject)
  if (before.loading || before.saving || before.needsRefresh || !before.facts || !goal.loaded || goal.loading || !goal.snapshot || goal.dirty || goal.conflict || goal.requiresReview || goal.saving) return
  const update = (patch: Partial<OwnerSetupState>) => { const entries = new Map(get(ownerSetupStatesAtom)); entries.set(ownerSetupKey(subject), { ...read(), ...patch }); set(ownerSetupStatesAtom, entries) }
  update({ saving: true, error: '' })
  try {
    const api = apiFor(get(ownerSetupApiAtom))
    let facts = await readFacts(api, subject.projectId)
    if ((facts.binding?.revision ?? 0) !== (before.facts.binding?.revision ?? 0)) {
      if (facts.binding?.actor !== 'system:owner-manager' || !ownerSetupBindingAvailable(facts)
        || before.modelExplicit && ownerSetupModelKey(facts.binding.channelId, facts.binding.modelId) !== before.modelKey) throw new Error('项目规划配置已被更新，请刷新后比较')
      update({ facts, modelKey: ownerSetupModelKey(facts.binding.channelId, facts.binding.modelId), workspaceId: facts.binding.workspaceId, carrierId: facts.binding.carrierId, dirty: false, authorizeWorkspace: false, editingConfiguration: false })
      await set(loadOwnerPlanAtom, subject)
      const latestPlan = getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject).snapshot
      if (!preparePlanning) await set(loadOwnerRuntimeAtom, subject)
      else if (!latestPlan || latestPlan.state === 'stale') await set(prepareOwnerSetupPlanningAtom, subject)
      else await set(loadOwnerRuntimeAtom, subject)
      return
    }
    const model = ownerSetupModels(facts).find(item => item.key === before.modelKey)
    if (!model || facts.channels.find(item => item.id === model.channelId)?.updatedAt !== before.facts.channels.find(item => item.id === model.channelId)?.updatedAt) throw new Error('模型配置已变化，请刷新后重新选择')
    const previouslyBoundModel = before.facts.binding && ownerSetupBindingAvailable(before.facts)
      ? ownerSetupModelKey(before.facts.binding.channelId, before.facts.binding.modelId)
      : undefined
    if (!before.modelExplicit && previouslyBoundModel !== before.modelKey && facts.defaultModelKey !== before.facts.defaultModelKey) throw new Error('应用默认模型已变化，请刷新后重新准备')
    let workspace = facts.workspaces.find(item => item.id === before.workspaceId)
    const previouslyBoundWorkspace = before.facts.binding && ownerSetupBindingAvailable(before.facts) ? before.facts.binding.workspaceId : undefined
    if (!previouslyBoundWorkspace && !before.newWorkspace && resolvePreferredBoundWorkspace(facts)?.id !== before.workspaceId) throw new Error('项目工作区授权或默认工作区已变化，请刷新后重新准备')
    if (!before.newWorkspace && (!workspace || workspace.rootPath !== before.facts.workspaces.find(item => item.id === before.workspaceId)?.rootPath)) throw new Error('工作区已变化，请刷新后重新选择')
    const selectedWorkspaceId = workspace?.id
    const alreadyBound = !before.newWorkspace && selectedWorkspaceId && facts.bindings.some(item => item.workspaceId === selectedWorkspaceId)
    if ((!alreadyBound || before.newWorkspace) && !before.authorizeWorkspace) throw new Error('请明确允许此项目使用选定的工作区')
    if (before.newWorkspace) {
      const recoveredWorkspaces = facts.workspaces.filter(item => isOwnerSetupWorkspace(item, subject.projectId))
      if (recoveredWorkspaces.length > 1) throw new Error('发现多个未完成的Owner资料空间，请核对后再继续')
      workspace = recoveredWorkspaces[0] ?? await api.createWorkspace(`Owner-${subject.projectId.slice(0, 8)}-${crypto.randomUUID().slice(0, 6)}`)
      if (!facts.workspaces.some(item => item.id === workspace?.id)) facts = { ...facts, workspaces: [...facts.workspaces, workspace] }
      update({ newWorkspace: false, workspaceId: workspace.id, facts })
    }
    if (!workspace) throw new Error('请选择工作区')
    const ownerWorkspaceId = workspace.id
    const currentOwnerBinding = facts.binding && facts.binding.channelId === model.channelId && facts.binding.modelId === model.modelId
      && facts.binding.workspaceId === ownerWorkspaceId && ownerSetupBindingAvailable(facts) ? facts.binding : null
    const currentOwnerCarrier = currentOwnerBinding ? facts.employees.find(item => item.id === currentOwnerBinding.carrierId) : undefined
    const retryCarriers = facts.employees.filter(item => (!before.carrierId || item.id === before.carrierId)
      && isDedicatedOwnerCarrier(item, subject.projectId, model.channelId, model.modelId, ownerWorkspaceId))
    if (retryCarriers.length > 1) throw new Error('发现多个匹配的Owner规划载体，请核对后再继续')
    let carrier: AgentEmployeeResult | undefined = currentOwnerCarrier ?? retryCarriers[0]
    if (!alreadyBound) {
      await api.bindWorkspace(subject.projectId, workspace.id)
      facts = { ...facts, bindings: await api.listBindings(subject.projectId) }
      if (!facts.bindings.some(item => item.projectId === subject.projectId && item.workspaceId === workspace?.id)) throw new Error('工作区授权回读不一致，请刷新核对')
    }
    if (!facts.binding && !before.modelExplicit) {
      const response = await api.ensureBinding({ projectId: subject.projectId })
      if (!response.ok) throw new Error(response.error.message)
      if (response.value) {
        facts = await readFacts(api, subject.projectId)
        if (!ownerSetupBindingAvailable(facts) || facts.binding?.revision !== response.value.revision) throw new Error('Owner自动配置回读不一致，请刷新核对')
        update({ facts, modelKey: ownerSetupModelKey(response.value.channelId, response.value.modelId), workspaceId: response.value.workspaceId, carrierId: response.value.carrierId, dirty: false, authorizeWorkspace: false, editingConfiguration: false })
        await set(loadOwnerPlanAtom, subject)
        const latestPlan = getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject).snapshot
        if (!preparePlanning) await set(loadOwnerRuntimeAtom, subject)
        else if (!latestPlan || latestPlan.state === 'stale') await set(prepareOwnerSetupPlanningAtom, subject)
        else await set(loadOwnerRuntimeAtom, subject)
        return
      }
    }
    if (!carrier) {
      carrier = await api.createEmployee({ name: `Owner 规划 · ${subject.projectId.slice(0, 8)}`, role: '项目规划', description: 'Owner专属受控规划载体；业务执行仍需单独授权。', runtime: 'ai-sdk', executionProfile: 'controlled', permissionMode: 'safe', channelId: model.channelId, modelId: model.modelId, workspaceIds: [workspace.id] })
      facts = { ...facts, employees: [...facts.employees, carrier] }
      update({ carrierId: carrier.id, facts })
    }
    const currentBinding = facts.binding
    update({ carrierId: carrier.id, facts })
    if (!ownerSetupBindingAvailable(facts) || currentBinding?.carrierId !== carrier.id || currentBinding.workspaceId !== workspace.id || before.dirty) {
      const response = await api.saveBinding({ projectId: subject.projectId, expectedRevision: currentBinding?.revision ?? 0, input: { ownerName: currentBinding?.ownerName ?? '项目Owner', carrierId: carrier.id, workspaceId: workspace.id, changeReason: 'Owner按配置策略建立规划载体；用户仅确认资料访问范围' } })
      if (!response.ok) throw new Error(response.error.message)
      facts = { ...facts, binding: response.value }
    }
    update({ facts, dirty: false, carrierId: carrier.id, authorizeWorkspace: false, editingConfiguration: false })
    await set(loadOwnerPlanAtom, subject)
    const currentPlan = getOwnerPlanEditor(get(ownerPlanEditorsAtom), subject).snapshot
    if (!preparePlanning) await set(loadOwnerRuntimeAtom, subject)
    else if (!currentPlan || currentPlan.state === 'stale') await set(prepareOwnerSetupPlanningAtom, subject)
    else await set(loadOwnerRuntimeAtom, subject)
  } catch (cause) {
    update({ dirty: true, needsRefresh: true, error: `${cause instanceof Error ? cause.message : String(cause)}。已保存的本地配置会保留，请刷新核对后继续。` })
  } finally { update({ saving: false }) }
})
