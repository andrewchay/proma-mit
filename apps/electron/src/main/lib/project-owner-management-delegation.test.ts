import { afterAll, beforeAll, expect, mock, spyOn, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HeadlessAgentRunCallbacks } from './agent-headless-runner-registry'
import type { ProviderType } from '@gravitas/shared'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-delegation-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel } = await import('./channel-manager')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const { saveProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
const plans = await import('./project-owner-plan-service')
const { saveOwnerRuntimeBinding } = await import('./project-owner-runtime-binding')
const { resolveOwnerPlanningSession } = await import('./project-owner-planning-source')
const { claimOwnerPlanningProviderRequest } = await import('./project-owner-planning-provider')
const { startDelegatedOwnerPlanningTask, assertControlledPreparedExecution } = await import('./controlled-project-task-service')
const service = await import('./project-owner-management-delegation')
const managementStore = await import('./project-owner-management-store')
const { getOwnerManagementConversation, answerOwnerManagementQuestion } = await import('./project-owner-management-questions')
const { reconcileOwnerManagement, startOwnerManagementLoop } = await import('./project-owner-management-loop')
const { registerProjectOwnerGoalIpcHandlers } = await import('./project-owner-goal-ipc')
const { PROJECT_IPC_CHANNELS } = await import('@gravitas/shared')
const { setHeadlessAgentRunner } = await import('./agent-headless-runner-registry')
const callbacks = new Map<string, HeadlessAgentRunCallbacks>()
let calls = 0
let localConfigurationError: string | null = null
beforeAll(async () => {
  await store.initProjectDb()
  // 真实产品排队/claim/准入，终端runner及HTTP为替身，不访问Provider。
  setHeadlessAgentRunner(async (input, handlers) => {
    calls++
    if (localConfigurationError) throw new Error(localConfigurationError)
    const source = resolveOwnerPlanningSession(input.sessionId)!
    const body = JSON.stringify({ model: source.binding.modelId, stream: true, max_tokens: source.link.maxOutputTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: source.request.systemPrompt }, { role: 'user', content: source.request.userPrompt }] })
    claimOwnerPlanningProviderRequest(input.sessionId, body, new URL('https://example.invalid/v1/chat/completions'))
    callbacks.set(input.sessionId, handlers)
  })
})
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
function fixture(modelId = 'deepseek-flash', provider: ProviderType = 'openai', apiKey = 'fake') {
  const project = store.createProject({ title: '委托项目', description: '' })
  const workspace = createAgentWorkspace(`委托-${randomUUID()}`); bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: 'fake', provider, baseUrl: 'https://example.invalid/v1', apiKey, enabled: true, models: [{ id: modelId, name: modelId, enabled: true }] })
  const employee = employees.createAgentEmployee({ name: 'Owner', role: '规划', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId, workspaceIds: [workspace.id] })
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成产品定位建议', constraints: [] })
  saveOwnerRuntimeBinding(project.id, 0, { ownerName: 'Owner', carrierId: employee.id, workspaceId: workspace.id, changeReason: '隔离测试' })
  reconcileOwnerManagement(project.id)
  const taskId = getOwnerManagementConversation(project.id).messages.findLast(item => item.planningTaskId)?.planningTaskId!
  const input = { projectId: project.id, requestId: randomUUID(), maxRequests: 3, maxCostMicros: 2_000_000, expiresAt: Date.now() + 3600000 }
  return { project, workspace, employee, taskId, input }
}
function issue(f: ReturnType<typeof fixture>) {
  const preview = service.previewOwnerManagementDelegation(f.input)
  return service.confirmOwnerManagementDelegation({ input: f.input, previewHash: preview.previewHash })
}
async function until(predicate: () => boolean) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) } throw new Error('等待后台行为超时') }
function clarify(taskId: string, knownUsage = true) {
  const execution = store.listAgentExecutionsByEntity('task', taskId)[0]!
  const source = resolveOwnerPlanningSession(execution.sessionId!)!
  const text = JSON.stringify({ schemaVersion: 1, kind: 'needs_clarification', projectId: source.link.projectId, goalVersion: source.context.goal.goal.goalVersion, contextFingerprint: source.context.fingerprint, reason: '需要受众信息', questions: [{ key: 'audience', reasonType: 'missing_information', question: '主要服务谁？', why: '确定方案取舍', options: ['现有用户', '新用户'] }] })
  callbacks.get(execution.sessionId!)!.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: execution.sessionId!, finish_reason: 'stop', result: text, usage: { input_tokens: 10, output_tokens: 20 }, ...(knownUsage ? { owner_planning_usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null } } : {}) } })
}

