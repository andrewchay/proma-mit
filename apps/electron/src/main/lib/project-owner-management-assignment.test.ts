import { afterAll, beforeAll, expect, mock, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_IPC_CHANNELS } from '@gravitas/shared'
import type { OwnerExecutionPreparationInput, ProjectOwnerExecutionLaunchApi } from '@gravitas/shared'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-managed-assignment-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
mock.module('electron', () => buildElectronMock())
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel } = await import('./channel-manager')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const { saveProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
const plans = await import('./project-owner-plan-service')
const { getOwnerRuntimeBinding, saveOwnerRuntimeBinding } = await import('./project-owner-runtime-binding')
const { ensureOwnerDefaultTeam } = await import('./project-owner-default-team')
const { resolveOwnerPlanningSession } = await import('./project-owner-planning-source')
const { claimOwnerPlanningProviderRequest } = await import('./project-owner-planning-provider')
const { getOwnerManagementConversation } = await import('./project-owner-management-questions')
const { reconcileOwnerManagement, startOwnerManagementLoop } = await import('./project-owner-management-loop')
const { appendOwnerManagementTrace, consumeOwnerManagementEvent, getOwnerManager, getOwnerManagementView, listPendingOwnerManagementEvents, setOwnerManagerStatus } = await import('./project-owner-management-store')
const { onOwnerManagementChanged } = await import('./project-owner-management-events')
const delegation = await import('./project-owner-management-delegation')
const ipcHandlers = new Map<string, (event: unknown, request: unknown) => unknown>()
const { setHeadlessAgentRunner } = await import('./agent-headless-runner-registry')
const { listOwnerExecutionAssignmentRuns } = await import('./project-owner-execution-assignment-service')
const teamAccess = await import('./project-owner-team-workspace-access')
const calls: Array<{ projectId: string; purpose: string; candidates: string[]; executionKinds?: string[]; employeeModes?: Array<{ id: string; executionProfile: string; ownerControlledCompatible?: boolean }> }> = []
let rejectNextAssignmentProjectId: string | null = null
let legacyNullScopeProjectId: string | null = null
let rejectNextAssignmentKind: 'reviewer' | 'coverage' = 'reviewer'
let nextOwnerPlanningResponseGate: { started(): void; wait: Promise<void> } | null = null
beforeAll(async () => {
  await store.initProjectDb()
  // 排队、来源与最终单发送准入使用产品实现；runner/HTTP和模型回答是隔离替身。
  setHeadlessAgentRunner(async (input, handlers) => {
    const execution = store.getAgentExecutionBySessionId(input.sessionId)
    if (execution?.ownerCommandId) {
      handlers.onRuntimeStarted?.()
      const command = store.getProjectDb().prepare('SELECT role FROM project_owner_execution_commands WHERE id=?').get(execution.ownerCommandId) as { role: string }
      const task = store.getTask(execution.entityId)!
      const workspaceManager = await import('./agent-workspace-manager')
      const workspace = workspaceManager.getAgentWorkspace(task.workspaceId!)!
      const transport = Object.assign(async () => new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } }), { headers: { 'content-type': 'application/json' } }), { preconnect: () => {} }) as typeof globalThis.fetch
      const boundary = await import('./controlled-provider-boundary')
      const fetch = boundary.createControlledProviderFetch(input.sessionId, () => ({ runtime: 'ai-sdk', cwd: workspaceManager.getAgentWorkspaceCwd(workspace, input.sessionId), modelId: input.modelId!, permissionMode: 'safe' }), transport)
      await fetch('https://example.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: input.modelId, max_tokens: 100, messages: [{ role: 'user', content: input.userMessage }] }) })
      let content = '已整理目标范围、证据和取舍，并标明仍需业务核验的不确定项。'
      if (command.role === 'reviewer') {
        const textDelivery = await import('./project-owner-text-delivery')
        const artifact = textDelivery.assertOwnerReviewerTextDelivery(execution.ownerCommandId)!
        const link = store.getProjectDb().prepare('SELECT payload FROM project_owner_task_step_links WHERE task_id=?').get(execution.entityId) as { payload: string }
        const acceptance = (JSON.parse(link.payload) as { projection: { acceptanceCriteria: string[] } }).projection.acceptanceCriteria[0]!
        content = JSON.stringify({ schemaVersion: 2, artifactHash: artifact.contentSha256, verdict: 'approved', summary: '完整成果符合当前范围', criteria: [{ criterion: acceptance, status: 'met', evidence: '完整文本成果含有可核对依据', quote: artifact.content }], findings: [], blockerReason: null })
      }
      const message = { id: randomUUID(), role: 'assistant' as const, content, createdAt: Date.now() }
      ;(await import('./agent-session-manager')).appendAgentMessage(input.sessionId, message)
      handlers.onComplete([message])
      return
    }
    const source = resolveOwnerPlanningSession(input.sessionId)!
    const conversation = source.context.conversation
    const delivery = conversation?.deliveryReview
    const observation = conversation?.executionObservation
    const claimProviderRequest = () => claimOwnerPlanningProviderRequest(
      input.sessionId,
      JSON.stringify({
        model: source.binding.modelId,
        stream: true,
        max_tokens: source.link.maxOutputTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: source.request.systemPrompt },
          { role: 'user', content: source.request.userPrompt },
        ],
      }),
      new URL('https://example.invalid/v1/chat/completions'),
    )
    if (delivery?.qualityDecisionVersion === 1 && delivery.artifact && observation) {
      calls.push({ projectId: source.link.projectId, purpose: 'owner_quality', candidates: [] })
      claimProviderRequest()
      const binding = { projectId: source.link.projectId, ...(source.context.goal.goal.taskId ? { taskId: source.context.goal.goal.taskId } : {}), goalVersion: source.context.goal.goal.goalVersion, contextFingerprint: source.context.fingerprint }
      const decision = { reviewerCommandId: observation.commandId, artifactHash: delivery.artifact.contentSha256, verdict: 'accept', reason: '已按完整成果、验收标准与独立评审核对', criteria: delivery.review!.criteria.map(item => ({ criterion: item.criterion, status: 'met', evidence: '成果与独立评审均包含对应依据', quote: delivery.artifact!.content })), findings: [] }
      const response = { schemaVersion: 1, kind: 'quality_decision', ...binding, messageId: conversation.throughMessageId, message: '成果与独立检查已完成核对，正在记录验收结果。', decision }
      handlers.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: input.sessionId, finish_reason: 'stop', result: JSON.stringify(response), usage: { input_tokens: 10, output_tokens: 20 }, owner_planning_usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null } } })
      return
    }
    if (observation && conversation) {
      calls.push({ projectId: source.link.projectId, purpose: 'owner_followup', candidates: [] })
      claimProviderRequest()
      const response = { schemaVersion: 1, kind: 'conversation_reply', projectId: source.link.projectId, goalVersion: source.context.goal.goal.goalVersion, contextFingerprint: source.context.fingerprint, messageId: conversation.throughMessageId, message: '我已记录当前进度，等独立检查完成后再核对成果。' }
      handlers.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: input.sessionId, finish_reason: 'stop', result: JSON.stringify(response), usage: { input_tokens: 10, output_tokens: 20 }, owner_planning_usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null } } })
      return
    }
    if (source.link.purpose === 'owner_planning') {
      calls.push({ projectId: source.link.projectId, purpose: source.link.purpose, candidates: [] })
      const roleKey = source.context.sources.roles.find(role => role.key === 'requirements-analyst')?.key ?? source.context.sources.roles[0]!.key
      const proposal = { schemaVersion: 1, kind: 'plan_proposal', binding: { projectId: source.link.projectId, goalVersion: source.context.goal.goal.goalVersion, contextFingerprint: source.context.fingerprint }, proposal: { summary: '按目标形成定位简报', assumptions: [], risks: [], steps: [{ key: 'brief', title: '分析需求', outcome: '定位简报', acceptanceCriteria: ['证据和取舍明确'], dependencies: [], roleKey }] } }
      claimProviderRequest()
      const gate = nextOwnerPlanningResponseGate
      if (gate) {
        nextOwnerPlanningResponseGate = null
        gate.started()
        await gate.wait
      }
      handlers.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: input.sessionId, finish_reason: 'stop', result: JSON.stringify(proposal), usage: { input_tokens: 10, output_tokens: 20 }, owner_planning_usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null } } })
      return
    }
    const context = source.assignmentContext
    if (!context) throw new Error('本用例只允许Owner规划或安排用途，不能启动员工')
    calls.push({ projectId: source.link.projectId, purpose: source.link.purpose, candidates: context.candidates.map(item => item.id), executionKinds: [...context.executionKinds], employeeModes: context.candidates.map(({ id, executionProfile, ownerControlledCompatible }) => ({ id, executionProfile, ...(ownerControlledCompatible ? { ownerControlledCompatible } : {}) })) })
    claimProviderRequest()
    const reviewer = context.candidates.find(item => item.roleTemplateId === 'delivery-verifier' || item.name === '独立检查')!
    const assignments = [...new Set(context.steps.map(step => step.roleKey))].map(roleKey => ({ roleKey, employeeId: context.candidates.find(item => item.roleTemplateId === roleKey || item.name === '分析师')!.id, reason: '岗位能力适用' }))
    const selectedIds = [...assignments.map(item => item.employeeId), reviewer.id]
    const workspaceId = context.workspaces.find(workspace => selectedIds.every(id => context.candidates.find(candidate => candidate.id === id)?.workspaceIds.includes(workspace.id)))?.id
    if (!workspaceId) throw new Error('fake安排没有共同的已授权员工工作区')
    const rejectedReviewer = rejectNextAssignmentProjectId === source.link.projectId ? assignments[0]?.employeeId : undefined
    if (rejectedReviewer) rejectNextAssignmentProjectId = null
    const proposal = { schemaVersion: 1, contextFingerprint: context.contextFingerprint, selectedStepKeys: context.steps.map(step => step.key), scopeReason: '执行已确认的完整方案', workspaceId, workspaceReason: '复用项目已有授权', executionKind: 'controlled', executionKindReason: '无需代码修改', assignments: rejectedReviewer && rejectNextAssignmentKind === 'coverage' ? [] : assignments, reviewerEmployeeId: rejectNextAssignmentKind === 'reviewer' ? rejectedReviewer ?? reviewer.id : reviewer.id, reviewerReason: '独立检查成果' }
    const isLegacyNullScope = legacyNullScopeProjectId === source.link.projectId
    const rejected = isLegacyNullScope ? spyOn(await import('./project-owner-execution-assignment-protocol'), 'parseOwnerExecutionAssignmentProposal').mockImplementationOnce(() => { throw new Error('受控非研发安排不得包含代码范围') }) : null
    if (isLegacyNullScope) legacyNullScopeProjectId = null
    try {
      handlers.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: input.sessionId, finish_reason: 'stop', result: JSON.stringify({ ...proposal, ...(isLegacyNullScope ? { developmentScope: null } : {}) }), usage: { input_tokens: 10, output_tokens: 20 }, owner_planning_usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null } } })
    } finally { rejected?.mockRestore() }
  })
})
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
function fixture(team: 'complete' | 'missing-reviewer' | 'missing-role' | 'general' | 'mixed' | 'pi-team' | 'pi-development-team' = 'complete', taskScoped = false, savePlan = true, saveGoal = true, separateTeamWorkspace = false) {
  const project = store.createProject({ title: '自动组织团队', description: '' }), workspace = createAgentWorkspace(`自动安排-${randomUUID()}`, team === 'pi-development-team' && !separateTeamWorkspace ? directory : undefined)
  const teamWorkspace = separateTeamWorkspace ? createAgentWorkspace(`共享团队-${randomUUID()}`, team === 'pi-development-team' ? directory : undefined) : workspace
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: 'fake', provider: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: 'fake', enabled: true, models: [{ id: 'deepseek-flash', name: 'fake', enabled: true }] })
  const executorChannel = ['mixed', 'pi-team', 'pi-development-team'].includes(team) ? createChannel({ name: 'fake executor', provider: team === 'pi-team' || team === 'pi-development-team' ? 'zhipu' : 'openai', baseUrl: team === 'pi-team' || team === 'pi-development-team' ? 'https://open.bigmodel.cn/api/paas/v4' : 'https://executor.invalid/v1', apiKey: 'fake', enabled: true, models: [{ id: 'glm-5.3-flash', name: 'glm', enabled: true }] }) : channel
  const employee = (name: string, roleTemplateId?: string) => {
    const teamEmployee = name !== 'Owner' && (team === 'pi-team' || team === 'pi-development-team' || name === '分析师' && team === 'mixed')
    const executionProfile = ['general', 'mixed'].includes(team) && name !== 'Owner' ? 'general' : team === 'pi-development-team' && name !== 'Owner' ? 'development' : 'controlled'
    return employees.createAgentEmployee({ name, role: name, ...(roleTemplateId ? { roleTemplateId } : {}), description: '', executionProfile, permissionMode: 'safe', runtime: teamEmployee && ['pi-team', 'pi-development-team'].includes(team) ? 'pi' : 'ai-sdk', channelId: teamEmployee ? executorChannel.id : channel.id, modelId: teamEmployee ? 'glm-5.3-flash' : 'deepseek-flash', workspaceIds: [(separateTeamWorkspace && name !== 'Owner' ? teamWorkspace : workspace).id] })
  }
  const owner = employee('Owner'), executor = employee('分析师', ['general', 'mixed'].includes(team) ? undefined : team === 'missing-role' ? 'visual-designer' : 'requirements-analyst'), reviewer = team === 'missing-reviewer' ? null : employee('独立检查', ['general', 'mixed'].includes(team) ? undefined : 'delivery-verifier')
  const taskId = taskScoped ? store.createTask(project.id, { title: '用户任务', description: '' }).id : undefined
  const subject = { projectId: project.id, ...(taskId ? { taskId } : {}) }
  if (saveGoal) saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成定位建议' }, taskId)
  saveOwnerRuntimeBinding(project.id, 0, { ownerName: 'Owner', carrierId: owner.id, workspaceId: workspace.id, changeReason: '隔离测试' })
  const context = saveGoal ? plans.getProjectOwnerPlanningContext(project.id, taskId) : null
  const plan = savePlan && context ? plans.saveProjectOwnerPlanDraft(project.id, 1, 0, { expectedContextFingerprint: context.fingerprint, summary: '定位研究', assumptions: [], risks: [], steps: [{ key: 'brief', title: '分析需求', outcome: '定位简报', acceptanceCriteria: ['证据和取舍明确'], dependencies: [], roleKey: 'requirements-analyst' }], changeReason: '创建可审核方案' }, taskId) : null
  return { project, workspace, teamWorkspace, owner, executor, reviewer, taskId, subject, plan }
}
function confirm(f: ReturnType<typeof fixture>) { return plans.confirmProjectOwnerPlanDraft(f.project.id, 1, 1, f.taskId) }
function authorize(f: ReturnType<typeof fixture>, autonomousExecution = false, maxRequests = 3) {
  const input = { ...f.subject, requestId: randomUUID(), maxRequests, maxCostMicros: 10_000_000, expiresAt: Date.now() + 3600000, ...(autonomousExecution ? { autonomousExecution: true as const } : {}) }
  const preview = delegation.previewOwnerManagementDelegation(input)
  return delegation.confirmOwnerManagementDelegation({ input, previewHash: preview.previewHash })
}

