import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-launch-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel, getChannelById } = await import('./channel-manager')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const { saveProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
const { saveOwnerRuntimeBinding } = await import('./project-owner-runtime-binding')
const management = await import('./project-owner-management-loop')
const managementDelegation = await import('./project-owner-management-delegation')
const plans = await import('./project-owner-plan-service')
const prep = await import('./project-owner-execution-preparation')
const materialization = await import('./project-owner-task-materialization')
const revalidation = await import('./project-owner-execution-revalidation')
const grantIssue = await import('./project-owner-execution-grant-issue')
const { launchOwnerPreparedExecution } = await import('./project-owner-execution-launch')
const { getAgentSessionMeta } = await import('./agent-session-manager')
let policy: typeof import('./project-pilot-policy')
beforeAll(async () => { await store.initProjectDb(); policy = await import('./project-pilot-policy') })
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
function fixture(profile: 'controlled' | 'general' | 'development' = 'controlled', permissionMode: 'safe' | 'auto' = profile === 'general' || profile === 'development' ? 'auto' : 'safe', mixed = false, textDelivery = false, runtime: 'ai-sdk' | 'pi' = 'ai-sdk', withKnowledge = false) {
  const project = store.createProject({ title: 'Owner最终启动', description: '' })
  const workspace = createAgentWorkspace(`owner-launch-${randomUUID()}`, profile === 'development' ? mkdtempSync(join(directory, 'owner-dev-root-')) : undefined)
  bindWorkspaceToProject(project.id, workspace.id)
  const modelId = 'glm-5.3-flash'
  const channel = createChannel({ name: 'fake', provider: runtime === 'pi' ? 'zhipu' : 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: modelId, name: modelId, enabled: true }] })
  const reviewerChannel = mixed ? createChannel({ name: 'fake reviewer', provider: 'openai', baseUrl: 'https://reviewer.invalid/v1', apiKey: 'fake-reviewer', enabled: true, models: [{ id: 'deepseek-flash', name: 'deepseek-flash', enabled: true }] }) : channel
  const employee = (name: string) => employees.createAgentEmployee({ name, role: '研究', description: '', executionProfile: profile, permissionMode, systemPrompt: '依据资料研究与独立检查，不扩大项目许可。', runtime, channelId: name === '独立评审' ? reviewerChannel.id : channel.id, modelId: mixed && name === '独立评审' ? 'deepseek-flash' : modelId, workspaceIds: [workspace.id] })
  const owner = employees.createAgentEmployee({ name: 'Owner', role: '项目管理者', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId, workspaceIds: [workspace.id] })
  const executor = employee('执行者'), reviewer = employee('独立评审')
  const knowledgeSourceIds: string[] = []
  let extraKnowledgeSourceId: string | undefined
  if (withKnowledge) {
    const catalog = require('./knowledge-catalog-service') as typeof import('./knowledge-catalog-service')
    const locator = mkdtempSync(join(directory, 'knowledge-'))
    writeFileSync(join(locator, 'evidence.md'), '## 第1页\n冻结项目资料与原文证据。')
    const source = catalog.createSource({ type: 'vault', name: '项目原文', locator })
    const extraLocator = mkdtempSync(join(directory, 'knowledge-extra-'))
    writeFileSync(join(extraLocator, 'other.md'), '## 第1页\n未冻结资料和原文证据。')
    const extra = catalog.createSource({ type: 'vault', name: '未冻结资料', locator: extraLocator })
    extraKnowledgeSourceId = extra.id
    const base = catalog.createKnowledgeBase({ name: '项目资料', sourceIds: [source.id, extra.id] })
    catalog.bindProject({ projectId: project.id, knowledgeBaseId: base.id })
    knowledgeSourceIds.push(source.id)
  }
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '交付研究材料' })
  saveOwnerRuntimeBinding(project.id, 0, { ownerName: 'Owner', carrierId: owner.id, workspaceId: workspace.id, changeReason: '测试' })
  management.reconcileOwnerManagement(project.id)
  const delegationInput = { projectId: project.id, requestId: randomUUID(), maxRequests: 6, maxCostMicros: 4_000_000, expiresAt: Date.now() + 6 * 3600000 }
  const delegationPreview = managementDelegation.previewOwnerManagementDelegation(delegationInput)
  managementDelegation.confirmOwnerManagementDelegation({ input: delegationInput, previewHash: delegationPreview.previewHash })
  const context = plans.getProjectOwnerPlanningContext(project.id)
  const steps = [{ key: 'brief', title: '研究', outcome: '材料', acceptanceCriteria: ['范围'], dependencies: [] as string[], roleKey: context.sources.roles[0]!.key }]
  plans.saveProjectOwnerPlanDraft(project.id, 1, 0, { expectedContextFingerprint: context.fingerprint, summary: '计划', assumptions: [], risks: [], steps, changeReason: '建立' })
  plans.confirmProjectOwnerPlanDraft(project.id, 1, 1)
  const subject = { projectId: project.id }
  const preparationInput = { requestId: randomUUID(), expectedPreparationRevision: 0, expectedPolicyRevision: null, expectedGoalRevision: 1, expectedPlanRevision: 2, selectedStepKeys: ['brief'], executionKind: 'controlled' as const, ...(mixed || runtime === 'pi' ? { employeeRuntimeVersion: 2 as const } : {}), ...(textDelivery ? { textDeliveryVersion: 1 as const } : {}), executorEmployeeId: executor.id, reviewerEmployeeId: reviewer.id, roleAssignments: [{ roleKey: steps[0]!.roleKey, employeeId: executor.id }], workspaceId: workspace.id, knowledgeSourceIds, maxCostMicros: 1000000, maxRuns: 4, maxRework: 1, expiresAt: Date.now() + 3600000, changeReason: '准备' }
  const pv = prep.previewOwnerExecutionPreparation(subject, preparationInput), preparation = prep.saveOwnerExecutionPreparation(subject, preparationInput, pv.previewFingerprint)
  const input = { requestId: randomUUID(), expectedMaterializationRevision: 0, expectedPreparationId: preparation.id, expectedPreparationRevision: preparation.revision, expectedPreparationHash: preparation.integrityHash, expectedPolicyRevision: preparation.policyRevision }
  const preview = materialization.previewOwnerTaskMaterialization(subject, input)
  return { project, subject, preparation, workspace, channel, reviewerChannel, executor, reviewer, knowledgeSourceIds, extraKnowledgeSourceId, request: { ...subject, input, previewFingerprint: preview.previewFingerprint } }
}
function adapters() {
  const calls = { schedules: 0 }
  const dependencies: NonNullable<Parameters<typeof launchOwnerPreparedExecution>[1]> = {
    schedule: async () => { calls.schedules++ },
  }
  return { calls, dependencies }
}
const taskCount = (projectId: string) => (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM tasks WHERE project_id=? AND owner_step_link_id IS NOT NULL').get(projectId) as { count: number }).count

test('Given最终范围摘要 When主进程确认 Then顺序登记核验签发自主许可且丢回包重提不重复', async () => {
  const f = fixture(), a = adapters()
  expect(taskCount(f.project.id)).toBe(0)
  const first = await launchOwnerPreparedExecution(f.request, a.dependencies)
  expect(first).toMatchObject({ projectId: f.project.id, state: 'active', dispatchMode: 'autonomous', budget: { maxCostMicros: 1000000, maxRuns: 4 } })
  expect(taskCount(f.project.id)).toBe(1)
  expect(revalidation.getOwnerExecutionRevalidation(f.subject).status).toBe('current')
  expect(a.calls).toMatchObject({ schedules: 1 })
  const replay = await launchOwnerPreparedExecution(f.request, a.dependencies)
  expect(replay.grantId).toBe(first.grantId)
  expect(taskCount(f.project.id)).toBe(1)
  expect(a.calls).toMatchObject({ schedules: 2 })
})

test('Given用户只查看结果卡但没有确认 When启动入口未被调用 Then不登记任务、不签发授权也不启动员工', () => {
  const f = fixture()
  expect(taskCount(f.project.id)).toBe(0)
  expect(grantIssue.getOwnerExecutionGrant(f.subject)).toBeNull()
  expect(store.listAgentExecutionsByEntity('task', f.project.id)).toHaveLength(0)
})

test('Given同一范围同时点击 When确认尚未返回 Then合并请求且拒绝不同范围', async () => {
  const f = fixture(), a = adapters()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const dependencies = { ...a.dependencies, schedule: async () => { await gate; a.calls.schedules++ } }
  const first = launchOwnerPreparedExecution(f.request, dependencies)
  const second = launchOwnerPreparedExecution(f.request, dependencies)
  await expect(launchOwnerPreparedExecution({ ...f.request, input: { ...f.request.input, requestId: randomUUID() } }, dependencies)).rejects.toThrow('另一份执行确认')
  release()
  const results = await Promise.all([first, second])
  expect(results[0]!.grantId).toBe(results[1]!.grantId)
  expect(a.calls).toMatchObject({ schedules: 1 })
  expect(taskCount(f.project.id)).toBe(1)
})

test('Given结果卡展示后目标更新 When用户确认旧范围 Then拒绝旧版本且不登记、不签发或调度', async () => {
  const f = fixture(), a = adapters()
  saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '新的目标' })
  await expect(launchOwnerPreparedExecution(f.request, a.dependencies)).rejects.toThrow()
  expect(taskCount(f.project.id)).toBe(0)
  expect(grantIssue.getOwnerExecutionGrant(f.subject)).toBeNull()
  expect(a.calls.schedules).toBe(0)
})