test('Given 明确范围与预算 When 预览确认并重提 Then 持久同一委托，发行本身不调用模型', async () => {
  const f = fixture(), before = calls, grant = issue(f)
  expect(issue(f)).toEqual(grant)
  expect(service.getOwnerManagementDelegation(f.project.id)).toMatchObject({ state: 'active', usedRequests: 0, reservedCostMicros: 0 })
  expect(calls).toBe(before)
  store.closeProjectDb(); await store.initProjectDb()
  expect(service.getOwnerManagementDelegation(f.project.id).delegation).toEqual(grant)
  service.revokeOwnerManagementDelegation(f.project.id, grant.id)
})

test('Given 配置了DeepSeek V4 Pro When 核对项目管理预算 Then按官方峰时上界通过预览且不发送请求', () => {
  const f = fixture('deepseek-v4-pro'), before = calls
  const preview = service.previewOwnerManagementDelegation(f.input)
  expect(preview.priceEvidenceId).toBe('deepseek-v4-pro-0813-2026-10-22')
  expect(preview.perRequestCeilingMicros).toBeGreaterThan(1_300_000)
  expect(preview.perRequestCeilingMicros).toBeLessThan(1_400_000)
  expect(calls).toBe(before)
})

test('Given DeepSeek渠道的Flash模型 When预览持续管理 Then支持预算上界且不发送请求', () => {
  const f = fixture('deepseek-flash', 'deepseek'), before = calls
  expect(service.previewOwnerManagementDelegation(f.input).priceEvidenceId).toBe('deepseek-flash-2026-10-17')
  expect(calls).toBe(before)
})

test('Given渠道密钥为空 When预览管理授权 Then在创建执行或占额前指出API Key缺失', () => {
  const f = fixture('deepseek-flash', 'deepseek', ''), before = calls
  expect(() => service.previewOwnerManagementDelegation(f.input)).toThrow('API Key')
  expect(calls).toBe(before)
  expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(0)
})

test('Given旧版本地参数失败且没有发送准入 When核对并重新确认 Then保留失败及预留并允许新授权但不自动重发', async () => {
  const f = fixture(), grant = issue(f)
  localConfigurationError = 'AI SDK Runtime 需要 provider、apiKey、baseUrl、model、cwd'
  try {
    await startDelegatedOwnerPlanningTask(f.taskId)
    await until(() => store.listAgentExecutionsByProject(f.project.id)[0]?.status === 'failed')
  } finally { localConfigurationError = null }
  const before = calls
  expect(service.getOwnerManagementDelegation(f.project.id)).toMatchObject({ state: 'stale', usedRequests: 1, reservedCostMicros: grant.perRequestCeilingMicros, detail: expect.stringContaining('本地配置') })
  expect(store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_owner_planning_admissions WHERE execution_id=?').get(store.listAgentExecutionsByProject(f.project.id)[0]!.id)).toEqual({ n: 0 })
  const input = { ...f.input, requestId: randomUUID() }, preview = service.previewOwnerManagementDelegation(input)
  const next = service.confirmOwnerManagementDelegation({ input, previewHash: preview.previewHash })
  expect(next.id).not.toBe(grant.id)
  expect(calls).toBe(before)
  expect(store.listAgentExecutionsByProject(f.project.id)[0]?.status).toBe('failed')
  service.revokeOwnerManagementDelegation(f.project.id, next.id)
})

test('Given已有发送准入但错误文本与本地参数错误相同 When核对 Then仍暂停核对不能按未发送恢复', async () => {
  const f = fixture(), grant = issue(f)
  await startDelegatedOwnerPlanningTask(f.taskId)
  const execution = store.listAgentExecutionsByProject(f.project.id)[0]!
  callbacks.get(execution.sessionId!)!.onError('AI SDK Runtime 需要 provider、apiKey、baseUrl、model、cwd')
  expect(service.getOwnerManagementDelegation(f.project.id).state).toBe('attention')
  service.revokeOwnerManagementDelegation(f.project.id, grant.id)
})

test('Given本地失败之后出现运行结果或损坏回调 When重新核对 Then证据矛盾仍进入核对门禁', async () => {
  for (const evidence of ['runtime_result', 'broken_json']) {
    const f = fixture(), grant = issue(f)
    localConfigurationError = 'AI SDK Runtime 需要 provider、apiKey、baseUrl、model、cwd'
    try {
      await startDelegatedOwnerPlanningTask(f.taskId)
      await until(() => store.listAgentExecutionsByProject(f.project.id)[0]?.status === 'failed')
    } finally { localConfigurationError = null }
    const execution = store.listAgentExecutionsByProject(f.project.id)[0]!
    expect(service.getOwnerManagementDelegation(f.project.id).state).toBe('stale')
    if (evidence === 'runtime_result') {
      const runs = await import('./project-owner-planning-run-service')
      runs.recordOwnerPlanningRun(execution.id, 'ai-sdk', { type: 'result', subtype: 'success', session_id: execution.sessionId!, finish_reason: 'stop', result: '无法解释的运行结果', usage: { input_tokens: 10, output_tokens: 20 } })
    } else {
      store.getProjectDb().prepare('INSERT INTO project_owner_planning_callback_evidence (id,execution_id,payload) VALUES (?,?,?)').run(randomUUID(), execution.id, '{broken')
    }
    expect(service.getOwnerManagementDelegation(f.project.id).state).toBe('attention')
    service.revokeOwnerManagementDelegation(f.project.id, grant.id)
  }
})

test('Given已添加DeepSeek但Owner仍绑定Kimi When预览持续管理 Then提示实际模型与更换入口且不静默切换', () => {
  const f = fixture('kimi-for-coding', 'kimi-coding'), before = calls
  createChannel({ name: 'DeepSeek', provider: 'deepseek', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: 'deepseek-flash', name: 'deepseek-flash', enabled: true }] })
  expect(() => service.previewOwnerManagementDelegation(f.input)).toThrow('kimi-for-coding')
  expect(() => service.previewOwnerManagementDelegation(f.input)).toThrow('更换 Owner 模型')
  expect(calls).toBe(before)
})

