import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { AgentEmployeeResult, OwnerRuntimeBinding, ProjectOwnerGoalSubject, ProjectOwnerPlanningContext, ProjectOwnerRunView } from '@gravitas/shared'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from './project-owner-goal-atoms'
import { ownerPlanApiAtom } from './project-owner-plan-atoms'
import { ownerRuntimeApiAtom } from './project-owner-runtime-atoms'
import { confirmOwnerSetupAtom, editOwnerSetupAtom, getOwnerSetupState, loadOwnerSetupAtom, ownerSetupApiAtom, ownerSetupBindingAvailable, ownerSetupCarriers, ownerSetupModelKey, ownerSetupStatesAtom, type OwnerSetupApi, type OwnerSetupFacts } from './owner-setup-atoms'

const subject = { projectId: 'project-a' }
const employee: AgentEmployeeResult = { id: 'employee-a', name: '现有规划配置', role: '规划', description: '', runtime: 'ai-sdk', executionProfile: 'controlled', permissionMode: 'safe', channelId: 'channel-a', modelId: 'model-a', workspaceIds: ['workspace-a'], skills: [], enabled: true, totalTasks: 0, completedTasks: 0, failureCount: 0, createdAt: 1, updatedAt: 1 }
const binding: OwnerRuntimeBinding = { schemaVersion: 1, projectId: subject.projectId, revision: 1, ownerRole: 'project_owner', ownerName: '项目Owner', carrierId: employee.id, workspaceId: 'workspace-a', channelId: 'channel-a', modelId: 'model-a', runtime: 'ai-sdk', carrierFingerprint: 'hash', actor: 'local-user', savedAt: 1, changeReason: 'test' }
function fixture(overrides: Partial<OwnerSetupFacts> = {}) {
  const store = createStore()
  const facts: OwnerSetupFacts = {
    channels: [{ id: 'channel-a', name: '本地渠道', updatedAt: 1, enabled: true, models: [{ id: 'model-a', name: '模型 A', enabled: true }] }],
    employees: [{ ...employee }], workspaces: [{ id: 'workspace-a', name: '项目资料', slug: 'workspace-a', createdAt: 1, updatedAt: 1 }],
    bindings: [{ projectId: subject.projectId, workspaceId: 'workspace-a', createdAt: 1 }], binding: null, ...overrides,
  }
  const effects = { employees: 0, workspaces: 0, bindings: 0, saves: 0, prepares: 0 }
  const context: ProjectOwnerPlanningContext = { goal: { schemaVersion: 1, revision: 1, state: 'draft', actor: 'local-user', savedAt: 1, goal: { projectId: subject.projectId, goalVersion: 1, objective: '产出可审阅方案', constraints: [], acceptanceCriteria: [] } }, sources: { project: { id: subject.projectId, title: '项目', description: '' }, roles: [] }, fingerprint: 'context' }
  store.set(ownerGoalEditorsAtom, new Map([[JSON.stringify([subject.projectId, null]), { ...getOwnerGoalEditor(new Map(), subject), snapshot: context.goal, loaded: true }]]))
  const runs: ProjectOwnerRunView[] = []
  const api: OwnerSetupApi = {
    listChannels: async () => structuredClone(facts.channels), listEmployees: async () => structuredClone(facts.employees), listWorkspaces: async () => structuredClone(facts.workspaces), listBindings: async () => structuredClone(facts.bindings), getBinding: async () => ({ ok: true, value: facts.binding }),
    createWorkspace: async name => { effects.workspaces++; const result = { id: 'created-workspace', name, slug: 'created-workspace', createdAt: 1, updatedAt: 1 }; facts.workspaces.push(result); return result },
    bindWorkspace: async (projectId, workspaceId) => { effects.bindings++; facts.bindings.push({ projectId, workspaceId, createdAt: 1 }) },
    createEmployee: async input => { effects.employees++; const result = { ...employee, ...input, id: 'created-employee' }; facts.employees.push(result); return result },
    saveBinding: async input => { effects.saves++; facts.binding = { ...binding, ...input.input, revision: input.expectedRevision + 1 }; return { ok: true, value: facts.binding } },
  }
  store.set(ownerSetupApiAtom, api)
  store.set(ownerPlanApiAtom, { getOwnerPlanDraft: async () => ({ ok: true, value: null }), getOwnerPlanningContext: async () => ({ ok: true, value: context }), listOwnerPlanHistory: async () => ({ ok: true, value: [] }), saveOwnerPlanDraft: async () => { throw new Error('禁止保存计划') }, confirmOwnerPlanDraft: async () => { throw new Error('禁止确认计划') } })
  store.set(ownerRuntimeApiAtom, {
    getOwnerRuntimeBinding: api.getBinding, saveOwnerRuntimeBinding: api.saveBinding,
    listEmployees: api.listEmployees, listWorkspaces: api.listWorkspaces, listWorkspaceBindings: api.listBindings,
    getOwnerPlanningContext: async () => ({ ok: true, value: context }), listOwnerPlanningRuns: async () => ({ ok: true, value: runs }),
    prepareOwnerPlanning: async input => { effects.prepares++; const link = { ...input.input, id: 'link-a', projectId: subject.projectId, planningTaskId: 'planning-task', goalRevision: 1, bindingRevision: facts.binding!.revision, planRevision: 0, contextFingerprint: 'context', goalVersion: 1, schemaVersion: 1 as const, purpose: 'owner_planning' as const, maxRequests: 1 as const, maxOutputTokens: 8192 as const, protocolVersion: '2' as const, promptHash: 'hash', carrierFingerprint: 'hash', createdAt: 1 }; runs.unshift({ link, executions: [], receipts: [], outcomes: [] }); return { ok: true, value: link } },
  })
  const read = (s: ProjectOwnerGoalSubject = subject) => getOwnerSetupState(store.get(ownerSetupStatesAtom), s)
  return { store, facts, effects, api, read, runs }
}

