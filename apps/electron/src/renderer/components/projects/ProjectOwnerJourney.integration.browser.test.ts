import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PROJECT_IPC_CHANNELS } from '@gravitas/shared'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import { buildElectronMock } from '../../../main/lib/testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-journey-browser-'))
const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('../../../main/lib/agent-service', () => ({ isAgentSessionActive: () => false }))

const database = await import('../../../main/lib/project-sqlite-store')
const employees = await import('../../../main/lib/agent-employee-service')
const controlledTasks = await import('../../../main/lib/controlled-project-task-service')
const { createAgentWorkspace, getAgentWorkspace, getAgentWorkspaceCwd, listAgentWorkspaces } = await import('../../../main/lib/agent-workspace-manager')
const { createChannel, listChannels } = await import('../../../main/lib/channel-manager')
const { bindWorkspaceToProject, listProjectWorkspaceBindings } = await import('../../../main/lib/project-workspace-bindings')
const { createProject } = await import('../../../main/lib/project-sqlite-store')
const { getOwnerManagementConversation } = await import('../../../main/lib/project-owner-management-questions')
const { startOwnerManagementLoop } = await import('../../../main/lib/project-owner-management-loop')
const { getProjectOwnerPlanDraft } = await import('../../../main/lib/project-owner-plan-service')
const { saveProjectOwnerGoalDraft } = await import('../../../main/lib/project-owner-goal-service')
const { saveOwnerRuntimeBinding } = await import('../../../main/lib/project-owner-runtime-binding')
const managementDelegation = await import('../../../main/lib/project-owner-management-delegation')
const { setHeadlessAgentRunner } = await import('../../../main/lib/agent-headless-runner-registry')
const { resolveOwnerPlanningSession } = await import('../../../main/lib/project-owner-planning-source')
const { claimOwnerPlanningProviderRequest } = await import('../../../main/lib/project-owner-planning-provider')
const { registerProjectOwnerGoalIpcHandlers } = await import('../../../main/lib/project-owner-goal-ipc')
const { registerProjectOwnerPlanIpcHandlers } = await import('../../../main/lib/project-owner-plan-ipc')
const { registerProjectOwnerRuntimeIpcHandlers } = await import('../../../main/lib/project-owner-runtime-ipc')
const { registerProjectOwnerExecutionIpcHandlers } = await import('../../../main/lib/project-owner-execution-ipc')
const { registerProjectOwnerExecutionGrantIpcHandlers } = await import('../../../main/lib/project-owner-execution-grant-ipc')
const { registerProjectOwnerExecutionRevalidationIpcHandlers } = await import('../../../main/lib/project-owner-execution-revalidation-ipc')
const { registerProjectOwnerTaskIpcHandlers } = await import('../../../main/lib/project-owner-task-ipc')

const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip
const ipcHandlers = new Map<string, (event: unknown, request: unknown) => unknown>()
const calls: string[] = []
const employeeCalls: string[] = []
const bridgeCalls: string[] = []
const register = { handle: (channel: string, handler: (event: unknown, request: unknown) => unknown) => { ipcHandlers.set(channel, handler) } }
registerProjectOwnerGoalIpcHandlers(register)
registerProjectOwnerPlanIpcHandlers(register)
registerProjectOwnerRuntimeIpcHandlers(register)
registerProjectOwnerExecutionIpcHandlers(register)
registerProjectOwnerExecutionGrantIpcHandlers(register)
registerProjectOwnerExecutionRevalidationIpcHandlers(register)
registerProjectOwnerTaskIpcHandlers(register)