test('Given 首次授权前已有待审方案且项目员工被停用 When 用户确认管理范围 Then 明确说明阻塞原因且不启动员工', async () => {
  const f = fixture()
  const disabled = employees.createAgentEmployee({ name: '已停用员工', role: '业务', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: f.employee.channelId, modelId: f.employee.modelId, workspaceIds: [f.workspace.id] })
  employees.updateAgentEmployee(disabled.id, { enabled: false })
  const context = plans.getProjectOwnerPlanningContext(f.project.id)
  plans.saveProjectOwnerPlanDraft(f.project.id, context.goal.revision, 0, {
    expectedContextFingerprint: context.fingerprint, summary: '按目标完成可审阅成果', assumptions: [], risks: [],
    steps: [{ key: 'brief', title: '形成建议', outcome: '可审阅建议', acceptanceCriteria: ['说明依据'], dependencies: [], roleKey: context.sources.roles[0]!.key }], changeReason: '先完成方案供用户审阅',
  })
  const preview = service.previewOwnerManagementDelegation(f.input), before = calls
  const grant = service.confirmOwnerManagementDelegation({ input: f.input, previewHash: preview.previewHash })
  expect(managementStore.listPendingOwnerManagementEvents(f.project.id)).toContainEqual(expect.objectContaining({ kind: 'delegation_confirmed', sourceId: grant.id }))
  const stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(message => message.kind === 'attention' && message.content.includes('没有能承担')))
    expect(calls).toBe(before)
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(0)
    expect(getOwnerManagementConversation(f.project.id).messages.some(message => message.kind === 'attention' && message.content.includes('管理调用尚未继续'))).toBe(false)
  } finally { stop(); service.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given待审方案的团队安排失败且管理资料随后变化 When Owner对账 Then即使没有可继续Run也在对话提醒重新确认', async () => {
  const f = fixture(), context = plans.getProjectOwnerPlanningContext(f.project.id)
  plans.saveProjectOwnerPlanDraft(f.project.id, context.goal.revision, 0, {
    expectedContextFingerprint: context.fingerprint, summary: '按目标完成可审阅成果', assumptions: [], risks: [],
    steps: [{ key: 'brief', title: '形成建议', outcome: '可审阅建议', acceptanceCriteria: ['说明依据'], dependencies: [], roleKey: context.sources.roles[0]!.key }], changeReason: '先完成方案供用户审阅',
  })
  const grant = issue(f)
  store.updateProject(f.project.id, { description: '补充了新的项目资料' })
  const stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(message => message.kind === 'attention' && message.content.includes('旧授权不会用于新请求')))
    const messages = getOwnerManagementConversation(f.project.id).messages.filter(message => message.content.includes('旧授权不会用于新请求'))
    expect(messages).toHaveLength(1)
    expect(service.getOwnerManagementDelegation(f.project.id)).toMatchObject({ state: 'stale', delegation: { id: grant.id } })
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(0)
  } finally { stop(); service.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given资料变化后Owner对话重新读取管理许可 When许可已stale Then立即唤醒对账并在原对话解释暂停', async () => {
  const f = fixture(), grant = issue(f), stop = startOwnerManagementLoop(), handlers = new Map<string, (event: unknown, request: unknown) => unknown>()
  registerProjectOwnerGoalIpcHandlers({ handle: (channel, handler) => { handlers.set(channel, handler) } })
  try {
    store.updateProject(f.project.id, { description: 'Owner授权后新增的资料' })
    expect(service.getOwnerManagementDelegation(f.project.id).state).toBe('stale')
    expect(getOwnerManagementConversation(f.project.id).messages.some(message => message.content.includes('旧授权不会用于新请求'))).toBe(false)
    const callsBeforeWake = calls
    const handler = handlers.get(PROJECT_IPC_CHANNELS.GET_OWNER_MANAGEMENT_DELEGATION)
    expect(handler).toBeDefined()
    expect(handler!({}, { projectId: f.project.id })).toMatchObject({ ok: true, value: { state: 'stale', delegation: { id: grant.id } } })
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(message => message.kind === 'attention' && message.content.includes('旧授权不会用于新请求')))
    expect(getOwnerManagementConversation(f.project.id).messages.filter(message => message.content.includes('旧授权不会用于新请求'))).toHaveLength(1)
    expect(calls).toBe(callsBeforeWake)
  } finally { stop(); service.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given 待审方案 When 用户确认方案与管理预算 Then 原子确认准确方案并允许确认请求安全重提', () => {
  const f = fixture(), context = plans.getProjectOwnerPlanningContext(f.project.id)
  const proposed = plans.saveProjectOwnerPlanDraft(f.project.id, context.goal.revision, 0, {
    expectedContextFingerprint: context.fingerprint, summary: '按目标完成定位建议', assumptions: [], risks: [],
    steps: [{ key: 'brief', title: '形成建议', outcome: '可审阅建议', acceptanceCriteria: ['说明依据'], dependencies: [], roleKey: context.sources.roles[0]!.key }], changeReason: '测试待审提案',
  })
  const input = { ...f.input, startApproval: { expectedGoalRevision: proposed.goalRevision, expectedPlanRevision: proposed.revision, planFingerprint: proposed.planFingerprint, contextFingerprint: proposed.contextFingerprint } }
  const preview = service.previewOwnerManagementDelegation(input)
  const grant = service.confirmOwnerManagementDelegation({ input, previewHash: preview.previewHash })
  expect(plans.getProjectOwnerPlanDraft(f.project.id)?.state).toBe('confirmed')
  expect(service.confirmOwnerManagementDelegation({ input: { ...input, startApproval: { ...input.startApproval } }, previewHash: preview.previewHash })).toEqual(grant)
  service.revokeOwnerManagementDelegation(f.project.id, grant.id)
})