test('Given旧目标已有执行批次 When用户修订目标并确认新自主额度 Then新Owner方案追加批次且旧批次暂停保留', async () => {
  const f = fixture('complete', false, false), first = authorize(f, true, 6)
  const scheduler = await import('./project-owner-autonomous-scheduler')
  const { onOwnerAutonomousScheduleWake } = await import('./project-owner-autonomous-scheduler-events')
  const stopSchedule = onOwnerAutonomousScheduleWake(id => { if (id === f.project.id) void scheduler.runOwnerAutonomousSchedule(id) })
  const stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'delivery'))
    const before = store.getProjectDb().prepare('SELECT id,state FROM project_owner_execution_grants WHERE project_id=? ORDER BY rowid').all(f.project.id) as Array<{ id: string; state: string }>
    saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '收敛为一份新的定位建议', constraints: ['只保留一个实现交付步骤，独立Reviewer由系统负责'] })
    const next = authorize(f, true, 6)
    expect(next.maxCostMicros).toBe(first.maxCostMicros)
    await until(() => (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id) as { count: number }).count > before.length)
    const after = store.getProjectDb().prepare('SELECT id,state FROM project_owner_execution_grants WHERE project_id=? ORDER BY rowid').all(f.project.id) as Array<{ id: string; state: string }>
    expect(after.find(item => item.id === before[0]!.id)?.state).toBe('paused')
    expect(after.at(-1)?.id).not.toBe(before[0]!.id)
    expect(store.listTasks(f.project.id).filter(item => item.ownerStepLinkId).length).toBeGreaterThan(1)
    await until(() => getOwnerManagementConversation(f.project.id).messages.filter(item => item.kind === 'delivery').length === 2)
  } finally { stop(); stopSchedule() }
}, 15000)
test('Given旧批次请求费用转待核对 When新目标已授权 Then保留旧占额且不发行新执行批次', async () => {
  const f = fixture('complete', false, false)
  authorize(f, true, 6)
  const scheduler = await import('./project-owner-autonomous-scheduler')
  const { onOwnerAutonomousScheduleWake } = await import('./project-owner-autonomous-scheduler-events')
  const stopSchedule = onOwnerAutonomousScheduleWake(id => { if (id === f.project.id) void scheduler.runOwnerAutonomousSchedule(id) })
  const stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'delivery'))
    const db = store.getProjectDb()
    const old = db.prepare('SELECT id FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id) as { id: string }
    db.prepare("UPDATE project_owner_execution_request_reservations SET state='needs_reconcile' WHERE command_id IN (SELECT id FROM project_owner_execution_commands WHERE grant_id=?)").run(old.id)
    saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '更新交付目标但不清除未知费用' })
    authorize(f, true, 6)
    await until(() => Boolean(db.prepare("SELECT 1 FROM project_owner_execution_start_intents WHERE project_id=? AND json_extract(payload,'$.expectedGoalRevision')=2 AND recovery_status='needs_attention'").get(f.project.id)))
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id)).toEqual({ count: 1 })
    expect((db.prepare("SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations WHERE state='needs_reconcile'").get() as { count: number }).count).toBeGreaterThan(0)
  } finally { stop(); stopSchedule() }
}, 15000)
test('Given 新项目只有Owner载体 When按方案准备团队 Then 自动在项目工作区创建所需员工和独立核验员且重复调用幂等', () => {
  const project = store.createProject({ title: '默认团队注入', description: '' }), workspace = createAgentWorkspace(`默认团队-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: 'fake default team', provider: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: 'fake', enabled: true, models: [{ id: 'deepseek-flash', name: 'fake', enabled: true }] })
  const owner = employees.createAgentEmployee({ name: 'Owner', role: '项目管理者', description: '', runtime: 'ai-sdk', channelId: channel.id, modelId: 'deepseek-flash', workspaceIds: [workspace.id], executionProfile: 'controlled', permissionMode: 'safe' })
  const binding = saveOwnerRuntimeBinding(project.id, 0, { ownerName: 'Owner', carrierId: owner.id, workspaceId: workspace.id, changeReason: '隔离测试' })
  ensureOwnerDefaultTeam(project.id, binding, ['requirements-analyst'])
  ensureOwnerDefaultTeam(project.id, binding, ['requirements-analyst'])
  const team = employees.listAgentEmployees().filter(employee => employee.id !== owner.id && employee.workspaceIds?.includes(workspace.id))
  expect(team.map(employee => employee.roleTemplateId).sort()).toEqual(['delivery-verifier', 'requirements-analyst'])
  expect(team.every(employee => employee.runtime === 'ai-sdk' && employee.executionProfile === 'controlled' && employee.permissionMode === 'safe' && employee.workspaceIds?.length === 1)).toBe(true)
})
function ownerHistoryFixture() {
  const f = fixture('missing-reviewer', false, false)
  employees.deleteAgentEmployee(f.executor.id)
  const owners = [f.owner]
  let binding = getOwnerRuntimeBinding(f.project.id)!
  for (let revision = 1; revision <= 2; revision++) {
    const owner = employees.createAgentEmployee({ name: `旧配置Owner-${revision}`, role: '项目管理者', description: '', runtime: 'ai-sdk', channelId: f.owner.channelId, modelId: f.owner.modelId, workspaceIds: [f.workspace.id], executionProfile: 'controlled', permissionMode: 'safe' })
    owners.push(owner)
    binding = saveOwnerRuntimeBinding(f.project.id, revision, { ownerName: 'Owner', carrierId: owner.id, workspaceId: f.workspace.id, changeReason: '模拟切换模型留下的载体历史' })
  }
  return { ...f, owners, binding }
}
test('Given多次更换Owner载体且没有业务员工 When准备默认团队 Then历史Owner不阻止补齐且不会成为执行或评审候选', async () => {
  const f = ownerHistoryFixture()
  ensureOwnerDefaultTeam(f.project.id, f.binding, ['requirements-analyst'])
  ensureOwnerDefaultTeam(f.project.id, f.binding, ['requirements-analyst'])
  const team = employees.listAgentEmployees().filter(employee => employee.workspaceIds?.includes(f.workspace.id) && !f.owners.some(owner => owner.id === employee.id))
  expect(team.map(employee => employee.roleTemplateId).sort()).toEqual(['delivery-verifier', 'requirements-analyst'])
  const { getOwnerExecutionPreparation } = await import('./project-owner-execution-preparation')
  const choices = getOwnerExecutionPreparation(f.subject).choices.employees
  expect(choices.filter(employee => employee.isOwnerCarrier).map(employee => employee.id).sort()).toEqual(f.owners.map(owner => owner.id).sort())
  setOwnerManagerStatus(f.project.id, getOwnerManager(f.project.id)!.revision, 'paused')
})
test('Given旧Owner记录导致已确认方案缺员且事件已消费 When重启后台管理 Then自动补齐并执行评审交付而不要求再次授权', async () => {
  const f = ownerHistoryFixture(), context = plans.getProjectOwnerPlanningContext(f.project.id)
  plans.saveProjectOwnerPlanDraft(f.project.id, 1, 0, { expectedContextFingerprint: context.fingerprint, summary: '定位研究', assumptions: [], risks: [], steps: [{ key: 'brief', title: '分析需求', outcome: '定位简报', acceptanceCriteria: ['证据和取舍明确'], dependencies: [], roleKey: 'requirements-analyst' }], changeReason: '复现已确认方案' })
  confirm(f)
  const grant = authorize(f, true)
  for (const event of listPendingOwnerManagementEvents(f.project.id)) consumeOwnerManagementEvent(event)
  const { appendOwnerManagementMessage } = await import('./project-owner-management-store')
  appendOwnerManagementMessage({ projectId: f.project.id, eventId: 'historical-team-blocked', role: 'assistant', kind: 'attention', content: '当前团队不足以同时完成执行和独立检查' })
  const scheduler = await import('./project-owner-autonomous-scheduler'), scheduleEvents = await import('./project-owner-autonomous-scheduler-events')
  const stopWake = scheduleEvents.onOwnerAutonomousScheduleWake(projectId => { if (projectId === f.project.id) void scheduler.runOwnerAutonomousSchedule(projectId) })
  const stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(message => message.kind === 'delivery'), () => getOwnerManagementConversation(f.project.id).messages.at(-1)?.content)
    expect(delegation.getOwnerManagementDelegation(f.project.id).delegation?.id).toBe(grant.id)
    const call = calls.find(call => call.projectId === f.project.id && call.purpose === 'owner_execution_assignment')!
    expect(call.candidates).toHaveLength(2)
    expect(call.candidates.some(id => f.owners.some(owner => owner.id === id))).toBe(false)
    expect(store.getProjectDb().prepare('SELECT role,state FROM project_owner_execution_commands WHERE project_id=? ORDER BY role').all(f.project.id)).toEqual([{ role: 'executor', state: 'settled' }, { role: 'reviewer', state: 'settled' }])
    expect(store.listAgentExecutionsByProject(f.project.id).filter(execution => execution.ownerCommandId).every(execution => execution.sessionId)).toBe(true)
    reconcileOwnerManagement(f.project.id)
    reconcileOwnerManagement(f.project.id)
    expect(calls.filter(call => call.projectId === f.project.id && call.purpose === 'owner_execution_assignment')).toHaveLength(1)
  } finally { stopWake(); stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id); setOwnerManagerStatus(f.project.id, getOwnerManager(f.project.id)!.revision, 'paused') }
}, 15000)
test('Given方案也包含交付核验岗位 When创建默认团队 Then该执行岗位之外仍有另一位独立评审员', () => {
  const f = ownerHistoryFixture()
  ensureOwnerDefaultTeam(f.project.id, f.binding, ['requirements-analyst', 'delivery-verifier'])
  ensureOwnerDefaultTeam(f.project.id, f.binding, ['requirements-analyst', 'delivery-verifier'])
  const team = employees.listAgentEmployees().filter(employee => employee.workspaceIds?.includes(f.workspace.id) && !f.owners.some(owner => owner.id === employee.id))
  expect(team).toHaveLength(3)
  expect(team.filter(employee => employee.roleTemplateId === 'delivery-verifier')).toHaveLength(2)
  setOwnerManagerStatus(f.project.id, getOwnerManager(f.project.id)!.revision, 'paused')
})
test('Given方案岗位模板缺失 When准备默认团队 Then不留下只创建了一半的团队', () => {
  const f = ownerHistoryFixture()
  expect(ensureOwnerDefaultTeam(f.project.id, f.binding, ['missing-template'])).toBe(false)
  expect(employees.listAgentEmployees().filter(employee => employee.workspaceIds?.includes(f.workspace.id))).toHaveLength(f.owners.length)
  setOwnerManagerStatus(f.project.id, getOwnerManager(f.project.id)!.revision, 'paused')
})
test('Given 缺少独立评审员且历史含撤销提示 When 重新授权后再次核对团队 Then 当前缺员原因重新显示且不调用模型', async () => {
  const f = fixture('missing-reviewer')
  confirm(f)
  const { prepareOwnerManagementAssignment } = await import('./project-owner-management-assignment')
  const { appendOwnerManagementMessage } = await import('./project-owner-management-store')
  const check = (id: string) => prepareOwnerManagementAssignment({ id: `reauthorize:${id}`, projectId: f.project.id, kind: 'delegation_confirmed', sourceId: id, sourceRevision: 1, createdAt: Date.now(), consumedAt: null })
  const first = authorize(f)
  check(first.id)
  delegation.revokeOwnerManagementDelegation(f.project.id, first.id)
  appendOwnerManagementMessage({ projectId: f.project.id, eventId: 'old-revoked', role: 'assistant', kind: 'attention', content: '管理授权已撤销' })
  const second = authorize(f)
  const before = calls.length
  check(second.id)
  expect(getOwnerManagementConversation(f.project.id).messages.at(-1)?.content).toContain('当前团队不足以同时完成执行和独立检查')
  expect(calls.length).toBe(before)
  delegation.revokeOwnerManagementDelegation(f.project.id, second.id)
})
async function until(predicate: () => boolean, diagnostic: () => unknown = () => undefined) { for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) } throw new Error(`等待自动安排超时${JSON.stringify(diagnostic())}`) }

test('Given 已有可用团队和管理委托 When 用户确认方案 Then 无页面参与自动安排，复用已有员工且不签发执行许可', async () => {
  const f = fixture(), grant = authorize(f), stop = startOwnerManagementLoop()
  try {
    confirm(f)
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'))
    const runs = listOwnerExecutionAssignmentRuns(f.subject)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.outcomes[0]?.assignmentProposal).toMatchObject({ assignments: [{ roleKey: 'requirements-analyst', employeeId: f.executor.id }], reviewerEmployeeId: f.reviewer!.id })
    expect(calls.filter(item => item.projectId === f.project.id)).toHaveLength(1)
    expect(calls.find(item => item.projectId === f.project.id)?.candidates.sort()).toEqual([f.executor.id, f.reviewer!.id].sort())
    expect(store.listAgentExecutionsByProject(f.project.id).every(item => item.agentId === f.owner.id)).toBe(true)
    for (const table of ['project_owner_execution_grants', 'project_owner_task_materializations']) expect(store.getProjectDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(f.project.id)).toEqual({ n: 0 })
    plans.confirmProjectOwnerPlanDraft(f.project.id, 1, 2)
    reconcileOwnerManagement(f.project.id)
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(1)
    delegation.revokeOwnerManagementDelegation(f.project.id, grant.id)
  } finally { stop() }
})

test.each(['reviewer', 'coverage'] as const)('Given 安排请求完整结束但违反%s协议 When Owner收到失败结果 Then 在原预算内只续跑一次并保留两次运行证据', async (kind) => {
  rejectNextAssignmentKind = kind
  const f = fixture()
  confirm(f)
  const grant = authorize(f, true), before = calls.length
  rejectNextAssignmentProjectId = f.project.id
  const stop = startOwnerManagementLoop()
  try {
    await until(() => calls.slice(before).filter(item => item.projectId === f.project.id && item.purpose === 'owner_execution_assignment').length === 2
      && listOwnerExecutionAssignmentRuns(f.subject).some(run => run.outcomes.some(outcome => outcome.state === 'proposed')), () => ({ calls: calls.filter(item => item.projectId === f.project.id), events: listPendingOwnerManagementEvents(f.project.id), assignments: listOwnerExecutionAssignmentRuns(f.subject).map(run => ({ status: run.sourceStatus, planRevision: run.link.planRevision, outcomes: run.outcomes })), messages: getOwnerManagementConversation(f.project.id).messages.slice(-5).map(item => ({ kind: item.kind, content: item.content })) }))
    const runs = listOwnerExecutionAssignmentRuns(f.subject)
    expect(runs.flatMap(run => run.outcomes.map(outcome => outcome.state)).sort()).toEqual(['failed', 'proposed'])
    expect(calls.slice(before).filter(item => item.projectId === f.project.id && item.purpose === 'owner_execution_assignment')).toHaveLength(2)
    expect(getOwnerManagementConversation(f.project.id).messages.map(item => item.content)).toContain('上一条团队安排有完整运行记录，但未通过岗位覆盖或独立评审员校验。我已在当前项目授权和预算内重新安排一次；原记录保留，不会循环重试。')
    reconcileOwnerManagement(f.project.id)
    reconcileOwnerManagement(f.project.id)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(calls.slice(before).filter(item => item.projectId === f.project.id && item.purpose === 'owner_execution_assignment')).toHaveLength(2)
    expect(delegation.getOwnerManagementDelegation(f.project.id).state).toBe('active')
  } finally { rejectNextAssignmentProjectId = null; stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
}, 15_000)

test('Given 授权前已有待审方案和完整团队 When 首次确认管理委托 Then Owner自动完成内部安排并等待一次执行确认', async () => {
  const f = fixture(), grant = authorize(f), before = calls.length, stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'))
    expect(plans.getProjectOwnerPlanDraft(f.project.id)?.state).toBe('proposed')
    expect(calls.slice(before).filter(item => item.projectId === f.project.id).map(item => item.purpose)).toEqual(['owner_execution_assignment'])
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(1)
    expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged' && item.content.includes('员工尚未启动'))).toBe(true)
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id)).toEqual({ n: 0 })
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_owner_task_materializations WHERE project_id=?').get(f.project.id)).toEqual({ n: 0 })
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given 员工位于未授权的共享工作区 When 团队不足 Then Owner建议最小工作区且只在用户确认后恢复安排', async () => {
  const f = fixture('complete', false, true, true, true)
  const grant = authorize(f)
  expect(teamAccess.getOwnerTeamWorkspaceProposal(f.project.id)).toMatchObject({ workspaceId: f.teamWorkspace.id, eligibleEmployeeCount: 2 })
  const stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.teamWorkspaceProposal), () => ({
      pending: listPendingOwnerManagementEvents(f.project.id).map(event => event.kind),
      messages: getOwnerManagementConversation(f.project.id).messages.slice(-5).map(message => ({ kind: message.kind, eventId: message.eventId, hasProposal: Boolean(message.teamWorkspaceProposal), content: message.content.slice(0, 120) })),
      assignments: listOwnerExecutionAssignmentRuns(f.subject).map(run => ({ status: run.sourceStatus, purpose: run.link.purpose })),
    }))
    const suggestion = getOwnerManagementConversation(f.project.id).messages.find(item => item.teamWorkspaceProposal)!
    expect(suggestion).toMatchObject({ kind: 'attention', teamWorkspaceProposal: { workspaceId: f.teamWorkspace.id, workspaceName: f.teamWorkspace.name, eligibleEmployeeCount: 2 } })
    expect(suggestion.content).toContain(f.teamWorkspace.name)
    expect(suggestion.content).not.toContain('名当前可用员工')
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(0)
    expect(calls.filter(item => item.projectId === f.project.id)).toHaveLength(0)
    expect(teamAccess.getOwnerTeamWorkspaceProposal(f.project.id)).toEqual(suggestion.teamWorkspaceProposal!)
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_workspace_bindings WHERE project_id=? AND workspace_id=?').get(f.project.id, f.teamWorkspace.id)).toEqual({ n: 0 })
    const approval = { projectId: f.project.id, messageId: suggestion.id, workspaceId: f.teamWorkspace.id, scopeFingerprint: suggestion.teamWorkspaceProposal!.scopeFingerprint }
    teamAccess.confirmOwnerTeamWorkspaceAccess(approval)
    teamAccess.confirmOwnerTeamWorkspaceAccess(approval)
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'))
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_workspace_bindings WHERE project_id=? AND workspace_id=?').get(f.project.id, f.teamWorkspace.id)).toEqual({ n: 1 })
    expect(getOwnerManagementConversation(f.project.id).messages.filter(item => item.eventId === `team-workspace-approved:${suggestion.id}`)).toHaveLength(1)
    expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.content.includes('这条消息保存后，项目目标已更新'))).toBe(false)
    expect(calls.filter(item => item.projectId === f.project.id).map(item => item.purpose)).toEqual(['owner_execution_assignment'])
    expect(calls.find(item => item.projectId === f.project.id)?.candidates.sort()).toEqual([f.executor.id, f.reviewer!.id].sort())
    expect(store.listAgentExecutionsByProject(f.project.id).every(item => item.agentId === f.owner.id)).toBe(true)
    expect(delegation.getOwnerManagementDelegation(f.project.id)).toMatchObject({ state: 'active', usedRequests: 1 })
    delegation.revokeOwnerManagementDelegation(f.project.id, grant.id)
  } finally { stop() }
})

test('Given 可计费Pi团队位于未授权工作区 When Owner检查执行能力 Then 提议最小资料范围并在确认后自动安排', async () => {
  const f = fixture('pi-team', false, true, true, true), grant = authorize(f), before = calls.length, stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.teamWorkspaceProposal))
    const suggestion = getOwnerManagementConversation(f.project.id).messages.find(item => item.teamWorkspaceProposal)!
    expect(suggestion.teamWorkspaceProposal).toMatchObject({ workspaceId: f.teamWorkspace.id, eligibleEmployeeCount: 2 })
    expect(suggestion.content).not.toContain('名当前可用员工')
    expect(teamAccess.getOwnerTeamWorkspaceProposal(f.project.id)).toEqual(suggestion.teamWorkspaceProposal!)
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(0)
    expect(calls.filter(item => item.projectId === f.project.id)).toHaveLength(0)

    const approval = { projectId: f.project.id, messageId: suggestion.id, workspaceId: f.teamWorkspace.id, scopeFingerprint: suggestion.teamWorkspaceProposal!.scopeFingerprint }
    teamAccess.confirmOwnerTeamWorkspaceAccess(approval)
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'), () => ({
      messages: getOwnerManagementConversation(f.project.id).messages.slice(-8).map(message => ({ kind: message.kind, content: message.content.slice(0, 100) })),
      events: listPendingOwnerManagementEvents(f.project.id).map(event => event.kind),
      assignments: listOwnerExecutionAssignmentRuns(f.subject).map(run => ({ status: run.sourceStatus, outcomes: run.outcomes.map(outcome => ({ state: outcome.state, detail: outcome.detail })) })),
      executions: store.listAgentExecutionsByProject(f.project.id).map(execution => ({ status: execution.status, error: execution.error, agentId: execution.agentId, entityId: execution.entityId })),
      links: store.getProjectDb().prepare('SELECT planning_task_id, payload FROM project_owner_planning_links WHERE project_id=?').all(f.project.id),
    }))

    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_workspace_bindings WHERE project_id=? AND workspace_id=?').get(f.project.id, f.teamWorkspace.id)).toEqual({ n: 1 })
    expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.content.includes('这条消息保存后，项目目标已更新'))).toBe(false)
    expect(calls.slice(before).filter(item => item.projectId === f.project.id).map(item => item.purpose)).toEqual(['owner_execution_assignment'])
    expect(calls.find(item => item.projectId === f.project.id && item.purpose === 'owner_execution_assignment')?.candidates.sort()).toEqual([f.executor.id, f.reviewer!.id].sort())
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(1)
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id)).toEqual({ n: 0 })
    expect(delegation.getOwnerManagementDelegation(f.project.id)).toMatchObject({ state: 'active', usedRequests: 1 })
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given可安全降级的Pi研发员工位于未授权Git工作区 When用户只确认资料范围 ThenOwner自动将其安排为受控非代码团队', async () => {
  const f = fixture('pi-development-team', false, true, true, true), grant = authorize(f), before = calls.length, stop = startOwnerManagementLoop()
  try {
    const proposal = teamAccess.getOwnerTeamWorkspaceProposal(f.project.id)
    if (!proposal) throw new Error('预期存在 Pi 团队工作区提议')
    expect(proposal).toMatchObject({ workspaceId: f.teamWorkspace.id, eligibleEmployeeCount: 2 })
    const suggestion = getOwnerManagementConversation(f.project.id).messages.find(item => item.teamWorkspaceProposal)!
    expect(suggestion.teamWorkspaceProposal).toEqual(proposal)
    expect(calls.filter(item => item.projectId === f.project.id)).toHaveLength(0)
    teamAccess.confirmOwnerTeamWorkspaceAccess({ projectId: f.project.id, messageId: suggestion.id, workspaceId: proposal!.workspaceId, scopeFingerprint: proposal!.scopeFingerprint })
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'), () => ({ messages: getOwnerManagementConversation(f.project.id).messages.slice(-6).map(item => ({ kind: item.kind, content: item.content.slice(0, 120) })), assignments: listOwnerExecutionAssignmentRuns(f.subject).map(run => run.outcomes.map(outcome => ({ state: outcome.state, detail: outcome.detail }))), calls: calls.filter(item => item.projectId === f.project.id) }))
    const run = listOwnerExecutionAssignmentRuns(f.subject)[0]!
    expect(run.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'proposed' })]))
    expect(calls.slice(before).filter(item => item.projectId === f.project.id).map(item => item.purpose)).toEqual(['owner_execution_assignment'])
    expect(employees.getAgentEmployee(f.executor.id)).toMatchObject({ executionProfile: 'development', permissionMode: 'safe' })
    expect(employees.getAgentEmployee(f.reviewer!.id)).toMatchObject({ executionProfile: 'development', permissionMode: 'safe' })
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
}, 15_000)

test('Given 待审方案的授权事件已消费但没有安排记录 When Owner循环恢复项目 Then 只重新检查一次并把缺少团队的原因带回对话', () => {
  const f = fixture(), grant = authorize(f), before = calls.filter(item => item.projectId === f.project.id).length
  store.getProjectDb().prepare('UPDATE agent_employees SET enabled = 0 WHERE id IN (?, ?)').run(f.executor.id, f.reviewer!.id)
  for (const event of listPendingOwnerManagementEvents(f.project.id)) consumeOwnerManagementEvent(event)
  try {
    reconcileOwnerManagement(f.project.id)
    const event = store.getProjectDb().prepare("SELECT payload, consumed_at FROM project_owner_management_events WHERE project_id = ? AND json_extract(payload, '$.kind') = 'assignment_recheck'").get(f.project.id) as { payload: string; consumed_at: number | null }
    expect(event.consumed_at).toBeNull()
    expect(JSON.parse(event.payload)).toMatchObject({ kind: 'assignment_recheck', sourceRevision: f.plan!.revision, sourceId: grant.id })
    reconcileOwnerManagement(f.project.id)
    expect(store.getProjectDb().prepare("SELECT consumed_at FROM project_owner_management_events WHERE project_id = ? AND json_extract(payload, '$.kind') = 'assignment_recheck'").get(f.project.id)).toMatchObject({ consumed_at: expect.any(Number) })
    expect(getOwnerManagementConversation(f.project.id).messages.filter(item => item.kind === 'attention').map(item => item.content)).toContainEqual(expect.stringContaining('没有能承担这项工作的员工'))
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(0)
    expect(calls.filter(item => item.projectId === f.project.id)).toHaveLength(before)
  } finally { delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given 已保存目标与已授权的项目费用边界 When 后台开始管理 Then Owner自动规划并安排团队，等待用户确认执行', async () => {
  const f = fixture('complete', false, false, true), grant = authorize(f), before = calls.length, stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'))
    expect(plans.getProjectOwnerPlanDraft(f.project.id)?.state).toBe('proposed')
    const projectCalls = calls.slice(before).filter(item => item.projectId === f.project.id)
    expect(projectCalls.map(item => item.purpose)).toEqual(['owner_planning', 'owner_execution_assignment'])
    expect(plans.getProjectOwnerPlanDraft(f.project.id)).toMatchObject({ state: 'proposed', origin: 'generated' })
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(2)
    expect(store.listAgentExecutionsByProject(f.project.id).every(item => item.agentId === f.owner.id)).toBe(true)
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(1)
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id)).toEqual({ n: 0 })
    expect(delegation.getOwnerManagementDelegation(f.project.id).usedRequests).toBe(2)
    expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'plan_proposal')).toBe(true)
    expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged')).toBe(true)
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given 已审核价格模型但没有项目费用授权 When Owner收到目标 Then 等待用户补齐边界且不发送请求', async () => {
  const f = fixture('complete', false, false, true), before = calls.length, stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.length > 0)
    expect(plans.getProjectOwnerPlanDraft(f.project.id)).toBeNull()
    expect(calls.slice(before).filter(item => item.projectId === f.project.id)).toHaveLength(0)
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(0)
    expect(delegation.getOwnerManagementDelegation(f.project.id).state).toBe('none')
    expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'plan_proposal')).toBe(false)
  } finally { stop() }
})

test('Given Owner生成了待审方案和有效规划委托 When 方案展示给用户 Then团队已内部安排但没有启动员工', async () => {
  const f = fixture('complete', false, false), grant = authorize(f), stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'))
    expect(plans.getProjectOwnerPlanDraft(f.project.id)?.state).toBe('proposed')
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(1)
    expect(calls.filter(item => item.projectId === f.project.id).map(item => item.purpose)).toEqual(['owner_planning', 'owner_execution_assignment'])
    expect(store.listAgentExecutionsByProject(f.project.id).every(item => item.agentId === f.owner.id)).toBe(true)
    for (const table of ['project_owner_execution_grants', 'project_owner_task_materializations']) expect(store.getProjectDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(f.project.id)).toEqual({ n: 0 })
    expect(delegation.getOwnerManagementDelegation(f.project.id).usedRequests).toBe(2)
    const trace = getOwnerManagementView(f.project.id).trace ?? []
    const latestTrace = trace.at(-1)
    if (!latestTrace) throw new Error('Owner安排未生成诊断Trace')
    expect(trace.map(item => [item.phase, item.state])).toContainEqual(['assignment_preparation', 'completed'])
    expect(trace.map(item => [item.phase, item.state])).toContainEqual(['assignment_run', 'completed'])
    expect(trace.every(item => !('content' in item) && !('prompt' in item) && !('response' in item))).toBe(true)
    expect(trace.every(item => /^[a-f0-9]{64}$/.test(item.eventId))).toBe(true)
    expect(appendOwnerManagementTrace(latestTrace)).toEqual(latestTrace)
    expect(appendOwnerManagementTrace({ ...latestTrace, createdAt: latestTrace.createdAt + 1 })).toEqual(latestTrace)
    const changes: { projectId: string; messageId?: string }[] = [], off = onOwnerManagementChanged(change => { if (change.projectId === f.project.id) changes.push(change) })
    appendOwnerManagementTrace({ ...latestTrace, eventId: randomUUID(), createdAt: latestTrace.createdAt + 2 })
    await new Promise(resolve => setTimeout(resolve, 0))
    off()
    expect(changes).toEqual([{ projectId: f.project.id }])
    expect(() => appendOwnerManagementTrace({ ...latestTrace, unexpected: 'secret' } as never)).toThrow('字段无效')
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
}, 15_000)

test('Given管理循环已运行且目标尚无计划 When首次规划后 Then自动安排团队但等待用户确认才启动员工', async () => {
  const f = fixture('complete', false, false), before = calls.length, stop = startOwnerManagementLoop()
  const grant = authorize(f)
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'))
    expect(plans.getProjectOwnerPlanDraft(f.project.id)?.state).toBe('proposed')
    expect(calls.slice(before).filter(item => item.projectId === f.project.id).map(item => item.purpose)).toEqual(['owner_planning', 'owner_execution_assignment'])
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(1)
    expect(delegation.getOwnerManagementDelegation(f.project.id).usedRequests).toBe(2)
    expect(store.listAgentExecutionsByProject(f.project.id).every(item => item.agentId === f.owner.id)).toBe(true)
    for (const table of ['project_owner_execution_grants', 'project_owner_task_materializations']) expect(store.getProjectDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(f.project.id)).toEqual({ n: 0 })
    expect(delegation.getOwnerManagementDelegation(f.project.id)).toMatchObject({ state: 'active', usedRequests: 2 })
  } finally { delegation.revokeOwnerManagementDelegation(f.project.id, grant.id); stop() }
}, 15_000)

test('Given 用户在项目对话提交新目标及总预算 When Owner规划并内部安排、用户确认执行 Then完成后续交付流程', async () => {
  const { createStore } = await import('jotai')
  const goalAtoms = await import('../../renderer/atoms/project-owner-goal-atoms')
  const planAtoms = await import('../../renderer/atoms/project-owner-plan-atoms')
  const runtimeAtoms = await import('../../renderer/atoms/project-owner-runtime-atoms')
  const setupAtoms = await import('../../renderer/atoms/owner-setup-atoms')
  const goals = await import('./project-owner-goal-service')
  const ownerBinding = await import('./project-owner-runtime-binding')
  const { listOwnerPlanningRuns } = await import('./project-owner-runtime-ipc')
  const workspaces = await import('./agent-workspace-manager')
  const bindings = await import('./project-workspace-bindings')
  const channels = await import('./channel-manager')
  const f = fixture('complete', false, false, false), state = createStore(), callsBefore = calls.length
  state.set(goalAtoms.ownerGoalApiAtom, {
    getOwnerGoalDraft: async subject => ({ ok: true as const, value: goals.getProjectOwnerGoalDraft(subject.projectId, subject.taskId) }),
    saveOwnerGoalDraft: async request => ({ ok: true as const, value: saveProjectOwnerGoalDraft(request.projectId, request.expectedRevision, request.input, request.taskId) }),
  })
  state.set(planAtoms.ownerPlanApiAtom, {
    getOwnerPlanningContext: async subject => ({ ok: true as const, value: plans.getProjectOwnerPlanningContext(subject.projectId, subject.taskId) }),
    getOwnerPlanDraft: async subject => ({ ok: true as const, value: plans.getProjectOwnerPlanDraft(subject.projectId, subject.taskId) }),
    listOwnerPlanHistory: async subject => ({ ok: true as const, value: plans.listProjectOwnerPlanHistory(subject.projectId, subject.taskId) }),
    saveOwnerPlanDraft: async request => ({ ok: true as const, value: plans.saveProjectOwnerPlanDraft(request.projectId, request.expectedGoalRevision, request.expectedRevision, request.input, request.taskId) }),
    confirmOwnerPlanDraft: async request => ({ ok: true as const, value: plans.confirmProjectOwnerPlanDraft(request.projectId, request.expectedGoalRevision, request.expectedRevision, request.taskId) }),
  })
  state.set(runtimeAtoms.ownerRuntimeApiAtom, {
    getOwnerRuntimeBinding: async subject => ({ ok: true as const, value: ownerBinding.getOwnerRuntimeBinding(subject.projectId) }),
    ensureOwnerRuntimeBinding: async subject => ({ ok: true as const, value: ownerBinding.getOwnerRuntimeBinding(subject.projectId) }),
    saveOwnerRuntimeBinding: async request => ({ ok: true as const, value: ownerBinding.saveOwnerRuntimeBinding(request.projectId, request.expectedRevision, request.input) }),
    getOwnerPlanningContext: async subject => ({ ok: true as const, value: plans.getProjectOwnerPlanningContext(subject.projectId, subject.taskId) }),
    listOwnerPlanningRuns: async subject => ({ ok: true as const, value: listOwnerPlanningRuns(subject.projectId, subject.taskId) }),
    prepareOwnerPlanning: async request => ({ ok: true as const, value: ownerBinding.prepareOwnerPlanning(request.projectId, request.input) }),
    listEmployees: async () => employees.listAgentEmployees().map(employee => ({ ...employee, skills: employee.skills ?? [] })),
    listWorkspaces: async () => workspaces.listAgentWorkspaces(),
    listWorkspaceBindings: async projectId => bindings.listProjectWorkspaceBindings(projectId),
  })
  state.set(setupAtoms.ownerSetupApiAtom, {
    listChannels: async () => channels.listChannels().map(({ id, name, provider, models, enabled, updatedAt }) => ({ id, name, provider, models, enabled, updatedAt })),
    listEmployees: async () => employees.listAgentEmployees().map(employee => ({ ...employee, skills: employee.skills ?? [] })),
    listWorkspaces: async () => workspaces.listAgentWorkspaces(),
    listBindings: async projectId => bindings.listProjectWorkspaceBindings(projectId),
    getBinding: async subject => ({ ok: true as const, value: ownerBinding.getOwnerRuntimeBinding(subject.projectId) }),
    ensureBinding: async subject => ({ ok: true as const, value: ownerBinding.getOwnerRuntimeBinding(subject.projectId) }),
    saveBinding: async request => ({ ok: true as const, value: ownerBinding.saveOwnerRuntimeBinding(request.projectId, request.expectedRevision, request.input) }),
    createWorkspace: async name => workspaces.createAgentWorkspace(name),
    bindWorkspace: async (projectId, workspaceId) => bindings.bindWorkspaceToProject(projectId, workspaceId),
    createEmployee: async input => ({ ...employees.createAgentEmployee(input), skills: [] }),
    authorizeOwnerManagement: async input => {
      const preview = delegation.previewOwnerManagementDelegation(input)
      return { ok: true as const, value: delegation.confirmOwnerManagementDelegation({ input, previewHash: preview.previewHash }) }
    },
  })
  const subject = { projectId: f.project.id }
  await state.set(goalAtoms.loadOwnerGoalAtom, subject)
  state.set(goalAtoms.editOwnerGoalAtom, { subject, patch: { objective: '为新产品确定首批用户和切入市场', constraintsText: '仅使用本项目资料', criteriaText: '结论附依据与主要不确定性' } })
  await state.set(setupAtoms.loadOwnerSetupAtom, subject)
  const stop = startOwnerManagementLoop()
  try {
    const planningPromise = state.set(setupAtoms.startOwnerPlanningWithBudgetAtom, { subject, budgetUsd: '15', hours: '24', authorizePlanning: true })
    await planningPromise
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'))
    const savedGoal = goals.getProjectOwnerGoalDraft(f.project.id)
    const proposedPlan = plans.getProjectOwnerPlanDraft(f.project.id)
    expect(savedGoal?.goal.objective).toBe('为新产品确定首批用户和切入市场')
    expect(proposedPlan?.state).toBe('proposed')
    expect(proposedPlan?.proposal.summary).toBe('按目标形成定位简报')
    expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged')).toBe(true)
    expect(calls.slice(callsBefore).filter(item => item.projectId === f.project.id).map(item => item.purpose)).toEqual(['owner_planning', 'owner_execution_assignment'])
    const arrangementCall = calls.find(item => item.projectId === f.project.id && item.purpose === 'owner_execution_assignment')
    if (!arrangementCall) throw new Error('Owner没有提交团队安排请求')
    expect([...arrangementCall.candidates].sort()).toEqual([f.executor.id, f.reviewer!.id].sort())
    const ownerExecutions = store.listAgentExecutionsByProject(f.project.id)
    expect(ownerExecutions.length).toBeGreaterThan(0)
    expect(ownerExecutions.every(item => item.agentId === f.owner.id)).toBe(true)
    for (const table of ['project_owner_execution_grants', 'project_owner_task_materializations']) expect(store.getProjectDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(f.project.id)).toEqual({ n: 0 })

    const executionAtoms = await import('../../renderer/atoms/project-owner-execution-atoms')
    const assignmentAtoms = await import('../../renderer/atoms/project-owner-execution-assignment-atoms')
    const taskAtoms = await import('../../renderer/atoms/project-owner-task-atoms')
    const revalidationAtoms = await import('../../renderer/atoms/project-owner-execution-revalidation-atoms')
    const grantAtoms = await import('../../renderer/atoms/project-owner-execution-grant-atoms')
    const deliveryAtoms = await import('../../renderer/atoms/owner-delivery-flow-atoms')
    const { registerProjectOwnerExecutionIpcHandlers } = await import('./project-owner-execution-ipc')
    registerProjectOwnerExecutionIpcHandlers({ handle: (channel, handler) => { ipcHandlers.set(channel, handler) } })
    const executionService = await import('./project-owner-execution-preparation')
    const taskService = await import('./project-owner-task-materialization')
    const revalidationService = await import('./project-owner-execution-revalidation')
    const grantService = await import('./project-owner-execution-grant-issue')
    const setup = await import('../../renderer/atoms/owner-execution-setup')
    state.set(assignmentAtoms.ownerExecutionAssignmentApiAtom, {
      prepareOwnerExecutionAssignment: async request => ({ ok: true as const, value: (await import('./project-owner-execution-assignment-service')).prepareOwnerExecutionAssignment(request, request.input) }),
      listOwnerExecutionAssignmentRuns: async subject => ({ ok: true as const, value: listOwnerExecutionAssignmentRuns(subject) }),
    })
    state.set(executionAtoms.ownerExecutionApiAtom, {
      getOwnerExecutionPreparation: async subject => ({ ok: true as const, value: executionService.getOwnerExecutionPreparation(subject) }),
      listOwnerExecutionPreparationHistory: async subject => ({ ok: true as const, value: executionService.listOwnerExecutionPreparationHistory(subject) }),
      previewOwnerExecutionPreparation: async request => ({ ok: true as const, value: executionService.previewOwnerExecutionPreparation(request, request.input) }),
      saveOwnerExecutionPreparation: async request => ({ ok: true as const, value: executionService.saveOwnerExecutionPreparation(request, request.input, request.previewFingerprint) }),
    })
    state.set(taskAtoms.ownerTaskApiAtom, {
      getOwnerTaskMaterialization: async subject => ({ ok: true as const, value: taskService.getOwnerTaskMaterialization(subject) }),
      listOwnerTaskMaterializationHistory: async subject => ({ ok: true as const, value: taskService.listOwnerTaskMaterializationHistory(subject) }),
      previewOwnerTaskMaterialization: async request => ({ ok: true as const, value: taskService.previewOwnerTaskMaterialization(request, request.input) }),
      materializeOwnerTasks: async request => ({ ok: true as const, value: taskService.materializeOwnerTasks(request, request.input, request.previewFingerprint) }),
    })
    state.set(taskAtoms.ownerTaskRefreshAtom, { listTasks: async () => undefined })
    state.set(revalidationAtoms.ownerRevalidationApiAtom, {
      getOwnerExecutionRevalidation: async subject => ({ ok: true as const, value: revalidationService.getOwnerExecutionRevalidation(subject) }),
      listOwnerExecutionRevalidationHistory: async subject => ({ ok: true as const, value: revalidationService.listOwnerExecutionRevalidationHistory(subject) }),
      previewOwnerExecutionRevalidation: async request => ({ ok: true as const, value: revalidationService.previewOwnerExecutionRevalidation(request, request.input) }),
      saveOwnerExecutionRevalidation: async request => ({ ok: true as const, value: revalidationService.saveOwnerExecutionRevalidation(request, request.input, request.previewFingerprint) }),
    })
    state.set(grantAtoms.ownerGrantApiAtom, {
      getOwnerExecutionGrant: async subject => ({ ok: true as const, value: grantService.getOwnerExecutionGrant(subject) }),
      listOwnerExecutionGrantHistory: async subject => ({ ok: true as const, value: grantService.listOwnerExecutionGrantHistory(subject) }),
      previewOwnerExecutionGrantIssue: async request => ({ ok: true as const, value: grantService.previewOwnerExecutionGrantIssue(request, request.input) }),
      confirmOwnerExecutionGrantIssue: async request => ({ ok: true as const, value: grantService.confirmOwnerExecutionGrantIssue(request, { input: request.input, preview: request.preview, confirmedFingerprint: request.confirmedFingerprint }) }),
      previewOwnerExecutionGrantRevoke: async request => ({ ok: true as const, value: grantService.previewOwnerExecutionGrantRevoke(request, { grantId: request.grantId }) }),
      confirmOwnerExecutionGrantRevoke: async request => ({ ok: true as const, value: grantService.confirmOwnerExecutionGrantRevoke(request, { grantId: request.grantId, confirmedFingerprint: request.confirmedFingerprint }) }),
    })
    state.set(deliveryAtoms.ownerExecutionLaunchApiAtom, {
      saveOwnerExecutionStartIntent: async request => await ipcHandlers.get(PROJECT_IPC_CHANNELS.SAVE_OWNER_EXECUTION_START_INTENT)!(undefined, request) as Awaited<ReturnType<ProjectOwnerExecutionLaunchApi['saveOwnerExecutionStartIntent']>>,
      resumeOwnerExecutionStartIntent: async request => await ipcHandlers.get(PROJECT_IPC_CHANNELS.RESUME_OWNER_EXECUTION_START_INTENT)!(undefined, request) as Awaited<ReturnType<ProjectOwnerExecutionLaunchApi['resumeOwnerExecutionStartIntent']>>,
    })
    const executionSubject = { projectId: f.project.id }
    await state.set(planAtoms.loadOwnerPlanAtom, executionSubject)
    await state.set(assignmentAtoms.loadOwnerExecutionAssignmentRunsAtom, executionSubject)
    await state.set(executionAtoms.loadOwnerExecutionAtom, executionSubject)
    const runs = assignmentAtoms.getOwnerExecutionAssignmentEditor(state.get(assignmentAtoms.ownerExecutionAssignmentEditorsAtom), executionSubject).runs
    const proposal = runs.at(-1)?.outcomes[0]?.assignmentProposal
    if (!proposal) throw new Error('Owner安排结果中缺少可确认的团队提案')
    const projectBudget = delegation.getOwnerManagementDelegation(f.project.id).delegation!
    const limits = setup.ownerExecutionSuggestedLimits(proposal.selectedStepKeys.length)
    const expiresAt = new Date(projectBudget.expiresAt - 60_000)
    expiresAt.setMinutes(expiresAt.getMinutes() - expiresAt.getTimezoneOffset())
    state.set(executionAtoms.editOwnerExecutionAtom, { subject: executionSubject, patch: {
      ...setup.ownerExecutionAssignmentEdit(proposal), ...limits,
      maxCostMicrosText: String(projectBudget.maxCostMicros - delegation.getOwnerManagementDelegation(f.project.id).reservedCostMicros),
      expiresAtText: expiresAt.toISOString().slice(0, 16),
      changeReason: '用户确认结果范围与项目总预算',
    } })
    expect(executionAtoms.ownerExecutionInput(state.get, executionSubject, true)).not.toBeNull()
    const scheduler = await import('./project-owner-autonomous-scheduler')
    const scheduleEvents = await import('./project-owner-autonomous-scheduler-events')
    const stopWake = scheduleEvents.onOwnerAutonomousScheduleWake(projectId => { if (projectId === f.project.id) void scheduler.runOwnerAutonomousSchedule(projectId) })
    try {
      await state.set(deliveryAtoms.reviewOwnerManagedExecutionAtom, executionSubject)
      await until(() => store.listAgentExecutionsByProject(f.project.id).some(item => item.ownerCommandId && item.status === 'completed'))
      await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'delivery' || item.kind === 'attention'))
      if (!getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'delivery')) {
        const outcomes = store.getProjectDb().prepare('SELECT e.status,e.error,o.payload FROM agent_executions e LEFT JOIN project_owner_planning_run_outcomes o ON o.execution_id=e.id WHERE e.project_id=?').all(f.project.id)
        const commands = store.getProjectDb().prepare('SELECT role,state,execution_id FROM project_owner_execution_commands WHERE project_id=?').all(f.project.id)
        const reviews = store.getProjectDb().prepare('SELECT verdict,response_json FROM project_owner_technical_reviews WHERE project_id=?').all(f.project.id)
        throw new Error(`Owner交付未完成：${JSON.stringify({ outcomes, commands, reviews })}`)
      }
      expect(getOwnerManagementConversation(f.project.id).messages.filter(item => item.kind === 'attention').map(item => item.content)).toEqual([])
      const intent = store.getProjectDb().prepare('SELECT state,grant_id FROM project_owner_execution_start_intents WHERE project_id=?').get(f.project.id) as { state: string; grant_id: string }
      expect(intent.state).toBe('completed')
      expect(intent.grant_id).toBeTruthy()
      expect(plans.getProjectOwnerPlanDraft(f.project.id)?.state).toBe('confirmed')
      expect(grantService.getOwnerExecutionGrant(executionSubject)?.dispatchMode).toBe('autonomous')
      expect(store.getProjectDb().prepare('SELECT role,state FROM project_owner_execution_commands WHERE project_id=? ORDER BY role').all(f.project.id)).toEqual([{ role: 'executor', state: 'settled' }, { role: 'reviewer', state: 'settled' }])
      expect(store.getProjectDb().prepare("SELECT json_extract(payload,'$.state') AS state FROM project_owner_quality_actions WHERE project_id=?").all(f.project.id)).toEqual([{ state: 'accepted' }])
      const delivery = getOwnerManagementConversation(f.project.id).messages.find(item => item.kind === 'delivery')
      expect(delivery?.conversationId).toBe(getOwnerManager(f.project.id)?.conversationId)
      expect(delivery?.delivery?.items[0]?.content).toContain('已整理目标范围、证据和取舍')
      expect(calls.filter(item => item.projectId === f.project.id).map(item => item.purpose)).toEqual(['owner_planning', 'owner_execution_assignment', 'owner_quality'])
    } finally { stopWake() }
  } finally {
    stop()
    const grant = delegation.getOwnerManagementDelegation(f.project.id)
    if (grant.state === 'active' && grant.delegation) delegation.revokeOwnerManagementDelegation(f.project.id, grant.delegation.id)
  }
})

test('Given 首次待审方案及项目绑定资料 When Owner自主安排 Then 保留资料范围完成启动绑定并仅显示真实门禁', async () => {
  const f = fixture()
  const sourceDirectory = join(directory, `knowledge-${randomUUID()}`)
  mkdirSync(sourceDirectory, { recursive: true })
  writeFileSync(join(sourceDirectory, 'brief.md'), '# 项目资料\n\n仅用于核对资料是否进入冻结执行范围。', 'utf8')
  const catalog = await import('./knowledge-catalog-service')
  const source = catalog.createSource({ type: 'vault', name: '项目授权资料', locator: sourceDirectory })
  const knowledgeBase = catalog.createKnowledgeBase({ name: '项目资料库', sourceIds: [source.id] })
  catalog.bindProject({ projectId: f.project.id, knowledgeBaseId: knowledgeBase.id })
  const input = { ...f.subject, requestId: randomUUID(), maxRequests: Number.MAX_SAFE_INTEGER, autonomousExecution: true as const, maxCostMicros: 15_000_000, expiresAt: Date.now() + 24 * 3600000 }
  const preview = delegation.previewOwnerManagementDelegation(input)
  const issued = delegation.confirmOwnerManagementDelegation({ input, previewHash: preview.previewHash })
  const scheduler = await import('./project-owner-autonomous-scheduler'), scheduleEvents = await import('./project-owner-autonomous-scheduler-events')
  const stopWake = scheduleEvents.onOwnerAutonomousScheduleWake(projectId => { if (projectId === f.project.id) void scheduler.runOwnerAutonomousSchedule(projectId) })
  const stop = startOwnerManagementLoop()
  try {
    await until(() => {
      const intent = store.getProjectDb().prepare("SELECT state FROM project_owner_execution_start_intents WHERE project_id=?").get(f.project.id) as { state: string } | undefined
      return intent?.state === 'completed'
    })
    expect(plans.getProjectOwnerPlanDraft(f.project.id)?.state).toBe('confirmed')
    expect(plans.getProjectOwnerPlanDraft(f.project.id)?.actor).toBe('system:owner-manager')
    expect(calls.some(item => item.projectId === f.project.id && item.purpose === 'owner_execution_assignment')).toBe(true)
    const intent = store.getProjectDb().prepare('SELECT payload,state,grant_id FROM project_owner_execution_start_intents WHERE project_id=?').get(f.project.id) as { payload: string; state: string; grant_id: string }
    expect(intent).toBeTruthy()
    expect(intent.state).toBe('completed')
    expect(intent.grant_id).toBeTruthy()
    expect(JSON.parse(intent.payload).input.knowledgeSourceIds).toEqual([source.id])
    expect(JSON.parse(intent.payload).input).toMatchObject({ maxRework: 2, maxRuns: 6 })
    const prep = (await import('./project-owner-execution-preparation')).getOwnerExecutionPreparation(f.subject)
    expect(prep.blockers).not.toContain('尚无权威业务任务与步骤关联，不能发行执行许可')
    expect(prep.blockers).not.toContain('执行侧资料与逐请求Owner来源门禁尚未接通')
    expect(prep.blockers).not.toContain('拟议预算不是已预留额度，不承诺金额硬封顶')
    expect(prep.blockers).not.toContain('非代码Pilot发行与资料适配器尚未接通')
    expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'management_progress' && item.content.includes('正在按你确认的方案和预算核验工作范围并启动团队'))).toBe(true)
  } finally { stopWake(); stop(); delegation.revokeOwnerManagementDelegation(f.project.id, issued.id) }
}, 15000)

test('Given 旧启动意图按方案顺序选择了executor When岗位冻结按roleKey排序 Then 自动对齐兼容输入并安全续接原意图', async () => {
  const f = fixture('complete', false, false)
  const visual = employees.createAgentEmployee({ name: '视觉设计师', role: '视觉设计师', roleTemplateId: 'visual-designer', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: f.owner.channelId, modelId: f.owner.modelId, workspaceIds: [f.workspace.id] })
  const context = plans.getProjectOwnerPlanningContext(f.project.id)!
  plans.saveProjectOwnerPlanDraft(f.project.id, 1, 0, {
    expectedContextFingerprint: context.fingerprint,
    summary: '按不同顺序完成两项成果', assumptions: [], risks: [],
    steps: [
      { key: 'visual', title: '先完成视觉', outcome: '视觉说明', acceptanceCriteria: ['布局清晰'], dependencies: [], roleKey: 'visual-designer' },
      { key: 'requirements', title: '再完成需求', outcome: '需求说明', acceptanceCriteria: ['规则清楚'], dependencies: ['visual'], roleKey: 'requirements-analyst' },
    ],
    changeReason: '覆盖方案顺序与稳定岗位排序不同的旧启动意图',
  })
  const issued = authorize(f, true)
  const { getOwnerExecutionPreparation } = await import('./project-owner-execution-preparation')
  const { saveOwnerExecutionStartIntent, resumeOwnerExecutionStartIntent } = await import('./project-owner-execution-start-intent')
  const plan = plans.getProjectOwnerPlanDraft(f.project.id)!
  const input: OwnerExecutionPreparationInput = {
    requestId: randomUUID(), expectedPreparationRevision: 0, expectedPolicyRevision: null,
    expectedGoalRevision: plan.goalRevision, expectedPlanRevision: plan.revision,
    selectedStepKeys: ['visual', 'requirements'], executionKind: 'controlled', employeeRuntimeVersion: 2,
    textDeliveryVersion: 1, qualityManagementVersion: 1,
    executorEmployeeId: visual.id, reviewerEmployeeId: f.reviewer!.id,
    roleAssignments: [
      { roleKey: 'requirements-analyst', employeeId: f.executor.id },
      { roleKey: 'visual-designer', employeeId: visual.id },
    ],
    workspaceId: f.workspace.id, acknowledgeOwnerWorkspaceOverride: true, knowledgeSourceIds: [],
    maxCostMicros: issued.maxCostMicros, maxRuns: 12, maxRework: 2,
    expiresAt: issued.expiresAt, changeReason: '用户已确认方案范围与项目预算',
  }
  const intent = saveOwnerExecutionStartIntent({ ...f.subject, intentId: input.requestId, expectedGoalRevision: plan.goalRevision,
    expectedPlanRevision: plan.revision, planFingerprint: plan.planFingerprint, contextFingerprint: plan.contextFingerprint, input })
  await expect(resumeOwnerExecutionStartIntent(intent.intentId, undefined, { launch: async () => { throw new Error('TEST_STOP_BEFORE_PROVIDER') } })).rejects.toThrow('TEST_STOP_BEFORE_PROVIDER')
  const preparation = getOwnerExecutionPreparation(f.subject).preparation
  expect(preparation?.input.roleAssignments?.map(item => item.roleKey)).toEqual(['requirements-analyst', 'visual-designer'])
  expect(preparation?.input.executorEmployeeId).toBe(f.executor.id)
  expect(store.getProjectDb().prepare('SELECT state FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id)).toBeUndefined()
  delegation.revokeOwnerManagementDelegation(f.project.id, issued.id)
})

test('Given Owner规划请求执行中持续管理授权被撤销 When提案返回 Then保存方案但不准备团队安排并明确显示未派工', async () => {
  const f = fixture('complete', false, false)
  let markStarted!: () => void, releaseResponse!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
  nextOwnerPlanningResponseGate = { started: markStarted, wait: responseGate }
  const issued = authorize(f, true), stop = startOwnerManagementLoop()
  try {
    await started
    delegation.revokeOwnerManagementDelegation(f.project.id, issued.id)
    releaseResponse()
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'plan_proposal'))
    const proposalMessage = getOwnerManagementConversation(f.project.id).messages.find(item => item.kind === 'plan_proposal')
    expect(proposalMessage?.content).toContain('当前持续管理授权已失效')
    expect(proposalMessage?.content).toContain('没有安排团队或启动员工')
    expect(plans.getProjectOwnerPlanDraft(f.project.id)?.state).toBe('proposed')
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(0)
    expect(calls.filter(item => item.projectId === f.project.id && item.purpose === 'owner_execution_assignment')).toHaveLength(0)
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_owner_execution_commands WHERE project_id=?').get(f.project.id)).toMatchObject({ n: 0 })
  } finally {
    releaseResponse()
    nextOwnerPlanningResponseGate = null
    stop()
    delegation.revokeOwnerManagementDelegation(f.project.id, issued.id)
  }
}, 15000)

test('Given 最后一次管理请求用于团队安排 When 安排完成但预算请求数已耗尽 Then Owner停住并说明未启动员工', async () => {
  const f = fixture(), proposed = f.plan!
  const input = { ...f.subject, requestId: randomUUID(), maxRequests: 1, maxCostMicros: 15_000_000, expiresAt: Date.now() + 24 * 3600000,
    startApproval: { expectedGoalRevision: proposed.goalRevision, expectedPlanRevision: proposed.revision, planFingerprint: proposed.planFingerprint, contextFingerprint: proposed.contextFingerprint } }
  const preview = delegation.previewOwnerManagementDelegation(input)
  const issued = delegation.confirmOwnerManagementDelegation({ input, previewHash: preview.previewHash }), stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'attention' && item.content.includes('预算')))
    expect(store.getProjectDb().prepare("SELECT COUNT(*) AS n FROM project_owner_execution_start_intents WHERE project_id=?").get(f.project.id)).toMatchObject({ n: 0 })
    expect(store.getProjectDb().prepare("SELECT COUNT(*) AS n FROM project_owner_execution_grants WHERE project_id=?").get(f.project.id)).toMatchObject({ n: 0 })
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, issued.id) }
})

test('Given 已确认方案但没有管理委托 When 后台处理 Then 仅准备一次不收费，重开及重复确认复用同记录', async () => {
  const f = fixture(); confirm(f); reconcileOwnerManagement(f.project.id)
  const first = listOwnerExecutionAssignmentRuns(f.subject)
  expect(first).toHaveLength(1)
  store.closeProjectDb(); await store.initProjectDb()
  const stop = startOwnerManagementLoop()
  try {
    plans.confirmProjectOwnerPlanDraft(f.project.id, 1, 2); reconcileOwnerManagement(f.project.id)
    expect(listOwnerExecutionAssignmentRuns(f.subject)[0]?.link.id).toBe(first[0]?.link.id)
    expect(calls.filter(item => item.projectId === f.project.id)).toHaveLength(0)
  } finally { stop() }
}, 15_000)

test('Given 现有团队缺独立评审 When 确认方案 Then 说明阻塞和可调整边界，不浪费安排请求', async () => {
  for (const team of ['missing-reviewer'] as const) {
    const f = fixture(team), grant = authorize(f); confirm(f); reconcileOwnerManagement(f.project.id)
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(0)
    const attention = getOwnerManagementConversation(f.project.id).messages.find(item => item.kind === 'attention')
    expect(attention?.content).toContain('还没有派工')
    expect(attention?.content).toContain('工作尚未开始')
    expect(attention?.content).toContain('团队配置发生变化时自动重新核对')
    expect(delegation.getOwnerManagementDelegation(f.project.id).usedRequests).toBe(0)
    delegation.revokeOwnerManagementDelegation(f.project.id, grant.id)
  }
})

test('Given 获准工作区没有可执行员工 When 确认方案 Then 明确说明未派工并询问是否调整授权范围', () => {
  const f = fixture(), grant = authorize(f)
  try {
    employees.updateAgentEmployee(f.executor.id, { enabled: false })
    employees.updateAgentEmployee(f.reviewer!.id, { enabled: false })
    confirm(f)
    reconcileOwnerManagement(f.project.id)
    const attention = getOwnerManagementConversation(f.project.id).messages.find(item => item.kind === 'attention')
    expect(attention?.content).toContain('还没有派工')
    expect(attention?.content).toContain('工作尚未开始')
    expect(attention?.content).toContain('扩大项目资料范围也不能解决当前团队配置问题')
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(0)
  } finally { delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given 待审方案缺少独立评审 When Owner尝试准备团队 Then 不声称范围已确认并说明下一步', async () => {
  const f = fixture('missing-reviewer', false, false), grant = authorize(f), stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'attention'))
    const attention = getOwnerManagementConversation(f.project.id).messages.find(item => item.kind === 'attention')
    expect(plans.getProjectOwnerPlanDraft(f.project.id)?.state).toBe('proposed')
    expect(attention?.content).toContain('方案仍待你确认')
    expect(attention?.content).toContain('还没有派工')
    expect(attention?.content).toContain('团队配置发生变化时自动重新核对')
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(0)
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
}, 15_000)

test('Given 已确认方案因缺评审受阻 When 新建合格员工 Then 持久团队事件自动恢复安排且重复变化不重复请求', async () => {
  const f = fixture('missing-reviewer'), grant = authorize(f), stop = startOwnerManagementLoop()
  try {
    confirm(f)
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'attention' && item.content.includes('还没有派工')))
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(0)
    const reviewer = employees.createAgentEmployee({ name: '独立检查', role: '交付检查', roleTemplateId: 'delivery-verifier', description: '检查成果与标准', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: employees.getAgentEmployee(f.executor.id)!.channelId, modelId: 'deepseek-flash', workspaceIds: [f.workspace.id] })
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'))
    expect(reviewer.enabled).toBe(true)
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(1)
    expect(calls.filter(item => item.projectId === f.project.id)).toHaveLength(1)
    employees.updateAgentEmployee(reviewer.id, { description: '继续独立检查成果与标准' })
    await until(() => getOwnerManagementView(f.project.id).pendingEvents === 0)
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(1)
    expect(calls.filter(item => item.projectId === f.project.id)).toHaveLength(1)
  } finally { delegation.revokeOwnerManagementDelegation(f.project.id, grant.id); stop() }
}, 30_000)

test('Given Owner暂停时团队能力变化 When恢复管理循环 Then累积事件自动重评且只建立一次安排', async () => {
  const f = fixture('missing-reviewer'), grant = authorize(f), stop = startOwnerManagementLoop()
  try {
    confirm(f)
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'attention' && item.content.includes('还没有派工')))
    const manager = getOwnerManager(f.project.id)!
    setOwnerManagerStatus(f.project.id, manager.revision, 'paused')
    employees.createAgentEmployee({ name: '独立检查', role: '交付检查', roleTemplateId: 'delivery-verifier', description: '检查成果与标准', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: employees.getAgentEmployee(f.executor.id)!.channelId, modelId: 'deepseek-flash', workspaceIds: [f.workspace.id] })
    reconcileOwnerManagement(f.project.id)
    expect(getOwnerManagementView(f.project.id).pendingEvents).toBeGreaterThan(0)
    const paused = getOwnerManager(f.project.id)!
    setOwnerManagerStatus(f.project.id, paused.revision, 'active')
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'))
    await until(() => getOwnerManagementView(f.project.id).pendingEvents === 0)
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(1)
    expect(calls.filter(item => item.projectId === f.project.id)).toHaveLength(1)
  } finally { delegation.revokeOwnerManagementDelegation(f.project.id, grant.id); stop() }
}, 20_000)

test('Given 员工新增与团队事件同事务 When 外层写入回滚 Then 员工和唤醒事件一并回滚', () => {
  const f = fixture(), database = store.getProjectDb()
  const employeeCount = employees.listAgentEmployees().length
  const eventCount = database.prepare('SELECT COUNT(*) AS n FROM project_owner_management_events WHERE project_id = ?').get(f.project.id) as { n: number }
  expect(() => database.transaction(() => {
    employees.createAgentEmployee({ name: '回滚员工', role: '研究', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: employees.getAgentEmployee(f.executor.id)!.channelId, modelId: 'deepseek-flash', workspaceIds: [f.workspace.id] })
    throw new Error('回滚员工与团队事件')
  })()).toThrow('回滚员工与团队事件')
  const nextEventCount = database.prepare('SELECT COUNT(*) AS n FROM project_owner_management_events WHERE project_id = ?').get(f.project.id) as { n: number }
  expect(employees.listAgentEmployees()).toHaveLength(employeeCount)
  expect(nextEventCount.n).toBe(eventCount.n)
}, 15_000)

test('Given 确认事务回滚或旧方案来源失效 When 后台处理 Then 不安排旧方案，任务级目标也准确隔离', () => {
  const f = fixture()
  expect(() => store.getProjectDb().transaction(() => { confirm(f); throw new Error('rollback') })()).toThrow('rollback')
  reconcileOwnerManagement(f.project.id)
  expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(0)
  confirm(f)
  saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '修改后的目标' })
  reconcileOwnerManagement(f.project.id)
  expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(0)
  const task = fixture('complete', true); confirm(task); reconcileOwnerManagement(task.project.id)
  expect(listOwnerExecutionAssignmentRuns(task.subject)[0]?.link.targetTaskId).toBe(task.taskId)
  expect(listOwnerExecutionAssignmentRuns({ projectId: task.project.id })).toHaveLength(0)
}, 20_000)


test('Given项目已有general员工且无精确模板 When确认方案 Then后台用既有能力形成安排、不改员工档案或让用户重建', async () => {
  for (const team of ['general', 'missing-role', 'mixed'] as const) {
    const f = fixture(team), grant = authorize(f), stop = startOwnerManagementLoop()
    try {
      const before = employees.listAgentEmployees().filter(item => [f.executor.id, f.reviewer!.id].includes(item.id))
      confirm(f)
      await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged')).catch(cause => { throw new Error(`${String(cause)}：${JSON.stringify(listOwnerExecutionAssignmentRuns(f.subject).map(run => ({ outcomes: run.outcomes, executions: run.executions })))}`) })
      const result = listOwnerExecutionAssignmentRuns(f.subject)[0]!.outcomes[0]!.assignmentProposal!
      expect(result.assignments).toMatchObject([{ employeeId: f.executor.id, roleKey: 'requirements-analyst' }])
      expect(result.reviewerEmployeeId).toBe(f.reviewer!.id)
      const after = employees.listAgentEmployees().filter(item => [f.executor.id, f.reviewer!.id].includes(item.id))
      expect(after.map(item => ({ id: item.id, profile: item.executionProfile, template: item.roleTemplateId, channel: item.channelId, model: item.modelId }))).toEqual(before.map(item => ({ id: item.id, profile: item.executionProfile, template: item.roleTemplateId, channel: item.channelId, model: item.modelId })))
      expect(delegation.getOwnerManagementDelegation(f.project.id).usedRequests).toBe(1)
    } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
  }
}, 30_000)

test('Given历史完整安排仅因空代码范围被拒绝 When本地恢复并对账 Then保留原失败和费用且不新增安排请求', async () => {
  const f = fixture()
  confirm(f)
  const grant = authorize(f, true), before = calls.length
  legacyNullScopeProjectId = f.project.id
  const stop = startOwnerManagementLoop()
  try {
    await until(() => (store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_owner_planning_run_recoveries r JOIN agent_executions e ON e.id=r.execution_id WHERE e.project_id=?').get(f.project.id) as { n: number }).n === 1)
    const row = store.getProjectDb().prepare('SELECT o.execution_id, o.payload FROM project_owner_planning_run_outcomes o JOIN project_owner_planning_run_recoveries r ON r.execution_id=o.execution_id JOIN agent_executions e ON e.id=o.execution_id WHERE e.project_id=?').get(f.project.id) as { execution_id: string; payload: string }
    expect(JSON.parse(row.payload)).toMatchObject({ state: 'failed', detail: '受控非研发安排不得包含代码范围' })
    const runService = await import('./project-owner-planning-run-service')
    expect(runService.getOwnerPlanningRunOutcome(row.execution_id)).toMatchObject({ state: 'proposed', assignmentProposal: { executionKind: 'controlled' } })
    expect(runService.getOwnerPlanningRunReceipt(JSON.parse(row.payload).receiptId)?.cost).toEqual({ source: 'unknown', usd: null })
    reconcileOwnerManagement(f.project.id)
    reconcileOwnerManagement(f.project.id)
    expect(calls.slice(before).filter(item => item.projectId === f.project.id && item.purpose === 'owner_execution_assignment')).toHaveLength(1)
    expect(store.getAgentExecution(row.execution_id)?.status).toBe('failed')
    expect((store.getProjectDb().prepare("SELECT COUNT(*) AS n FROM project_owner_management_events WHERE project_id=? AND json_extract(payload,'$.kind')='assignment_result' AND json_extract(payload,'$.sourceId')=?").get(f.project.id, row.execution_id) as { n: number }).n).toBe(2)
  } finally { legacyNullScopeProjectId = null; stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
}, 15_000)

test('Given 失败详情含凭据或换行 When 生成用户原因 Then 脱敏截断且保留可核对信息', async () => {
  const { ownerAssignmentFailureReason } = await import('./project-owner-management-assignment')
  expect(ownerAssignmentFailureReason('Owner人员安排提案格式无效或夹带未授权字段')).toBe('Owner人员安排提案格式无效或夹带未授权字段')
  expect(ownerAssignmentFailureReason('bad Bearer abc123\napi_key=sk-secret123456789')).not.toContain('abc123')
  expect(ownerAssignmentFailureReason('x'.repeat(400)).length).toBe(240)
})

test('Given 结构不合规的失败 When 判断可恢复 Then 允许在原预算内重排一次', async () => {
  const { isRecoverableOwnerAssignmentRejection } = await import('./project-owner-management-assignment')
  expect(isRecoverableOwnerAssignmentRejection('Owner人员安排提案格式无效或夹带未授权字段')).toBe(true)
  expect(isRecoverableOwnerAssignmentRejection('Owner人员安排缺少工作区')).toBe(false)
})