beforeAll(async () => {
  await database.initProjectDb()
  setHeadlessAgentRunner(async (input, handlers) => {
    const execution = database.getAgentExecutionBySessionId(input.sessionId)
    if (execution?.ownerCommandId) {
      handlers.onRuntimeStarted?.()
      const command = database.getProjectDb().prepare('SELECT role FROM project_owner_execution_commands WHERE id=?').get(execution.ownerCommandId) as { role: 'executor' | 'reviewer' }
      const task = database.getTask(execution.entityId)
      const workspace = task?.workspaceId ? getAgentWorkspace(task.workspaceId) : null
      if (!task || !workspace) throw new Error('fake Runner 找不到已派发员工的任务或工作区')
      employeeCalls.push(command.role)
      const transport = Object.assign(async () => new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } }), { headers: { 'content-type': 'application/json' } }), { preconnect: () => {} }) as typeof globalThis.fetch
      const { createControlledProviderFetch } = await import('../../../main/lib/controlled-provider-boundary')
      const fetch = createControlledProviderFetch(input.sessionId, () => ({ runtime: 'ai-sdk', cwd: getAgentWorkspaceCwd(workspace, input.sessionId), modelId: input.modelId!, permissionMode: 'safe' }), transport)
      await fetch('https://example.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: input.modelId, max_tokens: 100, messages: [{ role: 'user', content: input.userMessage }] }) })
      let content = task.title.includes('修订')
        ? '已补充替代方案，并说明当前建议的依据与取舍。'
        : '已整理目标范围、证据和取舍，并标明仍需业务核验的不确定项。'
      if (command.role === 'reviewer') {
        const { assertOwnerReviewerTextDelivery } = await import('../../../main/lib/project-owner-text-delivery')
        const artifact = assertOwnerReviewerTextDelivery(execution.ownerCommandId)
        const step = database.getProjectDb().prepare('SELECT payload FROM project_owner_task_step_links WHERE task_id=?').get(execution.entityId) as { payload: string }
        const acceptanceCriteria = (JSON.parse(step.payload) as { projection: { acceptanceCriteria: string[] } }).projection.acceptanceCriteria
        if (!artifact) throw new Error('fake Reviewer 缺少已验收员工成果')
        content = JSON.stringify({ schemaVersion: 2, artifactHash: artifact.contentSha256, verdict: 'approved', summary: '完整成果符合当前范围', criteria: acceptanceCriteria.map(criterion => ({ criterion, status: 'met', evidence: '完整文本成果含有可核对依据', quote: artifact.content })), findings: [], blockerReason: null })
      }
      const message = { id: randomUUID(), role: 'assistant' as const, content, createdAt: Date.now() }
      ;(await import('../../../main/lib/agent-session-manager')).appendAgentMessage(input.sessionId, message)
      handlers.onComplete([message])
      return
    }
    const source = resolveOwnerPlanningSession(input.sessionId)
    if (!source) throw new Error('测试 Runner 找不到 Owner 来源')
    const body = JSON.stringify({
      model: source.binding.modelId,
      stream: true,
      max_tokens: source.link.maxOutputTokens,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: source.request.systemPrompt }, { role: 'user', content: source.request.userPrompt }],
    })
    claimOwnerPlanningProviderRequest(input.sessionId, body, new URL('https://example.invalid/v1/chat/completions'))
    let result: Record<string, unknown>
    const deliveryReview = source.context.conversation?.deliveryReview
    const executionObservation = source.context.conversation?.executionObservation
    if (deliveryReview?.qualityDecisionVersion === 1 && deliveryReview.artifact && deliveryReview.review && executionObservation) {
      calls.push('owner_quality')
      const artifact = deliveryReview.artifact
      const review = deliveryReview.review
      const response = {
        schemaVersion: 1,
        kind: 'quality_decision',
        binding: { projectId: source.link.projectId, goalVersion: source.context.goal.goal.goalVersion, contextFingerprint: source.context.fingerprint },
        messageId: source.context.conversation!.throughMessageId,
        message: '成果与独立检查已完成核对，正在记录验收结果。',
        decision: {
          reviewerCommandId: executionObservation.commandId,
          artifactHash: artifact.contentSha256,
          verdict: 'accept',
          reason: '已按完整成果、验收标准与独立评审核对',
          criteria: review.criteria.map(item => ({ criterion: item.criterion, status: 'met', evidence: '成果与独立评审均包含对应依据', quote: artifact.content })),
          findings: [],
        },
      }
      result = response
    } else if (source.context.conversation?.executionObservation) {
      calls.push('owner_followup')
      result = { schemaVersion: 1, kind: 'conversation_reply', projectId: source.link.projectId, goalVersion: source.context.goal.goal.goalVersion, contextFingerprint: source.context.fingerprint, messageId: source.context.conversation.throughMessageId, message: '我已记录当前进度，等独立检查完成后再核对成果。' }
    } else if (source.context.conversation?.deliveryFeedback) {
      calls.push('owner_feedback_planning')
      const feedback = source.context.conversation.deliveryFeedback
      const roleKey = source.context.sources.roles[0]?.key
      if (!roleKey) throw new Error('反馈重规划缺少可用岗位')
      result = {
        schemaVersion: 1,
        kind: 'plan_proposal',
        binding: { projectId: source.link.projectId, goalVersion: source.context.goal.goal.goalVersion, contextFingerprint: source.context.fingerprint },
        proposal: {
          summary: '在定位建议中补充替代方案与取舍',
          assumptions: [],
          risks: [],
          steps: [{ key: 'brief', title: '修订定位建议', outcome: '包含定位、替代方案与取舍的建议', acceptanceCriteria: ['说明建议与依据', '比较替代方案并解释取舍'], dependencies: [], roleKey }],
          deliveryFeedbackAssessment: {
            messageId: feedback.messageId,
            artifactHash: feedback.artifactHash,
            ...(feedback.stepKey ? { stepKey: feedback.stepKey } : {}),
            summary: '按反馈补充替代方案和取舍说明',
            changes: feedback.acceptanceCriteria.map(criterion => ({ criterion, disposition: 'addressed', proposedChange: '在修订建议中比较替代方案并解释取舍' })),
            authorizationImpact: 'within_confirmed_boundary',
            authorizationRationale: '仍在原定位建议范围内；旧执行许可不沿用',
          },
        },
      }
    } else if (source.link.purpose === 'owner_planning') {
      calls.push(source.link.purpose)
      const roleKey = source.context.sources.roles[0]?.key
      if (!roleKey) throw new Error('隔离项目没有规划岗位')
      result = {
        schemaVersion: 1,
        kind: 'plan_proposal',
        binding: { projectId: source.link.projectId, goalVersion: source.context.goal.goal.goalVersion, contextFingerprint: source.context.fingerprint },
        proposal: { summary: '为新项目整理一页可评审的定位建议', assumptions: [], risks: [], steps: [{ key: 'brief', title: '整理定位建议', outcome: '一页定位建议', acceptanceCriteria: ['说明建议与依据'], dependencies: [], roleKey }] },
      }
    } else {
      calls.push(source.link.purpose)
      const context = source.assignmentContext
      if (!context) throw new Error('隔离安排请求没有团队候选')
      const reviewer = context.candidates.find(item => item.roleTemplateId === 'delivery-verifier' || item.name === '独立检查')
      const step = context.steps[0]
      const executor = context.candidates.find(item => item.roleTemplateId === step?.roleKey) ?? context.candidates.find(item => item.id !== reviewer?.id)
      if (!reviewer || !executor || !step) throw new Error('隔离团队不能满足方案岗位和独立检查')
      const workspaceId = context.workspaces.find(workspace => [executor, reviewer].every(employee => employee.workspaceIds.includes(workspace.id)))?.id
      if (!workspaceId) throw new Error('隔离安排没有员工共同授权的工作区')
      result = {
        schemaVersion: 1,
        contextFingerprint: context.contextFingerprint,
        selectedStepKeys: context.steps.map(item => item.key),
        scopeReason: '按确认后的结果范围组织执行',
        workspaceId,
        workspaceReason: '使用用户刚确认纳入项目范围的团队工作区',
        executionKind: 'controlled',
        executionKindReason: '本次交付不需要修改代码',
        assignments: context.steps.map(item => ({ roleKey: item.roleKey, employeeId: executor.id, reason: '现有员工能力适配本步骤' })),
        reviewerEmployeeId: reviewer.id,
        reviewerReason: '由另一位员工独立检查成果',
      }
    }
    handlers.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: input.sessionId, finish_reason: 'stop', result: JSON.stringify(result), usage: { input_tokens: 10, output_tokens: 30 }, owner_planning_usage: { inputTokens: 10, outputTokens: 30, cacheReadTokens: null, cacheWriteTokens: null } } })
  })
})

