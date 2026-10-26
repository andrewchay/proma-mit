import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { AgentEmployeeResult, OwnerRuntimeBinding, ProjectOwnerGoalSubject, ProjectOwnerPlanningContext, ProjectOwnerRunView } from '@gravitas/shared'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from './project-owner-goal-atoms'
import { ownerPlanApiAtom } from './project-owner-plan-atoms'
import { ownerRuntimeApiAtom } from './project-owner-runtime-atoms'
import { chooseOwnerSetupModel, confirmOwnerSetupAtom, editOwnerSetupAtom, getOwnerSetupState, loadOwnerSetupAtom, ownerSetupApiAtom, ownerSetupBindingAvailable, ownerSetupCarriers, ownerSetupModelKey, ownerSetupStatesAtom, type OwnerSetupApi, type OwnerSetupFacts } from './owner-setup-atoms'

const subject = { projectId: 'project-a' }
const employee: AgentEmployeeResult = { id: 'employee-a', name: '现有规划配置', role: '规划', description: '', runtime: 'ai-sdk', executionProfile: 'controlled', permissionMode: 'safe', channelId: 'channel-a', modelId: 'model-a', workspaceIds: ['workspace-a'], skills: [], enabled: true, totalTasks: 0, completedTasks: 0, failureCount: 0, createdAt: 1, updatedAt: 1 }
const binding: OwnerRuntimeBinding = { schemaVersion: 1, projectId: subject.projectId, revision: 1, ownerRole: 'project_owner', ownerName: '项目Owner', carrierId: employee.id, workspaceId: 'workspace-a', channelId: 'channel-a', modelId: 'model-a', runtime: 'ai-sdk', carrierFingerprint: 'hash', actor: 'local-user', savedAt: 1, changeReason: 'test' }
function fixture(overrides: Partial<OwnerSetupFacts> = {}) {
  const store = createStore()
  const facts: OwnerSetupFacts = {
    channels: [{ id: 'channel-a', name: '本地渠道', provider: 'openai', updatedAt: 1, enabled: true, models: [{ id: 'model-a', name: '模型 A', enabled: true }] }],
    employees: [{ ...employee }], workspaces: [{ id: 'workspace-a', name: '项目资料', slug: 'workspace-a', createdAt: 1, updatedAt: 1 }],
    bindings: [{ projectId: subject.projectId, workspaceId: 'workspace-a', createdAt: 1 }], binding: null, ...overrides,
  }
  const effects = { employees: 0, workspaces: 0, bindings: 0, saves: 0, prepares: 0 }
  const authorizations: Array<{ maxCostMicros: number; maxRequests: number }> = []
  let ensureBindingCalls = 0
  const context: ProjectOwnerPlanningContext = { goal: { schemaVersion: 1, revision: 1, state: 'draft', actor: 'local-user', savedAt: 1, goal: { projectId: subject.projectId, goalVersion: 1, objective: '产出可审阅方案', constraints: [], acceptanceCriteria: [] } }, sources: { project: { id: subject.projectId, title: '项目', description: '' }, roles: [] }, fingerprint: 'context' }
  store.set(ownerGoalEditorsAtom, new Map([[JSON.stringify([subject.projectId, null]), { ...getOwnerGoalEditor(new Map(), subject), snapshot: context.goal, loaded: true }]]))
  const runs: ProjectOwnerRunView[] = []
  const api: OwnerSetupApi = {
    getSettings: async () => ({ agentChannelId: 'channel-a', agentModelId: 'model-a' }),
    listChannels: async () => structuredClone(facts.channels), listEmployees: async () => structuredClone(facts.employees), listWorkspaces: async () => structuredClone(facts.workspaces), listBindings: async () => structuredClone(facts.bindings), getBinding: async () => ({ ok: true, value: facts.binding }),
    ensureBinding: async () => { ensureBindingCalls++; return { ok: true, value: null } },
    createWorkspace: async name => { effects.workspaces++; const result = { id: 'created-workspace', name, slug: 'created-workspace', createdAt: 1, updatedAt: 1 }; facts.workspaces.push(result); return result },
    bindWorkspace: async (projectId, workspaceId) => { effects.bindings++; facts.bindings.push({ projectId, workspaceId, createdAt: 1 }) },
    createEmployee: async input => { effects.employees++; const result = { ...employee, ...input, id: 'created-employee' }; facts.employees.push(result); return result },
    saveBinding: async input => { effects.saves++; const carrier = facts.employees.find(item => item.id === input.input.carrierId)!; facts.binding = { ...binding, ...input.input, channelId: carrier.channelId, modelId: carrier.modelId!, revision: input.expectedRevision + 1 }; return { ok: true, value: facts.binding } },
    authorizeOwnerManagement: async input => { authorizations.push({ maxCostMicros: input.maxCostMicros, maxRequests: input.maxRequests }); return { ok: true, value: { ...input, id: 'delegation-a', issuedAt: 1, scopeHash: 'scope', goalContentHash: 'goal', previewHash: 'preview', bindingRevision: facts.binding?.revision ?? 1, goalRevision: 1, modelId: 'model-a', workspaceName: '项目资料', priceEvidenceId: 'price', perRequestCeilingMicros: 100, maxOutputTokens: 8192 } } },
  }
  store.set(ownerSetupApiAtom, api)
  store.set(ownerPlanApiAtom, { getOwnerPlanDraft: async () => ({ ok: true, value: null }), getOwnerPlanningContext: async () => ({ ok: true, value: context }), listOwnerPlanHistory: async () => ({ ok: true, value: [] }), saveOwnerPlanDraft: async () => { throw new Error('禁止保存计划') }, confirmOwnerPlanDraft: async () => { throw new Error('禁止确认计划') } })
  store.set(ownerRuntimeApiAtom, {
    getOwnerRuntimeBinding: api.getBinding, ensureOwnerRuntimeBinding: api.ensureBinding, saveOwnerRuntimeBinding: api.saveBinding,
    listEmployees: api.listEmployees, listWorkspaces: api.listWorkspaces, listWorkspaceBindings: api.listBindings,
    getOwnerPlanningContext: async () => ({ ok: true, value: context }), listOwnerPlanningRuns: async () => ({ ok: true, value: runs }),
    prepareOwnerPlanning: async input => { effects.prepares++; const link = { ...input.input, id: 'link-a', projectId: subject.projectId, planningTaskId: 'planning-task', goalRevision: 1, bindingRevision: facts.binding!.revision, planRevision: 0, contextFingerprint: 'context', goalVersion: 1, schemaVersion: 1 as const, purpose: 'owner_planning' as const, maxRequests: 1 as const, maxOutputTokens: 8192 as const, protocolVersion: '2' as const, promptHash: 'hash', carrierFingerprint: 'hash', createdAt: 1 }; runs.unshift({ link, executions: [], receipts: [], outcomes: [] }); return { ok: true, value: link } },
  })
  const read = (s: ProjectOwnerGoalSubject = subject) => getOwnerSetupState(store.get(ownerSetupStatesAtom), s)
  return { store, facts, effects, api, read, runs, authorizations, recordEnsureBindingCall: () => { ensureBindingCalls++ }, get ensureBindingCalls() { return ensureBindingCalls } }
}