test('Given只登记成功后进程中断 When重开继续 Then核验原批次并完成最终确认', async () => {
  const f = fixture(), a = adapters()
  const batch = materialization.materializeOwnerTasks(f.subject, f.request.input, f.request.previewFingerprint)
  store.closeProjectDb(); await store.initProjectDb()
  const grant = await launchOwnerPreparedExecution(f.request, a.dependencies)
  expect(grant.materializationId).toBe(batch.id)
  expect(taskCount(f.project.id)).toBe(1)
  expect(a.calls).toMatchObject({ schedules: 1 })
})

test('Given签发成功但调度返回失败 When重提 Then回读已有许可并唤醒调度且不重新签发或弹框', async () => {
  const f = fixture(), a = adapters()
  await expect(launchOwnerPreparedExecution(f.request, { ...a.dependencies, schedule: async () => { throw new Error('模拟调度回包丢失') } })).rejects.toThrow('模拟调度回包丢失')
  const prior = grantIssue.getOwnerExecutionGrant(f.subject)!
  const grant = await launchOwnerPreparedExecution(f.request, a.dependencies)
  expect(grant.grantId).toBe(prior.grantId)
  expect(a.calls).toMatchObject({ schedules: 1 })
  expect(taskCount(f.project.id)).toBe(1)
})

test('Given已撤销旧许可 When重复旧最终请求 Then不能复活原许可', async () => {
  const f = fixture(), a = adapters()
  const grant = await launchOwnerPreparedExecution(f.request, a.dependencies)
  const preview = grantIssue.previewOwnerExecutionGrantRevoke(f.subject, { grantId: grant.grantId })
  grantIssue.confirmOwnerExecutionGrantRevoke(f.subject, { grantId: grant.grantId, confirmedFingerprint: preview.fingerprint })
  await expect(launchOwnerPreparedExecution(f.request, a.dependencies)).rejects.toThrow('已撤销')
  expect(a.calls).toMatchObject({ schedules: 1 })
})

/** 终态回调需等待逐请求结算落库，测试用项目级收敛等待替代“回调返回即已结算”的同步假设。 */
async function waitForOwnerProjectSettled(projectId: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const active = store.getProjectDb().prepare("SELECT COUNT(*) AS count FROM agent_executions WHERE project_id=? AND status IN ('queued','running')").get(projectId) as { count: number }
    const unsettled = store.getProjectDb().prepare("SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE project_id=? AND state IN ('queued','running')").get(projectId) as { count: number }
    if (active.count === 0 && unsettled.count === 0) return
    await Bun.sleep(5)
  }
  throw new Error('项目执行未在限定时间内收敛到终态')
}

