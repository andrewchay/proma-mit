import { afterAll, beforeAll, expect, mock, spyOn, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { createStore } from 'jotai'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OwnerExecutionPreparationInput, ProjectOwnerExecutionLaunchApi, ProjectOwnerPlanDraft } from '@gravitas/shared'
import type { OwnerQualityAction } from './project-owner-quality-actions'
import { PROJECT_IPC_CHANNELS } from '@gravitas/shared'
const directory = mkdtempSync(join(tmpdir(), 'owner-quality-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const store = await import('./project-sqlite-store'), employees = await import('./agent-employee-service')
const workspaces = await import('./agent-workspace-manager'), channels = await import('./channel-manager')
const goals = await import('./project-owner-goal-service'), plans = await import('./project-owner-plan-service')
const binding = await import('./project-owner-runtime-binding'), prep = await import('./project-owner-execution-preparation')
const material = await import('./project-owner-task-materialization'), delegation = await import('./project-owner-management-delegation')
const management = await import('./project-owner-management-loop'), source = await import('./project-owner-planning-source')
const actions = await import('./project-owner-quality-actions'), scheduler = await import('./project-owner-autonomous-scheduler')
const runs = await import('./project-owner-planning-run-service')
const boundary = await import('./controlled-provider-boundary'), registry = await import('./agent-headless-runner-registry')
const { claimOwnerPlanningProviderRequest } = await import('./project-owner-planning-provider')
const { onOwnerAutonomousScheduleWake } = await import('./project-owner-autonomous-scheduler-events')
const executionLaunch = await import('./project-owner-execution-launch')
const executionGrants = await import('./project-owner-execution-grant-issue')
const { registerProjectOwnerExecutionIpcHandlers } = await import('./project-owner-execution-ipc')
const { sendOwnerManagementMessage } = await import('./project-owner-management-conversation')
const managementConversation = await import('./project-owner-management-questions')
const rendererDeliveryFlow = await import('../../renderer/atoms/owner-delivery-flow-atoms')
const rendererExecution = await import('../../renderer/atoms/project-owner-execution-atoms')
const rendererPlan = await import('../../renderer/atoms/project-owner-plan-atoms')
const rendererGoal = await import('../../renderer/atoms/project-owner-goal-atoms')
const ipcHandlers = new Map<string, (event: unknown, request: unknown) => unknown>()
registerProjectOwnerExecutionIpcHandlers({ handle: (channel, handler) => { ipcHandlers.set(channel, handler) } })
interface Scenario { extraQualityCriteria?: boolean; omitQualityKind?: boolean; rework?: boolean; ownerDefect?: boolean; dependent?: boolean; hold?: boolean; maxRework?: number; legacy?: boolean; development?: boolean; validationFails?: boolean; durableStartIntent?: boolean; emptyReview?: boolean }
interface Trace { role: string; taskId: string; round: number; prompt: string }
const scenarios = new Map<string, Scenario>(), traces = new Map<string, Trace[]>()
const pending = new Map<string, { finish: () => void; executionId: string }>()
beforeAll(async () => {
  await store.initProjectDb()
  registry.setHeadlessAgentRunner(async (input, callbacks) => {
    callbacks.onRuntimeStarted?.()
    const execution = store.getAgentExecutionBySessionId(input.sessionId)!, scenario = scenarios.get(execution.projectId)!
    const log = traces.get(execution.projectId)!
    if (execution.ownerCommandId) {
      const command = store.getProjectDb().prepare('SELECT role,rework_ordinal FROM project_owner_execution_commands WHERE id=?').get(execution.ownerCommandId) as { role: string; rework_ordinal: number }
      const development = (await import('./project-owner-employee-runtime')).readOwnerCommandFrozenSource(execution.ownerCommandId).source.executionKind === 'development'
      log.push({ role: command.role, taskId: execution.entityId, round: command.rework_ordinal, prompt: input.userMessage })
      const workspace = workspaces.getAgentWorkspace(store.getTask(execution.entityId)!.workspaceId!)!
      if (development && command.role === 'executor' && command.rework_ordinal > 0) expect(readFileSync(join(workspaces.getAgentWorkspaceCwd(workspace,input.sessionId),'src/solution.cjs'),'utf8')).toContain('answer: 42')
      if (development && command.role === 'executor') writeFileSync(join(workspaces.getAgentWorkspaceCwd(workspace, input.sessionId), 'src/solution.cjs'), `module.exports = { answer: ${scenario.validationFails ? 0 : 42} }\n`)
      const transport = Object.assign(async () => new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } }), { headers: { 'content-type': 'application/json' } }), { preconnect: () => {} }) as typeof globalThis.fetch
      const fetch = boundary.createControlledProviderFetch(input.sessionId, () => ({ runtime: 'ai-sdk', cwd: workspaces.getAgentWorkspaceCwd(workspace, input.sessionId), modelId: input.modelId!, permissionMode: 'safe' }), transport)
      await fetch('https://example.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: input.modelId, max_tokens: 100, messages: [{ role: 'user', content: input.userMessage }] }) })
      let content = command.rework_ordinal || !scenario.rework ? '目标范围：面向已访谈的现有用户，建议有据可查。' : '目标范围：面向用户，尚未说明受众依据。'
      if (command.role === 'reviewer') {
        if (development) {
          const artifact = (await import('./project-owner-development-artifact')).ownerDevelopmentArtifactFromPrompt(input.userMessage)!
          content = JSON.stringify({ schemaVersion: 3, artifactHash: artifact.contentHash, verdict: 'approved', summary: '代码快照及成功验证符合范围。', criteria: [{ criterion: '代码输出固定42', status: 'met', evidence: '冻结快照包含实现，白名单验证成功', quote: scenario.validationFails ? 'answer: 0' : 'answer: 42' }], findings: [], blockerReason: null })
        } else {
          const artifact = (await import('./project-owner-text-delivery')).assertOwnerReviewerTextDelivery(execution.ownerCommandId)!
          const change = scenario.rework && !scenario.ownerDefect && command.rework_ordinal === 0
          content = JSON.stringify({ schemaVersion: 2, artifactHash: artifact.contentSha256, verdict: change ? 'changes_requested' : 'approved', summary: change ? '缺少受众依据' : '范围清楚', criteria: [{ criterion: '明确目标范围与受众依据', status: change ? 'not_met' : 'met', evidence: change ? '未说明受众依据' : '有明确范围', quote: change ? null : artifact.content }], findings: change ? [{ severity: 'high', description: '未说明受众依据', requestedChange: '补充依据与适用范围' }] : [], blockerReason: null })
        }
      }
      callbacks.onComplete(scenario.emptyReview && command.role === 'reviewer' ? [] : [{ id: randomUUID(), role: 'assistant', content, createdAt: Date.now() }])
      return
    }
    const current = source.resolveOwnerPlanningSession(input.sessionId)!, conversation = current.context.conversation!
    claimOwnerPlanningProviderRequest(input.sessionId, JSON.stringify({ model: current.binding.modelId, stream: true, max_tokens: current.link.maxOutputTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: current.request.systemPrompt }, { role: 'user', content: current.request.userPrompt }] }), new URL('https://example.invalid/v1/chat/completions'))
    if (current.link.purpose === 'owner_execution_assignment') {
      const context = current.assignmentContext!
      const reviewers = context.candidates.filter(item => item.id !== context.candidates[0]?.id)
      const reviewer = reviewers.find(item => ['reviewer', 'delivery-verifier'].includes(item.roleTemplateId ?? '')) ?? reviewers[0]
      if (!reviewer) throw new Error('反馈续做场景缺少独立评审候选')
      const assignments = [...new Set(context.steps.map(step => step.roleKey))].map(roleKey => ({
        roleKey,
        employeeId: context.candidates.find(item => item.id !== reviewer.id && (item.roleTemplateId === roleKey || item.roleTemplateId === undefined))!.id,
        reason: '符合当前岗位能力与项目范围',
      }))
      const response = { schemaVersion: 1, contextFingerprint: context.contextFingerprint, selectedStepKeys: context.steps.map(step => step.key), scopeReason: '按已确认目标继续修订成果', workspaceId: context.workspaces[0]!.id, workspaceReason: '沿用本项目授权资料空间', executionKind: 'controlled', executionKindReason: '使用当前非代码交付方式', assignments, reviewerEmployeeId: reviewer.id, reviewerReason: '独立检查修订后的成果' }
      log.push({ role: 'owner_arrangement', taskId: execution.entityId, round: 0, prompt: current.request.userPrompt })
      callbacks.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: execution.sessionId, finish_reason: 'stop', result: JSON.stringify(response), owner_planning_usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null }, usage: { input_tokens: 10, output_tokens: 20 } } })
      return
    }
    const delivery = conversation.deliveryReview
    if (conversation.deliveryFeedback) {
      const feedback = conversation.deliveryFeedback
      const roleKey = current.context.sources.roles[0]!.key
      const response = { schemaVersion: 1, kind: 'plan_proposal', binding: { projectId: execution.projectId, goalVersion: current.context.goal.goal.goalVersion, contextFingerprint: current.context.fingerprint }, proposal: {
        summary: '在原交付基础上补充用户指定的目标用户分析，并保留原有结论依据', assumptions: [], risks: [],
        steps: [{ key: 'revise-delivery', title: '按反馈修订定位建议', outcome: '交付补充目标用户分析的新版建议', acceptanceCriteria: feedback.acceptanceCriteria, dependencies: [], roleKey }],
        deliveryFeedbackAssessment: { messageId: feedback.messageId, artifactHash: feedback.artifactHash, ...(feedback.stepKey ? { stepKey: feedback.stepKey } : {}), summary: '本次修改针对已验收成果的目标用户分析补充', changes: feedback.acceptanceCriteria.map(criterion => ({ criterion, disposition: 'addressed', proposedChange: '在新版中补充对应分析并保留可核对依据' })), authorizationImpact: 'within_confirmed_boundary', authorizationRationale: '修改仍在原目标和交付边界内；旧执行许可不会沿用，需确认本次方案后再执行' },
      } }
      log.push({ role: 'owner_feedback', taskId: current.context.conversation?.tasks[0]?.id ?? '', round: 0, prompt: current.request.userPrompt })
      callbacks.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: execution.sessionId, finish_reason: 'stop', result: JSON.stringify(response), owner_planning_usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null }, usage: { input_tokens: 10, output_tokens: 20 } } })
      return
    }
    const observed = conversation.executionObservation!
    const artifactHash = delivery?.developmentArtifact?.contentHash ?? delivery?.artifact?.contentSha256
    const artifactContent = delivery?.developmentArtifact?.content ?? delivery?.artifact?.content
    const artifactRound = delivery?.developmentArtifact?.reworkOrdinal ?? delivery?.artifact?.reworkOrdinal ?? 0
    log.push({ role: delivery?.qualityDecisionVersion ? 'owner_quality' : 'owner_analysis', taskId: observed.businessTaskId, round: artifactRound, prompt: current.request.userPrompt })
    const responseBinding = { projectId: execution.projectId, goalVersion: current.context.goal.goal.goalVersion, contextFingerprint: current.context.fingerprint }
    const defect = Boolean(scenario.rework && artifactRound === 0)
    const decision = { reviewerCommandId: observed.commandId, artifactHash, verdict: defect ? 'rework' : 'accept', reason: defect ? '受众依据仍缺，不能只看格式通过' : '已按准确范围标准核对完整成果与独立检查', criteria: [{ criterion: delivery?.developmentArtifact ? '代码输出固定42' : '明确目标范围与受众依据', status: defect ? 'not_met' : 'met', evidence: defect ? '正文未说明受众依据' : '范围与依据对应', quote: artifactContent }], findings: defect ? [{ severity: 'high', description: '受众依据未交代', requestedChange: '补充受众依据并保留明确范围' }] : [] }
    if (scenario.extraQualityCriteria && delivery?.qualityDecisionVersion === 1) decision.criteria.push({ criterion: '明确范围', status: 'met', evidence: '额外已满足项目标准', quote: artifactContent })
    const response = delivery?.qualityDecisionVersion === 1 ? { schemaVersion: 1, kind: 'quality_decision', binding: responseBinding, messageId: conversation.throughMessageId, message: '已按完整成果逐项判断，待服务核验决定。', decision } : { schemaVersion: 1, kind: 'conversation_reply', binding: responseBinding, messageId: conversation.throughMessageId, message: '成果已收到，等待独立检查和质量判断。' }
    const { kind: _kind, ...withoutKind } = response
    const finish = () => callbacks.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: execution.sessionId, finish_reason: 'stop', result: JSON.stringify(scenario.omitQualityKind && delivery?.qualityDecisionVersion === 1 ? withoutKind : response), owner_planning_usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null }, usage: { input_tokens: 10, output_tokens: 20 } } })
    if (scenario.hold && delivery?.qualityDecisionVersion) pending.set(execution.projectId, { finish, executionId: execution.id })
    else finish()
  })
})
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
async function until(predicate: () => boolean, projectId?: string) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const tasks = projectId ? store.listTasks(projectId).filter(item => item.ownerStepLinkId) : []
  const commands = projectId ? store.getProjectDb().prepare('SELECT role,state FROM project_owner_execution_commands WHERE project_id=? ORDER BY created_at').all(projectId) : []
  const actions = projectId ? actionRows(projectId).map(action => ({ taskId: action.taskId, state: action.state, detail: action.detail })) : []
  const schedule = projectId ? scheduler.getOwnerAutonomousScheduleStatus(projectId) : null
  throw new Error(`等待Owner质量管理闭环超时：${JSON.stringify({ tasks: tasks.map(item => ({ id: item.id, status: item.status })), commands, actions, schedule,
    management: projectId ? delegation.getOwnerManagementDelegation(projectId) : null,
    failures: projectId ? store.listAgentExecutionsByProject(projectId).filter(item => item.status === 'failed').map(item => item.error) : [] })}`)
}
async function fixture(scenario: Scenario = {}) {
  const repo = scenario.development ? join(directory, `repo-${randomUUID()}`) : undefined
  if (repo) {
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'src/solution.cjs'), 'module.exports = { answer: -1 }\n')
    writeFileSync(join(repo, 'src/verify.cjs'), "const { answer } = require('./solution.cjs'); if (answer !== 42) process.exit(1)\n")
    for (const args of [['init'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid'], ['add', '.'], ['commit', '-m', 'baseline']]) execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
  }
  const project = store.createProject({ title: '定位建议质量闭环', description: '' }), workspace = workspaces.createAgentWorkspace(`质量-${randomUUID()}`, repo)
  scenarios.set(project.id, scenario); traces.set(project.id, [])
  ;(await import('./project-workspace-bindings')).bindWorkspaceToProject(project.id, workspace.id)
  const channel = channels.createChannel({ name: 'fake', provider: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: 'fake', enabled: true, models: [{ id: 'deepseek-flash', name: 'fake', enabled: true }] })
  const employee = (name: string, profile: 'general' | 'controlled' | 'development') => employees.createAgentEmployee({ name, role: '定位研究与检查', description: '', executionProfile: profile, permissionMode: profile === 'controlled' ? 'safe' : 'auto', runtime: 'ai-sdk', channelId: channel.id, modelId: 'deepseek-flash', workspaceIds: [workspace.id] })
  const owner = employee('Owner', 'controlled'), executor = employee('已有调研员', scenario.development ? 'development' : 'general'), reviewer = employee('已有独立检查员', scenario.development ? 'development' : 'general')
  goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成定位建议', ...(scenario.extraQualityCriteria ? { acceptanceCriteria: ['明确范围'] } : {}) })
  binding.saveOwnerRuntimeBinding(project.id, 0, { ownerName: 'Owner', carrierId: owner.id, workspaceId: workspace.id, changeReason: '测试' })
  const context = plans.getProjectOwnerPlanningContext(project.id), roleKey = context.sources.roles[0]!.key
  const criterion = scenario.development ? '代码输出固定42' : '明确目标范围与受众依据'
  const steps = [{ key: 'brief', title: scenario.development ? '修复代码' : '形成建议', outcome: scenario.development ? '代码实现' : '定位材料', acceptanceCriteria: [criterion], dependencies: [] as string[], roleKey }, ...(scenario.dependent ? [{ key: 'delivery', title: '整理最终建议', outcome: '最终版本', acceptanceCriteria: [criterion], dependencies: ['brief'], roleKey }] : [])]
  plans.saveProjectOwnerPlanDraft(project.id, 1, 0, { expectedContextFingerprint: context.fingerprint, summary: '计划', assumptions: [], risks: [], steps, changeReason: '建立' }); const confirmedPlan = plans.confirmProjectOwnerPlanDraft(project.id, 1, 1)
  const subject = { projectId: project.id }, input = { requestId: randomUUID(), expectedPreparationRevision: 0, expectedPolicyRevision: null, expectedGoalRevision: 1, expectedPlanRevision: 2, selectedStepKeys: steps.map(item => item.key), executionKind: scenario.development ? 'development' : 'controlled', ...(!scenario.development ? { textDeliveryVersion: 1 } : { developmentScope: { workspaceId: workspace.id, targetPaths: ['src/solution.cjs'], allowedPaths: ['src'], verificationCommands: ['node src/verify.cjs'] } }), ...(!scenario.legacy ? { qualityManagementVersion: 1 } : {}), employeeRuntimeVersion: 2, executorEmployeeId: executor.id, reviewerEmployeeId: reviewer.id, roleAssignments: [{ roleKey, employeeId: executor.id }], workspaceId: workspace.id, knowledgeSourceIds: [], maxCostMicros: 1_000_000, maxRuns: 8, maxRework: scenario.maxRework ?? 1, expiresAt: Date.now() + 3600000, changeReason: '测试质量委托' }
  const pv = prep.previewOwnerExecutionPreparation(subject, input), saved = prep.saveOwnerExecutionPreparation(subject, input, pv.previewFingerprint)
  const materialInput = { requestId: randomUUID(), expectedMaterializationRevision: 0, expectedPreparationId: saved.id, expectedPreparationRevision: saved.revision, expectedPreparationHash: saved.integrityHash, expectedPolicyRevision: saved.policyRevision }
  const permissionInput = { ...subject, requestId: randomUUID(), maxRequests: 12, maxCostMicros: 15_000_000, expiresAt: Date.now() + 3600000 }, permissionPreview = delegation.previewOwnerManagementDelegation(permissionInput)
  delegation.confirmOwnerManagementDelegation({ input: permissionInput, previewHash: permissionPreview.previewHash })
  const consumeInitialEvents = async () => {
    const managementStore = await import('./project-owner-management-store')
    for (const event of managementStore.listPendingOwnerManagementEvents(project.id)) managementStore.consumeOwnerManagementEvent(event)
  }
  let stopLifecycle = () => {}
  const startLifecycle = async () => {
    await consumeInitialEvents()
    const stopWake = onOwnerAutonomousScheduleWake(id => { if (id === project.id) void scheduler.runOwnerAutonomousSchedule(id) })
    const stopManagement = management.startOwnerManagementLoop()
    stopLifecycle = () => { stopWake(); stopManagement() }
  }
  if (scenario.durableStartIntent) await startLifecycle()
  let grant: Awaited<ReturnType<typeof executionLaunch.launchOwnerPreparedExecution>>
  if (scenario.durableStartIntent) {
    const saveResult = await ipcHandlers.get(PROJECT_IPC_CHANNELS.SAVE_OWNER_EXECUTION_START_INTENT)!(undefined, { ...subject, intentId: input.requestId, expectedGoalRevision: input.expectedGoalRevision,
      expectedPlanRevision: input.expectedPlanRevision, planFingerprint: confirmedPlan.planFingerprint, contextFingerprint: confirmedPlan.contextFingerprint, input }) as { ok: boolean; error?: { message: string } }
    if (!saveResult.ok) throw new Error(saveResult.error?.message ?? '保存启动意图失败')
    const resumeResult = await ipcHandlers.get(PROJECT_IPC_CHANNELS.RESUME_OWNER_EXECUTION_START_INTENT)!(undefined, { ...subject, intentId: input.requestId }) as { ok: boolean; error?: { message: string } }
    if (!resumeResult.ok) throw new Error(resumeResult.error?.message ?? '恢复启动意图失败')
    grant = executionGrants.getOwnerExecutionGrant(subject)!
  } else {
    const preview = material.previewOwnerTaskMaterialization(subject, materialInput)
    grant = await executionLaunch.launchOwnerPreparedExecution({ ...subject, input: materialInput, previewFingerprint: preview.previewFingerprint }, { schedule: async () => {} })
  }
  if (!scenario.durableStartIntent) await startLifecycle()
  // 初始目标/计划及边界已确认；本用例仅测交付后管理，不伪造模型或业务授权。
  await scheduler.runOwnerAutonomousSchedule(project.id)
  return { project, grant, input, executor, reviewer, owner, stop: stopLifecycle, tasks: () => store.listTasks(project.id).filter(item => item.ownerStepLinkId) }
}
function actionRows(projectId: string): OwnerQualityAction[] { return (store.getProjectDb().prepare('SELECT owner_execution_id FROM project_owner_quality_actions WHERE project_id=? ORDER BY rowid').all(projectId) as { owner_execution_id: string }[]).map(row => actions.readOwnerQualityActionByExecution(row.owner_execution_id)!) }

async function confirmFeedbackThroughRenderer(projectId: string, planDraft: ProjectOwnerPlanDraft, input: OwnerExecutionPreparationInput) {
  const subject = { projectId }, subjectKey = JSON.stringify([projectId, null]), ui = createStore()
  ui.set(rendererGoal.ownerGoalEditorsAtom, new Map([[subjectKey, { ...rendererGoal.getOwnerGoalEditor(new Map(), subject), loaded: true, snapshot: goals.getProjectOwnerGoalDraft(projectId)! }]]))
  ui.set(rendererPlan.ownerPlanEditorsAtom, new Map([[subjectKey, { ...rendererPlan.getOwnerPlanEditor(new Map(), subject), loaded: true, snapshot: planDraft, context: plans.getProjectOwnerPlanningContext(projectId) }]]))
  const date = new Date(input.expiresAt), pad = (value: number) => String(value).padStart(2, '0')
  ui.set(rendererExecution.ownerExecutionEditorsAtom, new Map([[subjectKey, {
    ...rendererExecution.getOwnerExecutionEditor(new Map(), subject), loaded: true, view: prep.getOwnerExecutionPreparation(subject), requestId: input.requestId,
    selectedStepKeys: [...input.selectedStepKeys], executionKind: input.executionKind, executorEmployeeId: input.executorEmployeeId,
    reviewerEmployeeId: input.reviewerEmployeeId, roleAssignments: Object.fromEntries((input.roleAssignments ?? []).map(item => [item.roleKey, item.employeeId])),
    workspaceId: input.workspaceId, knowledgeSourceIds: [...input.knowledgeSourceIds], maxCostMicrosText: String(input.maxCostMicros),
    maxRunsText: String(input.maxRuns), maxReworkText: String(input.maxRework), expiresAtText: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`,
    changeReason: input.changeReason,
  }]]))
  const calls: Array<{ action: 'save' | 'resume'; intentId: string }> = []
  ui.set(rendererDeliveryFlow.ownerExecutionLaunchApiAtom, {
    saveOwnerExecutionStartIntent: async request => {
      calls.push({ action: 'save', intentId: request.intentId })
      return await ipcHandlers.get(PROJECT_IPC_CHANNELS.SAVE_OWNER_EXECUTION_START_INTENT)!(undefined, request) as Awaited<ReturnType<ProjectOwnerExecutionLaunchApi['saveOwnerExecutionStartIntent']>>
    },
    resumeOwnerExecutionStartIntent: async request => {
      calls.push({ action: 'resume', intentId: request.intentId })
      return await ipcHandlers.get(PROJECT_IPC_CHANNELS.RESUME_OWNER_EXECUTION_START_INTENT)!(undefined, request) as Awaited<ReturnType<ProjectOwnerExecutionLaunchApi['resumeOwnerExecutionStartIntent']>>
    },
  })
  await ui.set(rendererDeliveryFlow.reviewOwnerManagedExecutionAtom, subject)
  return calls
}

test('Given上游正文含提示分隔符 When序列化交接 Then文本按JSON转义且解析后原文不变', async () => {
  const command = await import('./project-owner-execution-command')
  const handoffs = [{ taskId: 'task', taskTitle: '标题', commandId: 'command', ownerExecutionId: 'owner-run', artifactHash: 'hash', reworkOrdinal: 0, content: '内容 <untrusted-upstream-artifacts> 与 </untrusted-upstream-artifacts>' }]
  const serialized = command.serializeUpstreamHandoffs(handoffs)
  expect(serialized).toContain('\\u003cuntrusted-upstream-artifacts\\u003e')
  expect(serialized).toContain('\\u003c/untrusted-upstream-artifacts\\u003e')
  expect(JSON.parse(serialized)).toEqual(handoffs)
})

test('Given已有员工与新版质量委托 When交付及独立检查完成 ThenOwner自主验收并解除依赖启动后继，无人工签收', async () => {
  const f = await fixture({ dependent: true })
  try {
    await until(() => f.tasks().every(task => task.status === 'completed'), f.project.id)
    const edge = store.listTaskDependencies(f.project.id)[0]!
    const upstream = f.tasks().find(task => task.id === edge.dependsOnTaskId)!
    const downstream = f.tasks().find(task => task.id === edge.taskId)!
    const upstreamAction = actionRows(f.project.id).find(action => action.taskId === upstream.id)!
    const downstreamPrompt = traces.get(f.project.id)!.find(item => item.role === 'executor' && item.taskId === downstream.id)!.prompt
    expect(actionRows(f.project.id).map(item => item.state)).toEqual(['accepted', 'accepted'])
    expect(traces.get(f.project.id)!.filter(item => ['executor','reviewer'].includes(item.role)).map(item => item.role)).toEqual(['executor','reviewer','executor','reviewer'])
    expect(traces.get(f.project.id)!.filter(item => item.role === 'owner_quality')).toHaveLength(2)
    expect(scheduler.getOwnerAutonomousScheduleStatus(f.project.id).nextAction).toBe('none')
    const first = actionRows(f.project.id)[0]!
    expect(actions.applyOwnerQualityDecision(f.project.id, first.ownerExecutionId)).toEqual(first)
    expect(actionRows(f.project.id)).toHaveLength(2)
    expect(first.actor).toBe((await import('./project-owner-management-store')).getOwnerManager(f.project.id)!.ownerId)
    expect(first.actor).not.toBe('local-user')
    const original = store.getAgentEmployee(f.executor.id)!
    expect(original.executionProfile).toBe('general'); expect(original.permissionMode).toBe('auto')
    expect(downstreamPrompt).toContain('已完成上游任务的准确成果')
    expect(downstreamPrompt).toContain(upstreamAction.artifactHash)
    expect(downstreamPrompt).toContain('目标范围：面向已访谈的现有用户，建议有据可查。')
  } finally { f.stop() }
}, 15000)

test('Given账本中有已验收旧授权与较新未完成授权 WhenOwner恢复管理循环 Then旧批次仍先交付到同一对话', async () => {
  const f = await fixture({ hold: true })
  try {
    await until(() => pending.has(f.project.id), f.project.id)
    const db = store.getProjectDb()
    const prior = db.prepare('SELECT * FROM project_owner_execution_grants WHERE id=?').get(f.grant.grantId) as Record<string, unknown>
    const columns = Object.keys(prior)
    const values = columns.map(column => column === 'id' ? randomUUID() : column === 'state' ? 'paused' : column === 'request_id' ? randomUUID() : column === 'issued_at' ? Number(prior.issued_at) + 1 : prior[column]) as Array<string | number | null>
    db.prepare(`INSERT INTO project_owner_execution_grants (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...values)

    pending.get(f.project.id)!.finish()
    await until(() => actionRows(f.project.id).some(action => action.grantId === f.grant.grantId && action.state === 'accepted'), f.project.id)
    management.reconcileOwnerManagement(f.project.id)

    const messages = (db.prepare('SELECT payload FROM project_owner_management_messages WHERE project_id=?').all(f.project.id) as Array<{ payload: string }>).map(row => JSON.parse(row.payload) as { eventId: string; kind: string; delivery?: { schemaVersion: number; items: Array<{ artifactHash: string }> } }).filter(message => message.kind === 'delivery')
    const oldAction = actionRows(f.project.id).find(action => action.grantId === f.grant.grantId)!
    expect(messages).toHaveLength(1)
    expect(messages[0]!.eventId).toStartWith(`owner-delivery:${f.grant.grantId}:`)
    expect(messages[0]!.delivery).toMatchObject({ schemaVersion: 1, items: [{ artifactHash: oldAction.artifactHash }] })
  } finally { f.stop() }
}, 15000)

test('Given旧授权成果已被Owner验收且计划产生新重验证版本 When恢复管理循环 Then旧成果仍按原授权和成果哈希交付', async () => {
  const f = await fixture({ hold: true })
  const deliveryService = await import('./project-owner-management-delivery')
  const deliverySpy = spyOn(deliveryService, 'publishOwnerManagementCompletion').mockImplementation(() => false)
  try {
    await until(() => pending.has(f.project.id), f.project.id)
    pending.get(f.project.id)!.finish()
    await until(() => actionRows(f.project.id).some(action => action.grantId === f.grant.grantId && action.state === 'accepted'), f.project.id)

    const revokeService = await import('./project-owner-execution-grant-issue')
    const subject = { projectId: f.project.id }
    const revoke = revokeService.previewOwnerExecutionGrantRevoke(subject, { grantId: f.grant.grantId })
    expect(revoke.blockers).toEqual([])
    expect(revokeService.confirmOwnerExecutionGrantRevoke(subject, { grantId: f.grant.grantId, confirmedFingerprint: revoke.fingerprint }).state).toBe('paused')

    const goal = goals.saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '按新目标追加交付' })
    const context = plans.getProjectOwnerPlanningContext(f.project.id)
    const oldPlan = plans.getProjectOwnerPlanDraft(f.project.id)!
    const roleKey = context.sources.roles[0]!.key
    const proposed = plans.saveProjectOwnerPlanDraft(f.project.id, goal.revision, oldPlan.revision, {
      expectedContextFingerprint: context.fingerprint,
      summary: '追加一批新计划',
      assumptions: [], risks: [],
      steps: [{ key: 'brief-v2', title: '补充新研究', outcome: '新增材料', acceptanceCriteria: ['满足修订目标'], dependencies: [], roleKey }],
      changeReason: '验收旧成果后按新目标继续',
    })
    const confirmed = plans.confirmProjectOwnerPlanDraft(f.project.id, goal.revision, proposed.revision)
    const policyService = await import('./project-pilot-policy')
    const currentPreparation = prep.getOwnerExecutionPreparation(subject).preparation!
    const nextPreparationInput = {
      ...currentPreparation.input,
      requestId: randomUUID(),
      expectedPreparationRevision: currentPreparation.revision,
      expectedPolicyRevision: policyService.getPilotPolicy(f.project.id)!.revision,
      expectedGoalRevision: goal.revision,
      expectedPlanRevision: confirmed.revision,
      selectedStepKeys: ['brief-v2'],
      changeReason: '追加新计划任务',
    }
    const preparationPreview = prep.previewOwnerExecutionPreparation(subject, nextPreparationInput)
    const nextPreparation = prep.saveOwnerExecutionPreparation(subject, nextPreparationInput, preparationPreview.previewFingerprint)
    const currentMaterialization = material.getOwnerTaskMaterialization(subject).materialization!
    const materializationInput = {
      requestId: randomUUID(),
      expectedMaterializationRevision: currentMaterialization.revision,
      expectedPreparationId: nextPreparation.id,
      expectedPreparationRevision: nextPreparation.revision,
      expectedPreparationHash: nextPreparation.integrityHash,
      expectedPolicyRevision: nextPreparation.policyRevision,
    }
    const materializationPreview = material.previewOwnerTaskMaterialization(subject, materializationInput)
    const nextMaterialization = material.materializeOwnerTasks(subject, materializationInput, materializationPreview.previewFingerprint)
    const revalidation = await import('./project-owner-execution-revalidation')
    const revalidationInput = {
      requestId: randomUUID(),
      expectedRevalidationRevision: f.grant.revalidationRevision,
      expectedMaterializationId: nextMaterialization.id,
      expectedMaterializationRevision: nextMaterialization.revision,
      expectedMaterializationHash: nextMaterialization.integrityHash,
      expectedPolicyRevision: nextPreparation.policyRevision,
      changeReason: '核对新增计划批次',
    }
    const revalidationPreview = revalidation.previewOwnerExecutionRevalidation(subject, revalidationInput)
    const newerRevalidation = revalidation.saveOwnerExecutionRevalidation(subject, revalidationInput, revalidationPreview.previewFingerprint)
    expect(newerRevalidation.id).not.toBe(f.grant.revalidationId)

    f.stop()
    deliverySpy.mockRestore()
    const db = store.getProjectDb()
    db.prepare("UPDATE project_owner_execution_grants SET state='active' WHERE id=?").run(f.grant.grantId)
    expect(deliveryService.publishOwnerManagementCompletion(f.project.id)).toBe(false)
    db.prepare("UPDATE project_owner_execution_grants SET state='paused' WHERE id=?").run(f.grant.grantId)
    expect(deliveryService.publishOwnerManagementCompletion(f.project.id)).toBe(true)
    const messages = db.prepare('SELECT payload FROM project_owner_management_messages WHERE project_id=?').all(f.project.id) as Array<{ payload: string }>
    const deliveries = messages.map(row => JSON.parse(row.payload) as { eventId: string; kind: string; delivery?: { schemaVersion: number; items: Array<{ artifactHash: string }> } }).filter(message => message.kind === 'delivery')
    const oldAction = actionRows(f.project.id).find(action => action.grantId === f.grant.grantId)!
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]!.eventId).toStartWith(`owner-delivery:${f.grant.grantId}:`)
    expect(deliveries[0]!.delivery).toMatchObject({ schemaVersion: 1, items: [{ artifactHash: oldAction.artifactHash }] })
  } finally { deliverySpy.mockRestore(); f.stop() }
}, 15000)