test('Given 项目有唯一有效配置 When 打开对话 Then 建议来自本项目且只读零副作用', async () => {
  const f = fixture(); await f.store.set(loadOwnerSetupAtom, subject)
  expect(f.read().modelKey).toBe(ownerSetupModelKey('channel-a', 'model-a'))
  expect(f.read().workspaceId).toBe('workspace-a')
  expect(f.effects).toEqual({ employees: 0, workspaces: 0, bindings: 0, saves: 0, prepares: 0 })
  const other = fixture({ bindings: [] }); await other.store.set(loadOwnerSetupAtom, { projectId: 'other-project' })
  expect(other.read({ projectId: 'other-project' }).modelKey).toBe('')
  expect(other.read({ projectId: 'other-project' }).workspaceId).toBe('')
})

test('Given 已启用模型但没有规划员工 When 用户确认模型和项目工作区 Then 原地建safe配置并仅准备一次', async () => {
  const f = fixture({ employees: [] }); await f.store.set(loadOwnerSetupAtom, subject)
  f.store.set(editOwnerSetupAtom, { subject, patch: { modelKey: ownerSetupModelKey('channel-a', 'model-a') } })
  await Promise.all([f.store.set(confirmOwnerSetupAtom, subject), f.store.set(confirmOwnerSetupAtom, subject)])
  expect(f.effects).toEqual({ employees: 1, workspaces: 0, bindings: 0, saves: 1, prepares: 1 })
  expect(f.facts.employees[0]).toMatchObject({ runtime: 'ai-sdk', executionProfile: 'controlled', permissionMode: 'safe', workspaceIds: ['workspace-a'] })
  expect(f.read().error).toBe('')
  await f.store.set(confirmOwnerSetupAtom, subject)
  expect(f.effects.prepares).toBe(1)
  expect(f.effects.employees).toBe(1)
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

test('Given 多个现有配置或停用模型 When 推导候选 Then 不按列表顺序猜测或重启失效配置', async () => {
  const f = fixture({ employees: [employee, { ...employee, id: 'employee-b', name: '另一个配置' }] }); await f.store.set(loadOwnerSetupAtom, subject)
  await f.store.set(confirmOwnerSetupAtom, subject)
  expect(f.effects.saves).toBe(0)
  expect(f.read().error).toContain('多个配置')
  f.facts.channels[0]!.enabled = false
  expect(ownerSetupCarriers(f.facts, ownerSetupModelKey('channel-a', 'model-a'), 'workspace-a')).toEqual([])
  expect(ownerSetupBindingAvailable({ ...f.facts, binding })).toBe(false)
})

test('Given 确认期间配置或绑定已变化 When 主进程事实重读 Then 零写入并要求刷新比较', async () => {
  for (const mutate of [(facts: OwnerSetupFacts) => { facts.channels[0]!.updatedAt++ }, (facts: OwnerSetupFacts) => { facts.binding = { ...binding, revision: 2 } }, (facts: OwnerSetupFacts) => { facts.employees[0]!.permissionMode = 'auto' }]) {
    const f = fixture(); await f.store.set(loadOwnerSetupAtom, subject); mutate(f.facts)
    await f.store.set(confirmOwnerSetupAtom, subject)
    expect(f.effects).toEqual({ employees: 0, workspaces: 0, bindings: 0, saves: 0, prepares: 0 })
    expect(f.read().needsRefresh).toBe(true)
  }
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