test.each(['controlled', 'controlled-auto', 'general', 'mixed', 'pi'] as const)('Given%s员工与最终确认 When真实调度器配替身Runtime执行评审 Then准确员工会话启动且重提不重复派工', async kind => {
  const profile = kind === 'general' || kind === 'mixed' ? 'general' : 'controlled'
  const runtime = kind === 'pi' ? 'pi' : 'ai-sdk'
  const f = fixture(profile, kind === 'controlled' ? 'safe' : 'auto', kind === 'mixed', false, runtime), a = adapters()
  const scheduler = await import('./project-owner-autonomous-scheduler')
  const registry = await import('./agent-headless-runner-registry')
  const boundary = await import('./controlled-provider-boundary')
  const { getAgentWorkspaceCwd } = await import('./agent-workspace-manager')
  const invoked: string[] = [], finished: Promise<void>[] = []
  const sentRequestBodies: string[] = []
  registry.setHeadlessAgentRunner(async (input, callbacks) => {
    let finish!: () => void
    finished.push(new Promise<void>(resolve => { finish = resolve }))
    invoked.push(input.sessionId)
    expect(input.permissionModeOverride).toBe('safe')
    expect(input.userMessage).toContain('冻结项目目标与约束')
    expect(input.userMessage).toContain('交付研究材料')
    if (profile === 'general') expect(input.userMessage).toContain('依据资料研究与独立检查')
    callbacks.onRuntimeStarted?.()
    try {
      const transport = Object.assign(async (_input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
        if (typeof init?.body === 'string') sentRequestBodies.push(init.body)
        return new Response(JSON.stringify({ id: `fake-${invoked.length}`, choices: [{ message: { content: 'fake result' } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }, { preconnect: () => {} }) as typeof globalThis.fetch
      const fetch = boundary.createControlledProviderFetch(input.sessionId, () => ({ runtime, cwd: getAgentWorkspaceCwd(f.workspace, input.sessionId), modelId: input.modelId ?? '', permissionMode: 'safe' }), transport)
      const requestExit = await import('./project-owner-execution-request-exit')
      const expectedOutputLimit = 131_072
      expect(requestExit.resolveOwnerExecutionMaxOutputTokens(input.sessionId, input.modelId!, input.channelId === f.channel.id && runtime === 'pi' ? 'zhipu' : 'openai')).toBe(expectedOutputLimit)
      const target = getChannelById(input.channelId)!
      if (kind === 'mixed' && input.userMessage.includes('角色=reviewer')) await expect(fetch(`${target.baseUrl!}/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'glm-5.3-flash', max_tokens: 32, messages: [{ role: 'user', content: 'wrong model' }] }) })).rejects.toThrow('与价格证据不一致')
      await fetch(`${target.baseUrl!.replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: input.modelId, max_tokens: runtime === 'pi' ? 8192 : 100, messages: [{ role: 'user', content: 'fake-only' }] }) })
      if (runtime === 'pi') expect(JSON.parse(sentRequestBodies.at(-1)!).max_tokens).toBe(8192)
      const content = input.userMessage.includes('角色=reviewer') ? JSON.stringify({ schemaVersion: 1, verdict: 'approved', summary: '合成评审', criteria: [{ criterion: '范围', status: 'met', evidence: '合成产物' }], findings: [], blockerReason: null }) : '合成材料'
      callbacks.onComplete([{ id: randomUUID(), role: 'assistant', content, createdAt: Date.now() }])
    } catch (cause) { callbacks.onError(String(cause)) }
    finally { finish() }
  })
  const dependencies = { ...a.dependencies, schedule: async (projectId: string) => { a.calls.schedules++; await scheduler.runOwnerAutonomousSchedule(projectId) } }
  const grant = await launchOwnerPreparedExecution(f.request, dependencies)
  await finished[0]
  await waitForOwnerProjectSettled(f.project.id)
  const task = store.listTasks(f.project.id)[0]!
  const executions = store.listAgentExecutionsByEntity('task', task.id)
  expect(executions).toHaveLength(1)
  expect(executions[0]).toMatchObject({ agentId: f.executor.id, status: 'completed' })
  expect(executions[0]!.sessionId).toBe(invoked[0]!)
  if (kind === 'mixed') { store.closeProjectDb(); await store.initProjectDb() }
  // 重提唤醒调度器后仅启动尚缺的Reviewer，不重复Executor。
  await launchOwnerPreparedExecution(f.request, dependencies)
  await finished[1]
  await waitForOwnerProjectSettled(f.project.id)
  const after = store.listAgentExecutionsByEntity('task', task.id)
  expect(after).toHaveLength(2)
  expect(after.map(item => item.agentId).sort()).toEqual([f.executor.id, f.reviewer.id].sort())
  expect(after.every(item => item.status === 'completed')).toBe(true)
  expect(store.getProjectDb().prepare('SELECT role,state FROM project_owner_execution_commands WHERE grant_id=? ORDER BY created_at').all(grant.grantId)).toEqual([{ role: 'executor', state: 'settled' }, { role: 'reviewer', state: 'settled' }])
  await launchOwnerPreparedExecution(f.request, dependencies)
  expect(invoked).toHaveLength(2)
  expect(a.calls.schedules).toBe(3)
  expect(store.getAgentEmployee(f.executor.id)?.executionProfile).toBe(profile)
  expect(store.getAgentEmployee(f.reviewer.id)?.executionProfile).toBe(profile)
  expect(store.getAgentEmployee(f.executor.id)?.permissionMode).toBe(kind === 'controlled' ? 'safe' : 'auto')
  if (kind === 'mixed') {
    expect(grant.employeeRuntimes?.map(item => item.modelId).sort()).toEqual(['deepseek-flash', 'glm-5.3-flash'])
    const rows = store.getProjectDb().prepare('SELECT id,role,actual_cost_micros,usage_evidence FROM project_owner_execution_commands WHERE grant_id=?').all(grant.grantId) as Array<{ id: string; role: string; actual_cost_micros: number; usage_evidence: string }>
    for (const row of rows) expect(JSON.parse(row.usage_evidence)).toMatchObject({ source: 'request_settled', modelId: row.role === 'reviewer' ? 'deepseek-flash' : 'glm-5.3-flash', channelId: row.role === 'reviewer' ? f.reviewerChannel.id : f.channel.id })
    const runtime = await import('./project-owner-employee-runtime'), settlement = await import('./project-owner-execution-settlement')
    employees.updateAgentEmployee(f.reviewer.id, { modelId: 'glm-5.3-flash', channelId: f.channel.id })
    expect(settlement.readOwnerGrantUsage(grant.grantId)).toEqual({ runReservations: 2, committedCostMicros: 7 })
    expect(rows.map(row => [row.role, row.actual_cost_micros]).sort()).toEqual([['executor', 2], ['reviewer', 5]])
    const review = rows.find(item => item.role === 'reviewer')!
    expect(() => settlement.settleOwnerCommandUsage(review.id, { ...JSON.parse(review.usage_evidence), channelId: f.channel.id, modelId: 'glm-5.3-flash' })).toThrow('不匹配')
    expect(runtime.readOwnerCommandRuntime(review.id).modelId).toBe('deepseek-flash')
    expect(settlement.settleOwnerCommandUsage(review.id, JSON.parse(review.usage_evidence)).state).toBe('settled')
  }

})

test('Given旧批次已撤权 When确认新计划和新范围 Then新批次正常发行而旧记录保留', async () => {
  const f = fixture(), a = adapters()
  const old = await launchOwnerPreparedExecution(f.request, a.dependencies)
  const revoke = grantIssue.previewOwnerExecutionGrantRevoke(f.subject, { grantId: old.grantId })
  grantIssue.confirmOwnerExecutionGrantRevoke(f.subject, { grantId: old.grantId, confirmedFingerprint: revoke.fingerprint })
  const context = plans.getProjectOwnerPlanningContext(f.project.id)
  plans.saveProjectOwnerPlanDraft(f.project.id, 1, 2, { expectedContextFingerprint: context.fingerprint, summary: '新版计划', assumptions: [], risks: [], steps: [{ key: 'revised', title: '修订研究', outcome: '新版材料', acceptanceCriteria: ['新范围'], dependencies: [], roleKey: context.sources.roles[0]!.key }], changeReason: '修订' })
  const plan = plans.confirmProjectOwnerPlanDraft(f.project.id, 1, 3)
  const input = { ...f.preparation.input, requestId: randomUUID(), expectedPreparationRevision: 1, expectedPolicyRevision: policy.getPilotPolicy(f.project.id)!.revision, expectedPlanRevision: plan.revision, selectedStepKeys: ['revised'] }
  const preview = prep.previewOwnerExecutionPreparation(f.subject, input)
  const preparation = prep.saveOwnerExecutionPreparation(f.subject, input, preview.previewFingerprint)
  const next = { ...f.request.input, requestId: randomUUID(), expectedMaterializationRevision: 1, expectedPreparationId: preparation.id, expectedPreparationRevision: preparation.revision, expectedPreparationHash: preparation.integrityHash, expectedPolicyRevision: preparation.policyRevision }
  const reviewed = materialization.previewOwnerTaskMaterialization(f.subject, next)
  const grant = await launchOwnerPreparedExecution({ ...f.subject, input: next, previewFingerprint: reviewed.previewFingerprint }, a.dependencies)
  expect(grant.grantId).not.toBe(old.grantId)
  expect(grant.materializationId).not.toBe(old.materializationId)
  expect(grantIssue.listOwnerExecutionGrantHistory(f.subject)).toHaveLength(2)
  expect(taskCount(f.project.id)).toBe(2)
  expect(a.calls.schedules).toBe(2)
})


test('Given普通员工已冻结受控调用 When改工作流、模型或专业资料 Then来源失效且普通档案无隐式迁移', () => {
  const f = fixture('general')
  const view = prep.getOwnerExecutionPreparation(f.subject)
  expect(view.choices.employees.filter(item => item.ownerControlledCompatible).map(item => item.id).sort()).toEqual([f.executor.id, f.reviewer.id].sort())
  expect(f.preparation.source.employeeInvocations).toHaveLength(2)
  const invocation = require('./project-owner-employee-invocation') as typeof import('./project-owner-employee-invocation')
  expect(() => invocation.resolveOwnerEmployeeInvocation(store.getAgentEmployee(f.executor.id)!, { executionKind: 'controlled' })).toThrow('冻结来源')
  employees.updateAgentEmployee(f.executor.id, { description: '新的职责与能力' })
  expect(prep.getOwnerExecutionPreparation(f.subject).status).toBe('stale')
  expect(store.getAgentEmployee(f.executor.id)?.executionProfile).toBe('general')
})

test('Given员工是普通配置 When仅为Owner构造收紧调用 Then保留原配置、拒绝workflow和不兼容Runtime/工作区', () => {
  const f = fixture('general'), original = store.getAgentEmployee(f.executor.id)!
  const invocation = require('./project-owner-employee-invocation') as typeof import('./project-owner-employee-invocation')
  const effective = invocation.resolveOwnerEmployeeInvocation(original, { executionKind: 'controlled', employeeInvocations: f.preparation.source.employeeInvocations })
  expect(effective).toMatchObject({ id: original.id, channelId: original.channelId, modelId: original.modelId, runtime: original.runtime, executionProfile: 'controlled', permissionMode: 'safe' })
  expect(original).toMatchObject({ executionProfile: 'general', permissionMode: 'auto' })
  expect(invocation.canUseOwnerControlledEmployee({ ...original, workflowId: 'workflow' }, f.workspace.id)).toBe(false)
  expect(invocation.canUseOwnerControlledEmployee({ ...original, runtime: 'pi' }, f.workspace.id)).toBe(false)
  expect(invocation.canUseOwnerControlledEmployee({ ...original, modelId: undefined }, f.workspace.id)).toBe(false)
  expect(invocation.canUseOwnerControlledEmployee(original, 'other-workspace')).toBe(false)
  expect(() => invocation.resolveOwnerEmployeeInvocation(original, { executionKind: 'development', employeeInvocations: f.preparation.source.employeeInvocations })).toThrow('冻结来源')
})

test('Given Pi研发员工用于非代码Owner任务 When生成冻结调用 Then按本次授权临时降为受控safe且不改员工档案', () => {
  const f = fixture('development', 'auto', false, false, 'pi'), original = store.getAgentEmployee(f.executor.id)!
  const view = prep.getOwnerExecutionPreparation(f.subject)
  expect(view.choices.employees.find(item => item.id === f.executor.id)).toMatchObject({ executionProfile: 'development', ownerControlledCompatible: true })
  expect(f.preparation.source.employeeInvocations).toContainEqual({ employeeId: f.executor.id, originalProfile: 'development', executionProfile: 'controlled', permissionMode: 'safe' })
  expect(original).toMatchObject({ executionProfile: 'development', permissionMode: 'auto' })
  const invocation = require('./project-owner-employee-invocation') as typeof import('./project-owner-employee-invocation')
  expect(invocation.resolveOwnerEmployeeInvocation(original, { ...f.preparation.source, executionKind: 'controlled' })).toMatchObject({ id: original.id, runtime: 'pi', modelId: 'glm-5.3-flash', executionProfile: 'controlled', permissionMode: 'safe' })
  expect(store.getAgentEmployee(f.executor.id)).toMatchObject({ executionProfile: 'development', permissionMode: 'auto' })
})


test('Given逐员工配置已冻结 When旧单模型输入、次要员工配置或审核价格变化 Then拒绝或失效、不沿用旧范围', async () => {
  const f = fixture('general', 'auto', true)
  const { employeeRuntimeVersion: _version, ...legacy } = f.preparation.input
  const input = { ...legacy, requestId: randomUUID(), expectedPreparationRevision: 1, expectedPolicyRevision: f.preparation.policyRevision }
  expect(() => prep.previewOwnerExecutionPreparation(f.subject, input)).toThrow('同渠道')
  const runtime = await import('./project-owner-employee-runtime'), price = await import('./project-pilot-request-evidence')
  const frozen = f.preparation.source.employeeRuntimes!.find(item => item.employeeId === f.reviewer.id)!, original = { ...price.getPilotReviewedPriceEvidence(frozen.priceEvidenceId)! }
  price.registerPilotPriceEvidenceForTests({ ...original, outputMicrosPerMillion: original.outputMicrosPerMillion + 1 })
  try {
    expect(() => runtime.assertOwnerEmployeePrice(frozen)).toThrow('价格已变化')
    expect(prep.getOwnerExecutionPreparation(f.subject).status).toBe('stale')
  } finally { price.registerPilotPriceEvidenceForTests(original) }
  expect(prep.getOwnerExecutionPreparation(f.subject).status).toBe('current')
  const channel = await import('./channel-manager')
  channel.updateChannel(f.reviewerChannel.id, { baseUrl: 'https://changed-reviewer.invalid' })
  expect(prep.getOwnerExecutionPreparation(f.subject).status).toBe('stale')
})

test('Given不同模型的Reviewer运行时应用重开 When恢复与旧回调晚到 Then按Reviewer模型保留unknown和占额、不误记主模型', async () => {
  const f = fixture('general', 'auto', true), a = adapters(), scheduler = await import('./project-owner-autonomous-scheduler')
  const registry = await import('./agent-headless-runner-registry'), boundary = await import('./controlled-provider-boundary'), stop = await import('./project-owner-execution-stop')
  const { getAgentWorkspaceCwd } = await import('./agent-workspace-manager')
  const callbacksBySession = new Map<string, import('./agent-headless-runner-registry').HeadlessAgentRunCallbacks>()
  let done!: () => void
  const executorFinished = new Promise<void>(resolve => { done = resolve })
  registry.setHeadlessAgentRunner(async (input, callbacks) => {
    callbacksBySession.set(input.sessionId, callbacks); callbacks.onRuntimeStarted?.()
    if (input.userMessage.includes('角色=reviewer')) return
    try {
      const transport = Object.assign(async () => new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } }), { headers: { 'content-type': 'application/json' } }), { preconnect: () => {} }) as typeof globalThis.fetch
      const fetch = boundary.createControlledProviderFetch(input.sessionId, () => ({ runtime: 'ai-sdk', cwd: getAgentWorkspaceCwd(f.workspace, input.sessionId), modelId: input.modelId!, permissionMode: 'safe' }), transport)
      await fetch('https://example.invalid/chat/completions', { method: 'POST', body: JSON.stringify({ model: input.modelId, max_tokens: 100, messages: [{ role: 'user', content: 'fake' }] }) })
      callbacks.onComplete([{ id: randomUUID(), role: 'assistant', content: '合成材料', createdAt: Date.now() }])
    } finally { done() }
  })
  const deps = { ...a.dependencies, schedule: (projectId: string) => scheduler.runOwnerAutonomousSchedule(projectId).then(() => {}) }
  await launchOwnerPreparedExecution(f.request, deps); await executorFinished
  await launchOwnerPreparedExecution(f.request, deps)
  const review = store.listAgentExecutionsByProject(f.project.id).find(item => item.agentId === f.reviewer.id)!
  expect(review.status).toBe('running')
  store.closeProjectDb(); await store.initProjectDb()
  expect(stop.recoverInterruptedOwnerRuntimeExecutions(Date.now(), review.id)).toMatchObject([{ state: 'unknown_recorded' }])
  const command = store.getProjectDb().prepare('SELECT state,actual_cost_micros,reserved_cost_micros,usage_evidence FROM project_owner_execution_commands WHERE execution_id=?').get(review.id) as { state: string; actual_cost_micros: number | null; reserved_cost_micros: number; usage_evidence: string }
  expect(command.state).toBe('needs_reconcile'); expect(command.actual_cost_micros).toBeNull(); expect(command.reserved_cost_micros).toBeGreaterThan(0)
  expect(JSON.parse(command.usage_evidence)).toMatchObject({ source: 'unknown', modelId: 'deepseek-flash', channelId: f.reviewerChannel.id })
  callbacksBySession.get(review.sessionId!)!.onComplete([{ id: randomUUID(), role: 'assistant', content: '迟到的合成评审', createdAt: Date.now() }])
  expect(store.getAgentExecution(review.id)?.status).toBe('stale')
  expect(store.getProjectDb().prepare('SELECT usage_evidence FROM project_owner_execution_commands WHERE execution_id=?').get(review.id)).toEqual({ usage_evidence: command.usage_evidence })
})