test('Given 项目有唯一有效配置 When 打开对话 Then 建议来自本项目且只读零副作用', async () => {
  const f = fixture(); await f.store.set(loadOwnerSetupAtom, subject)
  expect(f.read().modelKey).toBe(ownerSetupModelKey('channel-a', 'model-a'))
  expect(f.read().workspaceId).toBe('workspace-a')
  expect(f.effects).toEqual({ employees: 0, workspaces: 0, bindings: 0, saves: 0, prepares: 0 })
  const other = fixture({ bindings: [] }); await other.store.set(loadOwnerSetupAtom, { projectId: 'other-project' })
  expect(other.read({ projectId: 'other-project' }).modelKey).toBe(ownerSetupModelKey('channel-a', 'model-a'))
  expect(other.read({ projectId: 'other-project' }).workspaceId).toBe('')
  expect(other.read({ projectId: 'other-project' }).newWorkspace).toBe(true)
})

test('Given 唯一兼容模型但项目没有授权工作区 When 读取Owner设置 Then 自动选模型并默认提出独立空间授权', async () => {
  const f = fixture({ employees: [], bindings: [] }); await f.store.set(loadOwnerSetupAtom, subject)
  expect(f.read().modelKey).toBe(ownerSetupModelKey('channel-a', 'model-a'))
  expect(f.read().newWorkspace).toBe(true)
  expect(f.read().authorizeWorkspace).toBe(false)
  expect(f.effects).toEqual({ employees: 0, workspaces: 0, bindings: 0, saves: 0, prepares: 0 })
})