afterAll(() => {
  employees.stopAgentEmployeeHeartbeat()
  database.closeProjectDb()
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
  rmSync(directory, { recursive: true, force: true })
})

browserTest('Given失效管理授权与未授权团队 When用户恢复范围并确认团队资料 Then Owner自动执行独立检查并交付回原对话', async () => {
  const project = createProject({ title: '浏览器旅程隔离项目', description: '' })
  const workspace = createAgentWorkspace(`owner-journey-${randomUUID()}`)
  const teamWorkspace = createAgentWorkspace(`owner-team-journey-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: 'Owner journey fake', provider: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: 'fake-only', enabled: true, models: [{ id: 'deepseek-flash', name: '隔离模型', enabled: true }] })
  const owner = employees.createAgentEmployee({ name: 'Owner', role: '项目管理者', description: '隔离旅程Owner载体', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId: 'deepseek-flash', workspaceIds: [workspace.id] })
  for (const [name, roleTemplateId] of [['需求分析师', 'requirements-analyst'], ['独立检查', 'delivery-verifier']] as const) {
    employees.createAgentEmployee({ name, role: name, roleTemplateId, description: '浏览器旅程隔离员工', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId: 'deepseek-flash', workspaceIds: [teamWorkspace.id] })
  }
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '为新项目整理一页产品定位建议' })
  saveOwnerRuntimeBinding(project.id, 0, { ownerName: 'Owner', carrierId: owner.id, workspaceId: workspace.id, changeReason: '隔离连续旅程' })
  const oldDelegationInput = { projectId: project.id, requestId: randomUUID(), maxRequests: 8, maxCostMicros: 15_000_000, expiresAt: Date.now() + 24 * 3600000 }
  const oldDelegationPreview = managementDelegation.previewOwnerManagementDelegation(oldDelegationInput)
  managementDelegation.confirmOwnerManagementDelegation({ input: oldDelegationInput, previewHash: oldDelegationPreview.previewHash })
  saveProjectOwnerGoalDraft(project.id, 1, { objective: '为新项目整理一页产品定位建议', constraints: ['纳入当前授权的团队范围'] })
  expect(managementDelegation.getOwnerManagementDelegation(project.id).state).toBe('stale')
  const scheduler = await import('../../../main/lib/project-owner-autonomous-scheduler')
  const scheduleEvents = await import('../../../main/lib/project-owner-autonomous-scheduler-events')
  const stopWake = scheduleEvents.onOwnerAutonomousScheduleWake(projectId => { if (projectId === project.id) void scheduler.runOwnerAutonomousSchedule(projectId) })
  const stopManagement = startOwnerManagementLoop()
  const apiNames = new Map<string, string>([
    ['getOwnerGoalDraft', PROJECT_IPC_CHANNELS.GET_OWNER_GOAL_DRAFT], ['saveOwnerGoalDraft', PROJECT_IPC_CHANNELS.SAVE_OWNER_GOAL_DRAFT],
    ['getOwnerManagement', PROJECT_IPC_CHANNELS.GET_OWNER_MANAGEMENT], ['sendOwnerManagementMessage', PROJECT_IPC_CHANNELS.SEND_OWNER_MANAGEMENT_MESSAGE], ['getOwnerManagementDelegation', PROJECT_IPC_CHANNELS.GET_OWNER_MANAGEMENT_DELEGATION],
    ['previewOwnerManagementDelegation', PROJECT_IPC_CHANNELS.PREVIEW_OWNER_MANAGEMENT_DELEGATION], ['confirmOwnerManagementDelegation', PROJECT_IPC_CHANNELS.CONFIRM_OWNER_MANAGEMENT_DELEGATION], ['confirmOwnerTeamWorkspaceAccess', PROJECT_IPC_CHANNELS.CONFIRM_OWNER_TEAM_WORKSPACE_ACCESS],
    ['getOwnerPlanDraft', PROJECT_IPC_CHANNELS.GET_OWNER_PLAN_DRAFT], ['getOwnerPlanningContext', PROJECT_IPC_CHANNELS.GET_OWNER_PLANNING_CONTEXT], ['listOwnerPlanHistory', PROJECT_IPC_CHANNELS.LIST_OWNER_PLAN_HISTORY], ['saveOwnerPlanDraft', PROJECT_IPC_CHANNELS.SAVE_OWNER_PLAN_DRAFT], ['confirmOwnerPlanDraft', PROJECT_IPC_CHANNELS.CONFIRM_OWNER_PLAN_DRAFT],
    ['getOwnerRuntimeBinding', PROJECT_IPC_CHANNELS.GET_OWNER_RUNTIME_BINDING], ['ensureOwnerRuntimeBinding', PROJECT_IPC_CHANNELS.ENSURE_OWNER_RUNTIME_BINDING], ['saveOwnerRuntimeBinding', PROJECT_IPC_CHANNELS.SAVE_OWNER_RUNTIME_BINDING], ['listOwnerPlanningRuns', PROJECT_IPC_CHANNELS.LIST_OWNER_PLANNING_RUNS], ['prepareOwnerPlanning', PROJECT_IPC_CHANNELS.PREPARE_OWNER_PLANNING],
    ['getOwnerExecutionPreparation', PROJECT_IPC_CHANNELS.GET_OWNER_EXECUTION_PREPARATION], ['listOwnerExecutionPreparationHistory', PROJECT_IPC_CHANNELS.LIST_OWNER_EXECUTION_PREPARATION_HISTORY], ['previewOwnerExecutionPreparation', PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_PREPARATION], ['saveOwnerExecutionPreparation', PROJECT_IPC_CHANNELS.SAVE_OWNER_EXECUTION_PREPARATION],
    ['listOwnerExecutionAssignmentRuns', PROJECT_IPC_CHANNELS.LIST_OWNER_EXECUTION_ASSIGNMENT_RUNS], ['prepareOwnerExecutionAssignment', PROJECT_IPC_CHANNELS.PREPARE_OWNER_EXECUTION_ASSIGNMENT],
    ['previewOwnerExecutionGrantIssue', PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_GRANT_ISSUE], ['confirmOwnerExecutionGrantIssue', PROJECT_IPC_CHANNELS.CONFIRM_OWNER_EXECUTION_GRANT_ISSUE], ['previewOwnerExecutionGrantRevoke', PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_GRANT_REVOKE], ['confirmOwnerExecutionGrantRevoke', PROJECT_IPC_CHANNELS.CONFIRM_OWNER_EXECUTION_GRANT_REVOKE],
    ['getOwnerExecutionGrant', PROJECT_IPC_CHANNELS.GET_OWNER_EXECUTION_GRANT], ['listOwnerExecutionGrantHistory', PROJECT_IPC_CHANNELS.LIST_OWNER_EXECUTION_GRANT_HISTORY], ['getOwnerExecutionRevalidation', PROJECT_IPC_CHANNELS.GET_OWNER_EXECUTION_REVALIDATION], ['listOwnerExecutionRevalidationHistory', PROJECT_IPC_CHANNELS.LIST_OWNER_EXECUTION_REVALIDATION_HISTORY], ['getOwnerTaskMaterialization', PROJECT_IPC_CHANNELS.GET_OWNER_TASK_MATERIALIZATION], ['listOwnerTaskMaterializationHistory', PROJECT_IPC_CHANNELS.LIST_OWNER_TASK_MATERIALIZATION_HISTORY], ['listOwnerExecutionCommands', PROJECT_IPC_CHANNELS.LIST_OWNER_EXECUTION_COMMANDS], ['getOwnerAutonomousScheduleStatus', PROJECT_IPC_CHANNELS.GET_OWNER_AUTONOMOUS_SCHEDULE_STATUS],
    ['previewOwnerExecutionRevalidation', PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_REVALIDATION], ['saveOwnerExecutionRevalidation', PROJECT_IPC_CHANNELS.SAVE_OWNER_EXECUTION_REVALIDATION], ['previewOwnerTaskMaterialization', PROJECT_IPC_CHANNELS.PREVIEW_OWNER_TASK_MATERIALIZATION], ['materializeOwnerTasks', PROJECT_IPC_CHANNELS.MATERIALIZE_OWNER_TASKS],
    ['saveOwnerExecutionStartIntent', PROJECT_IPC_CHANNELS.SAVE_OWNER_EXECUTION_START_INTENT], ['resumeOwnerExecutionStartIntent', PROJECT_IPC_CHANNELS.RESUME_OWNER_EXECUTION_START_INTENT],
  ])
  const entry = join(directory, 'entry.tsx')
  writeFileSync(entry, `
import React from 'react';import {createRoot} from 'react-dom/client';import {Provider,createStore} from 'jotai';
import {ProjectOwnerConversation} from ${JSON.stringify(join(renderer, 'components/projects/ProjectOwnerConversation.tsx'))};
const projectId=${JSON.stringify(project.id)},channels=${JSON.stringify(Object.fromEntries(apiNames))};
const invoke=(name,payload)=>fetch('/invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,payload})}).then(response=>response.json());
const projectApi=Object.fromEntries(Object.entries(channels).map(([name,channel])=>[name,payload=>invoke(channel,payload)]));
window.electronAPI={getSettings:async()=>({}),listChannels:async()=>invoke('listChannels'),listAgentWorkspaces:async()=>invoke('listAgentWorkspaces'),createAgentWorkspace:async name=>invoke('createAgentWorkspace',{name}),paa:{project:projectApi,projectWorkspace:{listByProject:async id=>invoke('listProjectWorkspaceBindings',{projectId:id}),bind:async(projectId,workspaceId)=>invoke('bindWorkspaceToProject',{projectId,workspaceId})},agentEmployees:{list:async()=>invoke('listEmployees'),create:async input=>invoke('createEmployee',{input}),getControlledTaskStartPreview:async taskId=>invoke('getControlledTaskStartPreview',{taskId}),startControlledTask:async input=>invoke('startControlledTask',input)}}};
projectApi.onOwnerManagementChanged=callback=>{let seen=new Set();const timer=setInterval(async()=>{const response=await projectApi.getOwnerManagement({projectId});if(!response.ok)return;for(const message of response.value.messages){if(seen.has(message.id))continue;seen.add(message.id);callback({projectId,messageId:message.id})}},100);return()=>clearInterval(timer)};
createRoot(document.getElementById('root')).render(<Provider store={createStore()}><ProjectOwnerConversation projectId={projectId}/></Provider>);
`)
  const handlers = new Map(ipcHandlers)
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== '/invoke') return new Response('<html><body><div id="root"></div><script src="/entry.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } })
    const body = await request.json() as { name: string; payload?: unknown }
    bridgeCalls.push(body.name)
    if (body.name === 'listChannels') return Response.json(listChannels())
    if (body.name === 'listAgentWorkspaces') return Response.json(listAgentWorkspaces())
    if (body.name === 'getControlledTaskStartPreview') return Response.json(controlledTasks.getControlledTaskStartPreview((body.payload as { taskId: string }).taskId))
    if (body.name === 'startControlledTask') return Response.json(await controlledTasks.startControlledTask(body.payload))
    if (body.name === 'createAgentWorkspace') return Response.json(createAgentWorkspace((body.payload as { name: string }).name))
    if (body.name === 'listProjectWorkspaceBindings') return Response.json(listProjectWorkspaceBindings(project.id))
    if (body.name === 'bindWorkspaceToProject') return Response.json(bindWorkspaceToProject(project.id, (body.payload as { workspaceId: string }).workspaceId))
    if (body.name === 'listEmployees') return Response.json(employees.listAgentEmployees().map(employee => ({ ...employee, skills: employee.skills ?? [] })))
    if (body.name === 'createEmployee') return Response.json({ ...employees.createAgentEmployee((body.payload as { input: Parameters<typeof employees.createAgentEmployee>[0] }).input), skills: [] })
    const handler = handlers.get(body.name)
    if (!handler) return Response.json({ ok: false, error: { code: 'failed', message: `未注册生产IPC：${body.name}` } })
    const value = await handler(undefined, body.payload)
    return Response.json(value)
  }, routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const bundle = await build({ entryPoints: [entry], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  void bundle
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  page.setDefaultTimeout(10000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const debug = async () => JSON.stringify({ calls, employeeCalls, body: (await page.locator('body').innerText()).slice(-8000), progressCount: await page.getByLabel('Owner项目进度与成果').count(), progressText: await page.getByLabel('Owner项目进度与成果').allInnerTexts(), executionSectionCount: await page.getByLabel('确认成果范围并开始').count(), planState: getProjectOwnerPlanDraft(project.id)?.state, ownerMessages: getOwnerManagementConversation(project.id).messages, commandViews: await ipcHandlers.get(PROJECT_IPC_CHANNELS.LIST_OWNER_EXECUTION_COMMANDS)?.(undefined, { projectId: project.id }), errors }, null, 2)
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByLabel('Owner管理委托').waitFor()
    await page.getByRole('button', { name: '重新核对当前授权', exact: true }).waitFor()
    await page.getByLabel('项目总模型费用上限（美元）').fill('15')
    // 初始预算不足时预览会要求重新核对；提高预算后沿用户可见的恢复路径继续。
    const confirmScope = page.getByRole('button', { name: '确认范围，让 Owner 自主推进', exact: true })
    const retryScope = page.getByRole('button', { name: '重新核对授权范围', exact: true })
    await confirmScope.or(retryScope).first().waitFor().catch(async cause => { throw new Error(`${String(cause)}\n${await debug()}`) })
    if (await retryScope.isVisible()) await retryScope.click()
    await page.getByText('项目总模型费用上限为 $15.00', { exact: false }).waitFor().catch(async cause => { throw new Error(`${String(cause)}\n${await debug()}`) })
    await confirmScope.waitFor().catch(async cause => { throw new Error(`${String(cause)}\n${await debug()}`) })
    await page.getByRole('button', { name: '确认范围，让 Owner 自主推进', exact: true }).click()
    const teamScope = page.getByLabel('团队工作区范围建议').last()
    await teamScope.waitFor()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(getOwnerManagementConversation(project.id).messages.filter(message => message.teamWorkspaceProposal)).toHaveLength(1)
    expect(await teamScope.innerText()).toContain('owner-team-journey')
    await teamScope.getByRole('button', { name: '允许本项目使用这个团队工作区', exact: true }).click()
    await page.getByText('范围已确认，Owner正在继续核对团队安排。', { exact: true }).waitFor()
    await page.getByLabel('Owner方案摘要').getByText('为新项目整理一页可评审的定位建议', { exact: true }).waitFor().catch(async cause => { throw new Error(`${String(cause)}\n${await debug()}`) })
    expect(calls).toContain('owner_planning')
    expect(calls).toContain('owner_execution_assignment')
    expect(getProjectOwnerPlanDraft(project.id)?.state).toBe('confirmed')
    expect(await page.getByRole('button', { name: '确认方案并开始执行', exact: true }).count()).toBe(0)
    for (let attempt = 0; attempt < 200 && !getOwnerManagementConversation(project.id).messages.some(message => message.kind === 'delivery'); attempt++) await new Promise(resolve => setTimeout(resolve, 50))
    await page.getByLabel('已验收成果').waitFor().catch(async cause => { throw new Error(`${String(cause)}\n${await debug()}`) })
    expect(calls).toContain('owner_execution_assignment')
    expect(calls).toContain('owner_quality')
    expect(employeeCalls).toEqual(['executor', 'reviewer'])
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    server.stop(true)
    stopManagement()
    stopWake()
  }
}, 90000)