/** 完整真实服务链，模型和传输为替身；正文故意长于旧回报/评审摘要上限。 */
async function textDeliveryRun(options: { rework?: boolean; oversized?: boolean; truncated?: boolean; holdReviewer?: boolean; profile?: 'general' | 'development'; runtime?: 'ai-sdk' | 'pi'; employeeQuestion?: (sessionId: string, projectId: string) => Promise<void> } = {}) {
  const profile = options.profile ?? 'general', runtime = options.runtime ?? 'ai-sdk'
  const f = fixture(profile, 'auto', runtime === 'ai-sdk', true, runtime), a = adapters()
  const scheduler = await import('./project-owner-autonomous-scheduler'), registry = await import('./agent-headless-runner-registry')
  const boundary = await import('./controlled-provider-boundary'), artifacts = await import('./project-owner-text-delivery')
  const { getAgentWorkspaceCwd } = await import('./agent-workspace-manager')
  const calls: Array<{ role: 'executor' | 'reviewer'; ordinal: number; content: string; artifactHash?: string }> = []
  const runtimeCalls: Array<{ role: 'executor' | 'reviewer'; agentRuntime?: string; permissionModeOverride?: string; userMessage: string }> = []
  const completed: Promise<void>[] = [], pendingReviews: Array<() => void> = []
  registry.setHeadlessAgentRunner(async (input, callbacks) => {
    let resolve!: () => void
    completed.push(new Promise<void>(done => { resolve = done }))
    const execution = store.getAgentExecutionBySessionId(input.sessionId)!
    const command = store.getProjectDb().prepare('SELECT role,rework_ordinal FROM project_owner_execution_commands WHERE id=?').get(execution.ownerCommandId!) as { role: 'executor' | 'reviewer'; rework_ordinal: number }
    runtimeCalls.push({ role: command.role, agentRuntime: input.agentRuntime, permissionModeOverride: input.permissionModeOverride, userMessage: input.userMessage })
    callbacks.onRuntimeStarted?.()
    try {
      const artifact = command.role === 'reviewer' ? artifacts.assertOwnerReviewerTextDelivery(execution.ownerCommandId!) : null
      if (artifact) {
        expect(input.userMessage).toContain(artifact.contentSha256)
        expect(input.userMessage).toContain('超出摘要位置的明确范围依据')
      }
      if (command.role === 'executor' && command.rework_ordinal > 0) {
        expect(input.userMessage).toContain('补齐范围依据')
        expect(input.userMessage).toContain('超出摘要位置的明确范围依据')
      }
      if (runtime === 'pi') {
        expect(input.agentRuntime).toBe('pi')
        expect(input.permissionModeOverride).toBe('safe')
        expect(input.userMessage).not.toContain('本次执行基线：')
      }
      const transport = Object.assign(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (artifact) expect(String(init?.body)).toContain('超出摘要位置的明确范围依据')
        return new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } }), { headers: { 'content-type': 'application/json' } })
      }, { preconnect: () => {} }) as typeof globalThis.fetch
      const fetcher = boundary.createControlledProviderFetch(input.sessionId, () => ({ runtime, cwd: getAgentWorkspaceCwd(f.workspace, input.sessionId), modelId: input.modelId!, permissionMode: 'safe' }), transport)
      const channel = getChannelById(input.channelId)!
      await fetcher(`${channel.baseUrl!.replace(/\/+$/, '')}/chat/completions`, { method: 'POST', body: JSON.stringify({ model: input.modelId, max_tokens: runtime === 'pi' ? 4096 : 100, messages: [{ role: 'user', content: input.userMessage }] }) })
      if (command.role === 'executor' && options.employeeQuestion) await options.employeeQuestion(input.sessionId, f.project.id)
      const changes = options.rework && command.rework_ordinal === 0
      const content = command.role === 'executor' ? `${'A'.repeat(options.oversized ? artifacts.OWNER_TEXT_DELIVERY_MAX_BYTES : 24000)}\n超出摘要位置的明确范围依据：${command.rework_ordinal ? '修订版' : '首版'}。`
        : JSON.stringify({ schemaVersion: 2, artifactHash: artifact!.contentSha256, verdict: changes ? 'changes_requested' : 'approved', summary: changes ? '需补齐范围依据' : '全文检查的合成评审', criteria: [{ criterion: '范围', status: changes ? 'not_met' : 'met', evidence: changes ? '范围依据不充分' : '引用正文范围依据', quote: changes ? null : '超出摘要位置的明确范围依据' }], findings: changes ? [{ severity: 'medium', description: '范围论据不够', requestedChange: '补齐范围依据并交付完整修订正文' }] : [], blockerReason: null })
      calls.push({ role: command.role, ordinal: command.rework_ordinal, content, ...(artifact ? { artifactHash: artifact.contentSha256 } : {}) })
      const finish = () => callbacks.onComplete([{ id: randomUUID(), role: 'assistant', content, createdAt: Date.now() }], options.truncated ? { runtimeResult: { type: 'result', subtype: 'error_during_execution', finish_reason: 'length' } as unknown as import('@gravitas/shared').SDKResultMessage } : undefined)
      if (command.role === 'reviewer' && options.holdReviewer) pendingReviews.push(finish)
      else finish()
    } catch (cause) { callbacks.onError(String(cause)) }
    finally { resolve() }
  })
  const dependencies = { ...a.dependencies, schedule: async (id: string) => { await scheduler.runOwnerAutonomousSchedule(id) } }
  const grant = await launchOwnerPreparedExecution(f.request, dependencies)
  await completed[0]
  const advance = async () => { const count = completed.length; await scheduler.runOwnerAutonomousSchedule(f.project.id); if (completed.length > count) await completed.at(-1) }
  return { f, grant, calls, runtimeCalls, pendingReviews, advance, artifacts, scheduler }
}