test('Given 已启用模型但没有规划员工 When Owner本地接手 Then 自动建专属safe配置并仅准备一次', async () => {
  const f = fixture({ employees: [] }); await f.store.set(loadOwnerSetupAtom, subject)
  await Promise.all([f.store.set(confirmOwnerSetupAtom, subject), f.store.set(confirmOwnerSetupAtom, subject)])
  expect(f.effects).toEqual({ employees: 1, workspaces: 0, bindings: 0, saves: 1, prepares: 1 })
  expect(f.facts.employees[0]).toMatchObject({ runtime: 'ai-sdk', executionProfile: 'controlled', permissionMode: 'safe', workspaceIds: ['workspace-a'] })
  expect(f.read().error).toBe('')
  await f.store.set(confirmOwnerSetupAtom, subject)
  expect(f.effects.prepares).toBe(1)
  expect(f.effects.employees).toBe(1)
})

test('Given 项目资料访问已确认 When 自动绑定返回主进程价格审核模型 Then UI采用系统绑定且不按旧默认另建载体', async () => {
  const f = fixture()
  await f.store.set(loadOwnerSetupAtom, subject)
  const automaticEmployee: AgentEmployeeResult = { ...employee, id: 'automatic-owner', name: `Owner运行载体 · ${subject.projectId.slice(0, 8)}`, role: '项目Owner运行载体', description: '系统内部载体：承载项目Owner的受控规划调用；不负责或授权业务执行。' }
  f.api.ensureBinding = async () => {
    f.recordEnsureBindingCall()
    f.facts.employees.push(automaticEmployee)
    f.facts.binding = { ...binding, actor: 'system:owner-manager', carrierId: automaticEmployee.id, changeReason: '按审核价格证据自动选择' }
    return { ok: true, value: f.facts.binding }
  }
  await f.store.set(confirmOwnerSetupAtom, subject)
  expect(f.ensureBindingCalls).toBe(1)
  expect(f.facts.binding).toMatchObject({ actor: 'system:owner-manager', carrierId: automaticEmployee.id })
  expect(f.effects).toMatchObject({ employees: 0, saves: 0 })
  expect(f.read()).toMatchObject({ modelKey: ownerSetupModelKey('channel-a', 'model-a'), dirty: false, error: '' })
})

test('Given 工作区尚未授权 When 只选中模型与工作区 Then 不绑定不创建也不准备', async () => {
  const f = fixture({ bindings: [], employees: [] }); await f.store.set(loadOwnerSetupAtom, subject)
  f.store.set(editOwnerSetupAtom, { subject, patch: { modelKey: ownerSetupModelKey('channel-a', 'model-a'), workspaceId: 'workspace-a' } })
  await f.store.set(confirmOwnerSetupAtom, subject)
  expect(f.read().error).toContain('明确允许')
  expect(f.effects).toEqual({ employees: 0, workspaces: 0, bindings: 0, saves: 0, prepares: 0 })
})

