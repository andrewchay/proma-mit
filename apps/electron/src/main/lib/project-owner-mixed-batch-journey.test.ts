/**
 * 真实混合批次接替旅程：规格步骤走完「执行 → 独立评审 → Owner 验收」，
 * 研发步骤的执行者在同一次授权内失败；随后核对旧批次、暂停旧授权并写关联记录。
 *
 * 全链使用真实服务（准备 / 材料化 / 重验证 / 发行 / 调度 / 终态结算 / 质量管理循环），
 * 仅模型与传输是替身，不发送真实 Provider 请求。
 */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-mixed-journey-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))

const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const workspaces = await import('./agent-workspace-manager')
const channels = await import('./channel-manager')
const bindings = await import('./project-workspace-bindings')
const goals = await import('./project-owner-goal-service')
const runtimeBinding = await import('./project-owner-runtime-binding')
const plans = await import('./project-owner-plan-service')
const management = await import('./project-owner-management-loop')
const managementStore = await import('./project-owner-management-store')
const delegation = await import('./project-owner-management-delegation')
const prep = await import('./project-owner-execution-preparation')
const material = await import('./project-owner-task-materialization')
const executionLaunch = await import('./project-owner-execution-launch')
const scheduler = await import('./project-owner-autonomous-scheduler')
const scheduleEvents = await import('./project-owner-autonomous-scheduler-events')
const registry = await import('./agent-headless-runner-registry')
const boundary = await import('./controlled-provider-boundary')
const planningSource = await import('./project-owner-planning-source')
const planningProvider = await import('./project-owner-planning-provider')
const executionCommand = await import('./project-owner-execution-command')
const grantIssue = await import('./project-owner-execution-grant-issue')
const qualityActions = await import('./project-owner-quality-actions')
const recovery = await import('./project-owner-mixed-batch-recovery')

/** 研发工作区必须绑定可核验的 Git 仓库，否则研发准备会被拒绝。 */
function gitRepository(): string {
  const repo = mkdtempSync(join(directory, 'mixed-journey-repo-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), '# 混合批次基线\n')
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: repo })
  return repo
}

const BRIEF_CONTENT = '目标范围：面向已访谈的现有用户，建议有据可查。'
const BRIEF_QUOTE = '面向已访谈的现有用户'

interface JourneyCall { role: 'executor' | 'reviewer'; taskTitle: string; reworkOrdinal: number }
const businessCalls: JourneyCall[] = []

async function fixture() {
  const project = store.createProject({ title: '混合批次接替旅程', description: '' })
  const repo = gitRepository()
  const workspace = workspaces.createAgentWorkspace(`mixed-journey-${randomUUID()}`, repo)
  bindings.bindWorkspaceToProject(project.id, workspace.id)
  const modelId = 'deepseek-flash'
  const channel = channels.createChannel({ name: 'fake', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: modelId, name: modelId, enabled: true }] })
  const employee = (name: string) => employees.createAgentEmployee({ name, role: '研发与检查', description: '', executionProfile: 'development', permissionMode: 'auto', runtime: 'ai-sdk', channelId: channel.id, modelId, workspaceIds: [workspace.id] })
  const owner = employees.createAgentEmployee({ name: 'Owner', role: '项目管理者', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId, workspaceIds: [workspace.id] })
  const executor = employee('执行者')
  const reviewer = employee('独立评审')
  goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '交付规格与实现' })
  runtimeBinding.saveOwnerRuntimeBinding(project.id, 0, { ownerName: 'Owner', carrierId: owner.id, workspaceId: workspace.id, changeReason: '测试' })
  const context = plans.getProjectOwnerPlanningContext(project.id)
  const roleKey = context.sources.roles[0]!.key
  plans.saveProjectOwnerPlanDraft(project.id, 1, 0, {
    expectedContextFingerprint: context.fingerprint,
    summary: '先定规格，再实现',
    assumptions: [],
    risks: [],
    steps: [
      { key: 'brief', title: '形成规格', outcome: '规格说明', acceptanceCriteria: ['范围明确'], dependencies: [], roleKey, deliveryKind: 'text' },
      { key: 'delivery', title: '实现页面', outcome: '可运行的页面', acceptanceCriteria: ['页面可打开'], dependencies: ['brief'], roleKey, deliveryKind: 'development' },
    ],
    changeReason: '建立混合方案',
  })
  plans.confirmProjectOwnerPlanDraft(project.id, 1, 1)
  const subject = { projectId: project.id }
  const preparationInput = {
    requestId: randomUUID(), expectedPreparationRevision: 0, expectedPolicyRevision: null, expectedGoalRevision: 1, expectedPlanRevision: 2,
    selectedStepKeys: ['brief', 'delivery'], executionKind: 'development' as const,
    developmentScope: { workspaceId: workspace.id, targetPaths: ['index.html'], allowedPaths: ['index.html', 'README.md'], verificationCommands: ['git status'] },
    qualityManagementVersion: 1 as const, employeeRuntimeVersion: 2 as const,
    executorEmployeeId: executor.id, reviewerEmployeeId: reviewer.id,
    roleAssignments: [{ roleKey, employeeId: executor.id }],
    workspaceId: workspace.id, knowledgeSourceIds: [],
    maxCostMicros: 1_000_000, maxRuns: 8, maxRework: 1, expiresAt: Date.now() + 3_600_000, changeReason: '准备混合执行',
  }
  const preparationPreview = prep.previewOwnerExecutionPreparation(subject, preparationInput)
  const preparation = prep.saveOwnerExecutionPreparation(subject, preparationInput, preparationPreview.previewFingerprint)
  const materializationInput = { requestId: randomUUID(), expectedMaterializationRevision: 0, expectedPreparationId: preparation.id, expectedPreparationRevision: preparation.revision, expectedPreparationHash: preparation.integrityHash, expectedPolicyRevision: preparation.policyRevision }
  const delegationInput = { projectId: project.id, requestId: randomUUID(), maxRequests: 12, maxCostMicros: 15_000_000, expiresAt: Date.now() + 3_600_000 }
  const delegationPreview = delegation.previewOwnerManagementDelegation(delegationInput)
  delegation.confirmOwnerManagementDelegation({ input: delegationInput, previewHash: delegationPreview.previewHash })
  return { project, subject, workspace, repo, executor, reviewer, materializationInput, preparationRoleKey: roleKey }
}