test('GivenOwner反馈修订方案 WhenRenderer确认Atom经正式IPC启动 Then新版自动复核并回到原对话', async () => {
  const f = await fixture({ dependent: true, durableStartIntent: true })
  try {
    await until(() => f.tasks().every(task => task.status === 'completed'), f.project.id)
    const intent = store.getProjectDb().prepare('SELECT state,grant_id FROM project_owner_execution_start_intents WHERE project_id=?').get(f.project.id) as { state: string; grant_id: string }
    const commands = store.getProjectDb().prepare('SELECT role,employee_id,state FROM project_owner_execution_commands WHERE grant_id=? ORDER BY created_at').all(f.grant.grantId) as { role: string; employee_id: string; state: string }[]
    const edge = store.listTaskDependencies(f.project.id)[0]!
    const downstreamTask = f.tasks().find(task => task.id === edge.taskId)!
    const downstreamPrompt = traces.get(f.project.id)!.find(item => item.role === 'executor' && item.taskId === downstreamTask.id)!.prompt
    expect(intent).toEqual({ state: 'completed', grant_id: f.grant.grantId })
    expect(commands.map(command => [command.role, command.employee_id, command.state])).toEqual([
      ['executor', f.executor.id, 'settled'], ['reviewer', f.reviewer.id, 'settled'],
      ['executor', f.executor.id, 'settled'], ['reviewer', f.reviewer.id, 'settled'],
    ])
    expect(actionRows(f.project.id).map(action => action.state)).toEqual(['accepted', 'accepted'])
    expect(traces.get(f.project.id)!.filter(item => item.role === 'owner_quality')).toHaveLength(2)
    await until(() => (store.getProjectDb().prepare("SELECT COUNT(*) AS count FROM project_owner_management_messages WHERE project_id=? AND json_extract(payload, '$.kind')='delivery'").get(f.project.id) as { count: number }).count === 1, f.project.id)
    const delivered = JSON.parse((store.getProjectDb().prepare("SELECT payload FROM project_owner_management_messages WHERE project_id=? AND json_extract(payload, '$.kind')='delivery'").get(f.project.id) as { payload: string }).payload) as { delivery: { items: Array<{ artifactHash: string; content: string }> } }
    const acceptedActions = actionRows(f.project.id)
    expect(delivered.delivery.items).toHaveLength(2)
    expect(delivered.delivery.items.map(item => item.artifactHash)).toEqual(acceptedActions.map(action => action.artifactHash))
    expect(delivered.delivery.items[0]?.content).toContain('目标范围：面向已访谈的现有用户')
    expect(downstreamPrompt).toContain('已完成上游任务的准确成果')
    expect(downstreamPrompt).toContain('目标范围：面向已访谈的现有用户，建议有据可查。')
    expect(scheduler.getOwnerAutonomousScheduleStatus(f.project.id).nextAction).toBe('none')

    const priorGrantCount = (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id) as { count: number }).count
    const priorCommandCount = (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE project_id=?').get(f.project.id) as { count: number }).count
    const priorExecutorRuns = traces.get(f.project.id)!.filter(item => item.role === 'executor').length
    const conversation = managementConversation.getOwnerManagementConversation(f.project.id)
    const deliveredMessage = conversation.messages.find(message => message.kind === 'delivery')!
    const feedbackItem = deliveredMessage.delivery!.items[0]!
    const feedback = sendOwnerManagementMessage({ projectId: f.project.id, conversationId: deliveredMessage.conversationId, requestId: randomUUID(), expectedGoalRevision: 1, content: '请在这份建议中补充目标用户分析', deliveryReference: { messageId: deliveredMessage.id, artifactHash: feedbackItem.artifactHash, stepKey: feedbackItem.stepKey } })
    let feedbackPlanningTaskId: string | undefined
    await until(() => {
      const row = store.getProjectDb().prepare("SELECT planning_task_id FROM project_owner_planning_links WHERE project_id=? AND json_extract(payload,'$.conversationMessageId')=? ORDER BY rowid DESC LIMIT 1").get(f.project.id, feedback.id) as { planning_task_id: string } | undefined
      feedbackPlanningTaskId = row?.planning_task_id
      return Boolean(row && store.listAgentExecutionsByEntity('task', row.planning_task_id).some(item => item.status === 'completed'))
    }, f.project.id)
    const feedbackSource = source.readOwnerPlanningSnapshot(feedbackPlanningTaskId!)!
    expect(feedbackSource.context.conversation?.deliveryFeedback).toMatchObject({ messageId: deliveredMessage.id, artifactHash: feedbackItem.artifactHash, stepKey: feedbackItem.stepKey, title: feedbackItem.title, content: feedbackItem.content, acceptanceCriteria: feedbackItem.acceptanceCriteria })
    await until(() => {
      const plan = plans.getProjectOwnerPlanDraft(f.project.id)
      return plan?.state === 'proposed' && plan.proposal.deliveryFeedbackAssessment?.messageId === deliveredMessage.id && plan.proposal.deliveryFeedbackAssessment.artifactHash === feedbackItem.artifactHash && plan.proposal.deliveryFeedbackAssessment.stepKey === feedbackItem.stepKey
    }, f.project.id)
    const revisedPlan = plans.getProjectOwnerPlanDraft(f.project.id)!
    expect(revisedPlan.state).toBe('proposed')
    expect(revisedPlan.proposal.deliveryFeedbackAssessment).toMatchObject({ messageId: deliveredMessage.id, artifactHash: feedbackItem.artifactHash, stepKey: feedbackItem.stepKey, authorizationImpact: 'within_confirmed_boundary' })
    expect(revisedPlan.proposal.steps.flatMap(step => step.acceptanceCriteria)).toEqual(feedbackItem.acceptanceCriteria)
    expect(traces.get(f.project.id)!.filter(item => item.role === 'owner_feedback')).toHaveLength(1)
    expect((store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id) as { count: number }).count).toBe(priorGrantCount)
    expect((store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE project_id=?').get(f.project.id) as { count: number }).count).toBe(priorCommandCount)

    const currentPreparation = prep.getOwnerExecutionPreparation({ projectId: f.project.id })
    const nextInput: OwnerExecutionPreparationInput = { ...currentPreparation.preparation!.input, requestId: randomUUID(), expectedPreparationRevision: currentPreparation.revision,
      expectedPolicyRevision: currentPreparation.policyRevision, expectedGoalRevision: 1, expectedPlanRevision: revisedPlan.revision,
      selectedStepKeys: revisedPlan.proposal.steps.map(step => step.key), changeReason: '按用户反馈修订已交付成果' }
    const intentCalls = await confirmFeedbackThroughRenderer(f.project.id, revisedPlan, nextInput)
    expect(intentCalls).toEqual([{ action: 'save', intentId: nextInput.requestId }, { action: 'resume', intentId: nextInput.requestId }])
    await until(() => (store.getProjectDb().prepare("SELECT COUNT(*) AS count FROM project_owner_management_messages WHERE project_id=? AND json_extract(payload, '$.kind')='delivery'").get(f.project.id) as { count: number }).count === 2, f.project.id)
    const deliveries = (store.getProjectDb().prepare("SELECT payload FROM project_owner_management_messages WHERE project_id=? AND json_extract(payload, '$.kind')='delivery' ORDER BY rowid").all(f.project.id) as { payload: string }[])
      .map(row => JSON.parse(row.payload) as { id: string; eventId: string; delivery: { items: Array<{ stepKey: string; content: string }> } })
    const grantHistory = (await import('./project-owner-execution-grant-issue')).listOwnerExecutionGrantHistory({ projectId: f.project.id })
    expect(deliveries).toHaveLength(2)
    expect(deliveries[0]!.id).toBe(deliveredMessage.id)
    expect(deliveries[0]!.delivery.items[0]?.content).toBe(feedbackItem.content)
    expect(deliveries[1]!.eventId).toContain(grantHistory.at(-1)!.grantId)
    expect(grantHistory).toHaveLength(priorGrantCount + 1)
    expect(grantHistory.at(-1)).toMatchObject({ state: 'active', materializationId: expect.not.stringMatching(f.grant.materializationId) })
    expect(deliveries[1]!.delivery.items).toMatchObject([{ stepKey: 'revise-delivery', content: expect.stringContaining('目标范围：面向已访谈的现有用户') }])
    expect(traces.get(f.project.id)!.filter(item => item.role === 'executor')).toHaveLength(priorExecutorRuns + 1)
    expect(actionRows(f.project.id).slice(-1).map(action => action.state)).toEqual(['accepted'])
  } finally { f.stop() }
}, 15000)

test('Given代码任务交付且白名单验证成功 WhenReviewer与Owner检查同一冻结快照 ThenOwner验收并解除依赖', async () => {
  const f = await fixture({ development: true, dependent: true })
  try {
    await until(() => f.tasks().every(task => task.status === 'completed'), f.project.id)
    const commands = store.getProjectDb().prepare("SELECT id,role,rework_ordinal,state FROM project_owner_execution_commands WHERE grant_id=? ORDER BY created_at").all(f.grant.grantId) as { id: string; role: string; rework_ordinal: number; state: string }[]
    expect(commands.map(item => [item.role, item.rework_ordinal, item.state])).toEqual([
      ['executor', 0, 'settled'], ['reviewer', 0, 'settled'], ['executor', 0, 'settled'], ['reviewer', 0, 'settled'],
    ])
    const reviews = (await import('./project-owner-technical-review')).listOwnerTechnicalReviewEvidence(f.project.id)
    expect(reviews).toHaveLength(2)
    expect(reviews.every(item => item.verdict === 'approved' && item.artifactVerified && item.validationEvidenceVerified)).toBe(true)
    expect(reviews.every(item => item.validationEvidence?.length === 1 && item.validationEvidence[0]?.status === 'passed' && item.validationEvidence[0]?.outputTruncated === false)).toBe(true)
    const validations = await import('./development-validation-service')
    for (const review of reviews) {
      const evidence = review.validationEvidence![0]!
      const saved = validations.readDevelopmentValidationEvidence(review.taskId, review.executorExecutionId, evidence.validationId)
      expect(saved.freshness).toBe('fresh')
      if (!review.artifactHash) throw new Error('已批准评审缺少成果摘要')
      expect(saved.result.snapshotContentHash).toBe(review.artifactHash)
      expect(saved.result.rawOutputSha256).toEqual(evidence.rawOutputSha256)
    }
    const actions = actionRows(f.project.id)
    expect(actions.map(item => item.state)).toEqual(['accepted', 'accepted'])
    expect(actions.every(item => item.decision.artifactHash === reviews.find(review => review.taskId === item.taskId)?.artifactHash)).toBe(true)
    expect(traces.get(f.project.id)!.filter(item => ['executor', 'reviewer', 'owner_quality'].includes(item.role)).map(item => item.role)).toEqual([
      'executor', 'reviewer', 'owner_quality', 'executor', 'reviewer', 'owner_quality',
    ])
    const dependency = store.listTaskDependencies(f.project.id)[0]!
    const downstream = f.tasks().find(task => task.id === dependency.taskId)!
    const downstreamPrompt = traces.get(f.project.id)!.find(item => item.role === 'executor' && item.taskId === downstream.id)!.prompt
    expect(downstreamPrompt).toContain('已完成上游任务的准确成果')
    expect(downstreamPrompt).toContain(actions[0]!.artifactHash)
    expect(downstreamPrompt).toContain('module.exports = { answer: 42 }')
    expect(scheduler.getOwnerAutonomousScheduleStatus(f.project.id).nextAction).toBe('none')
  } finally { f.stop() }
}, 120000)

test('Given代码白名单验证失败且Reviewer仍声称通过 WhenOwner质量链续跑 Then拒绝保存通过评审与质量验收且不启动后继', async () => {
  const f = await fixture({ development: true, dependent: true, validationFails: true })
  try {
    await until(() => {
      const reviewer = store.getProjectDb().prepare("SELECT state FROM project_owner_execution_commands WHERE grant_id=? AND role='reviewer' ORDER BY created_at LIMIT 1").get(f.grant.grantId) as { state: string } | undefined
      return Boolean(reviewer && !['reserved', 'queued', 'running'].includes(reviewer.state))
    }, f.project.id)
    const commands = store.getProjectDb().prepare('SELECT role,state FROM project_owner_execution_commands WHERE grant_id=? ORDER BY created_at').all(f.grant.grantId) as { role: string; state: string }[]
    expect(commands.map(item => item.role)).toEqual(['executor', 'reviewer'])
    expect(commands.every(item => item.state === 'settled')).toBe(true)
    const validations = await import('./development-validation-service')
    const executor = store.getProjectDb().prepare("SELECT execution_id,source_task_id FROM project_owner_execution_commands WHERE grant_id=? AND role='executor'").get(f.grant.grantId) as { execution_id: string; source_task_id: string }
    const validation = validations.listDevelopmentValidations(executor.source_task_id).find(item => item.executionId === executor.execution_id)
    expect(validation).toMatchObject({ status: 'failed', exitCode: 1 })
    expect((await import('./project-owner-technical-review')).listOwnerTechnicalReviewEvidence(f.project.id)).toHaveLength(0)
    const messages = (await import('./project-owner-management-store')).getOwnerManagementView(f.project.id).messages
    expect(messages.some(message => message.eventId.startsWith('owner-review-evidence-rejected:') && message.content.includes('没有可采信的评审结果'))).toBe(true)
    expect(messages.some(message => message.kind === 'delivery')).toBe(false)
    expect(actionRows(f.project.id)).toHaveLength(0)
    expect(f.tasks().every(task => task.status === 'paused')).toBe(true)
    expect(traces.get(f.project.id)!.filter(item => item.role === 'owner_quality')).toHaveLength(0)
    const downstreamTask = f.tasks().find(task => task.id !== executor.source_task_id)!
    expect(traces.get(f.project.id)!.filter(item => item.role === 'executor' && item.taskId === downstreamTask.id)).toHaveLength(0)
  } finally { f.stop() }
}, 120000)

test('Given后继命令已排队 When启动前预算不足或上游成果变化/提示被追加 Then拒绝使用旧冻结交接', async () => {
  const f = await fixture({ dependent: true, hold: true })
  let deliveryPath = ''
  let originalDelivery: Buffer | undefined
  try {
    await until(() => pending.has(f.project.id))
    const held = pending.get(f.project.id)!
    f.stop()
    held.finish()
    await until(() => Boolean(runs.getOwnerPlanningRunOutcome(held.executionId)?.qualityDecision))
    const accepted = actions.applyOwnerQualityDecision(f.project.id, held.executionId)
    expect(accepted.state).toBe('accepted')

    const edge = store.listTaskDependencies(f.project.id)[0]!
    const downstream = f.tasks().find(task => task.id === edge.taskId)!
    const executor = store.getProjectDb().prepare("SELECT execution_id FROM project_owner_execution_commands WHERE source_task_id=? AND role='executor' AND state='settled'").get(edge.dependsOnTaskId) as { execution_id: string }
    const textDelivery = await import('./project-owner-text-delivery')
    deliveryPath = textDelivery.ownerTextDeliveryFile(f.project.id, executor.execution_id)!
    originalDelivery = readFileSync(deliveryPath)

    const command = await import('./project-owner-execution-command')
    const queued = command.reserveAndQueueAutonomousOwnerCommand({ projectId: f.project.id }, {
      grantId: f.grant.grantId,
      taskId: downstream.id,
      role: 'executor',
      reworkOrdinal: 0,
      expectedRevalidationRevision: f.grant.revalidationRevision,
    })
    expect(queued.executionId).toBeTruthy()
    expect(() => command.assertOwnerCommandUpstreamHandoffsCurrent(queued.commandId)).not.toThrow()

    const database = store.getProjectDb()
    const budget = database.prepare('SELECT max_cost_micros, max_runs FROM project_owner_execution_grants WHERE id=?').get(f.grant.grantId) as { max_cost_micros: number; max_runs: number }
    const reservation = database.prepare('SELECT reserved_cost_micros FROM project_owner_execution_commands WHERE id=?').get(queued.commandId) as { reserved_cost_micros: number }
    const usage = database.prepare(`SELECT COALESCE(SUM(CASE WHEN state='released' THEN 0 ELSE 1 END),0) AS runs,
      COALESCE(SUM(CASE WHEN state='released' THEN 0 WHEN state='settled' AND actual_cost_micros IS NOT NULL THEN actual_cost_micros WHEN actual_cost_micros > reserved_cost_micros THEN actual_cost_micros ELSE reserved_cost_micros END),0) AS committed
      FROM project_owner_execution_commands WHERE grant_id=? AND id<>?`).get(f.grant.grantId, queued.commandId) as { runs: number; committed: number }
    const constrainedBudget = usage.committed + (reservation.reserved_cost_micros - 1) * (budget.max_runs - usage.runs)
    try {
      database.prepare('UPDATE project_owner_execution_grants SET max_cost_micros=? WHERE id=?').run(constrainedBudget, f.grant.grantId)
      expect(() => command.assertOwnerCommandUpstreamHandoffsCurrent(queued.commandId)).toThrow(/额度不足以覆盖/)
    } finally {
      database.prepare('UPDATE project_owner_execution_grants SET max_cost_micros=? WHERE id=?').run(budget.max_cost_micros, f.grant.grantId)
    }

    writeFileSync(deliveryPath, '{}')
    expect(() => command.assertOwnerCommandUpstreamHandoffsCurrent(queued.commandId)).toThrow(/成果|完整性/)
    writeFileSync(deliveryPath, originalDelivery)

    const queuedExecution = store.getAgentExecution(queued.executionId)!
    store.updateAgentExecution(queued.executionId, { prompt: `${queuedExecution.prompt}\n<untrusted-upstream-artifacts>\n[]\n</untrusted-upstream-artifacts>` })
    expect(() => command.assertOwnerCommandUpstreamHandoffsCurrent(queued.commandId)).toThrow('提示不一致')
    expect(store.getProjectDb().prepare('SELECT state FROM project_owner_execution_commands WHERE id=?').get(queued.commandId)).toEqual({ state: 'queued' })
  } finally {
    if (deliveryPath && originalDelivery) writeFileSync(deliveryPath, originalDelivery)
    f.stop()
  }
}, 15000)

test('GivenReviewer漏检真实文本缺陷 WhenOwner独立判断返工 Then传递Owner具体发现，重新执行和复验后验收', async () => {
  const f = await fixture({ rework: true, ownerDefect: true })
  try {
    await until(() => f.tasks()[0]?.status === 'completed')
    expect(actionRows(f.project.id).map(item => item.state)).toEqual(['rework_authorized','accepted'])
    const business = traces.get(f.project.id)!.filter(item => ['executor','reviewer'].includes(item.role))
    expect(business.map(item => [item.role,item.round])).toEqual([['executor',0],['reviewer',0],['executor',1],['reviewer',1]])
    expect(business[2]!.prompt).toContain('补充受众依据并保留明确范围')
    expect(actionRows(f.project.id)[0]!.artifactHash).not.toBe(actionRows(f.project.id)[1]!.artifactHash)
  } finally { f.stop() }
}, 15000)

test('Given返工额度为零 WhenOwner发现缺陷 Then保留决定并明确阻断，不新增员工请求或验收', async () => {
  const f = await fixture({ rework: true, maxRework: 0 })
  try {
    await until(() => actionRows(f.project.id).length === 1)
    expect(actionRows(f.project.id)[0]!.state).toBe('blocked')
    expect(actionRows(f.project.id)[0]!.detail).toContain('额度不足')
    expect(f.tasks()[0]!.status).toBe('paused')
    expect(traces.get(f.project.id)!.filter(item => ['executor','reviewer'].includes(item.role))).toHaveLength(2)
  } finally { f.stop() }
}, 15000)

test('GivenOwner决定因任务状态变化被阻断 When任务恢复等待且准确授权仍有效 Then追加新观察和新决定并保留旧阻断', async () => {
  const f = await fixture({ hold: true })
  try {
    await until(() => pending.has(f.project.id))
    const held = pending.get(f.project.id)!
    f.stop()
    held.finish()
    await until(() => Boolean(runs.getOwnerPlanningRunOutcome(held.executionId)?.qualityDecision))
    const task = f.tasks()[0]!
    store.getProjectDb().prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(task.id)
    const first = actions.applyOwnerQualityDecision(f.project.id, held.executionId)
    expect(first.state).toBe('blocked')
    expect(first.detail).toContain('目标、资料、计划')
    expect(store.getTask(task.id)?.status).toBe('in_progress')
    store.getProjectDb().prepare("UPDATE tasks SET status='paused' WHERE id=?").run(task.id)
    const recovery = actions.getOwnerQualityRecovery(f.project.id, first.reviewerCommandId)
    expect(recovery?.previousExecutionId).toBe(first.ownerExecutionId)
    scenarios.set(f.project.id, {})
    const execution = await import('./project-owner-management-execution')
    execution.scanOwnerExecutionObservations(f.project.id)
    const restartManagement = management.startOwnerManagementLoop()
    await until(() => actionRows(f.project.id).length === 2)
    restartManagement()
    expect(actionRows(f.project.id).map(item => item.state)).toEqual(['blocked', 'accepted'])
    expect(actionRows(f.project.id)[1]!.ownerExecutionId).not.toBe(first.ownerExecutionId)
    expect(f.tasks()[0]!.status).toBe('completed')
    expect(traces.get(f.project.id)!.filter(item => ['executor','reviewer'].includes(item.role))).toHaveLength(2)
    expect(actions.applyOwnerQualityDecision(f.project.id, first.ownerExecutionId)).toEqual(first)
    expect(actionRows(f.project.id)).toHaveLength(2)
    expect(f.tasks()[0]!.status).toBe('completed')
  } finally { f.stop() }
}, 15000)

test('GivenOwner判断在途 When业务授权撤销后返回 Then决定保留但不能完成Task或续派', async () => {
  const f = await fixture({ hold: true, dependent: true })
  try {
    await until(() => pending.has(f.project.id))
    store.getProjectDb().prepare("UPDATE project_owner_execution_grants SET state='paused' WHERE id=?").run(f.grant.grantId)
    const held = pending.get(f.project.id)!; held.finish()
    await until(() => Boolean(runs.getOwnerPlanningRunOutcome(held.executionId)))
    const outcome = runs.getOwnerPlanningRunOutcome(held.executionId)!
    expect(outcome.state).toBe('stale')
    expect(runs.getOwnerPlanningRunReceipt(outcome.receiptId)!.responseText).toContain('quality_decision')
    expect(actionRows(f.project.id)).toHaveLength(0)
    expect(f.tasks().every(task => task.status === 'paused')).toBe(true)
  } finally { f.stop() }
}, 15000)


test('Given仅完整文本的旧业务许可 When独立评审通过 Then不自动授予Owner子任务验收', async () => {
  const f = await fixture({ legacy: true })
  try {
    await until(() => traces.get(f.project.id)!.filter(item => item.role === 'owner_analysis').length >= 2)
    expect(scheduler.getOwnerAutonomousScheduleStatus(f.project.id).nextAction).toBe('await_business_acceptance')
    expect(actionRows(f.project.id)).toHaveLength(0)
    expect(f.tasks()[0]!.status).toBe('paused')
  } finally { f.stop() }
}, 15000)

test('Given准确Reviewer成果 WhenOwner判定协议或内部返工入口被篡改 Then拒绝错版本、虚构依据与无决定续派', async () => {
  const f = await fixture({ hold: true })
  try {
    await until(() => pending.has(f.project.id))
    const held = pending.get(f.project.id)!, execution = store.getAgentExecution(held.executionId)!
    const snapshot = source.readOwnerPlanningSnapshot(execution.entityId)!, context = snapshot.context, delivery = context.conversation!.deliveryReview!
    const decision = { reviewerCommandId: delivery.review!.reviewerCommandId, artifactHash: delivery.artifact!.contentSha256, verdict: 'accept', reason: '根据完整正文核对', criteria: [{ criterion: '明确目标范围与受众依据', status: 'met', evidence: '逐项检查', quote: '目标范围' }], findings: [] }
    const { parseOwnerQualityDecision } = await import('./project-owner-quality-protocol')
    expect(parseOwnerQualityDecision(decision, context).verdict).toBe('accept')
    for (const patch of [{ artifactHash: '0'.repeat(64) }, { reviewerCommandId: randomUUID() }, { criteria: [{ ...decision.criteria[0], quote: '正文不存在的引用' }] }, { criteria: [{ ...decision.criteria[0], status: 'not_verified', quote: null }] }, { criteria: [] }]) expect(() => parseOwnerQualityDecision({ ...decision, ...patch }, context)).toThrow()
    const old = structuredClone(context); delete old.conversation!.deliveryReview!.qualityDecisionVersion
    expect(() => parseOwnerQualityDecision(decision, old)).toThrow('缺少')
    const outdated = structuredClone(context); outdated.conversation!.currentPlan!.revision++
    expect(() => parseOwnerQualityDecision(decision, outdated)).toThrow('当前方案')
    expect(() => (require('./project-owner-execution-command') as typeof import('./project-owner-execution-command')).reserveAndQueueAutonomousOwnerCommand({ projectId: f.project.id }, { grantId: f.grant.grantId, taskId: f.tasks()[0]!.id, role: 'executor', reworkOrdinal: 1, expectedRevalidationRevision: f.grant.revalidationRevision })).toThrow('返工前置')
    held.finish(); await until(() => actionRows(f.project.id).length === 1)
  } finally { f.stop() }
}, 15000)


test('GivenOwner决定已保存且未投影 When数据库重开并重放 Then只完成一次Task并保留Owner身份审计', async () => {
  const f = await fixture({ hold: true })
  await until(() => pending.has(f.project.id)); f.stop()
  const held = pending.get(f.project.id)!; held.finish()
  expect(runs.getOwnerPlanningRunOutcome(held.executionId)?.qualityDecision?.verdict).toBe('accept')
  expect(actionRows(f.project.id)).toHaveLength(0)
  store.closeProjectDb(); await store.initProjectDb()
  const action = actions.applyOwnerQualityDecision(f.project.id, held.executionId)
  expect(action.state).toBe('accepted')
  expect(f.tasks()[0]!.status).toBe('completed')
  expect(actions.applyOwnerQualityDecision(f.project.id, held.executionId)).toEqual(action)
  expect((store.getProjectDb().prepare("SELECT COUNT(*) AS count FROM project_activities WHERE project_id=? AND action='owner_quality_decision'").get(f.project.id) as { count: number }).count).toBe(1)
  expect(() => store.getProjectDb().prepare("UPDATE project_owner_quality_actions SET task_id='changed' WHERE reviewer_command_id=?").run(action.reviewerCommandId)).toThrow('immutable')
}, 15000)

test('GivenTask更新后活动写入故障 When执行Owner验收 ThenSAVEPOINT回滚Task，保留阻断而非半验收', async () => {
  const f = await fixture({ hold: true })
  await until(() => pending.has(f.project.id)); f.stop()
  const held = pending.get(f.project.id)!; held.finish()
  store.getProjectDb().exec("CREATE TRIGGER owner_quality_fail_activity BEFORE INSERT ON project_activities WHEN NEW.action='updated' BEGIN SELECT RAISE(ABORT,'合成活动写入故障'); END")
  try {
    const action = actions.applyOwnerQualityDecision(f.project.id, held.executionId)
    expect(action.state).toBe('blocked')
    expect(action.detail).toContain('合成活动写入故障')
    expect(f.tasks()[0]!.status).toBe('paused')
    expect(f.tasks()[0]!.completionNotes).toBeFalsy()
    expect(actionRows(f.project.id)).toHaveLength(1)
  } finally { store.getProjectDb().exec('DROP TRIGGER IF EXISTS owner_quality_fail_activity') }
}, 15000)

for (const compatibility of [
  { name: '缺kind', scenario: { omitQualityKind: true }, detail: 'Owner执行跟进只允许分析回应或必要协商' },
  { name: '附加已满足项目标准', scenario: { extraQualityCriteria: true }, detail: 'Owner质量决定与准确评审/成果不匹配' },
  { name: '代码引用容器误判', scenario: { development: true }, detail: 'Owner质量决定未按准确标准逐项判断或引用不符' },
] as Array<{ name: string; scenario: Scenario; detail: string }>) test(`Given旧版本将${compatibility.name}质量决定拒绝 When本地重验完整原文 Then追加恢复记录并保持原失败和调用次数`, async () => {
  const f = await fixture(compatibility.scenario)
  try {
    await until(() => f.tasks().every(task => task.status === 'completed'), f.project.id)
    const action = actionRows(f.project.id)[0]!
    const outcome = runs.getOwnerPlanningRunOutcome(action.ownerExecutionId)!
    const before = traces.get(f.project.id)!.length
    // 仅在隔离测试库重建旧解析器的分类；原始回执与正文不变。
    const failed = { executionId: outcome.executionId, receiptId: outcome.receiptId, state: 'failed', detail: compatibility.detail }
    const integrityHash = createHash('sha256').update(JSON.stringify(failed)).digest('hex')
    store.getProjectDb().prepare('UPDATE project_owner_planning_run_outcomes SET payload=? WHERE execution_id=?').run(JSON.stringify({ ...failed, integrityHash }), outcome.executionId)
    expect(runs.recoverLegacyOwnerConversationReply(outcome.executionId)).toMatchObject({ state: 'replied', qualityDecision: { verdict: 'accept' } })
    const originalText = runs.getOwnerPlanningRunReceipt(outcome.receiptId)!.responseText
    if (compatibility.scenario.omitQualityKind) expect(originalText).not.toContain('"kind"')
    else expect(JSON.parse(originalText).decision.criteria).toHaveLength(compatibility.scenario.extraQualityCriteria ? 2 : 1)
    expect(runs.getOwnerPlanningRunOutcome(outcome.executionId)?.qualityDecision?.criteria).toHaveLength(1)
    expect(store.getProjectDb().prepare("SELECT json_extract(payload, '$.state') AS state FROM project_owner_planning_run_outcomes WHERE execution_id=?").get(outcome.executionId)).toEqual({ state: 'failed' })
    expect(actions.applyOwnerQualityDecision(f.project.id, outcome.executionId)).toEqual(action)
    expect(runs.recoverLegacyOwnerConversationReply(outcome.executionId)).toMatchObject({ state: 'replied' })
    expect(traces.get(f.project.id)).toHaveLength(before)
  } finally { f.stop() }
}, 15000)


test('Given独立评审回调返回空文本 When收尾 Then持久说明无有效评审且不验收交付', async () => {
  const f = await fixture({ emptyReview: true })
  try {
    const records = await import('./project-owner-management-store')
    await until(() => records.getOwnerManagementView(f.project.id).messages.some(message => message.eventId.startsWith('owner-review-evidence-rejected:')), f.project.id)
    expect((await import('./project-owner-technical-review')).listOwnerTechnicalReviewEvidence(f.project.id)).toHaveLength(0)
    expect(actionRows(f.project.id)).toHaveLength(0)
    expect(records.getOwnerManagementView(f.project.id).messages.some(message => message.kind === 'delivery')).toBe(false)
    expect(store.listAgentExecutionsByProject(f.project.id).some(execution => execution.ownerCommandId && execution.status === 'completed')).toBe(true)
  } finally { f.stop() }
}, 15000)


test('Given已恢复的accept尚未执行而验证随后过期 When首次应用 Then历史仍可读但动作阻断且任务不完成', async () => {
  const f = await fixture({ hold: true, development: true })
  try {
    await until(() => pending.has(f.project.id), f.project.id); f.stop()
    const held = pending.get(f.project.id)!
    held.finish()
    const outcome = runs.getOwnerPlanningRunOutcome(held.executionId)!
    expect(outcome.qualityDecision?.verdict).toBe('accept')
    const failed = { executionId: outcome.executionId, receiptId: outcome.receiptId, state: 'failed', detail: 'Owner质量决定未按准确标准逐项判断或引用不符' }
    const integrityHash = createHash('sha256').update(JSON.stringify(failed)).digest('hex')
    store.getProjectDb().prepare('UPDATE project_owner_planning_run_outcomes SET payload=? WHERE execution_id=?').run(JSON.stringify({ ...failed, integrityHash }), outcome.executionId)
    expect(runs.recoverLegacyOwnerConversationReply(outcome.executionId)?.qualityDecision?.verdict).toBe('accept')
    const later = Date.now() + 31 * 60_000, clock = spyOn(Date, 'now').mockReturnValue(later)
    try {
      expect(runs.getOwnerPlanningRunOutcome(outcome.executionId)?.qualityDecision?.verdict).toBe('accept')
      const action = actions.applyOwnerQualityDecision(f.project.id, outcome.executionId)
      expect(action.state).toBe('blocked')
      expect(action.detail).toContain('不能在独立检查未通过')
      expect(f.tasks()[0]!.status).toBe('paused')
    } finally { clock.mockRestore() }
  } finally { f.stop() }
}, 15000)


test('Given研发首轮完整冻结源码与Owner返工决定 When启动返工 Then使用新会话继承源码并保留原会话证据', async () => {
  const f = await fixture({ development: true, rework: true, ownerDefect: true })
  try {
    await until(() => f.tasks().every(task => task.status === 'completed'), f.project.id)
    const records=await import('./project-owner-management-store')
    await until(()=>records.getOwnerManagementView(f.project.id).messages.some(item=>item.kind==='delivery'),f.project.id)
    const delivered=records.getOwnerManagementView(f.project.id).messages.find(item=>item.kind==='delivery')!.delivery!
    expect(delivered.items[0]!.artifactHash).toBe(actionRows(f.project.id).at(-1)!.artifactHash)
    const damaged=structuredClone(delivered), serialized=JSON.parse(damaged.items[0]!.content)
    serialized.files[0].newContent+='tampered'
    damaged.items[0]!.content=JSON.stringify(serialized)
    expect(()=>records.appendOwnerManagementMessage({projectId:f.project.id,eventId:randomUUID(),role:'assistant',kind:'delivery',content:'invalid',delivery:damaged})).toThrow('Owner成果条目无效')
    const executions=store.listAgentExecutionsByProject(f.project.id).filter(item=>item.ownerCommandId)
    const executors=executions.filter(item=>store.getProjectDb().prepare("SELECT 1 FROM project_owner_execution_commands WHERE id=? AND role='executor'").get(item.ownerCommandId!)).sort((left,right)=>left.startedAt-right.startedAt)
    expect(executors).toHaveLength(2)
    expect(new Set(executors.map(item=>item.sessionId)).size).toBe(2)
    expect(actionRows(f.project.id).map(item=>item.state)).toEqual(['rework_authorized','accepted'])
    const first=executors[0]!, workspace=workspaces.getAgentWorkspace(store.getTask(first.entityId)!.workspaceId!)!
    const content=readFileSync(join(workspaces.getAgentWorkspaceCwd(workspace,first.sessionId),'src/solution.cjs'),'utf8')
    expect(content).toContain('answer: 42')
    expect(executors[1]!.prompt).toContain(first.id)
  } finally { f.stop() }
},30000)