test('Given 用户明确要求独立工作区 When 确认授权 Then 只绑定新工作区而不沿用旧选择', async () => {
  const f = fixture(); await f.store.set(loadOwnerSetupAtom, subject)
  f.store.set(editOwnerSetupAtom, { subject, patch: { newWorkspace: true, authorizeWorkspace: true } })
  await f.store.set(confirmOwnerSetupAtom, subject)
  expect(f.effects).toEqual({ employees: 1, workspaces: 1, bindings: 1, saves: 1, prepares: 1 })
  expect(f.facts.binding?.workspaceId).toBe('created-workspace')
})

test('Given 多个合格模型和多个旧员工配置 When Owner本地接手 Then按默认决策规则选模型并创建专属载体', async () => {
  const f = fixture({ channels: [
    { id: 'channel-a', name: '旧渠道', provider: 'openai', updatedAt: 1, enabled: true, models: [{ id: 'model-a', name: '模型 A', enabled: true }] },
    { id: 'channel-b', name: '最近使用渠道', provider: 'openai', updatedAt: 2, enabled: true, models: [{ id: 'model-b', name: '模型 B', enabled: true }, { id: 'model-c', name: '模型 C', enabled: true }] },
  ], employees: [employee, { ...employee, id: 'employee-b', name: '另一个配置' }] })
  await f.store.set(loadOwnerSetupAtom, subject)
  expect(f.read().modelKey).toBe(ownerSetupModelKey('channel-a', 'model-a'))
  await f.store.set(confirmOwnerSetupAtom, subject)
  expect(f.effects).toEqual({ employees: 1, workspaces: 0, bindings: 0, saves: 1, prepares: 1 })
  expect(f.facts.binding?.channelId).toBe('channel-a')
  expect(f.facts.binding?.modelId).toBe('model-a')
  expect(f.facts.employees.filter(item => item.name === '另一个配置')).toHaveLength(1)
  f.facts.channels[0]!.enabled = false
  expect(ownerSetupCarriers(f.facts, ownerSetupModelKey('channel-a', 'model-a'), 'workspace-a')).toEqual([])
  expect(ownerSetupBindingAvailable({ ...f.facts, binding: { ...binding, channelId: 'channel-a' } })).toBe(false)
})

test('Given 默认模型有效或已失效 When 选择Owner规划模型 Then沿用有效默认，无有效默认时等待选择', () => {
  const channels: OwnerSetupFacts['channels'] = [
    { id: 'channel-old', name: '旧渠道', provider: 'openai', updatedAt: 1, enabled: true, models: [{ id: 'old-model', name: '旧模型', enabled: true }] },
    { id: 'channel-new', name: '新渠道', provider: 'openai', updatedAt: 2, enabled: true, models: [{ id: 'new-model', name: '新模型', enabled: true }] },
  ]
  expect(chooseOwnerSetupModel(channels, { agentChannelId: 'channel-old', agentModelId: 'old-model' })).toBe(ownerSetupModelKey('channel-old', 'old-model'))
  expect(chooseOwnerSetupModel(channels, { agentChannelId: 'missing', agentModelId: 'missing' })).toBe('')
})