test('Given已结算用量但正文截断 When终态包含早期过程文字 Then执行失败且不冻结成果或启动Reviewer', async () => {
  const r = await textDeliveryRun({ truncated: true })
  const commands = (await import('./project-owner-execution-command')).listOwnerExecutionCommands(r.f.subject)
  expect(commands).toHaveLength(1)
  expect(commands[0]?.state).toBe('settled')
  expect(r.artifacts.readOwnerTextDelivery(commands[0]!.commandId)).toBeNull()
  expect(store.listAgentExecutionsByEntity('task', commands[0]!.taskId)[0]).toMatchObject({ status: 'failed' })
  await r.advance()
  expect(r.calls.map(item => item.role)).toEqual(['executor'])
})

test('GivenPi研发员工与有效执行许可 WhenOwner自动派工并独立评审 Then仅以controlled/safe任务运行且不改员工档案', async () => {
  const r = await textDeliveryRun({ profile: 'development', runtime: 'pi' })
  await r.advance()
  expect(r.calls.map(item => item.role)).toEqual(['executor', 'reviewer'])
  expect(r.runtimeCalls.map(item => [item.role, item.agentRuntime, item.permissionModeOverride])).toEqual([['executor', 'pi', 'safe'], ['reviewer', 'pi', 'safe']])
  expect(r.runtimeCalls.every(item => !item.userMessage.includes('本次执行基线：'))).toBe(true)
  const commands = store.getProjectDb().prepare('SELECT role,state,usage_evidence FROM project_owner_execution_commands WHERE grant_id=? ORDER BY created_at').all(r.grant.grantId) as Array<{ role: string; state: string; usage_evidence: string }>
  expect(commands).toHaveLength(2)
  expect(commands.map(item => [item.role, item.state, JSON.parse(item.usage_evidence).source])).toEqual([['executor', 'settled', 'request_settled'], ['reviewer', 'settled', 'request_settled']])
  expect(r.f.preparation.source.employeeInvocations).toEqual(expect.arrayContaining([
    expect.objectContaining({ employeeId: r.f.executor.id, originalProfile: 'development', executionProfile: 'controlled', permissionMode: 'safe' }),
    expect.objectContaining({ employeeId: r.f.reviewer.id, originalProfile: 'development', executionProfile: 'controlled', permissionMode: 'safe' }),
  ]))
  expect(store.getAgentEmployee(r.f.executor.id)).toMatchObject({ executionProfile: 'development', permissionMode: 'auto' })
  expect(store.getAgentEmployee(r.f.reviewer.id)).toMatchObject({ executionProfile: 'development', permissionMode: 'auto' })
})