test('Given 无委托 When 内部入口启动 Then 排队与准备状态一起回滚，不调用runner', async () => {
  const f = fixture(), before = calls
  await expect(startDelegatedOwnerPlanningTask(f.taskId)).rejects.toThrow('委托')
  expect(store.listAgentExecutionsByEntity('task', f.taskId)).toHaveLength(0)
  expect(store.getTask(f.taskId)?.status).toBe('paused')
  expect(calls).toBe(before)
})

test('Given 已确认委托 When 后台启动、收到澄清并答复 Then 自动第二轮且不要求逐次费用确认', async () => {
  const f = fixture(), before = calls, grant = issue(f), stop = startOwnerManagementLoop()
  try {
    await until(() => callbacks.has(store.listAgentExecutionsByEntity('task', f.taskId)[0]?.sessionId ?? ''))
    expect(calls).toBe(before + 1)
    expect(service.hasActiveOwnerManagementRequest(grant.id)).toBe(true)
    await startDelegatedOwnerPlanningTask(f.taskId)
    expect(calls).toBe(before + 1)
    clarify(f.taskId)
    await until(() => getOwnerManagementConversation(f.project.id).questions.length === 1)
    expect(service.hasActiveOwnerManagementRequest(grant.id)).toBe(false)
    const question = getOwnerManagementConversation(f.project.id).questions[0]!
    answerOwnerManagementQuestion({ projectId: f.project.id, questionId: question.id, requestId: randomUUID(), expectedGoalRevision: question.goalRevision, expectedContextFingerprint: question.contextFingerprint, answers: { audience: '现有用户' } })
    await until(() => calls === before + 2)
    expect(service.getOwnerManagementDelegation(f.project.id)).toMatchObject({ usedRequests: 2, reservedCostMicros: grant.perRequestCeilingMicros * 2 })
    const last = store.listAgentExecutionsByProject(f.project.id).find(item => item.status === 'running')!
    expect(() => assertControlledPreparedExecution(last.id, 'provider')).not.toThrow()
    service.revokeOwnerManagementDelegation(f.project.id, grant.id)
    expect(() => assertControlledPreparedExecution(last.id, 'provider')).toThrow('撤销')
  } finally { stop() }
})