test('Given 自动模型和工作区候选在确认前变化 When 旧候选被拒绝并重新读取 Then采用新候选且不复用旧载体', async () => {
  const f = fixture()
  await f.store.set(loadOwnerSetupAtom, subject)
  f.facts.channels = [
    { id: 'channel-a', name: '本地渠道', provider: 'openai', updatedAt: 1, enabled: true, models: [{ id: 'model-a', name: '模型 A', enabled: true }] },
    { id: 'channel-new', name: '新渠道', provider: 'openai', updatedAt: 2, enabled: true, models: [{ id: 'new-model', name: '新模型', enabled: true }] },
  ]
  f.api.getSettings = async () => ({ agentChannelId: 'channel-new', agentModelId: 'new-model' })
  f.facts.workspaces = [...f.facts.workspaces, { id: 'workspace-new', name: '较新的项目空间', slug: 'workspace-new', createdAt: 1, updatedAt: 1 }]
  f.facts.bindings = [...f.facts.bindings, { projectId: subject.projectId, workspaceId: 'workspace-new', createdAt: 2 }]
  await f.store.set(confirmOwnerSetupAtom, subject)
  expect(getOwnerSetupState(f.store.get(ownerSetupStatesAtom), subject)).toMatchObject({ needsRefresh: true, carrierId: '' })
  expect(f.effects).toEqual({ employees: 0, workspaces: 0, bindings: 0, saves: 0, prepares: 0 })
  await f.store.set(loadOwnerSetupAtom, subject)
  expect(getOwnerSetupState(f.store.get(ownerSetupStatesAtom), subject)).toMatchObject({ modelKey: ownerSetupModelKey('channel-new', 'new-model'), workspaceId: 'workspace-new', needsRefresh: false })
  await f.store.set(confirmOwnerSetupAtom, subject)
  expect(f.effects).toEqual({ employees: 1, workspaces: 0, bindings: 0, saves: 1, prepares: 1 })
  expect(f.facts.binding).toMatchObject({ channelId: 'channel-new', modelId: 'new-model', workspaceId: 'workspace-new' })
})

test('Given 所有兼容模型都停用 When 推导候选 Then不选择并保留配置缺口', async () => {
  const f = fixture({ employees: [employee, { ...employee, id: 'employee-b', name: '另一个配置' }] }); await f.store.set(loadOwnerSetupAtom, subject)
  f.facts.channels[0]!.enabled = false
  await f.store.set(confirmOwnerSetupAtom, subject)
  expect(f.effects.saves).toBe(0)
  expect(f.read().error).not.toBe('')
  expect(ownerSetupCarriers(f.facts, ownerSetupModelKey('channel-a', 'model-a'), 'workspace-a')).toEqual([])
  expect(ownerSetupBindingAvailable({ ...f.facts, binding: { ...binding, channelId: 'channel-a' } })).toBe(false)
})

test('Given 确认期间配置或绑定已变化 When 主进程事实重读 Then 零写入并要求刷新比较', async () => {
  for (const mutate of [(facts: OwnerSetupFacts) => { facts.channels[0]!.updatedAt++ }, (facts: OwnerSetupFacts) => { facts.binding = { ...binding, revision: 2 } }, (facts: OwnerSetupFacts) => { facts.workspaces[0]!.rootPath = '/changed/project' }]) {
    const f = fixture(); await f.store.set(loadOwnerSetupAtom, subject); mutate(f.facts)
    await f.store.set(confirmOwnerSetupAtom, subject)
    expect(f.effects).toEqual({ employees: 0, workspaces: 0, bindings: 0, saves: 0, prepares: 0 })
    expect(f.read().needsRefresh).toBe(true)
  }
})

test('Given 后台Owner先建立系统绑定 When旧页面并发确认 Then采纳有效系统版本并续本地准备', async () => {
  const f = fixture(); await f.store.set(loadOwnerSetupAtom, subject)
  f.api.getBinding = async () => {
    f.facts.binding = { ...binding, actor: 'system:owner-manager' }
    return { ok: true, value: f.facts.binding }
  }
  await f.store.set(confirmOwnerSetupAtom, subject)
  expect(f.read().facts?.binding?.actor).toBe('system:owner-manager')
  expect(f.read().dirty).toBe(false)
  expect(f.effects).toEqual({ employees: 0, workspaces: 0, bindings: 0, saves: 0, prepares: 1 })
})

test('Given 本地创建成功但配置保存失败 When 用户刷新再确认 Then 沿用已创建配置且不自动重试', async () => {
  const f = fixture({ employees: [] }); await f.store.set(loadOwnerSetupAtom, subject)
  f.store.set(editOwnerSetupAtom, { subject, patch: { modelKey: ownerSetupModelKey('channel-a', 'model-a') } })
  const original = f.api.saveBinding
  f.api.saveBinding = async () => { throw new Error('模拟保存失败') }
  await f.store.set(confirmOwnerSetupAtom, subject)
  expect(f.effects.employees).toBe(1); expect(f.effects.prepares).toBe(0)
  await f.store.set(confirmOwnerSetupAtom, subject)
  expect(f.effects.employees).toBe(1)
  f.api.saveBinding = original
  await f.store.set(loadOwnerSetupAtom, subject)
  await f.store.set(confirmOwnerSetupAtom, subject)
  expect(f.effects.employees).toBe(1); expect(f.effects.prepares).toBe(1)
})

