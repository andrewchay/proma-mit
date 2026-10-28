import { afterAll, beforeAll, expect, mock, spyOn, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import type { ProviderType } from '@gravitas/shared'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-stage-b-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel, decryptApiKey } = await import('./channel-manager')
const { getAgentWorkspaceCwd } = await import('./agent-workspace-manager')
const boundary = await import('./controlled-provider-boundary')
const { resolveAgentRuntimeBaseUrl } = await import('@gravitas/shared')
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
const command = await import('./project-owner-execution-command')
const dispatcher = await import('./project-owner-execution-dispatcher')
const settlement = await import('./project-owner-execution-settlement')
const technicalReview = await import('./project-owner-technical-review')
const requestExit = await import('./project-owner-execution-request-exit')
const preflightReconciliation = await import('./project-owner-execution-preflight-reconciliation')
const requestEvidence = await import('./project-pilot-request-evidence')
const stopModule = await import('./project-owner-execution-stop')
const startModule = await import('./project-owner-execution-start')
const actionApproval = await import('./project-owner-action-approval')
const executionGates = await import('./project-owner-execution-gates')
const { executeWriteTool } = await import('./agent-runtime/tool-impls/write-tool')
const { executeEditTool } = await import('./agent-runtime/tool-impls/edit-tool')
const { handlePermissionResponse } = await import('./agent-permission-response')
const { AgentPermissionService } = await import('./agent-permission-service')
const runnerRegistry = await import('./agent-headless-runner-registry')
const evidence = await import('./project-owner-execution-preparation-evidence')
const scheduler = await import('./project-owner-autonomous-scheduler')
const schedulerEvents = await import('./project-owner-autonomous-scheduler-events')
let policy: typeof import('./project-pilot-policy')
beforeAll(async () => { await store.initProjectDb(); policy = await import('./project-pilot-policy') })
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
function fixture(modelId = 'glm-5.3-flash', dispatchMode: 'manual' | 'autonomous' = 'manual', withDependentTask = false, baseUrl = 'https://example.invalid', splitRoleEmployee = false, provider: ProviderType = 'openai', maxRework = 0, maxRuns?: number, maxCostMicros = 1000000, roleBudgetCapMicros?: number, independentTasks = false, taskScopedGoal = false) {
  const project = store.createProject({ title: 'StageB fixture', description: '' })
  const goalTask = taskScopedGoal ? store.createTask(project.id, { title: '单任务目标主体', description: '目标来源任务' }) : undefined
  const workspace = createAgentWorkspace(`owner-stageb-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: 'fake', provider, baseUrl, apiKey: 'fake', enabled: true, models: [{ id: modelId, name: modelId, enabled: true }] })
  const employee = (name: string) => employees.createAgentEmployee({ name, role: '研究', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId, workspaceIds: [workspace.id] })
  const executor = employee('执行者'), secondExecutor = splitRoleEmployee ? employee('第二岗位执行者') : executor, reviewer = employee('技术评审')
  if (goalTask) saveProjectOwnerGoalDraft(project.id, 0, { objective: '项目目标' })
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '目标' }, goalTask?.id)
  if (dispatchMode === 'autonomous') {
    const owner = employee('Owner')
    saveOwnerRuntimeBinding(project.id, 0, { ownerName: 'Owner', carrierId: owner.id, workspaceId: workspace.id, changeReason: '测试' })
    management.reconcileOwnerManagement(project.id)
    const delegationInput = { projectId: project.id, ...(goalTask ? { taskId: goalTask.id } : {}), requestId: randomUUID(), maxRequests: 6, maxCostMicros: 4_000_000, expiresAt: Date.now() + 6 * 3600000 }
    const delegationPreview = managementDelegation.previewOwnerManagementDelegation(delegationInput)
    managementDelegation.confirmOwnerManagementDelegation({ input: delegationInput, previewHash: delegationPreview.previewHash })
  }
  const context = plans.getProjectOwnerPlanningContext(project.id, goalTask?.id)
  const orderedRoleKeys = context.sources.roles.map((role) => role.key).sort()
  const firstRoleKey = orderedRoleKeys[0]!
  const secondRoleKey = splitRoleEmployee ? orderedRoleKeys[1]! : firstRoleKey
  const steps = [
    { key: 'brief', title: '研究', outcome: '材料', acceptanceCriteria: ['范围'], dependencies: [] as string[], roleKey: firstRoleKey },
    ...(withDependentTask ? [{ key: 'delivery', title: '交付', outcome: '提交', acceptanceCriteria: ['完成'], dependencies: splitRoleEmployee || independentTasks ? [] : ['brief'], roleKey: secondRoleKey }] : []),
  ]
  plans.saveProjectOwnerPlanDraft(project.id, 1, 0, { expectedContextFingerprint: context.fingerprint, summary: '计划', assumptions: [], risks: [], steps, changeReason: '建立' }, goalTask?.id)
  plans.confirmProjectOwnerPlanDraft(project.id, 1, 1, goalTask?.id)
  const subject = { projectId: project.id, ...(goalTask ? { taskId: goalTask.id } : {}) }
  const preparationInput = { requestId: randomUUID(), expectedPreparationRevision: 0, expectedPolicyRevision: null, expectedGoalRevision: 1, expectedPlanRevision: 2, selectedStepKeys: steps.map(step => step.key), executionKind: 'controlled' as const, executorEmployeeId: executor.id, reviewerEmployeeId: reviewer.id, roleAssignments: [...new Set(steps.map(step => step.roleKey))].map(roleKey => ({ roleKey, employeeId: splitRoleEmployee && roleKey === secondRoleKey ? secondExecutor.id : executor.id })), ...(roleBudgetCapMicros === undefined ? {} : { roleBudgetCaps: [{ roleKey: firstRoleKey, maxCostMicros: roleBudgetCapMicros }] }), workspaceId: workspace.id, knowledgeSourceIds: [], maxCostMicros, maxRuns: maxRuns ?? steps.length * (2 + maxRework * 2), maxRework, expiresAt: Date.now() + 3600000, changeReason: '准备' }
  const pv = prep.previewOwnerExecutionPreparation(subject, preparationInput), preparation = prep.saveOwnerExecutionPreparation(subject, preparationInput, pv.previewFingerprint)
  const materialInput = { requestId: randomUUID(), expectedMaterializationRevision: 0, expectedPreparationId: preparation.id, expectedPreparationRevision: preparation.revision, expectedPreparationHash: preparation.integrityHash, expectedPolicyRevision: preparation.policyRevision }
  const mpv = materialization.previewOwnerTaskMaterialization(subject, materialInput), batch = materialization.materializeOwnerTasks(subject, materialInput, mpv.previewFingerprint)
  const revalInput = { requestId: randomUUID(), expectedRevalidationRevision: 0, expectedMaterializationId: batch.id, expectedMaterializationRevision: batch.revision, expectedMaterializationHash: batch.integrityHash, expectedPolicyRevision: batch.input.expectedPolicyRevision, changeReason: '重验证' }
  const rpv = revalidation.previewOwnerExecutionRevalidation(subject, revalInput), record = revalidation.saveOwnerExecutionRevalidation(subject, revalInput, rpv.previewFingerprint)
  const issueInput = { requestId: randomUUID(), expectedRevalidationRevision: record.revision, expectedPolicyRevision: policy.getPilotPolicy(project.id)!.revision, dispatchMode }
  const ip = grantIssue.previewOwnerExecutionGrantIssue(subject, issueInput), grant = grantIssue.confirmOwnerExecutionGrantIssue(subject, { input: issueInput, preview: ip, confirmedFingerprint: ip.approvalFingerprint })
  const tasks = store.listTasks(project.id).filter(item => item.ownerStepLinkId), task = tasks[0]!
  return { project, subject, record, batch, grant, task, tasks, workspace, channel, executor, secondExecutor, reviewer, goalTask }
}
/** 终态回调已改为异步（需等待逐请求结算落库），测试用轮询等待权威终态而不是假定同步完成。 */
async function waitForExecutionTerminal(executionId: string, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = store.getAgentExecution(executionId)?.status
    if (status && status !== 'running' && status !== 'queued') return status
    await Bun.sleep(5)
  }
  throw new Error(`执行未在 ${timeoutMs}ms 内进入终态`)
}

function ackFixture(f: ReturnType<typeof fixture>) {
  const input = { grantId: f.grant.grantId, taskId: f.task.id, role: 'executor' as const, reworkOrdinal: 0, expectedRevalidationRevision: f.record.revision }
  const preview = command.previewOwnerExecutionCommandAck(f.subject, input)
  const ack = { input, preview, confirmedFingerprint: preview.ackFingerprint, acknowledgeModelCosts: true }
  return { input, preview, ack }
}

test('Given真实Owner命令进入运行态 When审批精确工具动作 Then仅保存参数指纹且拒绝可审计', async () => {
  const f = fixture()
  const { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID(), sessionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  store.getProjectDb().prepare("UPDATE project_owner_execution_commands SET state='running' WHERE id=?").run(commandId)
  store.getProjectDb().prepare("UPDATE agent_executions SET status='running',session_id=? WHERE id=?").run(sessionId, executionId)
  const request = { requestId: randomUUID(), sessionId, toolName: 'Write', toolInput: { file_path: 'result.md', content: 'exact approved proposal' }, description: 'write result', dangerLevel: 'normal' as const, requiresPerActionApproval: true }
  actionApproval.recordOwnerActionApprovalRequest({ commandId, executionId, sessionId }, request)
  expect(actionApproval.hasApprovedOwnerAction(sessionId, request)).toBe(false)
  expect(actionApproval.listOwnerPendingActionRequests(f.project.id)).toContainEqual({ requestId: request.requestId, sessionId, taskId: f.task.id })
  expect(actionApproval.listOwnerPendingActionRequests(randomUUID())).toEqual([])
  expect(JSON.stringify(actionApproval.listOwnerPendingActionRequests(f.project.id))).not.toContain('exact approved proposal')
  expect(() => actionApproval.decideOwnerActionApproval({ ...request, toolInput: { ...request.toolInput, content: 'changed after preview' } }, 'deny', { commandId, executionId, sessionId })).toThrow('记录不匹配')
  actionApproval.decideOwnerActionApproval(request, 'deny', { commandId, executionId, sessionId })
  expect(actionApproval.listOwnerPendingActionRequests(f.project.id)).toEqual([])
  const row = store.getProjectDb().prepare('SELECT project_id,command_id,execution_id,session_id,tool_name,action_fingerprint,status,decided_by,decision_reason FROM project_owner_action_approvals WHERE request_id=?').get(request.requestId) as Record<string, unknown>
  expect(row).toMatchObject({ project_id: f.project.id, command_id: commandId, execution_id: executionId, session_id: sessionId, tool_name: 'Write', status: 'denied', decided_by: 'local-user', decision_reason: 'user_rejected' })
  expect(row.action_fingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(row)).not.toContain('exact approved proposal')
  expect(() => actionApproval.decideOwnerActionApproval(request, 'allow', { commandId, executionId, sessionId })).toThrow('已处理')
  expect(command.listOwnerExecutionCommands(f.subject).find(item => item.commandId === commandId)?.actionApprovals).toMatchObject([
    { requestId: request.requestId, toolName: 'Write', status: 'denied', decidedBy: 'local-user', reason: 'user_rejected' },
  ])
  expect(JSON.stringify(command.listOwnerExecutionCommands(f.subject).find(item => item.commandId === commandId)?.actionApprovals)).not.toContain('exact approved proposal')

  const allowedRequest = { ...request, requestId: randomUUID(), toolName: 'SendExternalMessage' }
  actionApproval.recordOwnerActionApprovalRequest({ commandId, executionId, sessionId }, allowedRequest)
  actionApproval.decideOwnerActionApproval(allowedRequest, 'allow', { commandId, executionId, sessionId })
  expect(actionApproval.hasApprovedOwnerAction(sessionId, allowedRequest)).toBe(true)
  expect(actionApproval.hasApprovedOwnerAction(sessionId, { ...allowedRequest, toolInput: { content: 'different action' } })).toBe(false)
  expect(store.getProjectDb().prepare('SELECT status,decided_by,decision_reason FROM project_owner_action_approvals WHERE request_id=?').get(allowedRequest.requestId)).toEqual({ status: 'allowed', decided_by: 'local-user', decision_reason: null })
  expect(command.listOwnerExecutionCommands(f.subject).find(item => item.commandId === commandId)?.actionApprovals).toMatchObject([
    { requestId: request.requestId, status: 'denied' }, { requestId: allowedRequest.requestId, toolName: 'SendExternalMessage', status: 'allowed' },
  ])
  expect(actionApproval.consumeApprovedOwnerAction(sessionId, allowedRequest)).toBe(true)
  expect(actionApproval.hasApprovedOwnerAction(sessionId, allowedRequest)).toBe(false)
  expect(actionApproval.consumeApprovedOwnerAction(sessionId, allowedRequest)).toBe(false)

  executionGates.admitOwnerExecutionGateSession(executionId, sessionId)
  const writeRequest = { ...request, requestId: randomUUID(), toolInput: { content: 'exact approved proposal', file_path: 'result.md' } }
  actionApproval.recordOwnerActionApprovalRequest({ commandId, executionId, sessionId }, writeRequest)
  actionApproval.decideOwnerActionApproval(writeRequest, 'allow', { commandId, executionId, sessionId })
  const cwd = getAgentWorkspaceCwd(f.workspace, sessionId)
  const firstWrite = await executeWriteTool(writeRequest.toolInput, { cwd, sessionId, ownerWorkspaceWrite: true })
  expect(firstWrite.isError).toBeFalsy()
  const replay = await executeWriteTool(writeRequest.toolInput, { cwd, sessionId, ownerWorkspaceWrite: true })
  expect(replay.isError).toBe(true)
  expect(command.listOwnerExecutionCommands(f.subject).find(item => item.commandId === commandId)?.actionApprovals?.find(item => item.requestId === writeRequest.requestId)?.consumedAt).toEqual(expect.any(Number))
  const editRequest = { ...request, requestId: randomUUID(), toolName: 'Edit', toolInput: { file_path: 'result.md', old_string: 'not-present', new_string: 'replacement' } }
  actionApproval.recordOwnerActionApprovalRequest({ commandId, executionId, sessionId }, editRequest)
  actionApproval.decideOwnerActionApproval(editRequest, 'allow', { commandId, executionId, sessionId })
  expect((await executeEditTool(editRequest.toolInput, { cwd, sessionId, ownerWorkspaceWrite: true })).content).toContain('未找到')
  expect((await executeEditTool(editRequest.toolInput, { cwd, sessionId, ownerWorkspaceWrite: true })).isError).toBe(true)

  const staleRequest = { ...request, requestId: randomUUID() }
  actionApproval.recordOwnerActionApprovalRequest({ commandId, executionId, sessionId }, staleRequest)
  store.getProjectDb().prepare("UPDATE project_owner_execution_grants SET state='paused' WHERE id=?").run(f.grant.grantId)
  expect(actionApproval.listOwnerPendingActionRequests(f.project.id)).toEqual([])
  expect(actionApproval.hasApprovedOwnerAction(sessionId, allowedRequest)).toBe(false)
  expect(() => actionApproval.decideOwnerActionApproval(staleRequest, 'allow', { commandId, executionId, sessionId })).toThrow('来源已失效')
  expect(store.getProjectDb().prepare('SELECT status,decision_reason FROM project_owner_action_approvals WHERE request_id=?').get(staleRequest.requestId)).toEqual({ status: 'invalidated', decision_reason: 'source_changed' })
  expect(command.listOwnerExecutionCommands(f.subject).find(item => item.commandId === commandId)?.actionApprovals?.find(item => item.requestId === staleRequest.requestId))
    .toMatchObject({ status: 'invalidated', reason: 'source_changed' })
})

test('Given真实Owner命令经权限服务请求敏感动作 WhenUI裁决 Then逐次响应进入同库审计且拒绝零执行', async () => {
  const f = fixture()
  const { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID(), sessionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  store.getProjectDb().prepare("UPDATE project_owner_execution_commands SET state='running' WHERE id=?").run(commandId)
  store.getProjectDb().prepare("UPDATE agent_executions SET status='running',session_id=? WHERE id=?").run(sessionId, executionId)

  const requests: import('@gravitas/shared').PermissionRequest[] = []
  const permissionService = new AgentPermissionService()
  const identity = { commandId, executionId, sessionId }
  const canUseTool = permissionService.createCanUseTool(
    sessionId,
    request => requests.push(request),
    undefined,
    undefined,
    'safe',
    {
      onRequest: request => actionApproval.recordOwnerActionApprovalRequest(identity, request),
      onDecision: (request, behavior) => actionApproval.decideOwnerActionApproval(request, behavior, identity),
      onCancel: request => actionApproval.invalidateOwnerActionApproval(request.requestId),
    },
  )
  let toolExecutions = 0
  const windowEvents: Array<{ sessionId: string; payload: import('@gravitas/shared').AgentStreamPayload }> = []
  const sessionEvents: Array<{ sessionId: string; payload: import('@gravitas/shared').AgentStreamPayload }> = []
  const responseDependencies = {
    respondToPermission: (requestId: string, behavior: 'allow' | 'deny', alwaysAllow: boolean) => permissionService.respondToPermission(requestId, behavior, alwaysAllow),
    sendResolvedEvent: (targetSessionId: string, payload: import('@gravitas/shared').AgentStreamPayload) => windowEvents.push({ sessionId: targetSessionId, payload }),
    emitResolvedEvent: (targetSessionId: string, payload: import('@gravitas/shared').AgentStreamPayload) => sessionEvents.push({ sessionId: targetSessionId, payload }),
  }
  const expectedResolution = (requestId: string, behavior: 'allow' | 'deny') => ({
    sessionId,
    payload: { kind: 'proma_event' as const, event: { type: 'permission_resolved' as const, requestId, behavior } },
  })
  const invokeSyntheticTool = async (inputValue: Record<string, unknown>) => {
    const result = await canUseTool('Write', inputValue, { signal: new AbortController().signal, toolUseID: randomUUID() })
    if (result.behavior === 'allow') toolExecutions += 1
    return result
  }

  const deniedInput = { file_path: '/tmp/owner-denied.md', content: 'synthetic denied content' }
  const deniedResultPromise = invokeSyntheticTool(deniedInput)
  const deniedRequest = requests[0]!
  expect(deniedRequest).toMatchObject({ requiresPerActionApproval: true, sessionId, toolName: 'Write', toolInput: deniedInput })
  expect(store.getProjectDb().prepare('SELECT status FROM project_owner_action_approvals WHERE request_id=?').get(deniedRequest.requestId)).toEqual({ status: 'pending' })
  expect(() => handlePermissionResponse({ requestId: deniedRequest.requestId, behavior: 'allow', alwaysAllow: true }, responseDependencies)).toThrow('只能逐次确认')
  expect(windowEvents).toHaveLength(0)
  expect(sessionEvents).toHaveLength(0)
  handlePermissionResponse({ requestId: deniedRequest.requestId, behavior: 'deny', alwaysAllow: false }, responseDependencies)
  expect(await deniedResultPromise).toMatchObject({ behavior: 'deny' })
  expect(store.getProjectDb().prepare('SELECT status,decided_by,decision_reason FROM project_owner_action_approvals WHERE request_id=?').get(deniedRequest.requestId)).toEqual({ status: 'denied', decided_by: 'local-user', decision_reason: 'user_rejected' })
  expect(toolExecutions).toBe(0)
  expect(windowEvents).toEqual([expectedResolution(deniedRequest.requestId, 'deny')])
  expect(sessionEvents).toEqual([expectedResolution(deniedRequest.requestId, 'deny')])

  const allowedInput = { file_path: '/tmp/owner-allowed.md', content: 'synthetic approved content' }
  const allowedResultPromise = invokeSyntheticTool(allowedInput)
  const allowedRequest = requests[1]!
  handlePermissionResponse({ requestId: allowedRequest.requestId, behavior: 'allow', alwaysAllow: false }, responseDependencies)
  expect(await allowedResultPromise).toMatchObject({ behavior: 'allow', updatedInput: allowedInput })
  expect(store.getProjectDb().prepare('SELECT status,decided_by,decision_reason FROM project_owner_action_approvals WHERE request_id=?').get(allowedRequest.requestId)).toEqual({ status: 'allowed', decided_by: 'local-user', decision_reason: null })
  expect(toolExecutions).toBe(1)
  expect(windowEvents.at(-1)).toEqual(expectedResolution(allowedRequest.requestId, 'allow'))
  expect(sessionEvents.at(-1)).toEqual(windowEvents.at(-1))
})

test('Given 两个稳定roleKey分别绑定不同员工 When材料化、重验证、发行并排队 Then命令及用户预览冻结同一岗位员工', () => {
  const f = fixture('glm-5.3-flash', 'manual', true, 'https://example.invalid', true)
  const first = f.record.source.tasks.find(task => task.stepKey === 'brief')!
  const second = f.record.source.tasks.find(task => task.stepKey === 'delivery')!
  expect(first.executor).toMatchObject({ id: f.executor.id })
  expect(second.executor).toMatchObject({ id: f.secondExecutor.id })
  expect(f.grant.roleAssignments?.map(item => [item.roleKey, item.employeeId])).toEqual([
    [first.executor!.roleKey, f.executor.id], [second.executor!.roleKey, f.secondExecutor.id],
  ])
  const input = { grantId: f.grant.grantId, taskId: second.taskId, role: 'executor' as const, reworkOrdinal: 0, expectedRevalidationRevision: f.record.revision }
  const preview = command.previewOwnerExecutionCommandAck(f.subject, input)
  expect(preview).toMatchObject({ employeeId: f.secondExecutor.id, roleKey: second.executor!.roleKey, employeeName: f.secondExecutor.name })
  const commandId = randomUUID(), executionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, { input, preview, confirmedFingerprint: preview.ackFingerprint, acknowledgeModelCosts: true }, { executionId })
  expect(store.getProjectDb().prepare('SELECT employee_id, budget_role_key FROM project_owner_execution_commands WHERE id=?').get(commandId)).toMatchObject({ employee_id: f.secondExecutor.id, budget_role_key: second.executor!.roleKey })
  expect(command.listOwnerExecutionCommands(f.subject).find(item => item.commandId === commandId)?.budgetRoleKey).toBe(second.executor!.roleKey)
  expect(store.getAgentExecution(executionId)?.agentId).toBe(f.secondExecutor.id)
  employees.updateAgentEmployee(f.secondExecutor.id, { roleTemplateId: 'changed-template' })
  expect(revalidation.getOwnerExecutionRevalidation(f.subject).status).toBe('stale')
  expect(() => command.previewOwnerExecutionCommandAck(f.subject, input)).toThrow('非current')
})

test('Given Owner命令与已冻结步骤 When读取审阅材料 Then仅返回绑定execution回报和权威验收标准', async () => {
  const f = fixture()
  const { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  const expectedCriteria = f.batch.links.find(link => link.taskId === f.task.id)!.projection.acceptanceCriteria
  store.getProjectDb().prepare('UPDATE agent_executions SET status=?, result_summary=? WHERE id=?').run('completed', '执行回报：已完成目标步骤', executionId)
  const view = command.listOwnerExecutionCommands(f.subject).find(item => item.commandId === commandId)!
  expect(view).toMatchObject({ acceptanceCriteria: expectedCriteria, executionId, executionStatus: 'completed', executionResultSummary: '执行回报：已完成目标步骤',
    grantAuthorization: { grantState: 'active', dispatchMode: 'manual', maxCostMicros: 1_000_000, maxRuns: 2, maxRework: 0 } })
  store.getProjectDb().prepare('UPDATE agent_executions SET owner_command_id=? WHERE id=?').run(randomUUID(), executionId)
  const mismatched = command.listOwnerExecutionCommands(f.subject).find(item => item.commandId === commandId)!
  expect(mismatched.acceptanceCriteria).toEqual(expectedCriteria)
  expect(mismatched.executionResultSummary).toBeUndefined()
  expect(mismatched.state).not.toBe('settled')
  store.getProjectDb().prepare('UPDATE agent_executions SET owner_command_id=? WHERE id=?').run(commandId, executionId)
  saveProjectOwnerGoalDraft(f.subject.projectId, 0, { objective: '补充交付验证', constraints: [`Owner交付修改意见（命令 ${commandId}）：补充边界验证`] }, f.task.id)
  const context = plans.getProjectOwnerPlanningContext(f.subject.projectId, f.task.id)
  expect(context.sources.delivery?.[0]).toMatchObject({ commandId, grantId: input.grantId, acceptanceCriteria: expectedCriteria,
    priorAuthorization: { maxCostMicros: 1_000_000, maxRuns: 2, dispatchMode: 'manual' }, executionResultSummary: '执行回报：已完成目标步骤' })
  const assessment = { summary: '为未覆盖边界补充验证', commands: [{ commandId,
    changes: expectedCriteria.map(criterion => ({ criterion, disposition: 'addressed' as const, proposedChange: '新增边界验证步骤' })),
    authorizationImpact: 'unchanged' as const, authorizationRationale: '只增加本地验证，不扩大原执行范围' }] }
  const saved = plans.saveProjectOwnerPlanDraft(f.subject.projectId, context.goal.revision, 0, {
    summary: '补充交付边界验证', assumptions: [], risks: [], changeReason: '回应具体交付修改意见',
    steps: [{ key: 'verify', title: '补充边界验证', outcome: '覆盖反馈中的边界', acceptanceCriteria: ['验证记录可审阅'], dependencies: [], roleKey: context.sources.roles[0]!.key }],
    expectedContextFingerprint: context.fingerprint, deliveryChangeAssessment: assessment,
  }, f.task.id)
  expect(saved.proposal.deliveryChangeAssessment).toEqual(assessment)
  const runtime = await import('./project-owner-runtime-binding')
  const protocol = await import('./project-owner-planning-protocol')
  const source = await import('./project-owner-planning-source')
  const binding = runtime.saveOwnerRuntimeBinding(f.subject.projectId, 0, { ownerName: 'Owner', carrierId: f.executor.id, workspaceId: f.workspace.id, changeReason: '历史反馈提示回读' })
  for (const format of ['legacy', 'fragment', 'envelope'] as const) {
    const input = { requestId: randomUUID(), taskId: f.task.id, expectedBindingRevision: binding.revision, expectedGoalRevision: context.goal.revision, expectedPlanRevision: saved.revision, expectedContextFingerprint: context.fingerprint }
    const link = runtime.prepareOwnerPlanning(f.subject.projectId, input)
    const frozen = protocol.buildProjectOwnerPlanningRequest(context, format)
    const promptHash = createHash('sha256').update(JSON.stringify(frozen)).digest('hex')
    // 模拟各历史发行版冻结的真实提示；生产代码不迁移或回写这些记录。
    store.getProjectDb().prepare('UPDATE project_owner_planning_links SET payload=? WHERE id=?').run(JSON.stringify({ ...link, promptHash }), link.id)
    expect(source.readOwnerPlanningSnapshot(link.planningTaskId)?.request).toEqual(frozen)
    expect(runtime.prepareOwnerPlanning(f.subject.projectId, input)).toMatchObject({ id: link.id, promptHash })
    const before = store.getProjectDb().prepare('SELECT payload,source_snapshot FROM project_owner_planning_links WHERE id=?').get(link.id)
    source.readOwnerPlanningSnapshot(link.planningTaskId)
    expect(store.getProjectDb().prepare('SELECT payload,source_snapshot FROM project_owner_planning_links WHERE id=?').get(link.id)).toEqual(before)
    store.getProjectDb().prepare('UPDATE project_owner_planning_links SET payload=? WHERE id=?').run(JSON.stringify({ ...link, promptHash: '0'.repeat(64) }), link.id)
    expect(() => source.readOwnerPlanningSnapshot(link.planningTaskId)).toThrow('来源记录无效')
    expect(() => runtime.prepareOwnerPlanning(f.subject.projectId, input)).toThrow('格式无效')
  }
})

test('Given Owner命令由真实AI SDK发起 When经loopback OpenAI SSE Then收到文本并逐请求结算', async () => {
  let transportCalls = 0, responseSequence = 0
  const requestBodies: Array<Record<string, unknown>> = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Uint8Array) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      transportCalls++
      responseSequence++
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      const created = Math.floor(Date.now() / 1000)
      const chunk = (content: Record<string, unknown>, usage?: Record<string, unknown>) => ({
        id: `ao06-integration-${responseSequence}`, object: 'chat.completion.chunk', created,
        model: 'glm-5.3-flash', choices: [content], ...(usage ? { usage } : {}),
      })
      const events = [
        chunk({ index: 0, delta: { role: 'assistant', content: 'loopback fake result' }, finish_reason: null }),
        chunk({ index: 0, delta: {}, finish_reason: 'stop' }),
        { id: `ao06-integration-${responseSequence}`, object: 'chat.completion.chunk', created, model: 'glm-5.3-flash', choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close', 'cache-control': 'no-cache' })
      const sse = `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
      response.end(sse)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('loopback Fake Provider 未启动')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const f = fixture('glm-5.3-flash', 'manual', false, baseUrl)
  const { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID(), sessionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  startModule.claimOwnerCommandStart(executionId, commandId, f.record.revision, sessionId)
  startModule.admitOwnerGateForClaim(executionId, sessionId)
  startModule.recordOwnerCommandHandoffIntent(executionId, commandId, sessionId)
  const { AISDKAgentAdapter } = await import('./adapters/ai-sdk-agent-adapter')
  const { AISDKRuntimeCore } = await import('./agent-runtime/ai-sdk-runtime-core')
  const retrySpy = spyOn(AISDKRuntimeCore.prototype, 'runStreamTextWithRetry')
  const adapter = new AISDKAgentAdapter()
  const messages: import('@gravitas/shared').SDKMessage[] = []
  const runtimeEvents: import('@gravitas/shared').AgentEvent[] = []
  try {
    for await (const message of adapter.query({
      sessionId, prompt: '仅验证本机 fake 文本响应', provider: 'openai', apiKey: decryptApiKey(f.channel.id),
      baseUrl: f.channel.baseUrl, model: 'glm-5.3-flash', cwd: getAgentWorkspaceCwd(f.workspace, sessionId),
      agentRuntime: 'ai-sdk', permissionMode: 'safe', maxTurns: 1, maxRetries: 3,
      onAgentEvent: event => runtimeEvents.push(event),
    })) messages.push(message)
    expect(retrySpy.mock.calls[0]?.[0].maxRetries).toBe(0)
    expect(retrySpy.mock.calls[0]?.[0].sdkMaxRetries).toBe(0)
  } finally {
    retrySpy.mockRestore()
    adapter.dispose()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  expect(transportCalls).toBe(1)
  expect(requestBodies[0]).toMatchObject({ model: 'glm-5.3-flash', stream: true, stream_options: { include_usage: true } })
  const exposedTools = requestBodies[0]?.tools as Array<{ function: { name: string } }>
  expect(exposedTools.map(tool => tool.function.name).sort()).toEqual(['AskUserQuestion', 'Edit', 'ReadKnowledgeSource', 'SearchKnowledge', 'Write'])

  expect([requestBodies[0]?.max_tokens, requestBodies[0]?.max_completion_tokens].some(value => typeof value === 'number' && value > 0)).toBe(true)
  expect(messages.some(message => message.type === 'assistant' && JSON.stringify(message).includes('loopback fake result'))).toBe(true)
  expect(store.getProjectDb().prepare('SELECT state, settled_cost_micros FROM project_owner_execution_request_reservations WHERE command_id=?').get(commandId)).toMatchObject({ state: 'settled', settled_cost_micros: expect.any(Number) })
})

test('Given Zhipu OpenAI兼容渠道与活动Owner命令 When解析审核输出上限 Then按协议映射接受价格证据且不创建请求预留', () => {
  const f = fixture('glm-5.3-flash', 'manual', false, 'https://open.bigmodel.cn/api/paas/v4', false, 'zhipu')
  const { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID(), sessionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  startModule.claimOwnerCommandStart(executionId, commandId, f.record.revision, sessionId)

  expect(requestExit.resolveOwnerExecutionMaxOutputTokens(sessionId, 'glm-5.3-flash', 'zhipu')).toBe(131_072)
  expect(store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations WHERE command_id=?').get(commandId)).toEqual({ count: 0 })
})

test('Given活动DeepSeek Flash Owner命令 When解析已审核输出上限 Then接受峰时价格证据且尚未发送或预留', () => {
  const f = fixture('deepseek-flash')
  const { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID(), sessionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  startModule.claimOwnerCommandStart(executionId, commandId, f.record.revision, sessionId)
  expect(requestExit.resolveOwnerExecutionMaxOutputTokens(sessionId, 'deepseek-flash', 'openai')).toBe(131_072)
  expect(store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations WHERE command_id=?').get(commandId)).toEqual({ count: 0 })
  const now = Date.now()
  store.updateAgentExecution(executionId, { status: 'completed', resultSummary: 'fake-only 执行结果', completedAt: now })
  settlement.settleOwnerCommandUsage(commandId, { source: 'traceable_estimate', priceSource: 'fixture', inputTokens: 1, outputTokens: 1, costMicros: 1, executionId, sessionId, channelId: f.channel.id, modelId: 'deepseek-flash', capturedAt: now })
  const reviewInput = { ...input, role: 'reviewer' as const }
  const preview = command.previewOwnerExecutionCommandAck(f.subject, reviewInput)
  const reviewerCommandId = randomUUID(), reviewerExecutionId = randomUUID(), reviewerSessionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId: reviewerCommandId, ...reviewInput, idempotencyKey: randomUUID() }, { input: reviewInput, preview, confirmedFingerprint: preview.ackFingerprint, acknowledgeModelCosts: true }, { executionId: reviewerExecutionId })
  startModule.claimOwnerCommandStart(reviewerExecutionId, reviewerCommandId, f.record.revision, reviewerSessionId)
  expect(requestExit.resolveOwnerExecutionMaxOutputTokens(reviewerSessionId, 'deepseek-flash', 'openai')).toBe(131_072)
  expect(store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations WHERE command_id=?').get(reviewerCommandId)).toEqual({ count: 0 })

})

test('Given活动Owner命令的审核价格协议证据不匹配 When解析输出上限在fetch前拒绝 Then只记录类型化拒绝证据且不创建请求预留', () => {
  const f = fixture('glm-5.3-flash', 'manual', false, 'https://open.bigmodel.cn/api/paas/v4', false, 'zhipu')
  const { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID(), sessionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  startModule.claimOwnerCommandStart(executionId, commandId, f.record.revision, sessionId)
  const evidenceId = 'zai-glm-5.3-flash-2026-09-28'
  const original = requestEvidence.getPilotReviewedPriceEvidence(evidenceId)
  if (!original) throw new Error('缺少测试价格证据')
  requestEvidence.registerPilotPriceEvidenceForTests({ ...original, providerKind: 'anthropic' })
  try {
    expect(() => requestExit.resolveOwnerExecutionMaxOutputTokens(sessionId, 'glm-5.3-flash', 'zhipu')).toThrow('Owner 命令输出上限与运行授权/审核价格证据不匹配')
  } finally {
    requestEvidence.registerPilotPriceEvidenceForTests(original)
  }
  expect(store.getProjectDb().prepare('SELECT reason_code, command_id, execution_id, project_id FROM project_owner_execution_preflight_rejections WHERE execution_id=?').get(executionId)).toEqual({ reason_code: 'reviewed_price_evidence_mismatch', command_id: commandId, execution_id: executionId, project_id: f.project.id })
  expect(store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations WHERE command_id=?').get(commandId)).toEqual({ count: 0 })
  expect(() => store.getProjectDb().prepare('UPDATE project_owner_execution_preflight_rejections SET reason_code=? WHERE execution_id=?').run('tampered', executionId)).toThrow(/immutable/)
  expect(() => store.getProjectDb().prepare('DELETE FROM project_owner_execution_preflight_rejections WHERE execution_id=?').run(executionId)).toThrow(/immutable/)
})

test('Given当前已知Zhipu历史预发送拒绝 When用户核对控制台并确认对账 Then只释放该命令费用/次数、暂停旧grant且保留独立审计', () => {
  const f = fixture('glm-5.3-flash', 'manual', false, 'https://open.bigmodel.cn/api/paas/v4', false, 'zhipu')
  const { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID(), sessionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  startModule.claimOwnerCommandStart(executionId, commandId, f.record.revision, sessionId)
  startModule.recordOwnerCommandHandoffIntent(executionId, commandId, sessionId)
  const error = 'Owner 命令输出上限与运行授权/审核价格证据不匹配'
  const now = Date.now()
  store.getProjectDb().prepare("UPDATE agent_executions SET status='failed', error=?, completed_at=? WHERE id=?").run(error, now, executionId)
  store.getProjectDb().prepare("UPDATE project_owner_execution_commands SET state='needs_reconcile', updated_at=? WHERE id=?").run(now, commandId)
  store.getProjectDb().prepare("UPDATE project_owner_execution_grants SET state='needs_reconcile' WHERE id=?").run(f.grant.grantId)

  const preview = preflightReconciliation.previewOwnerPreflightReconciliation(f.subject, { commandId })
  expect(preview).toMatchObject({ evidenceKind: 'legacy_operator_attested', commandId, executionId, reservedCostMicros: 500_000, requestReservationCount: 0, providerConsoleAttestationRequired: true })
  expect(settlement.readOwnerGrantUsage(f.grant.grantId)).toEqual({ runReservations: 1, committedCostMicros: 500_000 })
  expect(() => preflightReconciliation.confirmOwnerPreflightReconciliation(f.subject, { commandId, confirmedFingerprint: preview.fingerprint, providerConsoleCheckedNoUsage: false })).toThrow(/核对/)
  expect(store.getProjectDb().prepare('SELECT state, actual_cost_micros FROM project_owner_execution_commands WHERE id=?').get(commandId)).toEqual({ state: 'needs_reconcile', actual_cost_micros: null })

  const result = preflightReconciliation.confirmOwnerPreflightReconciliation(f.subject, { commandId, confirmedFingerprint: preview.fingerprint, providerConsoleCheckedNoUsage: true }, now + 1)
  expect(result).toMatchObject({ commandId, state: 'released', actualCostMicros: 0, grantState: 'paused', alreadyApplied: false })
  expect(store.getProjectDb().prepare('SELECT state, reserved_cost_micros, actual_cost_micros, usage_evidence, usage_record_key FROM project_owner_execution_commands WHERE id=?').get(commandId)).toEqual({ state: 'released', reserved_cost_micros: 500_000, actual_cost_micros: 0, usage_evidence: null, usage_record_key: null })
  expect(store.getProjectDb().prepare('SELECT state FROM project_owner_execution_grants WHERE id=?').get(f.grant.grantId)).toEqual({ state: 'paused' })
  expect(settlement.readOwnerGrantUsage(f.grant.grantId)).toEqual({ runReservations: 0, committedCostMicros: 0 })
  expect(store.getProjectDb().prepare('SELECT evidence_kind, provider_console_checked_no_usage, actor, request_reservation_count FROM project_owner_execution_preflight_reconciliations WHERE command_id=?').get(commandId)).toEqual({ evidence_kind: 'legacy_operator_attested', provider_console_checked_no_usage: 1, actor: 'local-user', request_reservation_count: 0 })
  expect(preflightReconciliation.confirmOwnerPreflightReconciliation(f.subject, { commandId, confirmedFingerprint: preview.fingerprint, providerConsoleCheckedNoUsage: true }, now + 2).alreadyApplied).toBe(true)
  expect(store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_preflight_reconciliations WHERE command_id=?').get(commandId)).toEqual({ count: 1 })
  expect(command.listOwnerExecutionCommands(f.subject).find(item => item.commandId === commandId)).toMatchObject({ state: 'released', preflightReconciliation: { evidenceKind: 'legacy_operator_attested', providerConsoleCheckedNoUsage: true, actor: 'local-user' } })
  expect(() => store.getProjectDb().prepare('UPDATE project_owner_execution_preflight_reconciliations SET reason_code=? WHERE command_id=?').run('tampered', commandId)).toThrow(/immutable/)
  expect(() => store.getProjectDb().prepare('DELETE FROM project_owner_execution_preflight_reconciliations WHERE command_id=?').run(commandId)).toThrow(/immutable/)
})

test('Given fetch前失败留下严格Runtime unknown标记 When用户核对控制台并确认 Then保留标记摘要审计后释放占额', () => {
  const f = fixture('glm-5.3-flash', 'manual', false, 'https://open.bigmodel.cn/api/paas/v4', false, 'zhipu')
  const { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID(), sessionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  startModule.claimOwnerCommandStart(executionId, commandId, f.record.revision, sessionId)
  startModule.recordOwnerCommandHandoffIntent(executionId, commandId, sessionId)
  const error = 'Owner 命令输出上限与运行授权/审核价格证据不匹配'
  const now = Date.now()
  const unknownEvidence = JSON.stringify({ source: 'unknown', executionId, sessionId, channelId: f.channel.id, modelId: 'glm-5.3-flash', capturedAt: now, reason: 'Runtime终态缺少完整逐请求用量结算' })
  const unknownRecordKey = `unknown:${executionId}:${sessionId}::`
  store.getProjectDb().prepare("UPDATE agent_executions SET status='failed', error=?, completed_at=? WHERE id=?").run(error, now, executionId)
  store.getProjectDb().prepare("UPDATE project_owner_execution_commands SET state='needs_reconcile', usage_evidence=?, usage_record_key=?, updated_at=? WHERE id=?").run(unknownEvidence, unknownRecordKey, now, commandId)
  store.getProjectDb().prepare("UPDATE project_owner_execution_grants SET state='needs_reconcile' WHERE id=?").run(f.grant.grantId)

  const preview = preflightReconciliation.previewOwnerPreflightReconciliation(f.subject, { commandId })
  expect(preview.preReconciliationUsageMarker).toBe('runtime_unknown')
  expect(preview.preReconciliationUsageEvidenceSha256).toBe(createHash('sha256').update(unknownEvidence).digest('hex'))
  expect(preview.preReconciliationUsageRecordKeySha256).toBe(createHash('sha256').update(unknownRecordKey).digest('hex'))
  expect(store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations WHERE command_id=?').get(commandId)).toEqual({ count: 0 })
  preflightReconciliation.confirmOwnerPreflightReconciliation(f.subject, { commandId, confirmedFingerprint: preview.fingerprint, providerConsoleCheckedNoUsage: true }, now + 1)
  expect(store.getProjectDb().prepare('SELECT state, actual_cost_micros, usage_evidence, usage_record_key FROM project_owner_execution_commands WHERE id=?').get(commandId)).toEqual({ state: 'released', actual_cost_micros: 0, usage_evidence: null, usage_record_key: null })
  expect(store.getProjectDb().prepare('SELECT pre_reconciliation_usage_marker, pre_reconciliation_usage_evidence_sha256, pre_reconciliation_usage_record_key_sha256 FROM project_owner_execution_preflight_reconciliations WHERE command_id=?').get(commandId)).toEqual({ pre_reconciliation_usage_marker: 'runtime_unknown', pre_reconciliation_usage_evidence_sha256: createHash('sha256').update(unknownEvidence).digest('hex'), pre_reconciliation_usage_record_key_sha256: createHash('sha256').update(unknownRecordKey).digest('hex') })
})

test('Given不匹配或不完整的Runtime unknown标记 When预览发送前对账 Then拒绝并保留needs_reconcile占额', () => {
  const f = fixture('glm-5.3-flash', 'manual', false, 'https://open.bigmodel.cn/api/paas/v4', false, 'zhipu')
  const { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID(), sessionId = randomUUID(), now = Date.now()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  startModule.claimOwnerCommandStart(executionId, commandId, f.record.revision, sessionId)
  startModule.recordOwnerCommandHandoffIntent(executionId, commandId, sessionId)
  store.getProjectDb().prepare("UPDATE agent_executions SET status='failed', error=?, completed_at=? WHERE id=?").run('Owner 命令输出上限与运行授权/审核价格证据不匹配', now, executionId)
  store.getProjectDb().prepare("UPDATE project_owner_execution_commands SET state='needs_reconcile', usage_evidence=?, usage_record_key=?, updated_at=? WHERE id=?").run('{"source":"unknown"}', `unknown:${executionId}:${sessionId}::`, now, commandId)
  store.getProjectDb().prepare("UPDATE project_owner_execution_grants SET state='needs_reconcile' WHERE id=?").run(f.grant.grantId)
  expect(() => preflightReconciliation.previewOwnerPreflightReconciliation(f.subject, { commandId })).toThrow(/标记/)
  expect(store.getProjectDb().prepare('SELECT state,reserved_cost_micros,actual_cost_micros FROM project_owner_execution_commands WHERE id=?').get(commandId)).toEqual({ state: 'needs_reconcile', reserved_cost_micros: 500_000, actual_cost_micros: null })
})

test('GivenOwner命令已有请求账本或未解决停止升级 When预览发送前对账 Then保持needs_reconcile并拒绝释放', () => {
  const f = fixture('glm-5.3-flash', 'manual', false, 'https://open.bigmodel.cn/api/paas/v4', false, 'zhipu')
  const { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID(), sessionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  startModule.claimOwnerCommandStart(executionId, commandId, f.record.revision, sessionId)
  startModule.recordOwnerCommandHandoffIntent(executionId, commandId, sessionId)
  const error = 'Owner 命令输出上限与运行授权/审核价格证据不匹配'
  const now = Date.now()
  store.getProjectDb().prepare("UPDATE agent_executions SET status='failed', error=?, completed_at=? WHERE id=?").run(error, now, executionId)
  store.getProjectDb().prepare("UPDATE project_owner_execution_commands SET state='needs_reconcile', updated_at=? WHERE id=?").run(now, commandId)
  store.getProjectDb().prepare("UPDATE project_owner_execution_grants SET state='needs_reconcile' WHERE id=?").run(f.grant.grantId)
  store.getProjectDb().prepare(`INSERT INTO project_owner_execution_stop_escalations
    (escalation_id,execution_id,command_id,project_id,session_id,expected_generation,requested_at,reason)
    VALUES(?,?,?,?,?,NULL,?,?)`).run(randomUUID(), executionId, commandId, f.project.id, sessionId, now, 'test stop')
  expect(() => preflightReconciliation.previewOwnerPreflightReconciliation(f.subject, { commandId })).toThrow(/停止升级/)
  store.getProjectDb().prepare("UPDATE project_owner_execution_stop_escalations SET resolved_at=?, resolution='reviewed' WHERE command_id=?").run(now + 1, commandId)
  store.getProjectDb().prepare(`INSERT INTO project_owner_execution_request_reservations
    (request_id,command_id,execution_id,session_id,request_evidence_id,price_evidence_id,reserved_cost_micros,settled_cost_micros,state,created_at)
    VALUES(?,?,?,?,?,?,1,0,'settled',?)`).run(randomUUID(), commandId, executionId, sessionId, 'a'.repeat(64), 'zai-glm-5.3-flash-2026-09-28', now)
  expect(() => preflightReconciliation.previewOwnerPreflightReconciliation(f.subject, { commandId })).toThrow(/请求账本/)
  expect(store.getProjectDb().prepare('SELECT state, reserved_cost_micros, actual_cost_micros FROM project_owner_execution_commands WHERE id=?').get(commandId)).toEqual({ state: 'needs_reconcile', reserved_cost_micros: 500_000, actual_cost_micros: null })
})

test('Given自主grant When读取Scheduler Then只显示当前冻结Executor资格，Renderer人工ack/dispatch入口拒绝', async () => {
  const f = fixture('glm-5.3-flash', 'autonomous')
  expect(scheduler.getOwnerAutonomousScheduleStatus(f.project.id)).toMatchObject({ state: 'ready', taskId: f.task.id, role: 'executor', grantId: f.grant.grantId })
  const input = { grantId: f.grant.grantId, taskId: f.task.id, role: 'executor' as const, reworkOrdinal: 0, expectedRevalidationRevision: f.record.revision }
  expect(() => command.previewOwnerExecutionCommandAck(f.subject, input)).toThrow('自主授权命令只能由主进程调度器消费')
  const queued = command.reserveAndQueueAutonomousOwnerCommand(f.subject, input)
  await expect(dispatcher.dispatchOwnerCommandExecution({ commandId: queued.commandId, ackFingerprint: queued.ackFingerprint, acknowledgeExecution: true })).rejects.toThrow('自主命令只能由主进程Scheduler派发')
  expect(store.getAgentExecution(queued.executionId)?.status).toBe('queued')
})

test('Given自主授权与fake Provider When执行/评审依次结算 Then只运行冻结角色且等待权威业务完成', async () => {
  const f = fixture('glm-5.3-flash', 'autonomous')
  let transportCalls = 0
  const finished: Promise<void>[] = [], finishers: Array<() => void> = []
  runnerRegistry.setHeadlessAgentRunner(async (agentInput, callbacks) => {
    const done = new Promise<void>(resolve => { finishers.push(resolve) }); finished.push(done)
    callbacks.onRuntimeStarted?.()
    try {
      const baseUrl = resolveAgentRuntimeBaseUrl('openai', 'ai-sdk', f.channel.baseUrl)
      const fetch = Object.assign(async (_request: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
        transportCalls++
        expect(init?.redirect).toBe('error')
        return new Response(JSON.stringify({ id: `fake-${transportCalls}`, choices: [{ message: { content: 'fake result' } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }, { preconnect: () => {} }) as typeof globalThis.fetch
      const guarded = boundary.createControlledProviderFetch(agentInput.sessionId, () => ({ runtime: 'ai-sdk', cwd: getAgentWorkspaceCwd(f.workspace, agentInput.sessionId), modelId: agentInput.modelId ?? '', permissionMode: 'safe' }), fetch)
      await guarded(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: agentInput.modelId ?? '', max_tokens: 100, messages: [{ role: 'user', content: 'fake-only' }] }) })
      const isReviewer = agentInput.userMessage.includes('角色=reviewer')
      const assistantContent = isReviewer ? JSON.stringify({
        schemaVersion: 1,
        verdict: 'approved',
        summary: 'fake-only 技术评审通过',
        criteria: [{ criterion: '范围', status: 'met', evidence: 'fake-only 检查' }],
        findings: [],
        blockerReason: null,
      }) : 'fake result'
      callbacks.onComplete([{ id: randomUUID(), role: 'assistant', content: assistantContent, createdAt: Date.now() }])
    } catch (error) { callbacks.onError(error instanceof Error ? error.message : String(error)) }
    finally { finishers[finishers.length - 1]?.() }
  })
  expect((await scheduler.runOwnerAutonomousSchedule(f.project.id)).state).toBe('running')
  await finished[0]
  const executorExecution = (store.getProjectDb().prepare("SELECT execution_id FROM project_owner_execution_commands WHERE grant_id=? AND role='executor'").get(f.grant.grantId) as { execution_id: string }).execution_id
  await waitForExecutionTerminal(executorExecution)
  expect(store.getProjectDb().prepare('SELECT role, state FROM project_owner_execution_commands WHERE grant_id=?').all(f.grant.grantId)).toEqual([{ role: 'executor', state: 'settled' }])
  expect(scheduler.getOwnerAutonomousScheduleStatus(f.project.id)).toMatchObject({ state: 'ready', taskId: f.task.id, role: 'reviewer' })
  const reviewerStart = await scheduler.runOwnerAutonomousSchedule(f.project.id)
  // Reviewer在Executor已知结算后才被主进程安排。
  expect(reviewerStart).toMatchObject({ state: 'running' })
  await finished[1]
  const reviewerExecution = (store.getProjectDb().prepare("SELECT execution_id FROM project_owner_execution_commands WHERE grant_id=? AND role='reviewer'").get(f.grant.grantId) as { execution_id: string }).execution_id
  await waitForExecutionTerminal(reviewerExecution)
  expect(transportCalls).toBe(2)
  expect(store.getProjectDb().prepare('SELECT role, state FROM project_owner_execution_commands WHERE grant_id=? ORDER BY created_at').all(f.grant.grantId)).toEqual([{ role: 'executor', state: 'settled' }, { role: 'reviewer', state: 'settled' }])
  expect(store.getTask(f.task.id)?.status).toBe('paused')
  expect(store.getProjectDb().prepare('SELECT verdict, rework_ordinal, executor_command_id, reviewer_execution_id FROM project_owner_technical_reviews WHERE task_id=?').get(f.task.id)).toMatchObject({ verdict: 'approved', rework_ordinal: 0, executor_command_id: expect.any(String), reviewer_execution_id: expect.any(String) })
  expect((await scheduler.runOwnerAutonomousSchedule(f.project.id)).state).toBe('waiting')
  expect(store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=?').get(f.grant.grantId)).toEqual({ count: 2 })
})

test('Given自主授权允许一次返工 When Reviewer请求修改 Then下一轮Executor只接收绑定本轮的finding且次数仍受限', () => {
  const f = fixture('glm-5.3-flash', 'autonomous', false, 'https://example.invalid', false, 'openai', 1)
  const runAndSettle = (role: 'executor' | 'reviewer', reworkOrdinal: number, rawReview?: string) => {
    const input = { grantId: f.grant.grantId, taskId: f.task.id, role, reworkOrdinal, expectedRevalidationRevision: f.record.revision }
    const queued = command.reserveAndQueueAutonomousOwnerCommand(f.subject, input), sessionId = randomUUID(), now = Date.now()
    startModule.claimOwnerCommandStart(queued.executionId, queued.commandId, f.record.revision, sessionId)
    store.updateAgentExecution(queued.executionId, { status: 'completed', resultSummary: role === 'executor' ? `fake executor round ${reworkOrdinal}` : rawReview, completedAt: now })
    settlement.settleOwnerCommandUsage(queued.commandId, { source: 'traceable_estimate', priceSource: 'fixture', inputTokens: 1, outputTokens: 1, costMicros: 1, executionId: queued.executionId, sessionId, channelId: f.channel.id, modelId: 'glm-5.3-flash', capturedAt: now })
    if (rawReview) technicalReview.recordOwnerTechnicalReviewEvidence(queued.commandId, queued.executionId, rawReview, now)
    return store.getAgentExecution(queued.executionId)!
  }
  runAndSettle('executor', 0)
  const requestedChanges = JSON.stringify({ schemaVersion: 1, verdict: 'changes_requested', summary: '缺少回归测试。', criteria: [{ criterion: '范围', status: 'not_met', evidence: '没有失败输入覆盖' }], findings: [{ severity: 'medium', description: '缺少回归断言。', requestedChange: '补充覆盖失败输入的测试。' }], blockerReason: null })
  runAndSettle('reviewer', 0, requestedChanges)
  const reworkExecution = runAndSettle('executor', 1)
  expect(reworkExecution.prompt).toContain('补充覆盖失败输入的测试')
  expect(technicalReview.listOwnerTechnicalReviewEvidence(f.project.id, f.task.id)).toMatchObject([{ verdict: 'changes_requested', reworkOrdinal: 0 }])
  const approved = JSON.stringify({ schemaVersion: 1, verdict: 'approved', summary: '已满足冻结标准。', criteria: [{ criterion: '范围', status: 'met', evidence: 'fake-only复核' }], findings: [], blockerReason: null })
  runAndSettle('reviewer', 1, approved)
  expect(technicalReview.listOwnerTechnicalReviewEvidence(f.project.id, f.task.id).map(review => review.verdict)).toEqual(['changes_requested', 'approved'])
  expect(() => store.getProjectDb().prepare('UPDATE project_owner_technical_reviews SET verdict=? WHERE task_id=?').run('approved', f.task.id)).toThrow(/immutable/)
  expect(() => command.reserveAndQueueAutonomousOwnerCommand(f.subject, { grantId: f.grant.grantId, taskId: f.task.id, role: 'executor', reworkOrdinal: 2, expectedRevalidationRevision: f.record.revision })).toThrow(/返工次数超出授权/)
  expect(store.getTask(f.task.id)?.status).toBe('paused')
  const reviewViews = command.listOwnerExecutionCommands(f.subject).filter(item => item.role === 'reviewer')
  expect(reviewViews.map(item => item.technicalReview?.verdict).sort()).toEqual(['approved', 'changes_requested'])
  expect(reviewViews.find(item => item.technicalReview?.verdict === 'approved')?.technicalReview).toMatchObject({ summary: '已满足冻结标准。', criteria: [{ criterion: '范围', status: 'met', evidence: 'fake-only复核' }] })
  expect(command.listOwnerExecutionCommands(f.subject).filter(item => item.role === 'executor').every(item => !item.technicalReview)).toBe(true)
})

test('Given Owner执行结算需先完成本地研发验证 When延后Scheduler唤醒 Then验证调用方可在唤醒前落证据', async () => {
  const f = fixture()
  const { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID(), sessionId = randomUUID(), now = Date.now()
  command.reserveAndQueueOwnerCommand(f.subject, {
    commandId, grantId: input.grantId, taskId: input.taskId, role: input.role,
    reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID(),
  }, ack, { executionId })
  startModule.claimOwnerCommandStart(executionId, commandId, f.record.revision, sessionId)
  store.updateAgentExecution(executionId, { status: 'completed', completedAt: now })
  let wakeCount = 0
  const unsubscribe = schedulerEvents.onOwnerAutonomousScheduleWake(() => { wakeCount++ })
  try {
    const usage = { source: 'traceable_estimate' as const, priceSource: 'fixture', inputTokens: 1, outputTokens: 1, costMicros: 1, executionId, sessionId, channelId: f.channel.id, modelId: 'glm-5.3-flash', capturedAt: now }
    settlement.settleOwnerCommandUsage(commandId, usage, now, { deferSchedulerWake: true })
    await new Promise<void>(resolve => queueMicrotask(resolve))
    expect(wakeCount).toBe(0)
    settlement.settleOwnerCommandUsage(commandId, usage, now)
    await new Promise<void>(resolve => queueMicrotask(resolve))
    expect(wakeCount).toBe(1)
  } finally { unsubscribe() }
})

test('Given有效自主授权 When Reviewer要求一次返工 Then后台Scheduler按轮次串行执行且不代替业务验收', async () => {
  const f = fixture('glm-5.3-flash', 'autonomous', false, 'https://example.invalid', false, 'openai', 1)
  const driver = {
    queue: command.reserveAndQueueAutonomousOwnerCommand,
    dispatch: async (raw: unknown) => {
      const { commandId, ackFingerprint } = raw as { commandId: string; ackFingerprint: string }
      const row = store.getProjectDb().prepare(`SELECT c.role, c.rework_ordinal, c.execution_id, c.source_task_id
        FROM project_owner_execution_commands c WHERE c.id=? AND c.ack_fingerprint=?`).get(commandId, ackFingerprint) as { role: 'executor' | 'reviewer'; rework_ordinal: number; execution_id: string; source_task_id: string }
      const sessionId = randomUUID(), now = Date.now()
      startModule.claimOwnerCommandStart(row.execution_id, commandId, f.record.revision, sessionId)
      store.updateAgentExecution(row.execution_id, { status: 'completed', resultSummary: `fake ${row.role} ${row.rework_ordinal}`, completedAt: now })
      settlement.settleOwnerCommandUsage(commandId, { source: 'traceable_estimate', priceSource: 'fixture', inputTokens: 1, outputTokens: 1, costMicros: 1, executionId: row.execution_id, sessionId, channelId: f.channel.id, modelId: 'glm-5.3-flash', capturedAt: now })
      if (row.role === 'reviewer') {
        const link = materialization.getOwnerTaskMaterializationRecord(f.project.id, f.record.source.materialization.id).links.find(item => item.taskId === row.source_task_id)!
        const changesRequested = row.rework_ordinal === 0
        const rawReview = JSON.stringify({
          schemaVersion: 1,
          verdict: changesRequested ? 'changes_requested' : 'approved',
          summary: changesRequested ? '需要一项有限修改。' : '冻结标准已满足。',
          criteria: link.projection.acceptanceCriteria.map(criterion => ({ criterion, status: changesRequested ? 'not_met' : 'met', evidence: 'fake-only' })),
          findings: changesRequested ? [{ severity: 'medium', description: '缺少回归覆盖。', requestedChange: '补充回归测试。' }] : [],
          blockerReason: null,
        })
        technicalReview.recordOwnerTechnicalReviewEvidence(commandId, row.execution_id, rawReview, now)
      }
      return { commandId, executionId: row.execution_id, started: true }
    },
  }

  expect((await scheduler.runOwnerAutonomousSchedule(f.project.id, driver)).state).toBe('ready')
  expect((await scheduler.runOwnerAutonomousSchedule(f.project.id, driver)).state).toBe('ready')
  expect((await scheduler.runOwnerAutonomousSchedule(f.project.id, driver)).state).toBe('ready')
  const final = await scheduler.runOwnerAutonomousSchedule(f.project.id, driver)
  expect(final).toMatchObject({ state: 'waiting', reviewVerdict: 'approved', reworkOrdinal: 1, nextAction: 'await_business_acceptance' })
  expect(store.getProjectDb().prepare('SELECT role, rework_ordinal, state FROM project_owner_execution_commands WHERE grant_id=? ORDER BY created_at').all(f.grant.grantId)).toEqual([
    { role: 'executor', rework_ordinal: 0, state: 'settled' },
    { role: 'reviewer', rework_ordinal: 0, state: 'settled' },
    { role: 'executor', rework_ordinal: 1, state: 'settled' },
    { role: 'reviewer', rework_ordinal: 1, state: 'settled' },
  ])
  expect(store.getTask(f.task.id)?.status).toBe('paused')
})

test('GivenReviewer已完成但输出非法 WhenScheduler恢复 Then保留证据并停等且不自动重跑', async () => {
  const f = fixture('glm-5.3-flash', 'autonomous')
  let dispatches = 0
  const settle = (role: 'executor' | 'reviewer') => {
    const input = { grantId: f.grant.grantId, taskId: f.task.id, role, reworkOrdinal: 0, expectedRevalidationRevision: f.record.revision }
    const queued = command.reserveAndQueueAutonomousOwnerCommand(f.subject, input), sessionId = randomUUID(), now = Date.now()
    startModule.claimOwnerCommandStart(queued.executionId, queued.commandId, f.record.revision, sessionId)
    store.updateAgentExecution(queued.executionId, { status: 'completed', resultSummary: 'fake result', completedAt: now })
    settlement.settleOwnerCommandUsage(queued.commandId, { source: 'traceable_estimate', priceSource: 'fixture', inputTokens: 1, outputTokens: 1, costMicros: 1, executionId: queued.executionId, sessionId, channelId: f.channel.id, modelId: 'glm-5.3-flash', capturedAt: now })
    if (role === 'reviewer') expect(() => technicalReview.recordOwnerTechnicalReviewEvidence(queued.commandId, queued.executionId, 'review passed')).toThrow(/严格 JSON/)
  }
  settle('executor')
  settle('reviewer')
  const driver = {
    queue: command.reserveAndQueueAutonomousOwnerCommand,
    dispatch: async () => { dispatches++; throw new Error('不应派发') },
  }
  expect(scheduler.getOwnerAutonomousScheduleStatus(f.project.id)).toMatchObject({ state: 'waiting', nextAction: 'human_decision', role: 'reviewer', reworkOrdinal: 0 })
  expect((await scheduler.runOwnerAutonomousSchedule(f.project.id, driver)).reason).toContain('缺少可核验的结构化技术评审')
  expect(dispatches).toBe(0)
  expect(store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=?').get(f.grant.grantId)).toEqual({ count: 2 })
})

test('Given有效返工意见但授权运行次数耗尽 WhenScheduler恢复 Then不排入返工命令且预算不扩张', () => {
  const f = fixture('glm-5.3-flash', 'autonomous', false, 'https://example.invalid', false, 'openai', 1, 2)
  expect(f.record.source.budget.maxRuns).toBe(2)
  const settleRole = (role: 'executor' | 'reviewer', review?: string): void => {
    const input = { grantId: f.grant.grantId, taskId: f.task.id, role, reworkOrdinal: 0, expectedRevalidationRevision: f.record.revision }
    const queued = command.reserveAndQueueAutonomousOwnerCommand(f.subject, input), sessionId = randomUUID(), now = Date.now()
    startModule.claimOwnerCommandStart(queued.executionId, queued.commandId, f.record.revision, sessionId)
    store.updateAgentExecution(queued.executionId, { status: 'completed', resultSummary: 'fake result', completedAt: now })
    settlement.settleOwnerCommandUsage(queued.commandId, { source: 'traceable_estimate', priceSource: 'fixture', inputTokens: 1, outputTokens: 1, costMicros: 1, executionId: queued.executionId, sessionId, channelId: f.channel.id, modelId: 'glm-5.3-flash', capturedAt: now })
    if (review) technicalReview.recordOwnerTechnicalReviewEvidence(queued.commandId, queued.executionId, review, now)
  }
  const changesRequested = JSON.stringify({ schemaVersion: 1, verdict: 'changes_requested', summary: '需要返工。', criteria: [{ criterion: '范围', status: 'not_met', evidence: '缺少覆盖' }], findings: [{ severity: 'medium', description: '缺少回归覆盖。', requestedChange: '补充测试。' }], blockerReason: null })
  settleRole('executor')
  settleRole('reviewer', changesRequested)
  const schedule = scheduler.getOwnerAutonomousScheduleStatus(f.project.id)
  expect(schedule).toMatchObject({ state: 'waiting', reviewVerdict: 'changes_requested', nextAction: 'human_decision', runReservations: 2 })
  expect(schedule.reason).toContain('运行次数已耗尽')
  expect(store.getProjectDb().prepare('SELECT role, rework_ordinal FROM project_owner_execution_commands WHERE grant_id=? ORDER BY role').all(f.grant.grantId)).toEqual([
    { role: 'executor', rework_ordinal: 0 }, { role: 'reviewer', rework_ordinal: 0 },
  ])
})

test('Given冻结Task有依赖 When前置角色完成但Task未完成 Then不越过blocker；权威完成后才选择下游', () => {
  const f = fixture('glm-5.3-flash', 'autonomous', true), dependency = store.listTaskDependencies(f.project.id)[0]!
  const upstream = f.tasks.find(task => task.id === dependency.dependsOnTaskId)!, downstream = f.tasks.find(task => task.id === dependency.taskId)!
  // 固定前置与下游Task，不依赖数据库列表排序。
  const settleRole = (role: 'executor' | 'reviewer'): void => {
    const input = { grantId: f.grant.grantId, taskId: upstream.id, role, reworkOrdinal: 0, expectedRevalidationRevision: f.record.revision }
    const queued = command.reserveAndQueueAutonomousOwnerCommand(f.subject, input), sessionId = randomUUID(), now = Date.now()
    startModule.claimOwnerCommandStart(queued.executionId, queued.commandId, f.record.revision, sessionId)
    store.updateAgentExecution(queued.executionId, { status: 'completed', resultSummary: 'fake result', completedAt: now })
    settlement.settleOwnerCommandUsage(queued.commandId, { source: 'traceable_estimate', priceSource: 'fixture', inputTokens: 1, outputTokens: 1, costMicros: 1, executionId: queued.executionId, sessionId, channelId: f.channel.id, modelId: 'glm-5.3-flash', capturedAt: now })
    if (role === 'reviewer') {
      const link = materialization.getOwnerTaskMaterializationRecord(f.project.id, f.record.source.materialization.id).links.find(item => item.taskId === upstream.id)!
      const rawReview = JSON.stringify({ schemaVersion: 1, verdict: 'approved', summary: 'fake-only通过', criteria: link.projection.acceptanceCriteria.map(criterion => ({ criterion, status: 'met', evidence: 'fake-only' })), findings: [], blockerReason: null })
      technicalReview.recordOwnerTechnicalReviewEvidence(queued.commandId, queued.executionId, rawReview, now)
    }
  }
  settleRole('executor'); settleRole('reviewer')
  expect(scheduler.getOwnerAutonomousScheduleStatus(f.project.id)).toMatchObject({ state: 'waiting', reason: expect.stringContaining('依赖') })
  expect(store.getTask(upstream.id)?.status).toBe('paused')
  store.updateTask(upstream.id, { status: 'completed' })
  expect(scheduler.getOwnerAutonomousScheduleStatus(f.project.id)).toMatchObject({ state: 'ready', taskId: downstream.id, role: 'executor' })
})

test('Given自主Scheduler When派发一次后状态未知 Then保留needs_reconcile且后续唤醒不重试', async () => {
  const f = fixture('glm-5.3-flash', 'autonomous')
  let dispatches = 0, sessionId = ''
  const driver = {
    queue: command.reserveAndQueueAutonomousOwnerCommand,
    dispatch: async (raw: unknown) => {
      dispatches++
      const { commandId } = raw as { commandId: string }
      const row = store.getProjectDb().prepare('SELECT execution_id FROM project_owner_execution_commands WHERE id=?').get(commandId) as { execution_id: string }
      sessionId = randomUUID()
      startModule.claimOwnerCommandStart(row.execution_id, commandId, f.record.revision, sessionId)
      return { commandId, executionId: row.execution_id, started: true }
    },
  }
  expect((await scheduler.runOwnerAutonomousSchedule(f.project.id, driver)).state).toBe('running')
  expect((await scheduler.runOwnerAutonomousSchedule(f.project.id, driver)).state).toBe('running')
  expect(dispatches).toBe(1)
  const row = store.getProjectDb().prepare('SELECT id, execution_id FROM project_owner_execution_commands WHERE grant_id=?').get(f.grant.grantId) as { id: string; execution_id: string }
  store.updateAgentExecution(row.execution_id, { status: 'stale', completedAt: Date.now() })
  settlement.settleOwnerCommandUsage(row.id, { source: 'unknown', reason: 'fake-only unknown terminal', executionId: row.execution_id, sessionId, channelId: f.channel.id, modelId: 'glm-5.3-flash', capturedAt: Date.now() })
  expect(scheduler.getOwnerAutonomousScheduleStatus(f.project.id).state).toBe('needs_reconcile')
  expect((await scheduler.runOwnerAutonomousSchedule(f.project.id, driver)).state).toBe('needs_reconcile')
  expect(dispatches).toBe(1)
})

test('Given ack+reserve/queue When 全链 Then 命令queued+execution豁免创建，普通start入口拒绝且boundary idle含commands+escalations', async () => {
  const f = fixture(), { input, preview, ack } = ackFixture(f)
  expect(preview.derivedReservationMicros).toBe(500000)
  command.acknowledgeOwnerExecutionCommand(f.subject, ack)
  const commandId = randomUUID(), executionId = randomUUID()
  const queued = command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  expect(queued.commandId).toBe(commandId)
  const execution = store.getAgentExecution(executionId)!
  expect(execution.ownerCommandId).toBe(commandId)
  // 豁免收敛：不再被业务负向谓词限制
  expect(store.hasOwnerBusinessExecutionEvidence(executionId)).toBe(false)
  expect(await employees.tryStartExecution(executionId)).toBe(false)
  expect(() => evidence.assertOwnerExecutionBoundaryIdle(f.project.id)).toThrow('活动授权')
})
test('Given queued命令 When claim/start Then 单事务running+attempts行+handoff intent', () => {
  const f = fixture(), { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  const sessionId = randomUUID()
  const claimed = startModule.claimOwnerCommandStart(executionId, commandId, input.expectedRevalidationRevision, sessionId)
  expect(claimed.execution.status).toBe('running')
  expect(() => startModule.recordOwnerCommandHandoffIntent(executionId, commandId, 'wrong-session')).toThrow('会话与已认领执行不匹配')
  startModule.admitOwnerGateForClaim(executionId, sessionId)
  startModule.recordOwnerCommandHandoffIntent(executionId, commandId, sessionId)
  const attempt = store.getProjectDb().prepare('SELECT handoff_intent_at FROM project_owner_execution_start_attempts WHERE execution_id=?').get(executionId) as { handoff_intent_at: number }
  expect(attempt.handoff_intent_at).not.toBeNull()
  expect(startModule.isOwnerStartProven(executionId, commandId)).toBe(false)
  expect(() => startModule.recordOwnerRuntimeStarted(executionId, commandId, f.project.id, 'wrong-session', 'fake-runner', Date.now(), null)).toThrow('回执与已认领交接记录不匹配')
  expect(() => startModule.recordOwnerRuntimeStarted(executionId, commandId, f.project.id, sessionId, 'fake-runner', attempt.handoff_intent_at - 1, null, Date.now())).toThrow('回执与已认领交接记录不匹配')
  const startedAt = Date.now()
  startModule.recordOwnerRuntimeStarted(executionId, commandId, f.project.id, sessionId, 'fake-runner', startedAt, null, startedAt)
  expect(startModule.isOwnerStartProven(executionId, commandId)).toBe(true)
  expect(() => startModule.claimOwnerCommandStart(executionId, commandId, input.expectedRevalidationRevision, randomUUID())).toThrow()
})
test('Given排队后员工配置漂移 When claim启动 Then 拒绝偏离已确认快照', () => {
  const f = fixture(), { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  employees.updateAgentEmployee(f.executor.id, { name: '排队后漂移员工名' })
  expect(() => startModule.claimOwnerCommandStart(executionId, commandId, input.expectedRevalidationRevision, randomUUID())).toThrow(/Owner启动来源非current|员工配置与已确认版本不一致/)
})
test('Given queued命令后Task规格被篡改 When claim Then 不允许以旧ack启动新内容', () => {
  const f = fixture(), { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  store.getProjectDb().prepare('UPDATE tasks SET description=? WHERE id=?').run('改变后的内容', f.task.id)
  expect(() => startModule.claimOwnerCommandStart(executionId, commandId, input.expectedRevalidationRevision, randomUUID())).toThrow(/Task\/依赖\/步骤来源|Owner启动来源非current/)
  expect(store.getAgentExecution(executionId)?.status).toBe('queued')
})

test('Given running命令 When settle traceable_estimate Then settled按实结；超预留→双needs_reconcile', () => {
  const f = fixture('glm-5.3-flash', 'manual', true, 'https://example.invalid', false, 'openai', 0, 6, 1000000, undefined, true), { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  const sessionId = randomUUID()
  startModule.claimOwnerCommandStart(executionId, commandId, input.expectedRevalidationRevision, sessionId)
  store.updateAgentExecution(executionId, { status: 'completed', completedAt: Date.now() })
  const settled = settlement.settleOwnerCommandUsage(commandId, { source: 'traceable_estimate', priceSource: 'registry', inputTokens: 100, outputTokens: 50, costMicros: 5000, executionId, sessionId, channelId: f.channel.id, modelId: 'glm-5.3-flash', capturedAt: Date.now() })
  expect(settled.state).toBe('settled')
  expect(settled.actualCostMicros).toBe(5000)
  expect(settlement.readOwnerGrantUsage(input.grantId).committedCostMicros).toBe(5000)
  // 第二个命令超预留→needs_reconcile双写
  const secondTask = f.tasks.find(task => task.id !== input.taskId)!
  const input2 = { ...input, taskId: secondTask.id, reworkOrdinal: 0 }
  const preview2 = command.previewOwnerExecutionCommandAck(f.subject, input2)
  const ack2 = { input: input2, preview: preview2, confirmedFingerprint: preview2.ackFingerprint, acknowledgeModelCosts: true }
  const commandId2 = randomUUID(), executionId2 = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId: commandId2, grantId: input2.grantId, taskId: input2.taskId, role: input2.role, reworkOrdinal: 0, expectedRevalidationRevision: input2.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack2, { executionId: executionId2 })
  startModule.claimOwnerCommandStart(executionId2, commandId2, input2.expectedRevalidationRevision, randomUUID())
  store.updateAgentExecution(executionId2, { status: 'completed', completedAt: Date.now() })
  const over = settlement.settleOwnerCommandUsage(commandId2, { source: 'traceable_estimate', priceSource: 'registry', inputTokens: 100, outputTokens: 50, costMicros: 99999999, executionId: executionId2, sessionId: store.getAgentExecution(executionId2)!.sessionId, channelId: f.channel.id, modelId: 'glm-5.3-flash', capturedAt: Date.now() })
  expect(over.state).toBe('needs_reconcile')
  expect(over.grantNeedsReconcile).toBe(true)
  expect(store.getProjectDb().prepare("SELECT state FROM project_owner_execution_grants WHERE id=?").get(input.grantId)).toEqual({ state: 'needs_reconcile' })
})
test('Given 单命令请求预留已耗尽预算 When 再次预留 Then 在调用fake出口前拒绝', async () => {
  requestEvidence.registerPilotPriceEvidenceForTests({ evidenceId: 'owner-budget-fixture', providerKind: 'openai', model: 'glm-5.3-flash', inputMicrosPerMillion: 1_000_000_000, outputMicrosPerMillion: 1_000_000_000, extraCostCeilingMicros: 0, maxModelInputTokens: 1000, maxModelOutputTokens: 200, reviewedAt: '2026-10-09', source: 'test fixture' })
  const f = fixture(), { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID(), sessionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  startModule.claimOwnerCommandStart(executionId, commandId, input.expectedRevalidationRevision, sessionId)
  const bodies = ['first', 'second'].map(text => JSON.stringify({ model: 'glm-5.3-flash', max_tokens: 200, messages: [{ role: 'user', content: text }] }))
  let sent = 0
  const baseFetch = Object.assign(async () => { sent++; return new Response(JSON.stringify({ usage: { prompt_tokens: 80, completion_tokens: 200 } }), { status: 200 }) }, { preconnect: () => {} })
  const ownerFetch = requestExit.createOwnerRequestFetch({ commandId, executionId, sessionId, priceEvidenceId: 'owner-budget-fixture', baseFetch })
  await ownerFetch('https://example.invalid/v1/chat/completions', { method: 'POST', body: bodies[0] })
  await requestExit.awaitOwnerRequestSettlements({ commandId })
  expect(store.getProjectDb().prepare('SELECT state FROM project_owner_execution_request_reservations WHERE command_id=?').get(commandId)).toEqual({ state: 'settled' })
  await expect(ownerFetch('https://example.invalid/v1/chat/completions', { method: 'POST', body: bodies[1] })).rejects.toThrow('超过命令授权额度')
  expect(sent).toBe(1)
})
test('Given Owner请求模型不匹配审核证据 When创建请求 Then 在预留与transport之前拒绝', async () => {
  const f = fixture(), { input, ack } = ackFixture(f), commandId = randomUUID(), executionId = randomUUID(), sessionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  const before = (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations').get() as { count: number }).count
  let sent = 0
  const baseFetch = Object.assign(async () => { sent++; return new Response('{}', { status: 200 }) }, { preconnect: () => {} })
  const ownerFetch = requestExit.createOwnerRequestFetch({ commandId, executionId, sessionId, baseFetch })
  await expect(ownerFetch('https://example.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'ao06-fake-only-model', max_tokens: 32, messages: [{ role: 'user', content: 'fake only' }] }) })).rejects.toThrow('与价格证据不一致')
  expect(sent).toBe(0)
  expect((store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations').get() as { count: number }).count).toBe(before)
})
test('Given running命令 When stop escalation Then 同事务撤权+open escalation拒非unknown结算', () => {
  const f = fixture(), { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  const sessionId = randomUUID()
  startModule.claimOwnerCommandStart(executionId, commandId, input.expectedRevalidationRevision, sessionId)
  const escalation = stopModule.recordOwnerCommandStopEscalation(executionId, '用户要求停止', Date.now())
  expect(escalation.commandId).toBe(commandId)
  expect(store.getProjectDb().prepare('SELECT state FROM project_owner_execution_grants WHERE id=?').get(input.grantId)).toEqual({ state: 'paused' })
  // open escalation拒非unknown结算，unknown接受且占额保留
  store.updateAgentExecution(executionId, { status: 'stale', completedAt: Date.now() })
  expect(() => settlement.settleOwnerCommandUsage(commandId, { source: 'traceable_estimate', priceSource: 'r', inputTokens: 1, outputTokens: 1, costMicros: 1, executionId, sessionId, channelId: f.channel.id, modelId: 'glm-5.3-flash', capturedAt: Date.now() })).toThrow('对账')
  const unknown = settlement.settleOwnerCommandUsage(commandId, { source: 'unknown', reason: '停止后终态未知', executionId, sessionId, channelId: f.channel.id, modelId: 'glm-5.3-flash', capturedAt: Date.now() })
  expect(unknown.state).toBe('needs_reconcile')
})
test('Given 遗留running owner执行 When 恢复对称扫描 Then 撤权+stale+unknown结算+边界识别', async () => {
  const f = fixture(), { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  const sessionId = randomUUID()
  startModule.claimOwnerCommandStart(executionId, commandId, input.expectedRevalidationRevision, sessionId)
  const pendingRequest = { requestId: randomUUID(), sessionId, toolName: 'Write', toolInput: { content: 'pending after process crash' }, description: 'write', dangerLevel: 'normal' as const, requiresPerActionApproval: true }
  actionApproval.recordOwnerActionApprovalRequest({ commandId, executionId, sessionId }, pendingRequest)
  store.closeProjectDb()
  await store.initProjectDb()
  // 模拟重启：无启动回执，execution遗留running。
  const results = stopModule.recoverInterruptedOwnerRuntimeExecutions()
  expect(results.some(item => item.executionId === executionId && item.state === 'unknown_recorded')).toBe(true)
  const after = store.getAgentExecution(executionId)!
  expect(after.status).toBe('stale')
  expect(store.getProjectDb().prepare("SELECT state FROM project_owner_execution_commands WHERE id=?").get(commandId)).toEqual({ state: 'needs_reconcile' })
  expect(store.getProjectDb().prepare('SELECT status, decided_at, decided_by, decision_reason FROM project_owner_action_approvals WHERE request_id=?').get(pendingRequest.requestId))
    .toEqual({ status: 'invalidated', decided_at: expect.any(Number), decided_by: null, decision_reason: 'runtime_recovered' })
  expect(command.listOwnerExecutionCommands(f.subject).find(item => item.commandId === commandId)?.actionApprovals?.[0])
    .toMatchObject({ requestId: pendingRequest.requestId, status: 'invalidated', reason: 'runtime_recovered' })
})
test('Given旧Runtime回调仍滞留 When独立进程重启恢复后回调晚到 Then保留unknown且不重写或续派', async () => {
  const f = fixture('glm-5.3-flash'), { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  let releaseRuntime!: () => void, signalRuntimeStarted!: () => void
  const runtimeHeld = new Promise<void>(resolve => { releaseRuntime = resolve })
  const runtimeStarted = new Promise<void>(resolve => { signalRuntimeStarted = resolve })
  let lateCallbacks: import('./agent-headless-runner-registry').HeadlessAgentRunCallbacks | null = null
  runnerRegistry.setHeadlessAgentRunner(async (_agentInput, callbacks) => {
    lateCallbacks = callbacks
    callbacks.onRuntimeStarted?.()
    signalRuntimeStarted()
    await runtimeHeld
    const delayedMessages = [{ id: randomUUID(), role: 'assistant' as const, content: 'fake delayed completion', createdAt: Date.now() }]
    callbacks.onComplete(delayedMessages)
    callbacks.onComplete(delayedMessages)
  })
  let parentDbClosed = false
  let dispatch: Promise<{ commandId: string; executionId: string; started: boolean }> | null = null
  try {
    dispatch = dispatcher.dispatchOwnerCommandExecution({ commandId, ackFingerprint: ack.preview.ackFingerprint, acknowledgeExecution: true })
    await runtimeStarted
    expect((await dispatch).started).toBe(true)
    expect(lateCallbacks).not.toBeNull()
    const sessionId = store.getAgentExecution(executionId)?.sessionId
    expect(sessionId).toBeTruthy()
    const pendingApproval = { requestId: randomUUID(), sessionId: sessionId!, toolName: 'Write', toolInput: { content: 'pending before process restart' }, description: 'write', dangerLevel: 'normal' as const, requiresPerActionApproval: true }
    actionApproval.recordOwnerActionApprovalRequest({ commandId, executionId, sessionId: sessionId! }, pendingApproval)
    const escalation = stopModule.recordOwnerCommandStopEscalation(executionId, '故障矩阵：重启前请求停止', Date.now())
    expect(escalation.commandId).toBe(commandId)
    expect(store.getProjectDb().prepare('SELECT state FROM project_owner_execution_grants WHERE id=?').get(input.grantId)).toEqual({ state: 'paused' })

    store.closeProjectDb()
    parentDbClosed = true
    const nativeRecoveryPath = join(directory, `native-recovery-${randomUUID()}.cjs`)
    buildSync({ entryPoints: [join(import.meta.dir, 'project-owner-native-recovery-child.ts')], outfile: nativeRecoveryPath,
      bundle: true, platform: 'node', format: 'cjs', target: 'node24', absWorkingDir: process.cwd(),
      external: ['better-sqlite3', 'electron', 'fsevents', 'playwright-core'] })
    const nativeNodeBinary = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim()
    const nodePath = [join(process.cwd(), 'node_modules'), join(process.cwd(), 'apps/electron/node_modules')].join(':')
    const childOutput = execFileSync(nativeNodeBinary, [nativeRecoveryPath, 'recover', executionId], {
      cwd: process.cwd(), env: { ...process.env, NODE_PATH: nodePath }, encoding: 'utf8', timeout: 30_000,
    })
    const recoveryLine = childOutput.split('\n').find(line => line.startsWith('OWNER_RECOVERY '))
    expect(recoveryLine).toBeDefined()
    const recovery = JSON.parse(recoveryLine!.slice('OWNER_RECOVERY '.length)) as {
      results: Array<{ executionId: string; state: string; startBoundary: string }>
      repeatedResults: Array<unknown>
      rows: Array<{ status: string; decided_at: number | null; decision_reason: string | null; execution_status: string;
        grant_state: string; command_state: string; actual_cost_micros: number | null; reserved_cost_micros: number;
        usage_evidence: string | null; escalation_id: string | null; escalation_resolved_at: number | null; escalation_reason: string | null }>
    }
    expect(recovery.results).toContainEqual(expect.objectContaining({ executionId, state: 'unknown_recorded', startBoundary: 'started_proven' }))
    expect(recovery.repeatedResults).toEqual([])
    expect(recovery.rows).toMatchObject([{ status: 'invalidated', decided_at: expect.any(Number), decision_reason: 'runtime_recovered',
      execution_status: 'stale', grant_state: 'paused', command_state: 'needs_reconcile', actual_cost_micros: null,
      escalation_id: expect.any(String), escalation_resolved_at: null, escalation_reason: '故障矩阵：重启前请求停止' }])
    expect(recovery.rows[0]?.reserved_cost_micros).toBeGreaterThan(0)
    expect(JSON.parse(recovery.rows[0]?.usage_evidence ?? 'null')).toMatchObject({ source: 'unknown', executionId })

    await store.initProjectDb()
    parentDbClosed = false
    expect(() => actionApproval.decideOwnerActionApproval(pendingApproval, 'allow', { commandId, executionId, sessionId: sessionId! })).toThrow('已处理')
    releaseRuntime()
    await dispatch
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.getAgentExecution(executionId)).toMatchObject({ status: 'stale' })
    expect(store.getAgentExecution(executionId)?.resultSummary).toBeUndefined()
    expect(store.getProjectDb().prepare('SELECT state, actual_cost_micros, reserved_cost_micros FROM project_owner_execution_commands WHERE id=?').get(commandId)).toMatchObject({ state: 'needs_reconcile', actual_cost_micros: null, reserved_cost_micros: recovery.rows[0]?.reserved_cost_micros })
    expect(store.getProjectDb().prepare('SELECT state FROM project_owner_execution_grants WHERE id=?').get(input.grantId)).toEqual({ state: 'paused' })
    const lateEscalation = store.getProjectDb().prepare('SELECT escalation_id, resolved_at, reason FROM project_owner_execution_stop_escalations WHERE command_id=?').get(commandId) as { escalation_id: string; resolved_at: number | null; reason: string } | undefined
    expect(typeof lateEscalation?.escalation_id).toBe('string')
    expect(lateEscalation).toMatchObject({ resolved_at: null, reason: '故障矩阵：重启前请求停止' })
    expect(technicalReview.listOwnerTechnicalReviewEvidence(f.project.id)).toEqual([])
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=?').get(input.grantId)).toEqual({ count: 1 })
  } finally {
    releaseRuntime()
    if (parentDbClosed) await store.initProjectDb()
    if (dispatch) await dispatch.catch(() => undefined)
  }
}, 15_000)

test('Given owner命令运行中但session失联 When 普通heartbeat扫描 Then 走Owner unknown恢复而不走普通回写', () => {
  const f = fixture(), { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  startModule.claimOwnerCommandStart(executionId, commandId, input.expectedRevalidationRevision, randomUUID())
  employees.scanAgentEmployeeHeartbeat()
  expect(store.getAgentExecution(executionId)?.status).toBe('stale')
  expect(store.getProjectDb().prepare('SELECT state FROM project_owner_execution_commands WHERE id=?').get(commandId)).toEqual({ state: 'needs_reconcile' })
  expect(store.getProjectDb().prepare('SELECT state FROM project_owner_execution_grants WHERE id=?').get(input.grantId)).toEqual({ state: 'paused' })
})
test('Given Owner授权仍有queued命令 When 撤权 Then blockers暴露占额；先取消后才能撤权', () => {
  const f = fixture(), { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  const preview = grantIssue.previewOwnerExecutionGrantRevoke(f.subject, { grantId: input.grantId })
  expect(preview.impact.commandCount).toBe(1)
  expect(preview.blockers.join(' ')).toContain('未启动命令')
  expect(() => grantIssue.confirmOwnerExecutionGrantRevoke(f.subject, { grantId: input.grantId, confirmedFingerprint: preview.fingerprint })).toThrow('收敛未结命令')
  stopModule.cancelQueuedOwnerCommand(commandId)
  const settledPreview = grantIssue.previewOwnerExecutionGrantRevoke(f.subject, { grantId: input.grantId })
  expect(settledPreview.impact.commandCount).toBe(0)
  expect(settledPreview.blockers).toEqual([])
  expect(grantIssue.confirmOwnerExecutionGrantRevoke(f.subject, { grantId: input.grantId, confirmedFingerprint: settledPreview.fingerprint }).state).toBe('paused')
  expect(store.getAgentExecution(executionId)?.status).toBe('stale')
})

test('Given queued Owner命令 When 缺独立执行确认 Then 不claim；确认后经fake AI SDK请求结算', async () => {
  const f = fixture('glm-5.3-flash'), { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  let inputSeen: import('@gravitas/shared').AgentSendInput | undefined
  let transportCalls = 0, resolveRuntimeFinished!: () => void, runtimeError: string | undefined
  const runtimeFinished = new Promise<void>(resolve => { resolveRuntimeFinished = resolve })
  runnerRegistry.setHeadlessAgentRunner(async (agentInput, callbacks) => {
    inputSeen = agentInput
    callbacks.onRuntimeStarted?.()
    try {
      const baseUrl = resolveAgentRuntimeBaseUrl('openai', 'ai-sdk', f.channel.baseUrl)
      const fetch = Object.assign(async (_request: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
        transportCalls++
        expect(init?.redirect).toBe('error')
        return new Response(JSON.stringify({ id: 'fake-response', choices: [{ message: { content: 'fake output' } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }, { preconnect: () => {} }) as typeof globalThis.fetch
      const guarded = boundary.createControlledProviderFetch(agentInput.sessionId, () => ({ runtime: 'ai-sdk', cwd: getAgentWorkspaceCwd(f.workspace, agentInput.sessionId), modelId: agentInput.modelId ?? '', permissionMode: 'safe' }), fetch)
      await guarded(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: agentInput.modelId ?? '', max_tokens: 100, messages: [{ role: 'user', content: 'fake' }] }) })
      callbacks.onComplete([{ id: randomUUID(), role: 'assistant', content: 'fake output', createdAt: Date.now() }])
    } catch (error) { runtimeError = error instanceof Error ? error.message : String(error); callbacks.onError(runtimeError) }
    finally { resolveRuntimeFinished() }
  })
  await expect(dispatcher.dispatchOwnerCommandExecution({ commandId, ackFingerprint: ack.preview.ackFingerprint, acknowledgeExecution: false })).rejects.toThrow('单独确认')
  expect(store.getAgentExecution(executionId)?.status).toBe('queued')
  const result = await dispatcher.dispatchOwnerCommandExecution({ commandId, ackFingerprint: ack.preview.ackFingerprint, acknowledgeExecution: true })
  expect(result).toEqual({ commandId, executionId, started: true })
  await runtimeFinished
  await waitForExecutionTerminal(executionId)
  expect(runtimeError).toBeUndefined()
  expect(inputSeen).toMatchObject({ sessionId: store.getAgentExecution(executionId)?.sessionId, agentRuntime: 'ai-sdk', channelId: f.channel.id, modelId: 'glm-5.3-flash', permissionModeOverride: 'safe' })
  expect(store.getAgentExecution(executionId)?.status).toBe('completed')
  expect(transportCalls).toBe(1)
  const requestSettlement = store.getProjectDb().prepare('SELECT state, settled_cost_micros FROM project_owner_execution_request_reservations WHERE command_id=?').get(commandId) as { state: string; settled_cost_micros: number }
  expect(requestSettlement.state).toBe('settled')
  expect(requestSettlement.settled_cost_micros).toBe(2)
  expect(store.getProjectDb().prepare('SELECT state FROM project_owner_execution_commands WHERE id=?').get(commandId)).toEqual({ state: 'settled' })
})

test('Given两个并发dispatch同一Owner命令 When第二次claim竞争失败 Then不得把首次活动执行恢复为unknown', async () => {
  const f = fixture('glm-5.3-flash'), { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  let releaseRuntime!: () => void, signalEntered!: () => void
  const holdRuntime = new Promise<void>(resolve => { releaseRuntime = resolve })
  const enteredRuntime = new Promise<void>(resolve => { signalEntered = resolve })
  let invocations = 0
  runnerRegistry.setHeadlessAgentRunner(async (_agentInput, callbacks) => {
    invocations++
    callbacks.onRuntimeStarted?.()
    signalEntered()
    await holdRuntime
    callbacks.onComplete([{ id: randomUUID(), role: 'assistant', content: 'fake output', createdAt: Date.now() }])
  })
  const request = { commandId, ackFingerprint: ack.preview.ackFingerprint, acknowledgeExecution: true }
  const dispatches = [dispatcher.dispatchOwnerCommandExecution(request), dispatcher.dispatchOwnerCommandExecution(request)]
  await enteredRuntime
  await Promise.resolve()
  expect(store.getAgentExecution(executionId)?.status).toBe('running')
  expect(store.getProjectDb().prepare('SELECT state FROM project_owner_execution_grants WHERE id=?').get(input.grantId)).toEqual({ state: 'active' })
  releaseRuntime()
  const results = await Promise.allSettled(dispatches)
  expect(results.filter(result => result.status === 'fulfilled' && result.value.started)).toHaveLength(1)
  expect(invocations).toBe(1)
  await waitForExecutionTerminal(executionId)
  expect(store.getAgentExecution(executionId)?.status).toBe('completed')
})

test('Given已结算执行命令且任务仍由executor负责 When显式派发reviewer命令 Then使用冻结reviewer身份启动', async () => {
  const f = fixture(), executor = ackFixture(f)
  const executorCommandId = randomUUID(), executorExecutionId = randomUUID(), executorSessionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId: executorCommandId, grantId: executor.input.grantId, taskId: executor.input.taskId, role: 'executor', reworkOrdinal: 0, expectedRevalidationRevision: executor.input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, executor.ack, { executionId: executorExecutionId })
  startModule.claimOwnerCommandStart(executorExecutionId, executorCommandId, f.record.revision, executorSessionId)
  store.updateAgentExecution(executorExecutionId, { status: 'completed', completedAt: Date.now() })
  settlement.settleOwnerCommandUsage(executorCommandId, { source: 'traceable_estimate', priceSource: 'fixture', inputTokens: 1, outputTokens: 1, costMicros: 1, executionId: executorExecutionId, sessionId: executorSessionId, channelId: f.channel.id, modelId: 'glm-5.3-flash', capturedAt: Date.now() })
  const input = { grantId: f.grant.grantId, taskId: f.task.id, role: 'reviewer' as const, reworkOrdinal: 0, expectedRevalidationRevision: f.record.revision }
  const preview = command.previewOwnerExecutionCommandAck(f.subject, input)
  const ack = { input, preview, confirmedFingerprint: preview.ackFingerprint, acknowledgeModelCosts: true }
  const commandId = randomUUID(), executionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  let invocations = 0
  runnerRegistry.setHeadlessAgentRunner(async (_agentInput, callbacks) => { invocations++; callbacks.onRuntimeStarted?.(); callbacks.onComplete([{ id: randomUUID(), role: 'assistant', content: 'fake review', createdAt: Date.now() }]) })
  const dispatched = await dispatcher.dispatchOwnerCommandExecution({ commandId, ackFingerprint: preview.ackFingerprint, acknowledgeExecution: true })
  expect(dispatched.started).toBe(true)
  expect(invocations).toBe(1)
})

test('Given fake Provider响应缺少usage When终态结算 Then请求与命令费用保持unknown且grant停在对账', async () => {
  const f = fixture('glm-5.3-flash'), { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  let resolveRuntimeFinished!: () => void
  const runtimeFinished = new Promise<void>(resolve => { resolveRuntimeFinished = resolve })
  runnerRegistry.setHeadlessAgentRunner(async (agentInput, callbacks) => {
    callbacks.onRuntimeStarted?.()
    const baseUrl = resolveAgentRuntimeBaseUrl('openai', 'ai-sdk', f.channel.baseUrl)
    let transportCalls = 0
    const fetch = Object.assign(async () => { transportCalls++; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) }, { preconnect: () => {} }) as typeof globalThis.fetch
    try {
      const guarded = boundary.createControlledProviderFetch(agentInput.sessionId, () => ({ runtime: 'ai-sdk', cwd: getAgentWorkspaceCwd(f.workspace, agentInput.sessionId), modelId: agentInput.modelId ?? '', permissionMode: 'safe' }), fetch)
      await guarded(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: agentInput.modelId, max_tokens: 100, messages: [{ role: 'user', content: 'fake' }] }) })
      await expect(guarded(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: agentInput.modelId, max_tokens: 100, messages: [{ role: 'user', content: 'different fake follow-up' }] }) })).rejects.toThrow('用量未知并需对账')
      expect(transportCalls).toBe(1)
      callbacks.onComplete([{ id: randomUUID(), role: 'assistant', content: 'fake result', createdAt: Date.now() }])
    } catch (error) { callbacks.onError(error instanceof Error ? error.message : String(error)) }
    finally { resolveRuntimeFinished() }
  })
  const result = await dispatcher.dispatchOwnerCommandExecution({ commandId, ackFingerprint: ack.preview.ackFingerprint, acknowledgeExecution: true })
  expect(result.started).toBe(true)
  await runtimeFinished
  await waitForExecutionTerminal(executionId)
  expect(store.getProjectDb().prepare('SELECT state, settled_cost_micros FROM project_owner_execution_request_reservations WHERE command_id=?').get(commandId)).toEqual({ state: 'needs_reconcile', settled_cost_micros: null })
  expect(store.getProjectDb().prepare('SELECT state, actual_cost_micros FROM project_owner_execution_commands WHERE id=?').get(commandId)).toEqual({ state: 'needs_reconcile', actual_cost_micros: null })
  expect(store.getProjectDb().prepare('SELECT state FROM project_owner_execution_grants WHERE id=?').get(input.grantId)).toEqual({ state: 'needs_reconcile' })
})

test('Given运行中Owner命令 When Runtime停止未证实 Then escalation持久且后续回调仍unknown', async () => {
  const f = fixture('glm-5.3-flash'), { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  let enterRuntime!: () => void, finishRuntime!: () => void
  const entered = new Promise<void>(resolve => { enterRuntime = resolve })
  const release = new Promise<void>(resolve => { finishRuntime = resolve })
  runnerRegistry.setAgentStopper((sessionId, generation) => ({ sessionId, expectedGeneration: generation, activeGeneration: generation, requestAccepted: true, stopped: false, reason: 'stop-request-accepted', processTermination: 'NOT_VERIFIED' }))
  runnerRegistry.setHeadlessAgentRunner(async (_agentInput, callbacks) => {
    callbacks.onRuntimeStarted?.(); enterRuntime(); await release
    callbacks.onComplete([{ id: randomUUID(), role: 'assistant', content: 'fake result', createdAt: Date.now() }], { stoppedByUser: true })
  })
  const started = await dispatcher.dispatchOwnerCommandExecution({ commandId, ackFingerprint: ack.preview.ackFingerprint, acknowledgeExecution: true })
  expect(started.started).toBe(true)
  await entered
  const stop = employees.cancelAgentExecution(executionId)
  expect(stop).toMatchObject({ status: 'running', stopped: false, stopRequested: true, processTermination: 'NOT_VERIFIED' })
  expect(store.getProjectDb().prepare('SELECT state FROM project_owner_execution_grants WHERE id=?').get(input.grantId)).toEqual({ state: 'paused' })
  expect((store.getProjectDb().prepare('SELECT resolved_at FROM project_owner_execution_stop_escalations WHERE command_id=?').get(commandId) as { resolved_at: string | null } | undefined)?.resolved_at).toBeNull()
  finishRuntime()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(store.getAgentExecution(executionId)?.status).toBe('cancelled')
  expect(store.getProjectDb().prepare('SELECT state, actual_cost_micros FROM project_owner_execution_commands WHERE id=?').get(commandId)).toEqual({ state: 'needs_reconcile', actual_cost_micros: null })
})

test('Given已claim Owner命令 When普通registry无Owner上下文调用Then拒绝；专用上下文完成handoff后才放行', async () => {
  const f = fixture(), { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID(), sessionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  startModule.claimOwnerCommandStart(executionId, commandId, input.expectedRevalidationRevision, sessionId)
  startModule.admitOwnerGateForClaim(executionId, sessionId)
  let invocations = 0
  runnerRegistry.setHeadlessAgentRunner(async () => { invocations++ })
  const agentInput = { sessionId, userMessage: 'fixture', channelId: f.channel.id, modelId: 'glm-5.3-flash', agentRuntime: 'ai-sdk' as const }
  const callbacks = { onError: () => {}, onComplete: () => {}, onTitleUpdated: () => {} }
  await expect(runnerRegistry.runRegisteredHeadlessAgent(agentInput, callbacks)).rejects.toThrow('专用Runtime dispatcher')
  expect(invocations).toBe(0)
  await runnerRegistry.runRegisteredHeadlessAgent(agentInput, {
    ...callbacks,
    ownerExecution: { commandId, executionId },
    onRunnerInvoke: () => startModule.recordOwnerCommandHandoffIntent(executionId, commandId, sessionId),
  })
  expect(invocations).toBe(1)
})

test('Given legacy无关任务 When 全链 Then 不误封：普通dispatch/排队按原门禁', async () => {
  const f = fixture()
  const legacy = store.createTask(f.project.id, { title: '无关任务', description: '' })
  const legacyEmployee = employees.createAgentEmployee({ name: '普通员工', role: '研究', description: '', executionProfile: 'general', permissionMode: 'safe', runtime: 'ai-sdk', channelId: f.channel.id, modelId: 'glm-5.3-flash', workspaceIds: [f.workspace.id] })
  expect(store.hasOwnerBusinessTaskEvidence(legacy.id)).toBe(false)
  const queued = store.createAgentExecution({ id: randomUUID(), projectId: f.project.id, entityType: 'task', entityId: legacy.id, agentId: legacyEmployee.id, sessionId: '', prompt: '普通路径', status: 'queued' })
  expect(queued.status).toBe('queued')
})

// 本组只使用隔离账本与fake回执，不调用Runtime或Provider。
function holdUnknownManualCommandFixture(f: ReturnType<typeof fixture>, taskId: string) {
  const input = { grantId: f.grant.grantId, taskId, role: 'executor' as const, reworkOrdinal: 0, expectedRevalidationRevision: f.record.revision }
  const preview = command.previewOwnerExecutionCommandAck(f.subject, input), commandId = randomUUID(), executionId = randomUUID()
  const queued = command.reserveAndQueueOwnerCommand(f.subject, { commandId, ...input, idempotencyKey: randomUUID() }, { input, preview, confirmedFingerprint: preview.ackFingerprint, acknowledgeModelCosts: true }, { executionId })
  const sessionId = randomUUID(), now = Date.now()
  startModule.claimOwnerCommandStart(queued.executionId, queued.commandId, f.record.revision, sessionId)
  store.updateAgentExecution(queued.executionId, { status: 'stale', completedAt: now })
  settlement.settleOwnerCommandUsage(queued.commandId, { source: 'unknown', reason: '测试未知用量保持岗位占额', executionId, sessionId, channelId: f.channel.id, modelId: 'glm-5.3-flash', capturedAt: now })
  return queued
}
function settleManualCommandFixture(f: ReturnType<typeof fixture>, role: 'executor' | 'reviewer', taskId: string, costMicros: number) {
  const input = { grantId: f.grant.grantId, taskId, role, reworkOrdinal: 0, expectedRevalidationRevision: f.record.revision } as const
  const preview = command.previewOwnerExecutionCommandAck(f.subject, input), commandId = randomUUID(), executionId = randomUUID()
  const queued = command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId, role, reworkOrdinal: 0, expectedRevalidationRevision: f.record.revision, idempotencyKey: randomUUID() }, { input, preview, confirmedFingerprint: preview.ackFingerprint, acknowledgeModelCosts: true }, { executionId })
  const sessionId = randomUUID(), now = Date.now()
  startModule.claimOwnerCommandStart(queued.executionId, queued.commandId, f.record.revision, sessionId)
  store.updateAgentExecution(queued.executionId, { status: 'completed', resultSummary: 'fake-only', completedAt: now })
  settlement.settleOwnerCommandUsage(queued.commandId, { source: 'traceable_estimate', priceSource: 'fixture', inputTokens: 1, outputTokens: 1, costMicros, executionId: queued.executionId, sessionId, channelId: f.channel.id, modelId: 'glm-5.3-flash', capturedAt: now })
  return queued
}
function settleReviewFixture(f: ReturnType<typeof fixture>, role: 'executor' | 'reviewer', ordinal = 0, verdict?: 'approved' | 'changes_requested' | 'blocked', taskId = f.task.id, costMicros = 1) {
  const queued = command.reserveAndQueueAutonomousOwnerCommand(f.subject, { grantId: f.grant.grantId, taskId, role, reworkOrdinal: ordinal, expectedRevalidationRevision: f.record.revision })
  const sessionId = randomUUID(), now = Date.now()
  const link = materialization.getOwnerTaskMaterializationRecord(f.project.id, f.record.source.materialization.id).links.find(item => item.taskId === taskId)!
  const rawReview = JSON.stringify({ schemaVersion: 1, verdict: verdict ?? 'approved', summary: 'fake-only评审', criteria: link.projection.acceptanceCriteria.map(criterion => ({ criterion, status: verdict === 'changes_requested' ? 'not_met' : verdict === 'blocked' ? 'not_verified' : 'met', evidence: 'fake-only' })), findings: verdict === 'changes_requested' ? [{ severity: 'medium', description: '缺少回归覆盖。', requestedChange: '补充回归测试。' }] : [], blockerReason: verdict === 'blocked' ? '缺少用户提供的资料。' : null })
  startModule.claimOwnerCommandStart(queued.executionId, queued.commandId, f.record.revision, sessionId)
  store.updateAgentExecution(queued.executionId, { status: 'completed', resultSummary: role === 'reviewer' ? rawReview : 'fake-only执行结果', completedAt: now })
  settlement.settleOwnerCommandUsage(queued.commandId, { source: 'traceable_estimate', priceSource: 'fixture', inputTokens: 1, outputTokens: 1, costMicros, executionId: queued.executionId, sessionId, channelId: f.channel.id, modelId: 'glm-5.3-flash', capturedAt: now })
  if (role === 'reviewer' && verdict) technicalReview.recordOwnerTechnicalReviewEvidence(queued.commandId, queued.executionId, rawReview, now)
  return { ...queued, rawReview, now }
}

async function assertNoAutonomousDispatch(f: ReturnType<typeof fixture>, expectedCount: number) {
  let queues = 0, dispatches = 0
  const driver = {
    queue: (...args: Parameters<typeof command.reserveAndQueueAutonomousOwnerCommand>) => { queues++; return command.reserveAndQueueAutonomousOwnerCommand(...args) },
    dispatch: async () => { dispatches++; throw new Error('停等时不得派发') },
  }
  const first = await scheduler.runOwnerAutonomousSchedule(f.project.id, driver)
  const second = await scheduler.runOwnerAutonomousSchedule(f.project.id, driver)
  expect(second).toEqual(first)
  expect(queues).toBe(0)
  expect(dispatches).toBe(0)
  expect(store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=?').get(f.grant.grantId)).toEqual({ count: expectedCount })
  return first
}

test('Given一次返工后Reviewer再次退回 When后台重复唤醒 Then最大返工次数停等且不新增命令', async () => {
  const f = fixture('glm-5.3-flash', 'autonomous', false, 'https://example.invalid', false, 'openai', 1, 6)
  settleReviewFixture(f, 'executor'); settleReviewFixture(f, 'reviewer', 0, 'changes_requested')
  settleReviewFixture(f, 'executor', 1); settleReviewFixture(f, 'reviewer', 1, 'changes_requested')
  const state = await assertNoAutonomousDispatch(f, 4)
  expect(state).toMatchObject({ state: 'waiting', reworkOrdinal: 1, reviewVerdict: 'changes_requested', nextAction: 'human_decision', runReservations: 4 })
  expect(state.reason).toContain('最大返工次数 1')
  expect(store.getTask(f.task.id)?.status).toBe('paused')
})

test('Given返工许可与剩余运行次数但两微美元授权费用耗尽 When重复唤醒 Then不得增加额度或排入返工', async () => {
  const f = fixture('glm-5.3-flash', 'autonomous', false, 'https://example.invalid', false, 'openai', 1, 4, 2)
  settleReviewFixture(f, 'executor'); settleReviewFixture(f, 'reviewer', 0, 'changes_requested')
  const state = await assertNoAutonomousDispatch(f, 2)
  expect(state).toMatchObject({ state: 'waiting', committedCostMicros: 2, reservedCostMicros: 0, runReservations: 2, nextAction: 'human_decision' })
  expect(state.reason).toContain('费用或运行次数已耗尽')
  expect(f.record.source.budget).toMatchObject({ maxRuns: 4, maxCostMicros: 2 })
})

test('Given合法blocked评审 When后台重复唤醒 Then保留卡点且不当作返工或业务验收', async () => {
  const f = fixture('glm-5.3-flash', 'autonomous', false, 'https://example.invalid', false, 'openai', 1)
  settleReviewFixture(f, 'executor'); settleReviewFixture(f, 'reviewer', 0, 'blocked')
  const state = await assertNoAutonomousDispatch(f, 2)
  expect(state).toMatchObject({ state: 'waiting', reviewVerdict: 'blocked', nextAction: 'human_decision' })
  expect(state.reason).toContain('缺少用户提供的资料')
  expect(store.getTask(f.task.id)?.status).toBe('paused')
})

test('GivenReviewer完成但未记录回执 When重复唤醒 Then不从resultSummary补造评审或重试', async () => {
  const f = fixture('glm-5.3-flash', 'autonomous')
  settleReviewFixture(f, 'executor'); settleReviewFixture(f, 'reviewer')
  expect((await assertNoAutonomousDispatch(f, 2)).reason).toContain('缺少可核验的结构化技术评审')
  expect(technicalReview.listOwnerTechnicalReviewEvidence(f.project.id)).toEqual([])
})

test('Given已持久评审 When重复或不同回执及跨项目execution进入 Then幂等且拒绝覆盖和身份混配', () => {
  const f = fixture('glm-5.3-flash', 'autonomous'), other = fixture('glm-5.3-flash', 'autonomous')
  const executor = settleReviewFixture(f, 'executor'), reviewer = settleReviewFixture(f, 'reviewer', 0, 'approved')
  settleReviewFixture(other, 'executor'); const otherReviewer = settleReviewFixture(other, 'reviewer', 0, 'approved')
  const before = technicalReview.listOwnerTechnicalReviewEvidence(f.project.id)
  technicalReview.recordOwnerTechnicalReviewEvidence(reviewer.commandId, reviewer.executionId, reviewer.rawReview, reviewer.now)
  expect(() => technicalReview.recordOwnerTechnicalReviewEvidence(reviewer.commandId, reviewer.executionId, reviewer.rawReview.replace('fake-only评审', '另一个结论'), reviewer.now)).toThrow('拒绝覆盖')
  expect(() => technicalReview.recordOwnerTechnicalReviewEvidence(reviewer.commandId, otherReviewer.executionId, reviewer.rawReview)).toThrow('拒绝保存')
  expect(() => technicalReview.recordOwnerTechnicalReviewEvidence(executor.commandId, executor.executionId, reviewer.rawReview)).toThrow('拒绝保存')
  expect(technicalReview.listOwnerTechnicalReviewEvidence(f.project.id)).toEqual(before)
  expect(technicalReview.listOwnerTechnicalReviewEvidence(other.project.id)).toHaveLength(1)
})

test('GivenReviewer命令轮次与Executor不一致 When记录评审回执 Then拒绝保存且不产生调度证据', () => {
  const f = fixture('glm-5.3-flash', 'autonomous')
  settleReviewFixture(f, 'executor')
  const reviewer = settleReviewFixture(f, 'reviewer')
  store.getProjectDb().prepare('UPDATE project_owner_execution_commands SET rework_ordinal=? WHERE id=?').run(1, reviewer.commandId)
  expect(() => technicalReview.recordOwnerTechnicalReviewEvidence(reviewer.commandId, reviewer.executionId, reviewer.rawReview, reviewer.now)).toThrow('对应返工轮次必须恰有一条 Executor 命令')
  expect(technicalReview.listOwnerTechnicalReviewEvidence(f.project.id)).toEqual([])
})

test('Given回执写入外层事务回滚 When调度读取 Then不使用已回滚证据且允许同回执正常重录', () => {
  const f = fixture('glm-5.3-flash', 'autonomous')
  settleReviewFixture(f, 'executor'); const reviewer = settleReviewFixture(f, 'reviewer')
  const db = store.getProjectDb()
  expect(() => db.transaction(() => {
    technicalReview.recordOwnerTechnicalReviewEvidence(reviewer.commandId, reviewer.executionId, reviewer.rawReview, reviewer.now)
    throw new Error('fixture rollback')
  })()).toThrow('fixture rollback')
  expect(technicalReview.listOwnerTechnicalReviewEvidence(f.project.id)).toEqual([])
  expect(scheduler.getOwnerAutonomousScheduleStatus(f.project.id).reason).toContain('缺少可核验')
  technicalReview.recordOwnerTechnicalReviewEvidence(reviewer.commandId, reviewer.executionId, reviewer.rawReview, reviewer.now)
  expect(technicalReview.listOwnerTechnicalReviewEvidence(f.project.id)).toHaveLength(1)
})

test('Given两任务依赖且前置经历返工复审 When技术通过与业务完成分别发生 Then只在权威完成后幂等排入下游', async () => {
  const f = fixture('glm-5.3-flash', 'autonomous', true, 'https://example.invalid', false, 'openai', 1)
  const dependency = store.listTaskDependencies(f.project.id)[0]!
  const upstream = dependency.dependsOnTaskId, downstream = dependency.taskId
  settleReviewFixture(f, 'executor', 0, undefined, upstream); settleReviewFixture(f, 'reviewer', 0, 'changes_requested', upstream)
  settleReviewFixture(f, 'executor', 1, undefined, upstream); settleReviewFixture(f, 'reviewer', 1, 'approved', upstream)
  expect((await assertNoAutonomousDispatch(f, 4)).reason).toContain('依赖')
  expect(store.getTask(upstream)?.status).toBe('paused')
  store.updateTask(upstream, { status: 'completed' })
  expect(scheduler.getOwnerAutonomousScheduleStatus(f.project.id)).toMatchObject({ state: 'ready', taskId: downstream, role: 'executor', reworkOrdinal: 0 })
  const input = { grantId: f.grant.grantId, taskId: downstream, role: 'executor' as const, reworkOrdinal: 0, expectedRevalidationRevision: f.record.revision }
  const first = command.reserveAndQueueAutonomousOwnerCommand(f.subject, input)
  expect(command.reserveAndQueueAutonomousOwnerCommand(f.subject, input)).toEqual({ ...first, alreadyQueued: true })
  expect(store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=?').get(f.grant.grantId)).toEqual({ count: 5 })
  expect(store.getTask(downstream)?.status).toBe('paused')
})

test('Given返工意见已冻结 When员工来源指纹漂移 ThenScheduler停为stale且不排入下一返工轮', async () => {
  const f = fixture('glm-5.3-flash', 'autonomous', false, 'https://example.invalid', false, 'openai', 1)
  settleReviewFixture(f, 'executor'); settleReviewFixture(f, 'reviewer', 0, 'changes_requested')
  employees.updateAgentEmployee(f.executor.id, { name: '漂移后的执行者' })
  expect(revalidation.getOwnerExecutionRevalidation(f.subject).status).toBe('stale')
  const state = await assertNoAutonomousDispatch(f, 2)
  expect(state.state).toBe('stale')
  expect(state.reason).toContain('冻结来源或策略不再current')
  expect(state.state).toBe('stale')
})

test('Given活动授权绑定旧目标版本 When目标前进并唤醒Scheduler Then旧v2失效且不新增命令', async () => {
  const f = fixture('glm-5.3-flash', 'autonomous', false, 'https://example.invalid', false, 'openai', 1)
  const beforeCount = (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=?').get(f.grant.grantId) as { count: number }).count

  const revisedGoal = saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '修订后的项目目标' })
  expect(revisedGoal.revision).toBe(2)
  expect(revalidation.getOwnerExecutionRevalidation(f.subject).status).toBe('stale')

  const state = await assertNoAutonomousDispatch(f, beforeCount)
  expect(state.state).toBe('stale')
  expect(state.reason).toContain('冻结来源或策略不再current')
  expect((store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=?').get(f.grant.grantId) as { count: number }).count).toBe(beforeCount)
})

test('Given活动授权绑定旧计划版本 When保存新计划版本并唤醒Scheduler Then旧v2失效且不新增命令', async () => {
  const f = fixture('glm-5.3-flash', 'autonomous', false, 'https://example.invalid', false, 'openai', 1)
  const beforeCount = (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=?').get(f.grant.grantId) as { count: number }).count
  const currentPlan = plans.getProjectOwnerPlanDraft(f.project.id)!
  const context = plans.getProjectOwnerPlanningContext(f.project.id)
  const revisedPlan = plans.saveProjectOwnerPlanDraft(f.project.id, context.goal.revision, currentPlan.revision, {
    expectedContextFingerprint: context.fingerprint,
    summary: '经人工修订的新计划版本',
    assumptions: currentPlan.proposal.assumptions,
    risks: currentPlan.proposal.risks,
    steps: currentPlan.proposal.steps,
    changeReason: '更新验收方案',
  })

  expect(revisedPlan.planVersion).toBe(currentPlan.planVersion + 1)
  expect(revisedPlan.state).toBe('proposed')
  expect(revalidation.getOwnerExecutionRevalidation(f.subject).status).toBe('stale')
  expect(() => grantIssue.previewOwnerExecutionGrantIssue(f.subject, {
    requestId: randomUUID(),
    expectedRevalidationRevision: f.record.revision,
    expectedPolicyRevision: policy.getPilotPolicy(f.project.id)!.revision,
    dispatchMode: 'autonomous',
  })).toThrow()
  expect(() => command.previewOwnerExecutionCommandAck(f.subject, {
    grantId: f.grant.grantId,
    taskId: f.task.id,
    role: 'executor',
    reworkOrdinal: 0,
    expectedRevalidationRevision: f.record.revision,
  })).toThrow()

  const state = await assertNoAutonomousDispatch(f, beforeCount)
  expect(state.state).toBe('stale')
  expect(state.reason).toContain('冻结来源或策略不再current')
  expect((store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=?').get(f.grant.grantId) as { count: number }).count).toBe(beforeCount)
})

test('Given活动授权绑定单任务旧目标版本 When单任务目标前进并唤醒Scheduler Then旧v2失效且不新增命令', async () => {
  const f = fixture('glm-5.3-flash', 'autonomous', false, 'https://example.invalid', false, 'openai', 1, undefined, 1000000, undefined, false, true)
  const goalTaskId = f.goalTask!.id
  const beforeCount = (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=?').get(f.grant.grantId) as { count: number }).count

  const revisedGoal = saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '修订后的单任务目标' }, goalTaskId)
  expect(revisedGoal.revision).toBe(2)
  expect(revalidation.getOwnerExecutionRevalidation(f.subject).status).toBe('stale')

  const state = await assertNoAutonomousDispatch(f, beforeCount)
  expect(state.state).toBe('stale')
  expect(state.reason).toContain('冻结来源或策略不再current')
  expect((store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=?').get(f.grant.grantId) as { count: number }).count).toBe(beforeCount)
})

test('Given返工Executor状态未知 WhenScheduler恢复 Then保留unknown占额且不排Reviewer或重试', async () => {
  const f = fixture('glm-5.3-flash', 'autonomous', false, 'https://example.invalid', false, 'openai', 1)
  settleReviewFixture(f, 'executor'); settleReviewFixture(f, 'reviewer', 0, 'changes_requested')
  const queued = command.reserveAndQueueAutonomousOwnerCommand(f.subject, { grantId: f.grant.grantId, taskId: f.task.id, role: 'executor', reworkOrdinal: 1, expectedRevalidationRevision: f.record.revision })
  const sessionId = randomUUID(), now = Date.now()
  startModule.claimOwnerCommandStart(queued.executionId, queued.commandId, f.record.revision, sessionId)
  store.updateAgentExecution(queued.executionId, { status: 'stale', completedAt: now })
  settlement.settleOwnerCommandUsage(queued.commandId, { source: 'unknown', reason: '返工运行终态未知', executionId: queued.executionId, sessionId, channelId: f.channel.id, modelId: 'glm-5.3-flash', capturedAt: now })
  const state = await assertNoAutonomousDispatch(f, 3)
  expect(state).toMatchObject({ state: 'needs_reconcile', grantId: f.grant.grantId })
  expect(state.reservedCostMicros).toBeGreaterThan(0)
  expect(technicalReview.listOwnerTechnicalReviewEvidence(f.project.id, f.task.id)).toHaveLength(1)
})

test('Given返工Reviewer存在未解决停止升级 When尝试记录通过回执 Then拒绝续派且保持对账状态', async () => {
  const f = fixture('glm-5.3-flash', 'autonomous', false, 'https://example.invalid', false, 'openai', 1)
  settleReviewFixture(f, 'executor'); settleReviewFixture(f, 'reviewer', 0, 'changes_requested'); settleReviewFixture(f, 'executor', 1)
  const queued = command.reserveAndQueueAutonomousOwnerCommand(f.subject, { grantId: f.grant.grantId, taskId: f.task.id, role: 'reviewer', reworkOrdinal: 1, expectedRevalidationRevision: f.record.revision })
  const sessionId = randomUUID(), now = Date.now()
  startModule.claimOwnerCommandStart(queued.executionId, queued.commandId, f.record.revision, sessionId)
  stopModule.recordOwnerCommandStopEscalation(queued.executionId, 'fake返工Reviewer停止未证实', now)
  store.updateAgentExecution(queued.executionId, { status: 'stale', completedAt: now })
  settlement.settleOwnerCommandUsage(queued.commandId, { source: 'unknown', reason: '停止后终态未知', executionId: queued.executionId, sessionId, channelId: f.channel.id, modelId: 'glm-5.3-flash', capturedAt: now })
  const state = await assertNoAutonomousDispatch(f, 4)
  expect(state.reason).toContain('自主授权已暂停')
  expect(store.getProjectDb().prepare('SELECT state FROM project_owner_execution_grants WHERE id=?').get(f.grant.grantId)).toEqual({ state: 'paused' })
  expect(store.getProjectDb().prepare('SELECT state FROM project_owner_execution_commands WHERE id=?').get(queued.commandId)).toEqual({ state: 'needs_reconcile' })
  expect(store.getProjectDb().prepare('SELECT resolved_at FROM project_owner_execution_stop_escalations WHERE command_id=?').get(queued.commandId)).toEqual({ resolved_at: null })
  expect(technicalReview.listOwnerTechnicalReviewEvidence(f.project.id, f.task.id)).toHaveLength(1)
})

test('Given同一授权任务角色轮次已有命令 When用新幂等键重复排队 ThenExecutor和Reviewer都拒绝第二次消费', () => {
  for (const role of ['executor', 'reviewer'] as const) {
    const f = fixture('glm-5.3-flash', 'manual', false, 'https://example.invalid', false, 'openai', 0, 6)
    if (role === 'reviewer') settleManualCommandFixture(f, 'executor', f.task.id, 1)
    settleManualCommandFixture(f, role, f.task.id, 1)
    const input = { grantId: f.grant.grantId, taskId: f.task.id, role, reworkOrdinal: 0, expectedRevalidationRevision: f.record.revision }
    const preview = command.previewOwnerExecutionCommandAck(f.subject, input)
    expect(() => command.reserveAndQueueOwnerCommand(f.subject, { commandId: randomUUID(), ...input, idempotencyKey: randomUUID() }, {
      input, preview, confirmedFingerprint: preview.ackFingerprint, acknowledgeModelCosts: true,
    }, { executionId: randomUUID() })).toThrow(/角色轮次已有非释放命令/)
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=? AND role=? AND rework_ordinal=0').get(f.grant.grantId, role)).toEqual({ count: 1 })
  }
})

test('Given岗位cap已被Executor结算耗尽 When Reviewer复用同一岗位cap Then被拦截但未设cap的岗位仍可预览', () => {
  const f = fixture('glm-5.3-flash', 'manual', true, 'https://example.invalid', true, 'openai', 0, 4, 1000000, 250000)
  const first = f.record.source.tasks.find(item => item.stepKey === 'brief')!, second = f.record.source.tasks.find(item => item.stepKey === 'delivery')!
  const firstPreview = command.previewOwnerExecutionCommandAck(f.subject, { grantId: f.grant.grantId, taskId: first.taskId, role: 'executor', reworkOrdinal: 0, expectedRevalidationRevision: f.record.revision })
  expect(firstPreview).toMatchObject({ roleBudgetCapMicros: 250000, remainingRoleCostMicros: 250000, derivedReservationMicros: 250000 })
  settleManualCommandFixture(f, 'executor', first.taskId, 250000)
  const reviewerInput = { grantId: f.grant.grantId, taskId: first.taskId, role: 'reviewer' as const, reworkOrdinal: 0, expectedRevalidationRevision: f.record.revision }
  expect(() => command.previewOwnerExecutionCommandAck(f.subject, reviewerInput)).toThrow(/岗位费用额度不足/)
  const uncappedInput = { ...reviewerInput, taskId: second.taskId, role: 'executor' as const }
  const uncappedPreview = command.previewOwnerExecutionCommandAck(f.subject, uncappedInput)
  expect(uncappedPreview.derivedReservationMicros).toBe(250000)
  expect(uncappedPreview.remainingRoleCostMicros).toBeUndefined()
})
test('Given unknown命令占满一个岗位cap When尝试同岗位另一个独立任务 Then即使共享额度有余也保留岗位预留并阻止', () => {
  const f = fixture('glm-5.3-flash', 'manual', true, 'https://example.invalid', false, 'openai', 0, 4, 1000000, 250000, true)
  const first = f.record.source.tasks.find(item => item.stepKey === 'brief')!, second = f.record.source.tasks.find(item => item.stepKey === 'delivery')!
  const held = holdUnknownManualCommandFixture(f, first.taskId)
  expect(store.getProjectDb().prepare('SELECT state, reserved_cost_micros, actual_cost_micros, budget_role_key FROM project_owner_execution_commands WHERE id=?').get(held.commandId)).toMatchObject({ state: 'needs_reconcile', reserved_cost_micros: 250000, actual_cost_micros: null, budget_role_key: first.executor!.roleKey })
  expect(store.getProjectDb().prepare('SELECT state FROM project_owner_execution_grants WHERE id=?').get(f.grant.grantId)).toEqual({ state: 'needs_reconcile' })
  const roleCommitted = (store.getProjectDb().prepare(`SELECT COALESCE(SUM(CASE WHEN state='released' THEN 0 WHEN state='settled' AND actual_cost_micros IS NOT NULL THEN actual_cost_micros WHEN actual_cost_micros > reserved_cost_micros THEN actual_cost_micros ELSE reserved_cost_micros END), 0) AS committed FROM project_owner_execution_commands WHERE grant_id=? AND budget_role_key=?`).get(f.grant.grantId, first.executor!.roleKey) as { committed: number }).committed
  expect(roleCommitted).toBe(250000)
  expect(() => command.previewOwnerExecutionCommandAck(f.subject, { grantId: f.grant.grantId, taskId: second.taskId, role: 'executor', reworkOrdinal: 0, expectedRevalidationRevision: f.record.revision })).toThrow('授权与v2来源不一致')
})
test('Given已知结算与不可变技术回执 When数据库关闭重开 Then恢复同一证据且技术通过仍不完成Task', async () => {
  const f = fixture('glm-5.3-flash', 'autonomous')
  settleReviewFixture(f, 'executor'); const reviewer = settleReviewFixture(f, 'reviewer', 0, 'approved')
  const before = technicalReview.listOwnerTechnicalReviewEvidence(f.project.id)
  store.closeProjectDb()
  await store.initProjectDb()
  expect(technicalReview.listOwnerTechnicalReviewEvidence(f.project.id)).toEqual(before)
  expect(store.getTask(f.task.id)?.status).toBe('paused')
  expect((await assertNoAutonomousDispatch(f, 2)).nextAction).toBe('await_business_acceptance')
  technicalReview.recordOwnerTechnicalReviewEvidence(reviewer.commandId, reviewer.executionId, reviewer.rawReview, reviewer.now)
  expect(technicalReview.listOwnerTechnicalReviewEvidence(f.project.id)).toEqual(before)
}, 15_000)

function verifyAppendNewPlanBatch(taskScopedGoal: boolean) {
  const f = taskScopedGoal
    ? fixture('glm-5.3-flash', 'manual', false, undefined, false, 'openai', 0, undefined, 1000000, undefined, false, true)
    : fixture()
  const oldTaskIds = f.batch.links.map(link => link.taskId)
  const oldMaterialization = materialization.getOwnerTaskMaterializationRecord(f.project.id, f.batch.id)
  const oldRevalidation = revalidation.listOwnerExecutionRevalidationHistory(f.subject).find(item => item.id === f.record.id)!
  const revoke = grantIssue.previewOwnerExecutionGrantRevoke(f.subject, { grantId: f.grant.grantId })
  expect(revoke.blockers).toEqual([])
  expect(grantIssue.confirmOwnerExecutionGrantRevoke(f.subject, { grantId: f.grant.grantId, confirmedFingerprint: revoke.fingerprint }).state).toBe('paused')

  const newGoal = saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '按新目标继续交付' }, f.subject.taskId)
  expect(newGoal.revision).toBe(2)
  const context = plans.getProjectOwnerPlanningContext(f.project.id, f.subject.taskId)
  const oldPlan = plans.getProjectOwnerPlanDraft(f.project.id, f.subject.taskId)!
  const roleKey = f.batch.preview.preparation.source.plan.proposal.steps[0]!.roleKey
  const proposed = plans.saveProjectOwnerPlanDraft(f.project.id, newGoal.revision, oldPlan.revision, {
    expectedContextFingerprint: context.fingerprint,
    summary: '第二批计划',
    assumptions: [],
    risks: [],
    steps: [{ key: 'brief-v2', title: '第二批研究', outcome: '新批次材料', acceptanceCriteria: ['满足新目标'], dependencies: [], roleKey }],
    changeReason: '目标版本推进，追加新任务批次',
  }, f.subject.taskId)
  const confirmed = plans.confirmProjectOwnerPlanDraft(f.project.id, newGoal.revision, proposed.revision, f.subject.taskId)
  const nextPreparationInput = {
    ...f.batch.preview.preparation.input,
    requestId: randomUUID(),
    expectedPreparationRevision: f.batch.preview.preparation.revision,
    expectedPolicyRevision: policy.getPilotPolicy(f.project.id)!.revision,
    expectedGoalRevision: 2,
    expectedPlanRevision: confirmed.revision,
    selectedStepKeys: ['brief-v2'],
    changeReason: '新计划经用户确认，追加暂停任务批次',
  }
  const preparationPreview = prep.previewOwnerExecutionPreparation(f.subject, nextPreparationInput)
  const nextPreparation = prep.saveOwnerExecutionPreparation(f.subject, nextPreparationInput, preparationPreview.previewFingerprint)

  const nextMaterializationInput = {
    requestId: randomUUID(),
    expectedMaterializationRevision: f.batch.revision,
    expectedPreparationId: nextPreparation.id,
    expectedPreparationRevision: nextPreparation.revision,
    expectedPreparationHash: nextPreparation.integrityHash,
    expectedPolicyRevision: nextPreparation.policyRevision,
  }
  const nextMaterializationPreview = materialization.previewOwnerTaskMaterialization(f.subject, nextMaterializationInput)
  const nextBatch = materialization.materializeOwnerTasks(f.subject, nextMaterializationInput, nextMaterializationPreview.previewFingerprint)
  const allTaskIds = store.listTasks(f.project.id).map(task => task.id)
  expect(nextBatch.links).toHaveLength(1)
  expect(nextBatch.links[0]!.taskId).not.toBe(oldTaskIds[0])
  expect(allTaskIds).toEqual(expect.arrayContaining([...oldTaskIds, nextBatch.links[0]!.taskId]))
  expect(oldMaterialization).toEqual(materialization.getOwnerTaskMaterializationRecord(f.project.id, f.batch.id))
  expect(oldRevalidation).toEqual(revalidation.listOwnerExecutionRevalidationHistory(f.subject).find(item => item.id === f.record.id)!)
  expect(oldTaskIds.map(id => store.getTask(id)?.ownerStepLinkId)).toEqual(f.batch.links.map(link => link.id))
  expect(materialization.getOwnerTaskMaterialization(f.subject)).toMatchObject({ revision: nextBatch.revision, status: 'needs_revalidation', materialization: { id: nextBatch.id } })

  const nextRevalidationInput = {
    requestId: randomUUID(),
    expectedRevalidationRevision: f.record.revision,
    expectedMaterializationId: nextBatch.id,
    expectedMaterializationRevision: nextBatch.revision,
    expectedMaterializationHash: nextBatch.integrityHash,
    expectedPolicyRevision: nextPreparation.policyRevision,
    changeReason: '重新核验新增任务批次',
  }
  const nextRevalidationPreview = revalidation.previewOwnerExecutionRevalidation(f.subject, nextRevalidationInput)
  const nextRevalidation = revalidation.saveOwnerExecutionRevalidation(f.subject, nextRevalidationInput, nextRevalidationPreview.previewFingerprint)
  const samePlanPreparationInput = {
    ...nextPreparation.input,
    requestId: randomUUID(),
    expectedPreparationRevision: nextPreparation.revision,
    expectedPolicyRevision: policy.getPilotPolicy(f.project.id)!.revision,
    changeReason: '尝试用相同计划替换v2准备',
  }
  const preparationHistoryLength = prep.listOwnerExecutionPreparationHistory(f.subject).length
  const samePlanPreparationPreview = prep.previewOwnerExecutionPreparation(f.subject, samePlanPreparationInput)
  expect(() => prep.saveOwnerExecutionPreparation(f.subject, samePlanPreparationInput, samePlanPreparationPreview.previewFingerprint)).toThrow('相同计划不能覆盖v2准备')
  expect(prep.listOwnerExecutionPreparationHistory(f.subject)).toHaveLength(preparationHistoryLength)
  const nextIssueInput = { requestId: randomUUID(), expectedRevalidationRevision: nextRevalidation.revision, expectedPolicyRevision: policy.getPilotPolicy(f.project.id)!.revision, dispatchMode: 'manual' as const }
  const nextIssuePreview = grantIssue.previewOwnerExecutionGrantIssue(f.subject, nextIssueInput)
  const nextGrant = grantIssue.confirmOwnerExecutionGrantIssue(f.subject, { input: nextIssueInput, preview: nextIssuePreview, confirmedFingerprint: nextIssuePreview.approvalFingerprint })
  expect(nextGrant.state).toBe('active')
  expect(store.getProjectDb().prepare('SELECT state, revalidation_id FROM project_owner_execution_grants WHERE id=?').get(f.grant.grantId)).toEqual({ state: 'paused', revalidation_id: f.record.id })
  expect(store.getProjectDb().prepare('SELECT state, revalidation_id FROM project_owner_execution_grants WHERE id=?').get(nextGrant.grantId)).toEqual({ state: 'active', revalidation_id: nextRevalidation.id })
  if (taskScopedGoal) expect(store.getTask(f.goalTask!.id)?.ownerStepLinkId).toBe(f.batch.links[0]!.id)
}

test('Given旧grant已撤权且新项目计划已确认 When重新准备/材料化/重验证/发行 Then追加新Task并保留旧任务与证据', () => {
  verifyAppendNewPlanBatch(false)
})

test('Given旧grant已撤权且新单任务计划已确认 When重新准备/材料化/重验证/发行 Then追加新Task并保留原目标与证据', () => {
  verifyAppendNewPlanBatch(true)
})

/** Owner流式出口夹具：同一命令进入running并领取会话，用于验证透传与结算时序。 */
function streamingOwnerRequest(priceEvidenceId: string, createBody: (release: Promise<void>) => ReadableStream<Uint8Array>) {
  requestEvidence.registerPilotPriceEvidenceForTests({ evidenceId: priceEvidenceId, providerKind: 'openai', model: 'glm-5.3-flash', inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, extraCostCeilingMicros: 0, maxModelInputTokens: 1000, maxModelOutputTokens: 200, reviewedAt: '2026-10-24', source: 'test fixture' })
  const f = fixture(), { input, ack } = ackFixture(f)
  const commandId = randomUUID(), executionId = randomUUID(), sessionId = randomUUID()
  command.reserveAndQueueOwnerCommand(f.subject, { commandId, grantId: input.grantId, taskId: input.taskId, role: input.role, reworkOrdinal: 0, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: randomUUID() }, ack, { executionId })
  startModule.claimOwnerCommandStart(executionId, commandId, input.expectedRevalidationRevision, sessionId)
  let releaseBody!: () => void
  const releaseGate = new Promise<void>(resolve => { releaseBody = resolve })
  const baseFetch = Object.assign(async () => new Response(createBody(releaseGate), { status: 200, headers: { 'content-type': 'text/event-stream' } }), { preconnect: () => {} })
  const ownerFetch = requestExit.createOwnerRequestFetch({ commandId, executionId, sessionId, priceEvidenceId, baseFetch })
  return {
    f, commandId, executionId, sessionId,
    send: () => ownerFetch('https://example.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'glm-5.3-flash', max_tokens: 200, stream: true, messages: [{ role: 'user', content: 'stream' }] }) }),
    release: () => releaseBody(),
    reservationState: () => store.getProjectDb().prepare('SELECT state FROM project_owner_execution_request_reservations WHERE command_id=?').get(commandId),
  }
}

test('Given Owner流式响应尚未结束 WhenRuntime读取首块 Then增量已透传且流结束后才结算为settled', async () => {
  const encoder = new TextEncoder()
  const s = streamingOwnerRequest('owner-streaming-fixture', release => new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你"}}]}\n\n'))
      await release
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"好"}}],"usage":{"prompt_tokens":80,"completion_tokens":20}}\n\n'))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  }))
  const response = await s.send()
  // 旧实现要等计费分支读完整个响应才返回 Response；此处上游还没结束就应拿到可读流。
  const reader = response.body!.getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toContain('你')
  expect(s.reservationState()).toEqual({ state: 'reserved' })
  // 结算尚未落地时工具门禁必须等待，不能放行也不能误判为失败。
  let gateResolved = false
  const gate = requestExit.awaitOwnerExecutionRequestsSettled(s.sessionId).then(() => { gateResolved = true })
  await Bun.sleep(20)
  expect(gateResolved).toBe(false)
  s.release()
  while (!(await reader.read()).done) { /* 读完剩余增量 */ }
  await gate
  expect(gateResolved).toBe(true)
  expect(s.reservationState()).toEqual({ state: 'settled' })
})

test('Given Owner流式响应没有用量回执 When流结束 Then请求进入对账且工具门禁拒绝', async () => {
  const encoder = new TextEncoder()
  const s = streamingOwnerRequest('owner-streaming-no-usage-fixture', () => new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"没有用量"}}]}\n\n'))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  }))
  const response = await s.send()
  await new Response(response.body!).text()
  await requestExit.awaitOwnerRequestSettlements({ commandId: s.commandId })
  expect(s.reservationState()).toEqual({ state: 'needs_reconcile' })
  await expect(requestExit.awaitOwnerExecutionRequestsSettled(s.sessionId)).rejects.toThrow('尚未确认')
})


test('Given认领前排队准备失败且无请求 When启动恢复 Then只恢复一次并保留原费用预留，未知用量与已有认领不得恢复', () => {
  for (const proof of ['empty','unknown','claimed','missing_source'] as const) {
    const f=fixture('glm-5.3-flash','autonomous')
    const { commandId,executionId }=command.reserveAndQueueAutonomousOwnerCommand(f.subject,{grantId:f.grant.grantId,taskId:f.task.id,role:'executor',reworkOrdinal:0,expectedRevalidationRevision:f.record.revision})
    const db=store.getProjectDb(), before=db.prepare('SELECT reserved_cost_micros FROM project_owner_execution_commands WHERE id=?').get(commandId)
    db.prepare("UPDATE project_owner_execution_commands SET state='needs_reconcile' WHERE id=?").run(commandId)
    if(proof==='unknown')db.prepare('UPDATE project_owner_execution_commands SET usage_evidence=? WHERE id=?').run(JSON.stringify({source:'unknown'}),commandId)
    if(proof==='missing_source')db.prepare('UPDATE project_owner_execution_commands SET usage_evidence=? WHERE id=?').run('{}',commandId)
    if(proof==='claimed')db.prepare('INSERT INTO project_owner_execution_start_attempts(execution_id,command_id,project_id,session_id,claimed_at) VALUES(?,?,?,?,?)').run(executionId,commandId,f.project.id,randomUUID(),Date.now())
    expect(stopModule.recoverUnclaimedOwnerCommandPreparations(Date.now(),executionId)).toBe(proof==='empty'?1:0)
    expect(db.prepare('SELECT reserved_cost_micros FROM project_owner_execution_commands WHERE id=?').get(commandId)).toEqual(before)
    expect(stopModule.recoverUnclaimedOwnerCommandPreparations(Date.now(),executionId)).toBe(0)
    expect(db.prepare('SELECT state FROM project_owner_execution_commands WHERE id=?').get(commandId)).toEqual({state:proof==='empty'?'queued':'needs_reconcile'})
  }
})
