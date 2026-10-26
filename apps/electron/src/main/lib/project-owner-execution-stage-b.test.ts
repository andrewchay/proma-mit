import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import type { ProviderType } from '@gravitas/shared'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const runnerRegistry = await import('./agent-headless-runner-registry')
const evidence = await import('./project-owner-execution-preparation-evidence')
const scheduler = await import('./project-owner-autonomous-scheduler')
let policy: typeof import('./project-pilot-policy')
beforeAll(async () => { await store.initProjectDb(); policy = await import('./project-pilot-policy') })
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
function fixture(modelId = 'glm-5.3-flash', dispatchMode: 'manual' | 'autonomous' = 'manual', withDependentTask = false, baseUrl = 'https://example.invalid', splitRoleEmployee = false, provider: ProviderType = 'openai', maxRework = 0, maxRuns?: number, maxCostMicros = 1000000, roleBudgetCapMicros?: number, independentTasks = false) {
  const project = store.createProject({ title: 'StageB fixture', description: '' })
  const workspace = createAgentWorkspace(`owner-stageb-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: 'fake', provider, baseUrl, apiKey: 'fake', enabled: true, models: [{ id: modelId, name: modelId, enabled: true }] })
  const employee = (name: string) => employees.createAgentEmployee({ name, role: '研究', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId, workspaceIds: [workspace.id] })
  const executor = employee('执行者'), secondExecutor = splitRoleEmployee ? employee('第二岗位执行者') : executor, reviewer = employee('技术评审')
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '目标' })
  const context = plans.getProjectOwnerPlanningContext(project.id)
  const orderedRoleKeys = context.sources.roles.map((role) => role.key).sort()
  const firstRoleKey = orderedRoleKeys[0]!
  const secondRoleKey = splitRoleEmployee ? orderedRoleKeys[1]! : firstRoleKey
  const steps = [
    { key: 'brief', title: '研究', outcome: '材料', acceptanceCriteria: ['范围'], dependencies: [] as string[], roleKey: firstRoleKey },
    ...(withDependentTask ? [{ key: 'delivery', title: '交付', outcome: '提交', acceptanceCriteria: ['完成'], dependencies: splitRoleEmployee || independentTasks ? [] : ['brief'], roleKey: secondRoleKey }] : []),
  ]
  plans.saveProjectOwnerPlanDraft(project.id, 1, 0, { expectedContextFingerprint: context.fingerprint, summary: '计划', assumptions: [], risks: [], steps, changeReason: '建立' })
  plans.confirmProjectOwnerPlanDraft(project.id, 1, 1)
  const subject = { projectId: project.id }
  const preparationInput = { requestId: randomUUID(), expectedPreparationRevision: 0, expectedPolicyRevision: null, expectedGoalRevision: 1, expectedPlanRevision: 2, selectedStepKeys: steps.map(step => step.key), executionKind: 'controlled' as const, executorEmployeeId: executor.id, reviewerEmployeeId: reviewer.id, roleAssignments: [...new Set(steps.map(step => step.roleKey))].map(roleKey => ({ roleKey, employeeId: splitRoleEmployee && roleKey === secondRoleKey ? secondExecutor.id : executor.id })), ...(roleBudgetCapMicros === undefined ? {} : { roleBudgetCaps: [{ roleKey: firstRoleKey, maxCostMicros: roleBudgetCapMicros }] }), workspaceId: workspace.id, knowledgeSourceIds: [], maxCostMicros, maxRuns: maxRuns ?? steps.length * (2 + maxRework * 2), maxRework, expiresAt: Date.now() + 3600000, changeReason: '准备' }
  const pv = prep.previewOwnerExecutionPreparation(subject, preparationInput), preparation = prep.saveOwnerExecutionPreparation(subject, preparationInput, pv.previewFingerprint)
  const materialInput = { requestId: randomUUID(), expectedMaterializationRevision: 0, expectedPreparationId: preparation.id, expectedPreparationRevision: preparation.revision, expectedPreparationHash: preparation.integrityHash, expectedPolicyRevision: preparation.policyRevision }
  const mpv = materialization.previewOwnerTaskMaterialization(subject, materialInput), batch = materialization.materializeOwnerTasks(subject, materialInput, mpv.previewFingerprint)
  const revalInput = { requestId: randomUUID(), expectedRevalidationRevision: 0, expectedMaterializationId: batch.id, expectedMaterializationRevision: batch.revision, expectedMaterializationHash: batch.integrityHash, expectedPolicyRevision: batch.input.expectedPolicyRevision, changeReason: '重验证' }
  const rpv = revalidation.previewOwnerExecutionRevalidation(subject, revalInput), record = revalidation.saveOwnerExecutionRevalidation(subject, revalInput, rpv.previewFingerprint)
  const issueInput = { requestId: randomUUID(), expectedRevalidationRevision: record.revision, expectedPolicyRevision: policy.getPilotPolicy(project.id)!.revision, dispatchMode }
  const ip = grantIssue.previewOwnerExecutionGrantIssue(subject, issueInput), grant = grantIssue.confirmOwnerExecutionGrantIssue(subject, { input: issueInput, preview: ip, confirmedFingerprint: ip.approvalFingerprint })
  const tasks = store.listTasks(project.id), task = tasks[0]!
  return { project, subject, record, batch, grant, task, tasks, workspace, channel, executor, secondExecutor, reviewer }
}
function ackFixture(f: ReturnType<typeof fixture>) {
  const input = { grantId: f.grant.grantId, taskId: f.task.id, role: 'executor' as const, reworkOrdinal: 0, expectedRevalidationRevision: f.record.revision }
  const preview = command.previewOwnerExecutionCommandAck(f.subject, input)
  const ack = { input, preview, confirmedFingerprint: preview.ackFingerprint, acknowledgeModelCosts: true }
  return { input, preview, ack }
}

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
  const adapter = new AISDKAgentAdapter()
  const messages: import('@gravitas/shared').SDKMessage[] = []
  const runtimeEvents: import('@gravitas/shared').AgentEvent[] = []
  try {
    for await (const message of adapter.query({
      sessionId, prompt: '仅验证本机 fake 文本响应', provider: 'openai', apiKey: decryptApiKey(f.channel.id),
      baseUrl: f.channel.baseUrl, model: 'glm-5.3-flash', cwd: getAgentWorkspaceCwd(f.workspace, sessionId),
      agentRuntime: 'ai-sdk', permissionMode: 'safe', maxTurns: 1, maxRetries: 0,
      onAgentEvent: event => runtimeEvents.push(event),
    })) messages.push(message)
  } finally {
    adapter.dispose()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  expect(transportCalls).toBe(1)
  expect(requestBodies[0]).toMatchObject({ model: 'glm-5.3-flash', stream: true, stream_options: { include_usage: true } })
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

  expect(requestExit.resolveOwnerExecutionMaxOutputTokens(sessionId, 'glm-5.3-flash', 'zhipu')).toBe(4096)
  expect(store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations WHERE command_id=?').get(commandId)).toEqual({ count: 0 })
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
  expect(store.getProjectDb().prepare('SELECT role, state FROM project_owner_execution_commands WHERE grant_id=?').all(f.grant.grantId)).toEqual([{ role: 'executor', state: 'settled' }])
  expect(scheduler.getOwnerAutonomousScheduleStatus(f.project.id)).toMatchObject({ state: 'ready', taskId: f.task.id, role: 'reviewer' })
  const reviewerStart = await scheduler.runOwnerAutonomousSchedule(f.project.id)
  // Reviewer在Executor已知结算后才被主进程安排。
  expect(reviewerStart).toMatchObject({ state: 'running' })
  await finished[1]
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
  expect(store.getProjectDb().prepare('SELECT state FROM project_owner_execution_request_reservations WHERE command_id=?').get(commandId)).toEqual({ state: 'settled' })
  await expect(ownerFetch('https://example.invalid/v1/chat/completions', { method: 'POST', body: bodies[1] })).rejects.toThrow('超过命令授权额度')
  expect(sent).toBe(1)
})
test('Given Owner请求模型不匹配审核证据 When创建请求 Then 在预留与transport之前拒绝', async () => {
  const before = (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations').get() as { count: number }).count
  let sent = 0
  const baseFetch = Object.assign(async () => { sent++; return new Response('{}', { status: 200 }) }, { preconnect: () => {} })
  const ownerFetch = requestExit.createOwnerRequestFetch({ commandId: randomUUID(), executionId: randomUUID(), sessionId: randomUUID(), baseFetch })
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
  store.closeProjectDb()
  await store.initProjectDb()
  // 模拟重启：无启动回执，execution遗留running。
  const results = stopModule.recoverInterruptedOwnerRuntimeExecutions()
  expect(results.some(item => item.executionId === executionId && item.state === 'unknown_recorded')).toBe(true)
  const after = store.getAgentExecution(executionId)!
  expect(after.status).toBe('stale')
  expect(store.getProjectDb().prepare("SELECT state FROM project_owner_execution_commands WHERE id=?").get(commandId)).toEqual({ state: 'needs_reconcile' })
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

    store.closeProjectDb()
    parentDbClosed = true
    const childTestPath = join(directory, `restart-recovery-${randomUUID()}.test.ts`)
    const childTest = `
      import { expect, mock, test } from 'bun:test'
      import { buildElectronMock } from ${JSON.stringify(join(process.cwd(), 'apps/electron/src/main/lib/testing/electron-mock.ts'))}
      mock.module('electron', () => buildElectronMock())
      test('startup recovery persists unknown before any old callback is delivered', async () => {
        const store = await import(${JSON.stringify(join(process.cwd(), 'apps/electron/src/main/lib/project-sqlite-store.ts'))})
        const stop = await import(${JSON.stringify(join(process.cwd(), 'apps/electron/src/main/lib/project-owner-execution-stop.ts'))})
        await store.initProjectDb()
        try {
          const executionId = ${JSON.stringify(executionId)}
          const result = stop.recoverInterruptedOwnerRuntimeExecutions(${Date.now()}, executionId)
          const repeatedResult = stop.recoverInterruptedOwnerRuntimeExecutions(${Date.now()}, executionId)
          const execution = store.getAgentExecution(executionId)
          const command = store.getProjectDb().prepare('SELECT state, actual_cost_micros, reserved_cost_micros, usage_evidence FROM project_owner_execution_commands WHERE id=?').get(${JSON.stringify(commandId)})
          const grant = store.getProjectDb().prepare('SELECT state FROM project_owner_execution_grants WHERE id=?').get(${JSON.stringify(input.grantId)})
          expect(result).toContainEqual(expect.objectContaining({ executionId, state: 'unknown_recorded', startBoundary: 'started_proven' }))
          expect(repeatedResult).toEqual([])
          expect(execution?.status).toBe('stale')
          expect(command).toMatchObject({ state: 'needs_reconcile', actual_cost_micros: null })
          expect(grant).toEqual({ state: 'paused' })
          console.log('OWNER_RECOVERY:' + JSON.stringify({ result, repeatedResult, executionStatus: execution?.status, command, grant }))
        } finally {
          store.closeProjectDb()
        }
      })
    `
    writeFileSync(childTestPath, childTest, 'utf8')
    const childOutput = execFileSync(process.execPath, ['test', childTestPath], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 30_000 })
    const recoveryLine = childOutput.split('\n').find(line => line.startsWith('OWNER_RECOVERY:'))
    expect(recoveryLine).toBeDefined()
    const recovery = JSON.parse(recoveryLine!.slice('OWNER_RECOVERY:'.length)) as {
      result: Array<{ executionId: string; state: string; startBoundary: string }>
      repeatedResult: Array<unknown>
      executionStatus: string | undefined
      command: { state: string; actual_cost_micros: number | null; reserved_cost_micros: number; usage_evidence: string | null } | undefined
      grant: { state: string } | undefined
    }
    expect(recovery.result).toContainEqual(expect.objectContaining({ executionId, state: 'unknown_recorded', startBoundary: 'started_proven' }))
    expect(recovery.repeatedResult).toEqual([])
    expect(recovery.executionStatus).toBe('stale')
    expect(recovery.command).toMatchObject({ state: 'needs_reconcile', actual_cost_micros: null })
    expect(recovery.command?.reserved_cost_micros).toBeGreaterThan(0)
    expect(JSON.parse(recovery.command?.usage_evidence ?? 'null')).toMatchObject({ source: 'unknown', executionId })
    expect(recovery.grant).toEqual({ state: 'paused' })

    await store.initProjectDb()
    parentDbClosed = false
    releaseRuntime()
    await dispatch
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.getAgentExecution(executionId)).toMatchObject({ status: 'stale' })
    expect(store.getAgentExecution(executionId)?.resultSummary).toBeUndefined()
    expect(store.getProjectDb().prepare('SELECT state, actual_cost_micros, reserved_cost_micros FROM project_owner_execution_commands WHERE id=?').get(commandId)).toMatchObject({ state: 'needs_reconcile', actual_cost_micros: null, reserved_cost_micros: recovery.command?.reserved_cost_micros })
    expect(store.getProjectDb().prepare('SELECT state FROM project_owner_execution_grants WHERE id=?').get(input.grantId)).toEqual({ state: 'paused' })
    expect(technicalReview.listOwnerTechnicalReviewEvidence(f.project.id)).toEqual([])
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=?').get(input.grantId)).toEqual({ count: 1 })
  } finally {
    releaseRuntime()
    if (parentDbClosed) await store.initProjectDb()
    if (dispatch) await dispatch.catch(() => undefined)
  }
})

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
})