test('Given 只余一次请求或一次预算 When 再占额 Then 拒绝并回滚第二个执行', async () => {
  const f = fixture(); f.input.maxRequests = 1; const grant = issue(f)
  await startDelegatedOwnerPlanningTask(f.taskId)
  clarify(f.taskId); reconcileOwnerManagement(f.project.id)
  const q = getOwnerManagementConversation(f.project.id).questions[0]!
  answerOwnerManagementQuestion({ projectId: f.project.id, questionId: q.id, requestId: randomUUID(), expectedGoalRevision: q.goalRevision, expectedContextFingerprint: q.contextFingerprint, answers: { audience: '现有用户' } })
  reconcileOwnerManagement(f.project.id)
  const next = getOwnerManagementConversation(f.project.id).messages.findLast(item => item.planningTaskId)?.planningTaskId!
  await expect(startDelegatedOwnerPlanningTask(next)).rejects.toThrow('用尽')
  expect(service.getOwnerManagementDelegation(f.project.id)).toMatchObject({ state: 'exhausted', usedRequests: 1, reservedCostMicros: grant.perRequestCeilingMicros })
  service.revokeOwnerManagementDelegation(f.project.id, grant.id)
})

test('Given 请求用量未知 When 澄清终态返回 Then 停等核对而不自动续调并给出本地诊断', async () => {
  const f = fixture(), grant = issue(f)
  await startDelegatedOwnerPlanningTask(f.taskId); clarify(f.taskId, false)
  expect(service.getOwnerManagementDelegation(f.project.id)).toMatchObject({ state: 'attention', attentionCheck: { executionStatus: 'completed', outcomeState: 'needs_clarification', reason: 'missing_usage', modelId: grant.modelId, inputTokens: null, outputTokens: null, costSource: 'unknown' } })
  service.revokeOwnerManagementDelegation(f.project.id, grant.id)
})

test('Given 模型正常终止且用量完整但规划JSON未通过协议校验 When 核对管理授权 Then保留原费用预留并允许新用户消息在总预算内继续', async () => {
  const f = fixture(), grant = issue(f)
  await startDelegatedOwnerPlanningTask(f.taskId)
  const execution = store.listAgentExecutionsByEntity('task', f.taskId)[0]!
  callbacks.get(execution.sessionId!)!.onComplete([], { runtimeResult: {
    type: 'result', subtype: 'success', session_id: execution.sessionId!, finish_reason: 'stop',
    result: '{"schemaVersion":1,"kind":"plan_proposal","proposal":{"steps":[{"acceptanceCriteria ["broken"]}]}}',
    usage: { input_tokens: 3222, output_tokens: 461 },
    owner_planning_usage: { inputTokens: 3222, outputTokens: 461, cacheReadTokens: null, cacheWriteTokens: null },
  } })
  expect(service.getOwnerManagementDelegation(f.project.id)).toMatchObject({
    state: 'active', usedRequests: 1, reservedCostMicros: grant.perRequestCeilingMicros,
    detail: expect.stringContaining('费用未知仍按保守预留占用项目额度'),
  })
  service.revokeOwnerManagementDelegation(f.project.id, grant.id)
})