test('Given 切换任务或目标未保存 When 修改选择或确认 Then 草案隔离且不产生配置副作用', async () => {
  const f = fixture(); await f.store.set(loadOwnerSetupAtom, subject)
  const task = { ...subject, taskId: 'task-a' }
  f.store.set(editOwnerSetupAtom, { subject: task, patch: { modelKey: 'task-draft' } })
  expect(f.read().modelKey).not.toBe('task-draft')
  await f.store.set(confirmOwnerSetupAtom, task)
  expect(f.effects.saves).toBe(0)
})

test('Given 绑定实际已保存但IPC回包丢失 When 刷新后再次确认 Then 不新增绑定版本或重复准备', async () => {
  const f = fixture(); await f.store.set(loadOwnerSetupAtom, subject)
  const original = f.api.saveBinding
  f.api.saveBinding = async input => { await original(input); throw new Error('IPC回包丢失') }
  await f.store.set(confirmOwnerSetupAtom, subject)
  expect(f.effects.saves).toBe(1); expect(f.effects.prepares).toBe(0)
  f.api.saveBinding = original
  await f.store.set(loadOwnerSetupAtom, subject)
  expect(f.read().dirty).toBe(false)
  await f.store.set(confirmOwnerSetupAtom, subject)
  expect(f.effects.saves).toBe(1); expect(f.effects.prepares).toBe(1)
})

test('Given 绑定版本发生回退 When 刷新同一选择 Then 不把回退版本当作保存成功', async () => {
  const f = fixture({ binding: { ...binding, revision: 3 } }); await f.store.set(loadOwnerSetupAtom, subject)
  f.store.set(editOwnerSetupAtom, { subject, patch: { modelKey: 'temporary-selection' } })
  f.store.set(editOwnerSetupAtom, { subject, patch: { modelKey: ownerSetupModelKey('channel-a', 'model-a'), carrierId: employee.id } })
  f.facts.binding = { ...binding, revision: 2 }
  await f.store.set(loadOwnerSetupAtom, subject)
  expect(f.read().dirty).toBe(true)
})

test('Given 配置首次读取失败或返回其他项目 When 刷新 Then 保留目标且不使用不可信候选', async () => {
  const f = fixture()
  const original = f.api.listChannels
  f.api.listChannels = async () => { throw new Error('暂不可读') }
  await f.store.set(loadOwnerSetupAtom, subject)
  expect(f.read().needsRefresh).toBe(true); expect(f.read().facts).toBeNull()
  f.api.listChannels = original
  await f.store.set(loadOwnerSetupAtom, subject)
  expect(f.read().needsRefresh).toBe(false)
  f.facts.binding = { ...binding, projectId: 'other-project' }
  await f.store.set(loadOwnerSetupAtom, subject)
  expect(f.read().needsRefresh).toBe(true)
  expect(f.read().error).toContain('不属于当前项目')
  expect(f.effects.saves).toBe(0)
})