test('Given完整文本交付 When执行与不同模型的独立评审 Then准确正文超出摘要仍完整可读、绑定哈希且重开保持', async () => {
  const r = await textDeliveryRun()
  expect(r.grant.textDeliveryVersion).toBe(1)
  await r.advance()
  expect(r.calls.map(item => item.role)).toEqual(['executor', 'reviewer'])
  const commandApi = await import('./project-owner-execution-command'), reviews = await import('./project-owner-technical-review')
  const commands = commandApi.listOwnerExecutionCommands(r.f.subject), executor = commands.find(item => item.role === 'executor')!
  const reviewer = commands.find(item => item.role === 'reviewer')!
  expect(store.getAgentExecution(reviewer.executionId!)!.prompt).toContain('quote只需锚定一处准确原文')
  expect(store.getAgentExecution(reviewer.executionId!)!.prompt).toContain('否则不能作为quote')
  expect(executor.textDelivery?.state).toBe('available')
  expect(executor.textDelivery?.artifact?.content).toBe(r.calls[0]!.content)
  expect(executor.executionResultSummary).not.toContain('超出摘要位置的明确范围依据')
  expect(executor.textDelivery!.artifact!.byteLength).toBeGreaterThan(20000)
  expect(reviews.listOwnerTechnicalReviewEvidence(r.f.project.id)[0]).toMatchObject({ schemaVersion: 2, artifactHash: executor.textDelivery!.artifact!.contentSha256, artifactVerified: true })
  store.closeProjectDb(); await store.initProjectDb()
  expect(r.artifacts.readOwnerTextDelivery(executor.commandId, true)?.content).toBe(r.calls[0]!.content)
  expect(store.getTask(executor.taskId)?.status).toBe('paused')
  expect(() => store.getProjectDb().prepare('UPDATE project_owner_execution_commands SET text_delivery_hash=? WHERE id=?').run('0'.repeat(64), executor.commandId)).toThrow('immutable')
})

test('Given全文评审要求返工 When额度内自动续派 Then保留两份准确正文与两轮独立评审，新轮不能沿用旧成果哈希', async () => {
  const r = await textDeliveryRun({ rework: true })
  await r.advance(); await r.advance(); await r.advance()
  expect(r.calls.map(item => [item.role, item.ordinal])).toEqual([['executor', 0], ['reviewer', 0], ['executor', 1], ['reviewer', 1]])
  const commandApi = await import('./project-owner-execution-command'), reviews = await import('./project-owner-technical-review')
  const commands = commandApi.listOwnerExecutionCommands(r.f.subject), executors = commands.filter(item => item.role === 'executor')
  expect(executors).toHaveLength(2)
  expect(new Set(executors.map(item => item.textDelivery!.artifact!.contentSha256)).size).toBe(2)
  const values = reviews.listOwnerTechnicalReviewEvidence(r.f.project.id)
  expect(values.map(item => item.verdict)).toEqual(['changes_requested', 'approved'])
  expect(values.every(item => item.artifactVerified)).toBe(true)
  await r.advance()
  expect(r.calls).toHaveLength(4)
})

test('Given成果已捕获 When本机文件改动或重算自摘要 Then不以新内容替代冻结成果、费用保留且不启动评审', async () => {
  const r = await textDeliveryRun(), api = await import('./project-owner-execution-command'), fs = await import('node:fs')
  const command = api.listOwnerExecutionCommands(r.f.subject).find(item => item.role === 'executor')!
  const path = r.artifacts.ownerTextDeliveryFile(r.f.project.id, command.executionId!)!, original = fs.readFileSync(path, 'utf8')
  const value = JSON.parse(original) as import('@gravitas/shared').OwnerTextDelivery
  value.content = '伪造的新正文'; value.byteLength = Buffer.byteLength(value.content); value.contentSha256 = (await import('node:crypto')).createHash('sha256').update(value.content).digest('hex')
  const { integrityHash: _hash, ...body } = value; value.integrityHash = (await import('./project-owner-execution-hash')).ownerExecutionHash(body)
  fs.writeFileSync(path, JSON.stringify(value))
  expect(() => r.artifacts.readOwnerTextDelivery(command.commandId)).toThrow('冻结正文摘要')
  await r.advance()
  expect(r.calls).toHaveLength(1)
  expect(api.listOwnerExecutionCommands(r.f.subject).find(item => item.role === 'executor')!.textDelivery?.state).toBe('unavailable')
  expect(store.getProjectDb().prepare('SELECT state,actual_cost_micros FROM project_owner_execution_commands WHERE id=?').get(command.commandId)).toEqual({ state: 'settled', actual_cost_micros: 2 })
  fs.writeFileSync(path, original)
})

test('Given完整成果超出审阅上限 When终态捕获 Then明确失败不截断评审、不自动重试、已花费用仍结算', async () => {
  const r = await textDeliveryRun({ oversized: true }), execution = store.listAgentExecutionsByProject(r.f.project.id).find(item => item.ownerCommandId)!
  expect(execution.status).toBe('failed')
  expect(execution.error).toContain('64KiB')
  await r.advance()
  expect(r.calls).toHaveLength(1)
  expect(r.artifacts.readOwnerTextDelivery(execution.ownerCommandId!)).toBeNull()
})

test('GivenReviewer已读取固定成果 When回包前成果被替换 Then旧回执不追认新内容，不落有效评审', async () => {
  const r = await textDeliveryRun({ holdReviewer: true }), api = await import('./project-owner-execution-command'), fs = await import('node:fs')
  await r.advance()
  expect(r.pendingReviews).toHaveLength(1)
  const executor = api.listOwnerExecutionCommands(r.f.subject).find(item => item.role === 'executor')!
  const path = r.artifacts.ownerTextDeliveryFile(r.f.project.id, executor.executionId!)!, original = fs.readFileSync(path, 'utf8')
  fs.writeFileSync(path, '{}')
  r.pendingReviews[0]!()
  expect((await import('./project-owner-technical-review')).listOwnerTechnicalReviewEvidence(r.f.project.id)).toHaveLength(0)
  await r.advance()
  expect(r.calls).toHaveLength(2)
  fs.writeFileSync(path, original)
})


test('Given有效全文评审已保存 When成果丢失 Then评审历史仍可查看但失效，不继续自动推进', async () => {
  const r = await textDeliveryRun(); await r.advance()
  const api = await import('./project-owner-execution-command'), fs = await import('node:fs'), reviews = await import('./project-owner-technical-review')
  const executor = api.listOwnerExecutionCommands(r.f.subject).find(item => item.role === 'executor')!
  const path = r.artifacts.ownerTextDeliveryFile(r.f.project.id, executor.executionId!)!, original = fs.readFileSync(path, 'utf8')
  fs.unlinkSync(path)
  expect(reviews.listOwnerTechnicalReviewEvidence(r.f.project.id)[0]).toMatchObject({ verdict: 'approved', artifactVerified: false })
  expect(api.listOwnerExecutionCommands(r.f.subject).find(item => item.role === 'executor')!.textDelivery?.state).toBe('unavailable')
  expect(r.scheduler.getOwnerAutonomousScheduleStatus(r.f.project.id).state).toBe('stale')
  fs.writeFileSync(path, original)
})

test.skipIf(process.platform === 'win32')('Given成果文件被替换为符号链接 When读取/评审 Then拒绝跟随，不读取目标内容', async () => {
  const r = await textDeliveryRun(), fs = await import('node:fs'), api = await import('./project-owner-execution-command')
  const executor = api.listOwnerExecutionCommands(r.f.subject).find(item => item.role === 'executor')!
  const path = r.artifacts.ownerTextDeliveryFile(r.f.project.id, executor.executionId!)!, original = fs.readFileSync(path, 'utf8'), target = join(directory, randomUUID())
  fs.writeFileSync(target, '不得读取的目标内容'); fs.unlinkSync(path); fs.symlinkSync(target, path)
  expect(() => r.artifacts.readOwnerTextDelivery(executor.commandId)).toThrow('符号链接')
  await r.advance(); expect(r.calls).toHaveLength(1)
  expect(fs.readFileSync(target, 'utf8')).toBe('不得读取的目标内容')
  fs.unlinkSync(path); fs.writeFileSync(path, original)
})