test('Given模型输出达到请求上限且委托资料已变化 When读取管理状态 Then显示截断原因与费用核对而不自动续跑', async () => {
  const f = fixture(), grant = issue(f)
  await startDelegatedOwnerPlanningTask(f.taskId)
  const execution = store.listAgentExecutionsByEntity('task', f.taskId)[0]!
  const source = resolveOwnerPlanningSession(execution.sessionId!)!
  store.updateProject(f.project.id, { description: '资料配置已变化' })
  callbacks.get(execution.sessionId!)!.onComplete([], { runtimeResult: {
    type: 'result', subtype: 'error_during_execution', session_id: execution.sessionId!, finish_reason: 'length',
    result: '{"schemaVersion":1', usage: { input_tokens: 10, output_tokens: source.link.maxOutputTokens },
    owner_planning_usage: { inputTokens: 10, outputTokens: source.link.maxOutputTokens, cacheReadTokens: null, cacheWriteTokens: null },
  } })
  expect(service.getOwnerManagementDelegation(f.project.id)).toMatchObject({
    state: 'attention', detail: expect.stringContaining('不会自动重试'),
    attentionCheck: { executionStatus: 'failed', outcomeState: 'failed', reason: 'output_limit', costSource: 'unknown' },
  })
  service.revokeOwnerManagementDelegation(f.project.id, grant.id)
})

test('Given 已确认委托 When 人工改目标、资料变更或删除单个占额证据 Then 旧委托拒绝发送而非降级', async () => {
  const f = fixture(), grant = issue(f)
  await startDelegatedOwnerPlanningTask(f.taskId)
  const execution = store.listAgentExecutionsByEntity('task', f.taskId)[0]!
  const db = store.getProjectDb()
  expect(() => db.transaction(() => { db.prepare('DELETE FROM project_owner_management_claims WHERE task_id = ?').run(f.taskId); assertControlledPreparedExecution(execution.id, 'provider') })()).toThrow('证据缺失')
  saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '改成另外的目标' })
  expect(service.getOwnerManagementDelegation(f.project.id).state).toBe('stale')
  expect(() => assertControlledPreparedExecution(execution.id, 'provider')).toThrow()
  service.revokeOwnerManagementDelegation(f.project.id, grant.id)
})

test('Given 项目管理调用已有预算预留 When 来源变化后重新确认 Then 新授权保留项目累计次数和费用', async () => {
  const f = fixture(), grant = issue(f)
  await startDelegatedOwnerPlanningTask(f.taskId)
  clarify(f.taskId)
  store.updateProject(f.project.id, { description: '新资料需要重新确认' })
  expect(service.getOwnerManagementDelegation(f.project.id)).toMatchObject({ state: 'stale', usedRequests: 1, reservedCostMicros: grant.perRequestCeilingMicros })
  const stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(message => message.kind === 'attention' && message.content.includes('旧授权不会用于新请求')))
    expect(getOwnerManagementConversation(f.project.id).messages.filter(message => message.content.includes('旧授权不会用于新请求'))).toHaveLength(1)
    const requestId = randomUUID()
    expect(() => service.previewOwnerManagementDelegation({ ...f.input, requestId, maxCostMicros: grant.perRequestCeilingMicros })).toThrow('历史预留')
    expect(() => service.previewOwnerManagementDelegation({ ...f.input, requestId, maxRequests: 1 })).toThrow('累计管理请求次数')
    const input = { ...f.input, requestId }
    const preview = service.previewOwnerManagementDelegation(input)
    const previousCalls = calls
    const replacement = service.confirmOwnerManagementDelegation({ input, previewHash: preview.previewHash })
    expect(replacement.id).not.toBe(grant.id)
    expect(store.getProjectDb().prepare('SELECT revoked_at FROM project_owner_management_delegations WHERE id = ?').get(grant.id)).toMatchObject({ revoked_at: expect.any(Number) })
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(message => message.kind === 'management_progress' && message.content.includes('重新整理方案')))
    const conversation = getOwnerManagementConversation(f.project.id)
    const nextTaskId = conversation.messages.findLast(message => message.planningTaskId)?.planningTaskId!
    expect(nextTaskId).not.toBe(f.taskId)
    await until(() => calls > previousCalls)
    clarify(nextTaskId)
    await until(() => getOwnerManagementConversation(f.project.id).questions.some(question => question.state === 'open'))
    expect(service.getOwnerManagementDelegation(f.project.id)).toMatchObject({ state: 'active', usedRequests: 2, reservedCostMicros: grant.perRequestCeilingMicros * 2 })
  } finally { stop() }
})

test('Given委托失效或已撤销但旧请求仍在运行 When重新发行委托 Then先核对旧请求且不允许并行请求', async () => {
  const f = fixture(), grant = issue(f)
  await startDelegatedOwnerPlanningTask(f.taskId)
  store.updateProject(f.project.id, { description: '资料已变化' })
  const input = { ...f.input, requestId: randomUUID() }, preview = service.previewOwnerManagementDelegation(input)
  expect(() => service.confirmOwnerManagementDelegation({ input, previewHash: preview.previewHash })).toThrow('上次管理请求仍在运行')
  service.revokeOwnerManagementDelegation(f.project.id, grant.id)
  const afterRevoke = service.previewOwnerManagementDelegation(input)
  expect(() => service.confirmOwnerManagementDelegation({ input, previewHash: afterRevoke.previewHash })).toThrow('上次管理请求仍在运行')
})