test('Given反馈保存后已有计划stale When沿用现有配置 Then准备新规划但不发送模型或改写旧计划', async () => {
  const f = fixture({ binding })
  const plan = {
    ...subject, schemaVersion: 1 as const, revision: 2, planVersion: 1, goalRevision: 1, goalVersion: 1,
    state: 'stale' as const, actor: 'local-user' as const, origin: 'manual' as const, savedAt: 1, changeReason: '反馈前计划',
    contextFingerprint: 'context', planFingerprint: 'old-plan', sources: { project: { id: subject.projectId, title: '项目', description: '' }, roles: [] },
    proposal: { ...subject, goalVersion: 1, mode: 'proposal_only' as const, summary: '旧计划', assumptions: [], risks: [], steps: [] },
  }
  f.store.set(ownerPlanApiAtom, { ...f.store.get(ownerPlanApiAtom), getOwnerPlanDraft: async () => ({ ok: true, value: plan }) })
  await f.store.set(loadOwnerSetupAtom, subject)
  await f.store.set(confirmOwnerSetupAtom, subject)
  expect(f.read().error).toBe('')
  expect(f.effects).toEqual({ employees: 0, workspaces: 0, bindings: 0, saves: 0, prepares: 1 })
})


test('Given 没有GLM或显式应用默认 When 读取并确认 Then 保留模型缺口且零副作用', async () => {
  const f = fixture()
  f.api.getSettings = async () => ({})
  await f.store.set(loadOwnerSetupAtom, subject)
  expect(f.read().modelKey).toBe('')
  await f.store.set(confirmOwnerSetupAtom, subject)
  expect(f.effects).toEqual({ employees: 0, workspaces: 0, bindings: 0, saves: 0, prepares: 0 })
})

test('Given 已配置GLM与其他应用默认 When 推导Owner默认 Then 优先使用GLM且不按数组顺序漂移', () => {
  const channels: OwnerSetupFacts['channels'] = [
    { id: 'glm-old', name: '旧GLM', provider: 'zhipu', updatedAt: 1, enabled: true, models: [{ id: 'glm-5.3-flash', name: 'GLM', enabled: true }] },
    { id: 'glm-new', name: '新GLM', provider: 'zhipu', updatedAt: 2, enabled: true, models: [{ id: 'glm-5.3-flash', name: 'GLM', enabled: true }] },
  ]
  expect(chooseOwnerSetupModel(channels, {})).toBe(ownerSetupModelKey('glm-new', 'glm-5.3-flash'))
  expect(chooseOwnerSetupModel([...channels].reverse(), {})).toBe(ownerSetupModelKey('glm-new', 'glm-5.3-flash'))
})

test('Given 默认模型存在 When 用户手选其他模型再刷新并确认 Then 保留选择且不调用默认绑定入口', async () => {
  const f = fixture()
  f.facts.channels.push({ id: 'manual', name: '手选渠道', provider: 'openai', enabled: true, updatedAt: 1, models: [{ id: 'manual-model', name: '手选模型', enabled: true }] })
  await f.store.set(loadOwnerSetupAtom, subject)
  f.store.set(editOwnerSetupAtom, { subject, patch: { modelKey: ownerSetupModelKey('manual', 'manual-model') } })
  await f.store.set(loadOwnerSetupAtom, subject)
  expect(f.read().modelKey).toBe(ownerSetupModelKey('manual', 'manual-model'))
  await f.store.set(confirmOwnerSetupAtom, subject)
  expect(f.read().error).toBe('')
  expect(f.ensureBindingCalls).toBe(0)
  expect(f.facts.binding).toMatchObject({ channelId: 'manual', modelId: 'manual-model' })
  await f.store.set(loadOwnerSetupAtom, subject)
  expect(f.read().dirty).toBe(false)
  expect(f.read().modelKey).toBe(ownerSetupModelKey('manual', 'manual-model'))
})

test('Given 手选模型在确认前停用 When 确认 Then 不回退其他模型且不创建载体', async () => {
  const f = fixture()
  await f.store.set(loadOwnerSetupAtom, subject)
  f.store.set(editOwnerSetupAtom, { subject, patch: { modelKey: ownerSetupModelKey('channel-a', 'model-a') } })
  f.facts.channels[0]!.models[0]!.enabled = false
  await f.store.set(confirmOwnerSetupAtom, subject)
  expect(f.effects.employees).toBe(0)
  expect(f.effects.saves).toBe(0)
  expect(f.read().needsRefresh).toBe(true)
})