test('Given准确全文及独立评审 WhenOwner读取Reviewer观察 Then收到同一正文及逐项引用而非摘要', async () => {
  const r = await textDeliveryRun(); await r.advance()
  const commands = (await import('./project-owner-execution-command')).listOwnerExecutionCommands(r.f.subject)
  const review = commands.find(item => item.role === 'reviewer')!
  const observed = (await import('./project-owner-management-execution')).readOwnerExecutionObservation(r.f.project.id, review.executionId!, 'terminal')
  const delivery = (await import('./project-owner-management-delivery')).readOwnerManagementDelivery(r.f.project.id, observed.observation)
  expect(delivery.state).toBe('available')
  expect(delivery.artifact!.content.length).toBeGreaterThan(20000)
  expect(delivery.review!.artifactHash).toBe(delivery.artifact!.contentSha256)
  expect(delivery.review!.reviewerCommandId).toBe(review.commandId)
  expect(delivery.review!.criteria.every(item => item.quote && delivery.artifact!.content.includes(item.quote))).toBe(true)
  const observations = await import('./project-owner-management-execution')
  observations.scanOwnerExecutionObservations(r.f.project.id)
  const message = store.getProjectDb().prepare("SELECT id FROM project_owner_management_messages WHERE project_id=? AND json_extract(payload,'$.executionObservation.executionId')=? ORDER BY rowid DESC LIMIT 1").get(r.f.project.id, review.executionId!) as { id: string }
  const context = (await import('./project-owner-management-conversation')).withOwnerConversationContext((await import('./project-owner-plan-service')).getProjectOwnerPlanningContext(r.f.project.id), message.id, undefined, 1, 1)
  const request = (await import('./project-owner-planning-protocol')).buildProjectOwnerPlanningRequest(context)
  expect(JSON.parse(request.userPrompt).conversation.deliveryReview).toEqual(delivery)
  expect(request.systemPrompt).toContain('不声称已经验收')

})