test('Given 预算、字段、确认来源无效 When 预览发行 Then 拒绝且不落委托', () => {
  const f = fixture()
  expect(() => service.previewOwnerManagementDelegation({ ...f.input, maxCostMicros: 1 })).toThrow('预算不足')
  expect(() => service.previewOwnerManagementDelegation({ ...f.input, maxRequests: 0 })).toThrow()
  expect(() => service.previewOwnerManagementDelegation({ ...f.input, maxRequests: 13 })).toThrow()
  expect(() => service.previewOwnerManagementDelegation({ ...f.input, actor: 'model' })).toThrow()
  const p = service.previewOwnerManagementDelegation(f.input)
  saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '新的目标' })
  expect(() => service.confirmOwnerManagementDelegation({ input: f.input, previewHash: p.previewHash })).toThrow('已变化')
  expect(service.getOwnerManagementDelegation(f.project.id).state).toBe('none')
})

test('Given 旧版本委托超过当前内部请求上限 When 重开授权 Then 标记待重确认并阻止新请求', async () => {
  const f = fixture(), grant = issue(f), db = store.getProjectDb(), row = db.prepare('SELECT payload FROM project_owner_management_delegations WHERE id = ?').get(grant.id) as { payload: string }
  const legacy = { ...JSON.parse(row.payload), maxRequests: 13 }
  const payload = JSON.stringify(legacy), integrityHash = createHash('sha256').update(payload).digest('hex')
  db.prepare('UPDATE project_owner_management_delegations SET payload = ?, integrity_hash = ? WHERE id = ?').run(payload, integrityHash, grant.id)
  const before = calls
  expect(service.getOwnerManagementDelegation(f.project.id)).toMatchObject({ state: 'stale', detail: '管理委托超过当前调用安全上限，请重新确认预算与期限' })
  await expect(startDelegatedOwnerPlanningTask(f.taskId)).rejects.toThrow('重新确认')
  expect(store.listAgentExecutionsByEntity('task', f.taskId)).toHaveLength(0)
  expect(calls).toBe(before)
})

test('Given 升级前已排队的高额度管理请求 When 到达发送门禁 Then 拒绝旧请求', async () => {
  const f = fixture(), grant = issue(f)
  await startDelegatedOwnerPlanningTask(f.taskId)
  const execution = store.listAgentExecutionsByEntity('task', f.taskId)[0]!, db = store.getProjectDb()
  const row = db.prepare('SELECT payload FROM project_owner_management_delegations WHERE id = ?').get(grant.id) as { payload: string }
  const legacy = { ...JSON.parse(row.payload), maxRequests: 13 }
  const payload = JSON.stringify(legacy), integrityHash = createHash('sha256').update(payload).digest('hex')
  db.prepare('UPDATE project_owner_management_delegations SET payload = ?, integrity_hash = ? WHERE id = ?').run(payload, integrityHash, grant.id)
  expect(() => assertControlledPreparedExecution(execution.id, 'provider')).toThrow('超过当前调用安全上限')
})


test('Given 预算只能覆盖一次但次数尚余 When 请求完成 Then 预算耗尽且未知费用不退款', async () => {
  const f = fixture()
  f.input.maxCostMicros = service.previewOwnerManagementDelegation(f.input).perRequestCeilingMicros
  const grant = issue(f)
  await Promise.all([startDelegatedOwnerPlanningTask(f.taskId), startDelegatedOwnerPlanningTask(f.taskId)])
  expect(store.listAgentExecutionsByEntity('task', f.taskId)).toHaveLength(1)
  clarify(f.taskId)
  expect(service.getOwnerManagementDelegation(f.project.id)).toMatchObject({ state: 'exhausted', usedRequests: 1, reservedCostMicros: grant.perRequestCeilingMicros })
  service.revokeOwnerManagementDelegation(f.project.id, grant.id)
})