/** 替身 Runner：业务执行走真实受控出口，Owner 规划返回质量决定或普通回应。 */
function installRunner() {
  registry.setHeadlessAgentRunner(async (input, callbacks) => {
    callbacks.onRuntimeStarted?.()
    const execution = store.getAgentExecutionBySessionId(input.sessionId)
    if (!execution) throw new Error('替身 Runner 找不到执行')
    if (execution.ownerCommandId) {
      const command = store.getProjectDb().prepare('SELECT role,rework_ordinal FROM project_owner_execution_commands WHERE id=?').get(execution.ownerCommandId) as { role: 'executor' | 'reviewer'; rework_ordinal: number }
      const task = store.getTask(execution.entityId)!
      businessCalls.push({ role: command.role, taskTitle: task.title, reworkOrdinal: command.rework_ordinal })
      const workspace = workspaces.getAgentWorkspace(task.workspaceId!)!
      const transport = Object.assign(async () => new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } }), { headers: { 'content-type': 'application/json' } }), { preconnect: () => {} }) as typeof globalThis.fetch
      const fetcher = boundary.createControlledProviderFetch(input.sessionId, () => ({ runtime: 'ai-sdk', cwd: workspaces.getAgentWorkspaceCwd(workspace, input.sessionId), modelId: input.modelId!, permissionMode: 'safe' }), transport)
      const channel = channels.getChannelById(input.channelId)!
      await fetcher(`${channel.baseUrl!.replace(/\/+$/, '')}/chat/completions`, { method: 'POST', body: JSON.stringify({ model: input.modelId, max_tokens: 100, messages: [{ role: 'user', content: input.userMessage }] }) })
      // 研发步骤的执行者失败：Provider 以 other 结束，费用仍按真实请求结算。
      if (task.title === '实现页面') {
        callbacks.onComplete([{ id: randomUUID(), role: 'assistant', content: '已开始实现页面，但运行时提前结束。', createdAt: Date.now() }], {
          runtimeResult: { type: 'result', subtype: 'error_during_execution', finish_reason: 'other', usage: { input_tokens: 1, output_tokens: 2 },
            toolCallBatchIntegrity: { version: 1, complete: false, reasons: ['tool_call_batch_incomplete'], unexecutedMandatory: false } } as unknown as import('@gravitas/shared').SDKResultMessage,
        })
        return
      }
      const content = command.role === 'reviewer'
        ? JSON.stringify({ schemaVersion: 2, artifactHash: (await import('./project-owner-text-delivery')).assertOwnerReviewerTextDelivery(execution.ownerCommandId)!.contentSha256, verdict: 'approved', summary: '规格范围与依据清楚', criteria: [{ criterion: '范围明确', status: 'met', evidence: '正文给出目标范围与依据', quote: BRIEF_QUOTE }], findings: [], blockerReason: null })
        : BRIEF_CONTENT
      callbacks.onComplete([{ id: randomUUID(), role: 'assistant', content, createdAt: Date.now() }], {
        runtimeResult: { type: 'result', subtype: 'success', finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 2 },
          toolCallBatchIntegrity: { version: 1, complete: true, reasons: [], unexecutedMandatory: false } } as unknown as import('@gravitas/shared').SDKResultMessage,
      })
      return
    }
    const source = planningSource.resolveOwnerPlanningSession(input.sessionId)
    if (!source) throw new Error('替身 Runner 找不到 Owner 来源')
    planningProvider.claimOwnerPlanningProviderRequest(input.sessionId, JSON.stringify({
      model: source.binding.modelId, stream: true, max_tokens: source.link.maxOutputTokens, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: source.request.systemPrompt }, { role: 'user', content: source.request.userPrompt }],
    }), new URL('https://example.invalid/v1/chat/completions'))
    const conversation = source.context.conversation
    const delivery = conversation?.deliveryReview
    const observation = conversation?.executionObservation
    const binding = { projectId: source.link.projectId, goalVersion: source.context.goal.goal.goalVersion, contextFingerprint: source.context.fingerprint }
    const result = delivery?.qualityDecisionVersion === 1 && delivery.artifact && delivery.review && observation
      ? {
        schemaVersion: 1, kind: 'quality_decision', binding, messageId: conversation!.throughMessageId,
        message: '已按完整成果与独立检查核对。',
        decision: {
          reviewerCommandId: observation.commandId, artifactHash: delivery.artifact.contentSha256, verdict: 'accept',
          reason: '规格步骤的成果与独立检查均满足验收标准',
          criteria: delivery.review.criteria.map(item => ({ criterion: item.criterion, status: 'met', evidence: '成果正文包含对应依据', quote: item.quote ?? BRIEF_QUOTE })),
          findings: [],
        },
      }
      : { schemaVersion: 1, kind: 'conversation_reply', binding, messageId: conversation?.throughMessageId ?? randomUUID(), message: '我已记录当前进度，等待下一步事实。' }
    callbacks.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: input.sessionId, finish_reason: 'stop', result: JSON.stringify(result), usage: { input_tokens: 10, output_tokens: 30 }, owner_planning_usage: { inputTokens: 10, outputTokens: 30, cacheReadTokens: null, cacheWriteTokens: null } } as unknown as import('@gravitas/shared').SDKResultMessage })
  })
}