test('Given项目资料已索引但应用重开句柄为空 When自主启动员工 Then在claim前打开索引并通过资料门禁', async () => {
  const f = fixture('controlled', 'safe', false, true, 'ai-sdk', true), a = adapters()
  const index = await import('./knowledge-index-service')
  expect((await index.indexSource({ sourceId: f.knowledgeSourceIds[0]!, sourceType: 'vault' })).ok).toBe(true)
  expect((await index.indexSource({ sourceId: f.extraKnowledgeSourceId!, sourceType: 'vault' })).ok).toBe(true)
  await launchOwnerPreparedExecution(f.request, a.dependencies)
  await index.closeKnowledgeIndexStore()
  expect(index.getStoreHandle()).toBeNull()
  const scheduler = await import('./project-owner-autonomous-scheduler')
  const registry = await import('./agent-headless-runner-registry')
  const gates = await import('./project-owner-execution-gates')
  let invoked = 0
  registry.setHeadlessAgentRunner(async (input, callbacks) => {
    invoked++
    expect(index.getStoreHandle()).not.toBeNull()
    expect(getAgentSessionMeta(input.sessionId)).toMatchObject({ knowledgeScopeMode: 'explicit', explicitKnowledgeBaseIds: expect.arrayContaining([expect.any(String)]) })
    expect(gates.resolveOwnerExecutionGateSession(input.sessionId).kind).toBe('owner_business')
    expect(() => gates.assertToolAllowedForSessionPurpose(input.sessionId, 'SearchKnowledge', { query: '原文证据' })).not.toThrow()
    const knowledge = await import('./agent-runtime/tool-impls/knowledge-tool')
    const search = await knowledge.executeSearchKnowledgeTool({ query: '原文证据' }, { cwd: directory, sessionId: input.sessionId })
    expect(search.isError).toBeFalsy()
    expect(search.content).toContain('冻结项目资料')
    expect(search.content).not.toContain('未冻结资料')
    const countReads = () => (store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_owner_execution_knowledge_reads WHERE session_id = ?').get(input.sessionId) as { n: number }).n
    const beforeReads = countReads()
    const allowedId = /documentId: (\S+)/.exec(search.content)![1]!
    const allowedRead = await knowledge.executeReadKnowledgeSourceTool({ documentId: allowedId }, { cwd: directory, sessionId: input.sessionId })
    expect(allowedRead.content).toContain('冻结项目资料')
    expect(countReads()).toBe(beforeReads + 1)
    const extraDocument = index.getStoreHandle()!.knowledge.listDocumentsBySource(f.extraKnowledgeSourceId!)[0]!
    const denied = await knowledge.executeReadKnowledgeSourceTool({ documentId: extraDocument.id }, { cwd: directory, sessionId: input.sessionId })
    expect(denied.isError).toBe(true)
    expect(denied.content).not.toContain('未冻结资料')
    expect(countReads()).toBe(beforeReads + 1)
    callbacks.onError('隔离Runtime替身结束；未发送Provider请求')
  })
  await scheduler.runOwnerAutonomousSchedule(f.project.id)
  expect(invoked).toBe(1)
  await index.closeKnowledgeIndexStore()
})


test('Given运行中员工问题无人答复 When超过等待期限 Then原Promise被拒绝且只登记一次失联', async () => {
  let outcome = ''
  await textDeliveryRun({ employeeQuestion: async (sessionId, projectId) => {
    const { askUserService } = await import('./agent-ask-user-service')
    const interactions = await import('./project-owner-employee-interactions')
    const messages = await import('./project-owner-management-store')
    const management = await import('./project-owner-management-loop')
    const signal = new AbortController()
    const result = askUserService.handleAskUserQuestion(sessionId, { questions: [{ question: '材料采用何种标题？', options: [{ label: '研究材料' }] }] }, signal.signal, () => {})
    try {
      const interaction = interactions.listOwnerEmployeeInteractions(projectId)[0]!
      expect(interaction.state).toBe('pending_owner')
      expect(askUserService.hasOwnerPendingRequest(interaction.requestId, sessionId)).toBe(true)
      expect(interactions.expireOwnerEmployeeInteractions(projectId, interaction.expiresAt! - 1)).toBe(0)
      management.reconcileOwnerManagement(projectId)
      expect(interactions.getOwnerEmployeeInteraction(projectId, interaction.id)?.state).toBe('pending_owner')
      expect(interactions.expireOwnerEmployeeInteractions(projectId, interaction.expiresAt!)).toBe(1)
      management.reconcileOwnerManagement(projectId)
      management.reconcileOwnerManagement(projectId)
      expect(interactions.getOwnerEmployeeInteraction(projectId, interaction.id)?.state).toBe('stale')
      expect(askUserService.hasOwnerPendingRequest(interaction.requestId, sessionId)).toBe(false)
      expect(messages.getOwnerManagementView(projectId).messages.filter(item => item.content.includes('原提问已失效'))).toHaveLength(1)
      const delivered = await result
      outcome = delivered.behavior
      expect(delivered.behavior).toBe('deny')
      expect(() => interactions.deliverOwnerEmployeeDecision({ projectId, sourceMessageId: 'late', decision: { interactionId: interaction.id, interactionRevision: interaction.revision, action: 'answer', answers: { '材料采用何种标题？': '研究材料' }, reason: '迟到决定' } })).toThrow()
    } finally { signal.abort() }
  } })
  expect(outcome).toBe('deny')
})

test('Given运行中员工问题 WhenOwner在同一对话定案 Then仅原Promise恢复且冻结来源不漂移', async () => {
  let answered = false
  await textDeliveryRun({ employeeQuestion: async (sessionId, projectId) => {
    const { askUserService } = await import('./agent-ask-user-service')
    const interactions = await import('./project-owner-employee-interactions')
    const messages = await import('./project-owner-management-store')
    const { withOwnerConversationContext } = await import('./project-owner-management-conversation')
    const signal = new AbortController()
    let rendererRequests = 0
    const result = askUserService.handleAskUserQuestion(sessionId, { questions: [{ question: '材料采用何种标题？', options: [{ label: '研究材料' }] }] }, signal.signal, () => { rendererRequests++ })
    try {
      const interaction = interactions.listOwnerEmployeeInteractions(projectId)[0]!
      expect(interaction.state).toBe('pending_owner')
      expect(rendererRequests).toBe(0)
      expect(askUserService.getPendingRequests().some(item => item.sessionId === sessionId)).toBe(false)
      expect(askUserService.respondToAskUser(interaction.requestId, { '材料采用何种标题？': '错误旁路' })).toBeNull()
      const message = messages.getOwnerManagementView(projectId).messages.find(item => item.employeeInteraction?.id === interaction.id)!
      expect(message.role).toBe('assistant')
      const context = plans.getProjectOwnerPlanningContext(projectId)
      const frozen = withOwnerConversationContext(context, message.id, undefined, 2, 0, 1, 1)
      expect(frozen.conversation!.employeeInteractions).toHaveLength(1)
      expect(() => interactions.deliverOwnerEmployeeDecision({ projectId: 'other', sourceMessageId: 'receipt', decision: { interactionId: interaction.id, interactionRevision: 1, action: 'answer', answers: { '材料采用何种标题？': '研究材料' }, reason: '沿用已确认研究主题' } })).toThrow()
      let decision = { interactionId: interaction.id, interactionRevision: 1, action: 'answer' as const, answers: { '材料采用何种标题？': '研究材料' }, reason: '沿用已确认研究主题' }
      expect(() => interactions.deliverOwnerEmployeeDecision({ projectId, sourceMessageId: 'receipt', decision: { ...decision, answers: { wrong: '研究材料' } } })).toThrow('全部问题')
      store.getProjectDb().transaction(() => {
        expect(() => interactions.deliverOwnerEmployeeDecision({ projectId, sourceMessageId: 'receipt', decision })).toThrow('外层事务')
      })()
      // 经过真实Run回执、管理结果事件和管理循环，而不直接调用投递入口。
      const runtimeBinding = await import('./project-owner-runtime-binding')
      const sources = await import('./project-owner-planning-source')
      const runs = await import('./project-owner-planning-run-service')
      const providers = await import('./project-owner-planning-provider')
      const binding = runtimeBinding.getOwnerRuntimeBinding(projectId)!
      // 先经Owner普通回复讨论；不解决员工Promise，也不修改正式目标。
      const discussionLink = runtimeBinding.prepareOwnerPlanning(projectId, { requestId: randomUUID(), conversationMessageId: message.id, expectedBindingRevision: binding.revision, expectedGoalRevision: context.goal.revision, expectedPlanRevision: plans.getProjectOwnerPlanDraft(projectId)!.revision, expectedContextFingerprint: context.fingerprint })
      const discussionSnapshot = sources.readOwnerPlanningSnapshot(discussionLink.planningTaskId)!
      const discussionExecution = randomUUID(), discussionSession = randomUUID()
      store.createAgentExecution({ id: discussionExecution, projectId, entityType: 'task', entityId: discussionLink.planningTaskId, agentId: binding.carrierId, sessionId: discussionSession, status: 'running', prompt: '隔离讨论回执夹具' })
      store.getProjectDb().prepare('UPDATE controlled_task_preparations SET execution_id=? WHERE task_id=?').run(discussionExecution, discussionLink.planningTaskId)
      store.getProjectDb().prepare('INSERT INTO project_owner_planning_admissions(link_id,execution_id,session_id,request_hash,source_snapshot,admitted_at) VALUES(?,?,?,?,?,?)').run(discussionLink.id, discussionExecution, discussionSession, 'b'.repeat(64), JSON.stringify(discussionSnapshot.context), Date.now())
      const discussionAdmission = store.getProjectDb().prepare('SELECT * FROM project_owner_planning_admissions WHERE execution_id=?').get(discussionExecution) as import('./project-owner-planning-provider').OwnerPlanningAdmission
      store.getProjectDb().prepare('UPDATE project_owner_planning_admissions SET integrity_hash=? WHERE execution_id=?').run(providers.ownerPlanningAdmissionHash(discussionAdmission), discussionExecution)
      const discussionOutcome = runs.recordOwnerPlanningRun(discussionExecution, 'ai-sdk', { type: 'result', subtype: 'success', session_id: discussionSession, finish_reason: 'stop', result: JSON.stringify({ schemaVersion: 1, kind: 'conversation_reply', projectId, goalVersion: discussionSnapshot.context.goal.goal.goalVersion, contextFingerprint: discussionSnapshot.context.fingerprint, messageId: message.id, message: '建议沿用研究主题，请补充标题侧重点。' }), usage: { input_tokens: 2, output_tokens: 3 } })!
      expect(discussionOutcome.state).toBe('replied')
      management.reconcileOwnerManagement(projectId)
      const discussed = interactions.getOwnerEmployeeInteraction(projectId, interaction.id)!
      expect(discussed.state).toBe('discussing_user')
      expect(askUserService.hasOwnerPendingRequest(interaction.requestId, sessionId)).toBe(true)
      expect(plans.getProjectOwnerPlanningContext(projectId).goal.revision).toBe(context.goal.revision)
      expect(() => interactions.deliverOwnerEmployeeDecision({ projectId, sourceMessageId: 'old-decision', decision })).toThrow('已变化')
      decision = { ...decision, interactionRevision: discussed.revision }
      const link = runtimeBinding.prepareOwnerPlanning(projectId, { requestId: randomUUID(), conversationMessageId: message.id, expectedBindingRevision: binding.revision, expectedGoalRevision: context.goal.revision, expectedPlanRevision: plans.getProjectOwnerPlanDraft(projectId)!.revision, expectedContextFingerprint: context.fingerprint })
      const snapshot = sources.readOwnerPlanningSnapshot(link.planningTaskId)!
      const ownerSession = randomUUID(), ownerExecution = randomUUID()
      store.createAgentExecution({ id: ownerExecution, projectId, entityType: 'task', entityId: link.planningTaskId, agentId: binding.carrierId, sessionId: ownerSession, status: 'running', prompt: '隔离Owner回执夹具，未调用Provider' })
      store.getProjectDb().prepare('UPDATE controlled_task_preparations SET execution_id=? WHERE task_id=?').run(ownerExecution, link.planningTaskId)
      store.getProjectDb().prepare('INSERT INTO project_owner_planning_admissions(link_id,execution_id,session_id,request_hash,source_snapshot,admitted_at) VALUES(?,?,?,?,?,?)').run(link.id, ownerExecution, ownerSession, 'a'.repeat(64), JSON.stringify(snapshot.context), Date.now())
      const admission = store.getProjectDb().prepare('SELECT * FROM project_owner_planning_admissions WHERE execution_id=?').get(ownerExecution) as import('./project-owner-planning-provider').OwnerPlanningAdmission
      store.getProjectDb().prepare('UPDATE project_owner_planning_admissions SET integrity_hash=? WHERE execution_id=?').run(providers.ownerPlanningAdmissionHash(admission), ownerExecution)
      const outcome = runs.recordOwnerPlanningRun(ownerExecution, 'ai-sdk', { type: 'result', subtype: 'success', session_id: ownerSession, finish_reason: 'stop', result: JSON.stringify({ schemaVersion: 1, kind: 'employee_decision', projectId, goalVersion: snapshot.context.goal.goal.goalVersion, contextFingerprint: snapshot.context.fingerprint, messageId: message.id, message: '采用原研究材料标题。', decision }), usage: { input_tokens: 2, output_tokens: 3 } })!
      expect(outcome.state).toBe('replied')
      management.reconcileOwnerManagement(projectId)
      expect(interactions.getOwnerEmployeeInteraction(projectId, interaction.id)?.state).toBe('resolved')
      expect(messages.getOwnerManagementView(projectId).messages.some(item => item.content.includes('决定已回传原员工请求'))).toBe(true)
      management.reconcileOwnerManagement(projectId)
      expect(messages.getOwnerManagementView(projectId).messages.filter(item => item.content.includes('决定已回传原员工请求'))).toHaveLength(1)
      expect(await result).toMatchObject({ behavior: 'allow', updatedInput: { answers: decision.answers } })
      expect(() => interactions.deliverOwnerEmployeeDecision({ projectId, sourceMessageId: 'receipt', decision })).toThrow('已变化')
      expect(withOwnerConversationContext(context, message.id, frozen.conversation!.historyThroughMessageId, 2, 0, 1, 1, frozen.conversation!.employeeInteractions)).toEqual(frozen)
      answered = true
    } finally { signal.abort() }
  } })
  expect(answered).toBe(true)
})