test('Given 有效委托 When 到期或项目资料变更 Then 发送前拒绝，跨项目撤销也拒绝', async () => {
  const f = fixture(), grant = issue(f)
  await startDelegatedOwnerPlanningTask(f.taskId)
  const execution = store.listAgentExecutionsByEntity('task', f.taskId)[0]!
  const clock = spyOn(Date, 'now').mockReturnValue(grant.expiresAt + 1)
  try {
    expect(service.getOwnerManagementDelegation(f.project.id).state).toBe('expired')
    expect(() => assertControlledPreparedExecution(execution.id, 'provider')).toThrow('过期')
  } finally { clock.mockRestore() }
  const other = store.createProject({ title: '其他', description: '' })
  expect(() => service.revokeOwnerManagementDelegation(other.id, grant.id)).toThrow('不属于')
  store.updateProject(f.project.id, { description: '增加未经确认的资料' })
  expect(service.getOwnerManagementDelegation(f.project.id).state).toBe('stale')
  expect(() => assertControlledPreparedExecution(execution.id, 'provider')).toThrow()
  service.revokeOwnerManagementDelegation(f.project.id, grant.id)
})

test('Given 项目总预算 When 计算Owner模型占比上限 Then按20%向下取整且不接受无效输入', () => {
  expect(service.ownerModelBudgetLimit(2_000_000)).toBe(400_000)
  expect(service.ownerModelBudgetLimit(1)).toBe(0)
  expect(service.ownerModelBudgetLimit(999_999)).toBe(199_999)
  expect(() => service.ownerModelBudgetLimit(0)).toThrow('项目总预算无效')
  expect(() => service.ownerModelBudgetLimit(1.5)).toThrow('项目总预算无效')
})

test('Given Owner模型已占额 When 达到20% Then明确拒绝并要求增量授权', () => {
  expect(() => service.assertOwnerModelBudgetAvailable({ projectBudgetMicros: 2_000_000, ownerModelMicros: 399_999 })).not.toThrow()
  expect(() => service.assertOwnerModelBudgetAvailable({ projectBudgetMicros: 2_000_000, ownerModelMicros: 400_000 })).toThrow('20%上限')
  expect(() => service.assertOwnerModelBudgetAvailable({ projectBudgetMicros: 2_000_000, ownerModelMicros: 900_000 })).toThrow('20%上限')
  expect(() => service.assertOwnerModelBudgetAvailable({ projectBudgetMicros: 2_000_000, ownerModelMicros: -1 })).toThrow('占额记录无效')
})

test('Given 已预留Owner模型请求 When 读取占比用量 Then只累计管理占额且不混入员工执行', async () => {
  const f = fixture(), grant = issue(f), hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  let ordinal = 0
  const claim = (executionId: string, reservedCostMicros: number) => {
    const taskId = `claim-task-${++ordinal}`
    const value = { taskId, executionId, delegationId: grant.id, reservedCostMicros }
    store.getProjectDb().prepare('INSERT INTO project_owner_management_claims (task_id, delegation_id, execution_id, payload, integrity_hash) VALUES (?, ?, ?, ?, ?)').run(taskId, grant.id, executionId, JSON.stringify(value), hash(value))
  }
  const before = service.getOwnerModelBudgetUsage(f.project.id, 2_000_000)
  expect(before).toMatchObject({ projectBudgetMicros: 2_000_000, ownerModelLimitMicros: 400_000, ownerModelMicros: 0, ownerModelSettledMicros: 0, ownerModelInFlightMicros: 0, executionMicros: 0, remainingOwnerModelMicros: 400_000 })
  claim(randomUUID(), 150_000)
  claim(randomUUID(), 150_000)
  const after = service.getOwnerModelBudgetUsage(f.project.id, 2_000_000)
  expect(after).toMatchObject({ ownerModelMicros: 300_000, ownerModelSettledMicros: 0, ownerModelInFlightMicros: 300_000, remainingOwnerModelMicros: 100_000 })
  expect(() => service.assertOwnerModelBudgetAvailable({ projectBudgetMicros: 2_000_000, ownerModelMicros: after.ownerModelMicros })).not.toThrow()
  expect(service.getOwnerManagementDelegation(f.project.id).ownerModelBudget).toMatchObject({ limitMicros: 400_000, usedMicros: 300_000, settledMicros: 0, inFlightMicros: 300_000, ratio: 0.2 })
  claim(randomUUID(), 100_000)
  expect(() => service.assertOwnerModelBudgetAvailable({ projectBudgetMicros: 2_000_000, ownerModelMicros: service.getOwnerModelBudgetUsage(f.project.id, 2_000_000).ownerModelMicros })).toThrow('20%上限')
  service.revokeOwnerManagementDelegation(f.project.id, grant.id)
})