async function until(predicate: () => boolean, description: string, timeoutMs = 30_000, debug?: () => unknown): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`等待超时：${description}${debug ? `\n${JSON.stringify(debug(), null, 2)}` : ''}`)
}

beforeAll(async () => { await store.initProjectDb() })
afterAll(() => {
  employees.stopAgentEmployeeHeartbeat()
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

test('Given真实混合批次（规格完成+评审通过+研发失败）When接替恢复 Then保留已验收步骤且只重跑失败步骤', async () => {
  installRunner()
  const f = await fixture()
  // 初始管理事件只是历史痕迹：本用例从已确认方案直接启动批次，不让它触发额外的安排调用。
  for (const event of managementStore.listPendingOwnerManagementEvents(f.project.id)) managementStore.consumeOwnerManagementEvent(event)
  const stopWake = scheduleEvents.onOwnerAutonomousScheduleWake(projectId => { if (projectId === f.project.id) void scheduler.runOwnerAutonomousSchedule(projectId) })
  const stopManagement = management.startOwnerManagementLoop()
  try {
    const materializationPreview = material.previewOwnerTaskMaterialization(f.subject, f.materializationInput)
    const grant = await executionLaunch.launchOwnerPreparedExecution(
      { ...f.subject, input: f.materializationInput, previewFingerprint: materializationPreview.previewFingerprint },
      { schedule: async () => {} },
    )
    await scheduler.runOwnerAutonomousSchedule(f.project.id)
    // 规格执行 + 独立评审 + Owner 验收；随后研发执行者失败，批次停在失败步骤。
    await until(() => {
      const commands = executionCommand.listOwnerExecutionCommands(f.subject)
      const delivery = commands.find(command => command.role === 'executor' && command.taskTitle === '实现页面')
      return commands.filter(command => command.taskTitle === '形成规格').every(command => command.state === 'settled')
        && Boolean(delivery && delivery.state === 'settled' && delivery.executionStatus === 'failed')
    }, '规格步骤验收完成且研发执行者失败', 30_000, () => ({
      businessCalls,
      commands: executionCommand.listOwnerExecutionCommands(f.subject).map(command => ({ title: command.taskTitle, role: command.role, state: command.state, executionStatus: command.executionStatus })),
      tasks: store.listTasks(f.project.id).map(task => ({ title: task.title, status: task.status })),
      schedule: scheduler.getOwnerAutonomousScheduleStatus(f.project.id),
      failures: store.listAgentExecutionsByProject(f.project.id).filter(item => item.status === 'failed').map(item => item.error),
    }))

    const commands = executionCommand.listOwnerExecutionCommands(f.subject)
    const brief = commands.filter(command => command.taskTitle === '形成规格')
    const delivery = commands.find(command => command.role === 'executor' && command.taskTitle === '实现页面')!

    // (a) 失败命令带可核对的终端证据，根因是 Provider 提前结束响应。
    expect(delivery.executionStatus).toBe('failed')
    expect(delivery.terminalEvidence).toBeDefined()
    expect(delivery.terminalEvidence!.reason).toBe('provider_stop')
    expect(delivery.terminalEvidence!.provider).toMatchObject({ subtype: 'error_during_execution', finishReason: 'other' })
    expect(delivery.terminalEvidence!.cost.state).toBe('settled')
    // 生产链路把 Runtime 消息归一化为 AgentMessage（正文是字符串、不含工具块），
    // 证据因此不虚构工具调用次数；归因由 Provider 字段承载，而不是倒果为因。
    expect(delivery.terminalEvidence!.tools).toMatchObject({ calls: 0, results: 0, incompleteBatch: false })

    // 规格步骤确实走完独立评审与 Owner 验收，而不是只跑了个执行者。
    expect(businessCalls.map(call => [call.taskTitle, call.role])).toEqual([
      ['形成规格', 'executor'], ['形成规格', 'reviewer'], ['实现页面', 'executor'],
    ])
    const briefReviewer = brief.find(command => command.role === 'reviewer')!
    expect(qualityActions.readOwnerQualityAction(briefReviewer.commandId)).toMatchObject({ state: 'accepted', taskId: briefReviewer.taskId })

    // (b) 评估接替：保留规格任务，只把失败的研发命令列为待重跑。
    const assessment = recovery.readMixedBatchAssessment(f.subject, grant.materializationId)
    expect(assessment.ok).toBe(true)
    if (!assessment.ok) throw new Error(assessment.blockers.join('；'))
    expect(assessment.retainedTaskIds).toEqual([briefReviewer.taskId])
    expect(assessment.failedCommandIds).toEqual([delivery.commandId])
    expect(assessment.supersededCommandIds.sort()).toEqual(commands.map(command => command.commandId).sort())

    const usageBefore = (await import('./project-owner-execution-settlement')).readOwnerGrantUsage(grant.grantId)

    // (c) 接替第一步：旧授权被安全暂停，方案与命令都没被删除或复制。
    // 先确认接替前授权仍是 active，证明后面暂停确实由接替动作完成，而不是本来就已暂停。
    expect(grantIssue.getOwnerExecutionGrant(f.subject)).toMatchObject({ grantId: grant.grantId, state: 'active' })
    const plan = recovery.planMixedBatchSupersession(f.subject, grant.materializationId)
    expect(plan).toMatchObject({ projectId: f.project.id, previousMaterializationId: grant.materializationId, previousGrantId: grant.grantId, retainedTaskIds: [briefReviewer.taskId], failedCommandIds: [delivery.commandId] })
    expect(grantIssue.getOwnerExecutionGrant(f.subject)).toMatchObject({ grantId: grant.grantId, state: 'paused' })
    // 撤权必须留下独立审计决定，不能只改状态。
    expect(store.getProjectDb().prepare("SELECT action, actor FROM project_owner_execution_grant_decisions WHERE grant_id=? AND action='revoke'").all(grant.grantId)).toEqual([{ action: 'revoke', actor: 'local-user' }])

    // (d) 旧命令与费用记录都还在，没有被接替动作清空或改写。
    const afterSupersession = executionCommand.listOwnerExecutionCommands(f.subject)
    expect(afterSupersession.map(command => command.commandId).sort()).toEqual(commands.map(command => command.commandId).sort())
    expect(afterSupersession.find(command => command.commandId === delivery.commandId)!.actualCostMicros).toBe(delivery.actualCostMicros)
    expect((await import('./project-owner-execution-settlement')).readOwnerGrantUsage(grant.grantId)).toEqual(usageBefore)

    // (e) 新批次材料化后写入关联记录，可完整读回。
    const nextMaterializationId = randomUUID()
    const record = recovery.recordMixedBatchSupersession(f.subject, plan, nextMaterializationId)
    expect(record).toMatchObject({ projectId: f.project.id, previousMaterializationId: grant.materializationId, previousGrantId: grant.grantId, nextMaterializationId, retainedTaskIds: [briefReviewer.taskId], failedCommandIds: [delivery.commandId] })
    expect(recovery.listMixedBatchSupersessions(f.project.id)).toEqual([record])
    // 未材料化的新批次标识必须拒绝，避免写出无法追溯的关联。
    expect(() => recovery.recordMixedBatchSupersession(f.subject, plan, 'pending:not-materialized')).toThrow('已材料化')
    // 关联记录不完整时不能静默返回：篡改 payload 必须报完整性错误。
    store.getProjectDb().prepare('UPDATE project_owner_execution_batch_supersessions SET payload=? WHERE id=?').run(JSON.stringify({ ...record, retainedTaskIds: [] }), record.id)
    expect(() => recovery.listMixedBatchSupersessions(f.project.id)).toThrow('完整性无效')
  } finally {
    await stopManagement()
    stopWake()
    const manager = managementStore.getOwnerManager(f.project.id)
    if (manager?.status === 'active') managementStore.setOwnerManagerStatus(f.project.id, manager.revision, 'paused')
  }
}, 90_000)

/**
 * 在已跑完失败步骤的批次上，按给定步骤再确认一版方案并准备新批次。
 * 版本号全部从当前状态推导，避免硬编码。
 */
async function prepareSupersedingBatch(
  f: Awaited<ReturnType<typeof fixture>>,
  steps: Array<{ key: string; title: string; outcome: string; acceptanceCriteria: string[]; dependencies: string[]; roleKey: string; deliveryKind?: 'text' | 'development' }>,
  changeReason: string,
) {
  const context = plans.getProjectOwnerPlanningContext(f.project.id)
  const plan = plans.getProjectOwnerPlanDraft(f.project.id)!
  const goal = goals.getProjectOwnerGoalDraft(f.project.id)!
  plans.saveProjectOwnerPlanDraft(f.project.id, goal.revision, plan.revision, {
    expectedContextFingerprint: context.fingerprint, summary: changeReason, assumptions: [], risks: [], steps, changeReason,
  })
  const confirmed = plans.confirmProjectOwnerPlanDraft(f.project.id, goal.revision, plan.revision + 1)
  const previousPreparation = prep.getOwnerExecutionPreparation(f.subject).preparation!
  const { getPilotPolicy } = await import('./project-pilot-policy')
  const preparationInput = {
    requestId: randomUUID(),
    expectedPreparationRevision: prep.getOwnerExecutionPreparation(f.subject).revision,
    // 策略 revision 必须以当前值为准；旧准备记录里的那个只说明当时。
    expectedPolicyRevision: getPilotPolicy(f.project.id)?.revision ?? null,
    expectedGoalRevision: goal.revision,
    expectedPlanRevision: confirmed.revision,
    selectedStepKeys: steps.map(step => step.key),
    executionKind: 'development' as const,
    developmentScope: previousPreparation.source.developmentScope ?? { workspaceId: f.workspace.id, targetPaths: ['index.html'], allowedPaths: ['index.html', 'README.md'], verificationCommands: ['git status'] },
    qualityManagementVersion: 1 as const, employeeRuntimeVersion: 2 as const,
    executorEmployeeId: f.executor.id, reviewerEmployeeId: f.reviewer.id,
    roleAssignments: [{ roleKey: previousPreparation.source.roleAssignments![0]!.roleKey, employeeId: f.executor.id }],
    workspaceId: f.workspace.id, knowledgeSourceIds: [],
    // 新批次授权不得晚于项目总预算期限，沿用旧准备的上界。
    maxCostMicros: 1_000_000, maxRuns: 8, maxRework: 1,
    expiresAt: Math.min(Date.now() + 3_600_000, previousPreparation.input.expiresAt), changeReason,
  }
  const prepPreview = prep.previewOwnerExecutionPreparation(f.subject, preparationInput)
  const preparation = prep.saveOwnerExecutionPreparation(f.subject, preparationInput, prepPreview.previewFingerprint)
  const materializationInput = {
    requestId: randomUUID(),
    expectedMaterializationRevision: material.getOwnerTaskMaterialization(f.subject).revision,
    expectedPreparationId: preparation.id, expectedPreparationRevision: preparation.revision,
    expectedPreparationHash: preparation.integrityHash, expectedPolicyRevision: preparation.policyRevision,
  }
  return { materializationInput, preview: material.previewOwnerTaskMaterialization(f.subject, materializationInput) }
}

const TWO_STEPS = (roleKey: string) => [
  { key: 'brief', title: '形成规格', outcome: '规格说明', acceptanceCriteria: ['范围明确'], dependencies: [] as string[], roleKey, deliveryKind: 'text' as const },
  { key: 'delivery', title: '实现页面', outcome: '可运行的页面', acceptanceCriteria: ['页面可打开'], dependencies: ['brief'], roleKey, deliveryKind: 'development' as const },
]

/** 等规格验收完成、研发步骤失败；返回规格任务。 */
async function untilBriefAccepted(f: Awaited<ReturnType<typeof fixture>>) {
  await until(() => {
    const commands = executionCommand.listOwnerExecutionCommands(f.subject)
    return commands.some(c => c.taskTitle === '形成规格' && c.role === 'reviewer' && c.state === 'settled')
      && commands.some(c => c.taskTitle === '实现页面' && c.state === 'settled' && c.executionStatus === 'failed')
  }, '规格验收完成且研发失败', 30_000, () => ({
    calls: businessCalls,
    commands: executionCommand.listOwnerExecutionCommands(f.subject)
      .map(c => ({ title: c.taskTitle, role: c.role, state: c.state, executionStatus: c.executionStatus })),
    schedule: scheduler.getOwnerAutonomousScheduleStatus(f.project.id),
  }))
  return store.listTasks(f.project.id).find(task => task.title === '形成规格')!
}

/**
 * 复用的完整验收：真实验收后新批次只重做失败步骤，
 * 且下游能拿到上游已验收正文、上游不产生新命令与费用预留。
 */
test('Given真实接替 When新批次材料化 Then只重做失败步骤且下游拿到已验收成果', async () => {
  installRunner()
  const f = await fixture()
  for (const event of managementStore.listPendingOwnerManagementEvents(f.project.id)) managementStore.consumeOwnerManagementEvent(event)
  const stopWake = scheduleEvents.onOwnerAutonomousScheduleWake(projectId => { if (projectId === f.project.id) void scheduler.runOwnerAutonomousSchedule(projectId) })
  const stopManagement = management.startOwnerManagementLoop()
  try {
    const preview = material.previewOwnerTaskMaterialization(f.subject, f.materializationInput)
    const grant = await executionLaunch.launchOwnerPreparedExecution(
      { ...f.subject, input: f.materializationInput, previewFingerprint: preview.previewFingerprint },
      { schedule: async () => {} },
    )
    await scheduler.runOwnerAutonomousSchedule(f.project.id)
    // 等规格步骤走完真实验收、研发步骤失败。
    await until(() => {
      const commands = executionCommand.listOwnerExecutionCommands(f.subject)
      return commands.some(c => c.taskTitle === '形成规格' && c.role === 'reviewer' && c.state === 'settled')
        && commands.some(c => c.taskTitle === '实现页面' && c.state === 'settled' && c.executionStatus === 'failed')
    }, '规格验收完成且研发失败')

    const briefTask = store.listTasks(f.project.id).find(task => task.title === '形成规格')!
    const commandsBefore = executionCommand.listOwnerExecutionCommands(f.subject)
    const briefCommandsBefore = commandsBefore.filter(c => c.taskId === briefTask.id)
    expect(briefCommandsBefore.length).toBeGreaterThan(0)

    // 生产路径：先经接替核对暂停旧授权，再为新批次重新准备。
    const plan0 = recovery.planMixedBatchSupersession(f.subject, grant.materializationId)
    expect(plan0.retainedTaskIds).toContain(briefTask.id)

    // 新方案仍列出两步（模拟模型重复规划），材料化应只保留失败步骤。
    const context = plans.getProjectOwnerPlanningContext(f.project.id)
    const plan = plans.getProjectOwnerPlanDraft(f.project.id)!
    const goal = goals.getProjectOwnerGoalDraft(f.project.id)!
    plans.saveProjectOwnerPlanDraft(f.project.id, goal.revision, plan.revision, {
      expectedContextFingerprint: context.fingerprint,
      summary: '接替失败步骤', assumptions: [], risks: [],
      steps: [
        { key: 'brief', title: '形成规格', outcome: '规格说明', acceptanceCriteria: ['范围明确'], dependencies: [], roleKey: context.sources.roles[0]!.key, deliveryKind: 'text' as const },
        { key: 'delivery', title: '实现页面', outcome: '可运行的页面', acceptanceCriteria: ['页面可打开'], dependencies: ['brief'], roleKey: context.sources.roles[0]!.key, deliveryKind: 'development' as const },
      ],
      changeReason: '接替失败步骤',
    })
    const confirmed = plans.confirmProjectOwnerPlanDraft(f.project.id, goal.revision, plan.revision + 1)
    const previousPreparation = prep.getOwnerExecutionPreparation(f.subject).preparation!
    const { getPilotPolicy } = await import('./project-pilot-policy')
    const preparationInput = {
      requestId: randomUUID(),
      expectedPreparationRevision: prep.getOwnerExecutionPreparation(f.subject).revision,
      // 策略 revision 必须以当前值为准；旧准备记录里的那个只说明当时。
      expectedPolicyRevision: getPilotPolicy(f.project.id)?.revision ?? null,
      expectedGoalRevision: goal.revision,
      expectedPlanRevision: confirmed.revision,
      selectedStepKeys: ['brief', 'delivery'],
      executionKind: 'development' as const,
      developmentScope: previousPreparation.source.developmentScope ?? { workspaceId: f.workspace.id, targetPaths: ['index.html'], allowedPaths: ['index.html', 'README.md'], verificationCommands: ['git status'] },
      qualityManagementVersion: 1 as const, employeeRuntimeVersion: 2 as const,
      executorEmployeeId: f.executor.id, reviewerEmployeeId: f.reviewer.id,
      roleAssignments: [{ roleKey: previousPreparation.source.roleAssignments![0]!.roleKey, employeeId: f.executor.id }],
      workspaceId: f.workspace.id, knowledgeSourceIds: [],
      maxCostMicros: 1_000_000, maxRuns: 8, maxRework: 1, expiresAt: Date.now() + 3_600_000, changeReason: '接替失败步骤',
    }
    const prepPreview = prep.previewOwnerExecutionPreparation(f.subject, preparationInput)
    const preparation = prep.saveOwnerExecutionPreparation(f.subject, preparationInput, prepPreview.previewFingerprint)
    const nextInput = {
      requestId: randomUUID(), expectedMaterializationRevision: 1,
      expectedPreparationId: preparation.id, expectedPreparationRevision: preparation.revision,
      expectedPreparationHash: preparation.integrityHash, expectedPolicyRevision: preparation.policyRevision,
    }
    const nextPreview = material.previewOwnerTaskMaterialization(f.subject, nextInput)

    // (a) 只为失败步骤建任务；已验收步骤进入复用清单并带真实成果哈希。
    expect(nextPreview.projections.map(item => item.stepKey)).toEqual(['delivery'])
    expect(nextPreview.retainedSteps).toHaveLength(1)
    expect(nextPreview.retainedSteps![0]).toMatchObject({ stepKey: 'brief', taskId: briefTask.id })
    const accepted = (await import('./project-owner-accepted-artifact')).readLatestAcceptedArtifact(f.project.id, briefTask.id)!
    expect(nextPreview.retainedSteps![0]!.artifactHash).toBe(accepted.artifactHash)
    // 下游依赖记录完整：delivery 依赖 brief 的已验收成果。
    expect(nextPreview.retainedSteps![0]!.dependedOnBy).toEqual(['delivery'])
    // 交接内容就是已验收正文，不是链接哈希。
    expect(accepted.content).toContain(BRIEF_QUOTE)

    material.materializeOwnerTasks(f.subject, nextInput, nextPreview.previewFingerprint)
    // (b) 上游任务与命令原样保留：没有新增命令，费用预留也没变。
    const briefCommandsAfter = executionCommand.listOwnerExecutionCommands(f.subject).filter(c => c.taskId === briefTask.id)
    const identity = (c: (typeof briefCommandsAfter)[number]) => `${c.commandId}:${c.role}:${c.reworkOrdinal}:${c.actualCostMicros}:${c.reservedCostMicros}`
    expect(briefCommandsAfter.map(identity).sort()).toEqual(briefCommandsBefore.map(identity).sort())
    expect(briefCommandsAfter).toHaveLength(briefCommandsBefore.length)
    // 旧任务仍归属旧 link，不被新批次改写。
    expect(store.getTask(briefTask.id)!.ownerStepLinkId).toBe(briefTask.ownerStepLinkId)
  } finally {
    await stopManagement()
    stopWake()
    const manager = managementStore.getOwnerManager(f.project.id)
    if (manager?.status === 'active') managementStore.setOwnerManagerStatus(f.project.id, manager.revision, 'paused')
  }
}, 90_000)

/**
 * 场景二：连续两次恢复。
 *
 * 第一次恢复后，最新一批记录只含当时失败的步骤；若复用判定只看最近一批，
 * 更早已验收的步骤会被重新派工。这里验证累积语义：两轮之后 A 仍然不被重做。
 */
test('Given连续两次恢复 When第二次材料化 Then更早已验收的步骤仍不复用重做', async () => {
  installRunner()
  const f = await fixture()
  for (const event of managementStore.listPendingOwnerManagementEvents(f.project.id)) managementStore.consumeOwnerManagementEvent(event)
  const stopWake = scheduleEvents.onOwnerAutonomousScheduleWake(projectId => { if (projectId === f.project.id) void scheduler.runOwnerAutonomousSchedule(projectId) })
  const stopManagement = management.startOwnerManagementLoop()
  try {
    const preview = material.previewOwnerTaskMaterialization(f.subject, f.materializationInput)
    const grant = await executionLaunch.launchOwnerPreparedExecution(
      { ...f.subject, input: f.materializationInput, previewFingerprint: preview.previewFingerprint },
      { schedule: async () => {} },
    )
    await scheduler.runOwnerAutonomousSchedule(f.project.id)
    const briefTask = await untilBriefAccepted(f)
    recovery.planMixedBatchSupersession(f.subject, grant.materializationId)

    // 第一次恢复：只重做 delivery。
    const first = await prepareSupersedingBatch(f, TWO_STEPS(f.preparationRoleKey), '第一次接替')
    expect(first.preview.retainedSteps?.map(step => step.stepKey)).toEqual(['brief'])
    material.materializeOwnerTasks(f.subject, first.materializationInput, first.preview.previewFingerprint)

    // 第二次恢复：新方案的 brief 仍在，但已验收成果必须继续沿用。
    const second = await prepareSupersedingBatch(f, TWO_STEPS(f.preparationRoleKey), '第二次接替')
    expect(second.preview.retainedSteps?.map(step => step.stepKey)).toEqual(['brief'])
    expect(second.preview.retainedSteps![0]).toMatchObject({ taskId: briefTask.id })
    // 仍指向最新一次验收，而不是第一次恢复时的过期记录。
    const latest = (await import('./project-owner-accepted-artifact'))
      .readLatestAcceptedArtifact(f.project.id, briefTask.id)!
    expect(second.preview.retainedSteps![0]!.artifactHash).toBe(latest.artifactHash)
  } finally {
    await stopManagement()
    stopWake()
    const manager = managementStore.getOwnerManager(f.project.id)
    if (manager?.status === 'active') managementStore.setOwnerManagerStatus(f.project.id, manager.revision, 'paused')
  }
}, 120_000)

/**
 * 场景三：新 B 实际收到旧 A 的正文。
 *
 * 只断言 retainedSteps 存在不足以证明交接真的发生——必须看 B 启动时的
 * 冻结提示里是否含 A 的已验收正文。
 */
test('Given接替批次 WhenB实际启动 Then提示里带A的已验收正文', async () => {
  installRunner()
  const f = await fixture()
  for (const event of managementStore.listPendingOwnerManagementEvents(f.project.id)) managementStore.consumeOwnerManagementEvent(event)
  const stopWake = scheduleEvents.onOwnerAutonomousScheduleWake(projectId => { if (projectId === f.project.id) void scheduler.runOwnerAutonomousSchedule(projectId) })
  const stopManagement = management.startOwnerManagementLoop()
  try {
    const preview = material.previewOwnerTaskMaterialization(f.subject, f.materializationInput)
    const grant = await executionLaunch.launchOwnerPreparedExecution(
      { ...f.subject, input: f.materializationInput, previewFingerprint: preview.previewFingerprint },
      { schedule: async () => {} },
    )
    await scheduler.runOwnerAutonomousSchedule(f.project.id)
    await untilBriefAccepted(f)
    recovery.planMixedBatchSupersession(f.subject, grant.materializationId)

    const next = await prepareSupersedingBatch(f, TWO_STEPS(f.preparationRoleKey), '接替失败步骤')
    const materialized = material.materializeOwnerTasks(f.subject, next.materializationInput, next.preview.previewFingerprint)
    const deliveryTaskId = materialized.links.find(link => link.stepKey === 'delivery')!.taskId

    // 走真实启动路径：新批次发行授权后由调度器派工，
    // B 的命令提示由 resolveUpstreamArtifactHandoffs 构造。
    await executionLaunch.launchOwnerPreparedExecution(
      { ...f.subject, input: next.materializationInput, previewFingerprint: next.preview.previewFingerprint },
      { schedule: async () => {} },
    )
    await scheduler.runOwnerAutonomousSchedule(f.project.id)
    await until(() => executionCommand.listOwnerExecutionCommands(f.subject)
      .some(c => c.taskId === deliveryTaskId && c.role === 'executor'), 'B 命令已排队')
    const commands = executionCommand.listOwnerExecutionCommands(f.subject)
    const deliveryCommand = commands.find(c => c.taskId === deliveryTaskId && c.role === 'executor')!
    expect(deliveryCommand).toBeDefined()
    const execution = store.getAgentExecution(deliveryCommand.executionId!)!
    // 交接块必须存在且含 A 的已验收正文。
    expect(execution.prompt).toContain('<untrusted-upstream-artifacts>')
    expect(execution.prompt).toContain(BRIEF_QUOTE)
  } finally {
    await stopManagement()
    stopWake()
    const manager = managementStore.getOwnerManager(f.project.id)
    if (manager?.status === 'active') managementStore.setOwnerManagerStatus(f.project.id, manager.revision, 'paused')
  }
}, 120_000)
