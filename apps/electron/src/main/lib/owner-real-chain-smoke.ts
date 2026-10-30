/**
 * 真实链路受控冒烟：按模式运行准备、员工执行与独立评审；不等同产品验收。
 *
 * 约束：
 * - 只读取已配置渠道的真实凭据，模型费用由调用方在环境变量里设定硬上限；
 * - 分段模式不自动返工；project-2048 模式走真实 Owner 有界返工及交付；
 * - 输出只包含身份、状态、用量与脱敏后的错误，不写项目正文。
 */
import { randomUUID } from 'node:crypto'
import { ensureSmokeBudget, remainingSmokeBudget } from './owner-real-chain-smoke-budget'

export interface OwnerRealChainSmokeReport {
  files?: string[]
  sessionFiles?: string[]
  tools?: Record<string, number>
  gitStatus?: string[]
  validations?: Array<{ taskId: string; status: string; method: string }>
  browser?: { passed: boolean; checks: number; failures: string[] }
  projectId: string
  channelId: string
  modelId: string
  executionId?: string
  status: string
  artifactDirectory?: string
  ownerQualityState?: 'not_checked' | 'accepted' | 'rework_authorized' | 'escalated' | 'blocked'
  deliveryState?: 'not_checked' | 'delivered'
  checks?: Array<{ id: string; status: string; detail: string }>
  reworkCount?: number
  knownEmployeeCostMicros?: number
  error?: string
  resultExcerpt?: string
  usage?: Record<string, unknown>
  costMicros?: number | null
  requestsSent?: number
  reviewer?: { status: string; commandSettlement: string; recorded: boolean; verdict?: string; findings?: number; costMicros: number | null; requestsSent: number; error?: string }
  stage?: string
  ownerPlan?: { revision: number; steps: number; confirmed: boolean; generatedByOwner?: boolean }
  ownerAssignment?: { selectedSteps: number; assignments: number; reviewerChosen: boolean }
  totalRequestsSent?: number
  totalCostMicros?: number
}

const CHAIN_SMOKE_MAX_COST_MICROS = 1_400_000

export async function runOwnerRealChainSmoke(): Promise<OwnerRealChainSmokeReport | false> {
  const channelId = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_CHANNEL_ID
  if (!channelId) return false
  const modelId = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MODEL ?? 'glm-5.3-flash'
  ensureSmokeBudget(CHAIN_SMOKE_MAX_COST_MICROS)
  const availableCostMicros = remainingSmokeBudget(Number(process.env.GRAVITAS_OWNER_CHAIN_SMOKE_PRIOR_COST_MICROS ?? 0))

  const store = await import('./project-sqlite-store')
  await store.initProjectDb()
  const employees = await import('./agent-employee-service')
  const { createAgentWorkspace } = await import('./agent-workspace-manager')
  const { getChannelById } = await import('./channel-manager')
  const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
  const { saveProjectOwnerGoalDraft, getProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
  const { saveOwnerRuntimeBinding, getOwnerRuntimeBinding } = await import('./project-owner-runtime-binding')
  const management = await import('./project-owner-management-loop')
  const delegation = await import('./project-owner-management-delegation')
  const plans = await import('./project-owner-plan-service')
  const prep = await import('./project-owner-execution-preparation')
  const materialization = await import('./project-owner-task-materialization')
  const { launchOwnerPreparedExecution } = await import('./project-owner-execution-launch')

  const channel = getChannelById(channelId)
  if (!channel) throw new Error('真实链路冒烟的渠道不存在')

  const mode = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MODE ?? 'segment'
  const resumeProjectId = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RESUME_PROJECT_ID
  if (resumeProjectId) {
    const { owner2048SmokeGoal } = await import('./owner-2048-smoke-contract')
    const binding = getOwnerRuntimeBinding(resumeProjectId)
    const resumePlan = plans.getProjectOwnerPlanDraft(resumeProjectId)
    const delivered = resumePlan ? (await import('./project-owner-management-delivery')).hasCompleteOwnerManagementDelivery(resumeProjectId, undefined, resumePlan) : false
    const hasBlockingExecution = store.listAgentExecutionsByProject(resumeProjectId).some(item => {
      if (!['queued', 'running'].includes(item.status)) return false
      // 已交付恢复只读取并停止管理循环；崩溃遗留的旧规划/安排保持 unknown，既不取消也不重放。
      if (delivered && !item.ownerCommandId) return false
      return item.status === 'running' || !item.ownerCommandId || Boolean(item.sessionId)
        || Boolean(store.getProjectDb().prepare('SELECT 1 FROM project_owner_execution_start_attempts WHERE execution_id=?').get(item.id))
    })
    if (mode !== 'project-2048' || !store.getProject(resumeProjectId)
      || getProjectOwnerGoalDraft(resumeProjectId)?.goal.objective !== owner2048SmokeGoal().objective
      || binding?.channelId !== channelId || binding.modelId !== modelId || hasBlockingExecution) throw new Error('只能恢复同一隔离2048项目的已知静止状态')
    // 修复后的版本重新核验原始来源；不重写方案、请求账本或未知费用。
    const { readOwnerPlanningSnapshot } = await import('./project-owner-planning-source')
    for (const row of store.getProjectDb().prepare('SELECT planning_task_id FROM project_owner_planning_links WHERE project_id=?').all(resumeProjectId) as Array<{ planning_task_id: string }>) {
      if (!readOwnerPlanningSnapshot(row.planning_task_id, { allowUnknownPromptForHistory: true })) throw new Error('恢复项目的规划来源缺失')
    }
    if (process.env.GRAVITAS_OWNER_CHAIN_SMOKE_REPLAN_SINGLE_STEP === '1') {
      const goal = getProjectOwnerGoalDraft(resumeProjectId)!
      const previous = delegation.getOwnerManagementDelegation(resumeProjectId).delegation
      const marker = '本轮重整内部方案：只能生成1个实现交付步骤；独立评审、测试、返工与最终交付由系统后置流程处理，不得列成普通步骤。保留原历史，不沿用旧执行许可。'
      if (!previous || previous.expiresAt <= Date.now() || ![1, 2].includes(goal.revision)
        || goal.revision === 2 && !goal.goal.constraints.includes(marker)) throw new Error('本次单步收敛只能创建一次或恢复同一目标版本')
      const { owner2048SmokeGoal } = await import('./owner-2048-smoke-contract')
      const input = { ...owner2048SmokeGoal(), constraints: goal.goal.constraints }
      if (goal.revision === 1) saveProjectOwnerGoalDraft(resumeProjectId, goal.revision, { ...input, constraints: [...input.constraints, marker] })
      management.reconcileOwnerManagement(resumeProjectId)
      if (previous.goalRevision !== getProjectOwnerGoalDraft(resumeProjectId)!.revision) {
        delegation.revokeOwnerManagementDelegation(resumeProjectId, previous.id)
        const authorization = { projectId: resumeProjectId, requestId: randomUUID(), maxRequests: Number(process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS ?? 8), maxCostMicros: Math.min(previous.maxCostMicros, availableCostMicros),
          expiresAt: previous.expiresAt, autonomousExecution: true }
        const preview = delegation.previewOwnerManagementDelegation(authorization)
        delegation.confirmOwnerManagementDelegation({ input: authorization, previewHash: preview.previewHash })
      }
    }
    ;(await import('./project-owner-execution-stop')).recoverUnclaimedOwnerCommandPreparations()
    ;(await import('./project-owner-management-failures')).clearOwnerManagementFailure(resumeProjectId)
    const startIntentId = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RESUME_START_INTENT
    if (startIntentId) await (await import('./project-owner-execution-start-intent')).resumeOwnerExecutionStartIntent(startIntentId, { projectId: resumeProjectId })
    const failedOwnerExecutionId = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID
    const revalidationHash = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_REVALIDATE_ARTIFACT_HASH
    if (failedOwnerExecutionId) {
      const recovery = await import('./owner-quality-protocol-recovery-smoke')
      if (process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RENEW_EXPIRED === '1') recovery.renewExpiredOwnerQualityAuthorizationForSmoke(resumeProjectId, failedOwnerExecutionId)
      if (revalidationHash) recovery.authorizeOwnerQualityRevalidationFromFailedRun(resumeProjectId, failedOwnerExecutionId, revalidationHash)
      else recovery.resumeFailedOwnerQualityForSmoke(resumeProjectId, failedOwnerExecutionId)
    } else if (revalidationHash) throw new Error('Owner复验必须绑定准确的原失败Owner执行')
    const { runOwner2048ProjectSmoke, runOwner2048RevalidationSmoke } = await import('./owner-2048-project-smoke')
    if (revalidationHash && failedOwnerExecutionId) return runOwner2048RevalidationSmoke(resumeProjectId, channel.id, modelId, failedOwnerExecutionId, revalidationHash)
    return runOwner2048ProjectSmoke(resumeProjectId, channel.id, modelId)
  }
  const project = store.createProject({ title: mode === 'project-2048' ? '真实2048项目冒烟' : '真实链路冒烟', description: mode === 'project-2048' ? '目标、真实Owner规划派工、员工执行、独立评审与原项目交付的完整验收' : '受控真实执行，只验证员工执行这一段' })
  // 研发员工要求工作区绑定本地 Git 仓库；冒烟在临时目录里初始化一个空仓库。
  const seedPath = mode === 'project-2048' ? process.env.GRAVITAS_OWNER_CHAIN_SMOKE_SEED_INDEX_PATH : undefined
  const workspace = createAgentWorkspace(`owner-real-chain-${randomUUID()}`, ['development', 'project-2048'].includes(mode) ? initGitRoot(seedPath) : undefined)
  bindWorkspaceToProject(project.id, workspace.id)
  const employee = (name: string, role: string) => employees.createAgentEmployee({
    name, role, description: '', executionProfile: mode === 'project-2048' && name !== 'Smoke Owner' ? 'development' : 'controlled', permissionMode: 'safe',
    runtime: 'ai-sdk', channelId: channel.id, modelId, workspaceIds: [workspace.id],
  })
  const owner = employee('Smoke Owner', '项目管理者')
  const executor = employee('Smoke Executor', '研究')
  const reviewerEmployee = employee('Smoke Reviewer', '独立检查')

  const { owner2048SmokeGoal } = await import('./owner-2048-smoke-contract')
  saveProjectOwnerGoalDraft(project.id, 0, mode === 'project-2048' ? { ...owner2048SmokeGoal(), ...(seedPath ? { constraints: [...owner2048SmokeGoal().constraints, '项目已有上一尝试未修改的 index.html。初始化因缺失 overlay/overlay-text 元素而在 classList 调用处失败。让员工先读现有文件，只修复缺失元素及必要缺陷，不重写整个游戏，再按同一七项标准验证交付。'] } : {}) } : mode === 'development'
    ? { objective: '做出可在浏览器直接打开的 2048 网页，文件写在项目工作区' }
    : { objective: '产出一段可直接核验的需求说明' })
  saveOwnerRuntimeBinding(project.id, 0, { ownerName: 'Smoke Owner', carrierId: owner.id, workspaceId: workspace.id, changeReason: '真实链路冒烟' })
  management.reconcileOwnerManagement(project.id)

  // 执行授权不能晚于项目总预算授权；统一用同一时间基准。
  const expiresAt = Date.now() + 3600_000
  const delegationInput = { projectId: project.id, requestId: randomUUID(), maxRequests: mode === 'project-2048' ? Number(process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS ?? 8) : 2, maxCostMicros: availableCostMicros, expiresAt, autonomousExecution: true }
  const delegationPreview = delegation.previewOwnerManagementDelegation(delegationInput)
  delegation.confirmOwnerManagementDelegation({ input: delegationInput, previewHash: delegationPreview.previewHash })

  if (mode === 'project-2048') {
    const { runOwner2048ProjectSmoke } = await import('./owner-2048-project-smoke')
    return runOwner2048ProjectSmoke(project.id, channel.id, modelId)
  }
  if (mode === 'development') return runDevelopmentChain({ project, workspace, channel, modelId, plans, store, management, expiresAt })
  if (mode === 'full') {
    // 全链路：由真实 Owner 模型自己规划、自己安排，随后执行与评审。
    const loop = management.startOwnerManagementLoop()
    try {
      // 产品要求用户明确确认方案后才启动；冒烟以本机用户身份完成这一步，不伪造 Owner 自批。
      const proposed = await waitForOwnerPlanProposed(project.id, plans, store)
      if (!proposed) throw new Error(`Owner 规划未在期限内产出方案：${diagnoseOwnerRun(project.id, store, plans)}`)
      if (proposed.state !== 'confirmed') plans.confirmProjectOwnerPlanDraft(project.id, proposed.goalRevision, proposed.revision)
      const confirmed = await waitForOwnerPlanConfirmed(project.id, plans, store)
      if (!confirmed) throw new Error(`方案确认未生效：${diagnoseOwnerRun(project.id, store, plans)}`)
      const execution = await waitForExecutorTerminal(project.id, store)
      const reviewer = await driveReviewer(project.id, store)
      const stages = summarizeOwnerRun(project.id, store, plans)
      return { projectId: project.id, channelId: channel.id, modelId, stage: 'full', ...stages,
        executionId: execution?.id, status: execution?.status ?? 'unknown',
        ...(execution?.error ? { error: execution.error.slice(0, 400) } : {}),
        ...(execution?.resultSummary ? { resultExcerpt: execution.resultSummary.slice(0, 300) } : {}),
        reviewer: reviewer.report }
    } finally { await loop() }
  }
  const context = plans.getProjectOwnerPlanningContext(project.id)
  const steps = [{ key: 'brief', title: '整理需求说明', outcome: '一段可核验的需求说明', acceptanceCriteria: ['说明核心操作'], dependencies: [] as string[], roleKey: context.sources.roles[0]!.key }]
  plans.saveProjectOwnerPlanDraft(project.id, 1, 0, { expectedContextFingerprint: context.fingerprint, summary: '最小真实链路', assumptions: [], risks: [], steps, changeReason: '冒烟' })
  plans.confirmProjectOwnerPlanDraft(project.id, 1, 1)

  const subject = { projectId: project.id }
  const preparationInput = {
    requestId: randomUUID(), expectedPreparationRevision: 0, expectedPolicyRevision: null, expectedGoalRevision: 1, expectedPlanRevision: 2,
    selectedStepKeys: ['brief'], executionKind: 'controlled' as const, textDeliveryVersion: 1 as const,
    executorEmployeeId: executor.id, reviewerEmployeeId: reviewerEmployee.id,
    roleAssignments: [{ roleKey: steps[0]!.roleKey, employeeId: executor.id }],
    workspaceId: workspace.id, knowledgeSourceIds: [],
    maxCostMicros: 400_000, maxRuns: 2, maxRework: 0, expiresAt: expiresAt - 60_000, changeReason: '冒烟',
  }
  const preparationPreview = prep.previewOwnerExecutionPreparation(subject, preparationInput)
  const preparation = prep.saveOwnerExecutionPreparation(subject, preparationInput, preparationPreview.previewFingerprint)
  const materializationInput = { requestId: randomUUID(), expectedMaterializationRevision: 0, expectedPreparationId: preparation.id, expectedPreparationRevision: preparation.revision, expectedPreparationHash: preparation.integrityHash, expectedPolicyRevision: preparation.policyRevision }
  const materializationPreview = materialization.previewOwnerTaskMaterialization(subject, materializationInput)
  await launchOwnerPreparedExecution({ ...subject, input: materializationInput, previewFingerprint: materializationPreview.previewFingerprint })

  const execution = await waitForExecutorTerminal(project.id, store)
  const command = store.getProjectDb().prepare('SELECT id, state, actual_cost_micros, reserved_cost_micros FROM project_owner_execution_commands WHERE project_id=? ORDER BY rowid DESC LIMIT 1').get(project.id) as { id: string; state: string; actual_cost_micros: number | null; reserved_cost_micros: number } | undefined
  const requestsSent = command
    ? (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations WHERE command_id=?').get(command.id) as { count: number }).count
    : 0

  // 独立评审：只由自主调度按权威任务链排队一次，不重试、不返工。
  const reviewRun = await driveReviewer(project.id, store)
  return {
    projectId: project.id, channelId: channel.id, modelId, executionId: execution?.id,
    status: execution?.status ?? command?.state ?? 'unknown',
    ...(execution?.error ? { error: execution.error.slice(0, 400) } : {}),
    ...(execution?.resultSummary ? { resultExcerpt: execution.resultSummary.slice(0, 300) } : {}),
    costMicros: command?.actual_cost_micros ?? null,
    requestsSent,
    reviewer: reviewRun.report,
    totalRequestsSent: requestsSent + reviewRun.report.requestsSent,
    totalCostMicros: (command?.actual_cost_micros ?? 0) + (reviewRun.report.costMicros ?? 0),
  }
}

async function waitForExecutorTerminal(projectId: string, store: typeof import('./project-sqlite-store'), timeoutMs = 300_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    // 只认业务命令执行（ownerCommandId 非空），不把 Owner 自己的规划/安排执行当成员工执行。
    const execution = store.listAgentExecutionsByProject(projectId).find(item => item.ownerCommandId && ['completed', 'failed', 'cancelled', 'stale'].includes(item.status))
    if (execution) return execution
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  return undefined
}

async function driveReviewer(projectId: string, store: typeof import('./project-sqlite-store')) {
  const scheduler = await import('./project-owner-autonomous-scheduler')
  const reviews = await import('./project-owner-technical-review')
  for (let round = 0; round < 30; round++) {
    const status = await scheduler.runOwnerAutonomousSchedule(projectId)
    // 调度在无更多可派发动作时回到 waiting/paused/ready 以外的稳定态；这里只等评审执行到终态。
    const reviewerDone = store.listAgentExecutionsByProject(projectId).some(item => item.ownerCommandId && ['completed', 'failed', 'cancelled', 'stale'].includes(item.status) && item.status !== 'completed')
    if (status.state === 'paused' || status.state === 'needs_reconcile' || status.state === 'expired' || reviewerDone) break
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  const commands = store.getProjectDb().prepare("SELECT id, state, actual_cost_micros FROM project_owner_execution_commands WHERE project_id=? AND role='reviewer' ORDER BY rowid DESC LIMIT 1").get(projectId) as { id: string; state: string; actual_cost_micros: number | null } | undefined
  if (!commands) return { report: { status: 'not_dispatched', commandSettlement: 'not_dispatched', recorded: false, costMicros: null, requestsSent: 0 } }
  const reviewerExecution = store.listAgentExecutionsByProject(projectId).find(item => item.ownerCommandId === commands.id)
  const evidence = reviews.listOwnerTechnicalReviewEvidence(projectId).find(item => item.reviewerExecutionId === reviewerExecution?.id)
  const requestsSent = (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations WHERE command_id=?').get(commands.id) as { count: number }).count
  return { report: {
    status: reviewerExecution?.status ?? commands.state,
    commandSettlement: commands.state,
    recorded: Boolean(evidence),
    ...(evidence?.verdict ? { verdict: evidence.verdict } : {}),
    ...(evidence?.findings ? { findings: evidence.findings.length } : {}),
    costMicros: commands.actual_cost_micros,
    requestsSent,
    ...(reviewerExecution?.error ? { error: reviewerExecution.error.slice(0, 300) } : {}),
  } }
}

async function waitForOwnerPlanConfirmed(projectId: string, plans: typeof import('./project-owner-plan-service'), store: typeof import('./project-sqlite-store'), timeoutMs = 240_000) {
  const started = Date.now()
  let polls = 0
  while (Date.now() - started < timeoutMs) {
    const plan = plans.getProjectOwnerPlanDraft(projectId)
    if (plan?.state === 'confirmed') return plan
    if (polls++ % 5 === 0) console.log(`[owner-real-chain] 等待方案确认 state=${plan?.state ?? 'none'} elapsed=${Math.round((Date.now() - started) / 1000)}s ${diagnoseOwnerRun(projectId, store, plans)}`)
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  return undefined
}

/** 只输出本地事实，便于判断卡在规划、确认还是安排。 */
function diagnoseOwnerRun(projectId: string, store: typeof import('./project-sqlite-store'), plans: typeof import('./project-owner-plan-service')): string {
  const plan = plans.getProjectOwnerPlanDraft(projectId)
  const executionIds = new Set(store.listAgentExecutionsByProject(projectId).map(item => item.id))
  const outcomes = (store.getProjectDb().prepare('SELECT payload FROM project_owner_planning_run_outcomes ORDER BY rowid DESC LIMIT 50').all() as Array<{ payload: string }>)
    .filter(row => executionIds.has((JSON.parse(row.payload) as { executionId?: string }).executionId ?? ''))
    .slice(0, 3)
  const messages = store.getProjectDb().prepare('SELECT payload FROM project_owner_management_messages WHERE project_id=? ORDER BY rowid DESC LIMIT 2').all(projectId) as Array<{ payload: string }>
  const pending = (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_management_events WHERE project_id=? AND consumed_at IS NULL').get(projectId) as { count: number }).count
  return JSON.stringify({
    planState: plan?.state ?? null, planRevision: plan?.revision ?? null, pending,
    outcomes: outcomes.map(row => (JSON.parse(row.payload) as { state?: string; detail?: string }).state ?? ''),
    lastMessages: messages.map(row => (JSON.parse(row.payload) as { content?: string }).content?.slice(0, 120) ?? ''),
  })
}

function summarizeOwnerRun(projectId: string, store: typeof import('./project-sqlite-store'), plans: typeof import('./project-owner-plan-service')) {
  const plan = plans.getProjectOwnerPlanDraft(projectId)
  const executionIds = new Set(store.listAgentExecutionsByProject(projectId).map(item => item.id))
  const outcome = (store.getProjectDb().prepare('SELECT payload FROM project_owner_planning_run_outcomes ORDER BY rowid DESC LIMIT 50').all() as Array<{ payload: string }>)
    .filter(row => executionIds.has((JSON.parse(row.payload) as { executionId?: string }).executionId ?? ''))[0]
  const parsed = outcome ? JSON.parse(outcome.payload) as { assignmentProposal?: { assignments?: unknown[]; selectedStepKeys?: string[]; reviewerEmployeeId?: string } } : {}
  return {
    ownerPlan: plan ? { revision: plan.revision, steps: plan.proposal.steps.length, confirmed: plan.state === 'confirmed' } : undefined,
    ownerAssignment: parsed.assignmentProposal ? {
      selectedSteps: parsed.assignmentProposal.selectedStepKeys?.length ?? 0,
      assignments: parsed.assignmentProposal.assignments?.length ?? 0,
      reviewerChosen: Boolean(parsed.assignmentProposal.reviewerEmployeeId),
    } : undefined,
  }
}

async function waitForOwnerPlanProposed(projectId: string, plans: typeof import('./project-owner-plan-service'), store: typeof import('./project-sqlite-store'), timeoutMs = 240_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const plan = plans.getProjectOwnerPlanDraft(projectId)
    if (plan && (plan.state === 'proposed' || plan.state === 'confirmed')) return plan
    if (Math.round((Date.now() - started) % 10000) < 2000) console.log(`[owner-real-chain] 等待方案产出 state=${plan?.state ?? 'none'} ${diagnoseOwnerRun(projectId, store, plans)}`)
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  return undefined
}

/** 开发型链路：员工真的写文件，随后用隐藏浏览器核对页面，再进入独立评审。 */
async function runDevelopmentChain(input: {
  project: { id: string }
  workspace: { id: string; slug: string }
  channel: { id: string }
  modelId: string
  plans: typeof import('./project-owner-plan-service')
  store: typeof import('./project-sqlite-store')
  management: typeof import('./project-owner-management-loop')
  expiresAt: number
}): Promise<OwnerRealChainSmokeReport> {
  const { project, workspace, plans, store, management, modelId } = input
  const employees = await import('./agent-employee-service')
  const { getAgentWorkspace, getAgentWorkspaceCwd } = await import('./agent-workspace-manager')
  const { runOwnerRuntimeBrowserAssertions } = await import('./owner-runtime-browser-verifier')

  const employee = (name: string, role: string) => employees.createAgentEmployee({
    name, role, description: '', executionProfile: 'development', permissionMode: 'auto',
    runtime: 'ai-sdk', channelId: input.channel.id, modelId, workspaceIds: [workspace.id],
  })
  const executor = employee('Dev Executor', '前端实现')
  const reviewer = employee('Dev Reviewer', '独立检查')
  management.reconcileOwnerManagement(project.id)

  // 复用公共段已确认的管理授权，不重复确认（重复确认会要求先撤销）。

  const context = plans.getProjectOwnerPlanningContext(project.id)
  const steps = [{ key: 'page', title: '实现 2048 网页', outcome: '工作区内的 index.html 可直接打开并游玩', acceptanceCriteria: ['方向键移动与合并', '分数与结束判定可见'], dependencies: [] as string[], roleKey: context.sources.roles[0]!.key }]
  plans.saveProjectOwnerPlanDraft(project.id, 1, 0, { expectedContextFingerprint: context.fingerprint, summary: '开发最小 2048', assumptions: [], risks: [], steps, changeReason: '冒烟' })
  plans.confirmProjectOwnerPlanDraft(project.id, 1, 1)

  const prep = await import('./project-owner-execution-preparation')
  const materialization = await import('./project-owner-task-materialization')
  const { launchOwnerPreparedExecution } = await import('./project-owner-execution-launch')
  const subject = { projectId: project.id }
  const preparationInput = {
    requestId: randomUUID(), expectedPreparationRevision: 0, expectedPolicyRevision: null, expectedGoalRevision: 1, expectedPlanRevision: 2,
    selectedStepKeys: ['page'], executionKind: 'development' as const,
    developmentScope: { workspaceId: workspace.id, targetPaths: ['index.html'], allowedPaths: ['index.html', 'styles.css', 'game.js'], verificationCommands: ['browser:html.loads+dom.board+dom.initial-tiles+behavior.merge+storage.best-score+dom.restart'] },
    executorEmployeeId: executor.id, reviewerEmployeeId: reviewer.id,
    roleAssignments: [{ roleKey: steps[0]!.roleKey, employeeId: executor.id }],
    workspaceId: workspace.id, knowledgeSourceIds: [],
    maxCostMicros: 600_000, maxRuns: 2, maxRework: 0, expiresAt: input.expiresAt - 60_000, changeReason: '冒烟',
  }
  const preparationPreview = prep.previewOwnerExecutionPreparation(subject, preparationInput)
  const preparation = prep.saveOwnerExecutionPreparation(subject, preparationInput, preparationPreview.previewFingerprint)
  const materializationInput = { requestId: randomUUID(), expectedMaterializationRevision: 0, expectedPreparationId: preparation.id, expectedPreparationRevision: preparation.revision, expectedPreparationHash: preparation.integrityHash, expectedPolicyRevision: preparation.policyRevision }
  const materializationPreview = materialization.previewOwnerTaskMaterialization(subject, materializationInput)
  await launchOwnerPreparedExecution({ ...subject, input: materializationInput, previewFingerprint: materializationPreview.previewFingerprint })

  const execution = await waitForExecutorTerminal(project.id, store)
  const workspaceRootPath = getAgentWorkspace(workspace.id)?.rootPath ?? ''
  // 研发会话在独立 git worktree 里工作；成果与仓库状态都要看这个目录。
  const sessionCwd = execution?.sessionId && getAgentWorkspace(workspace.id) ? getAgentWorkspaceCwd(getAgentWorkspace(workspace.id)!, execution.sessionId) : ''
  const workingRoot = sessionCwd || workspaceRootPath
  const files = listWorkspaceFiles(workingRoot).slice(0, 20)
  const sessionFiles = sessionCwd ? listWorkspaceFiles(sessionCwd).slice(0, 20) : []
  const tools = summarizeSessionTools(execution?.sessionId)
  const gitStatus = readGitStatus(workingRoot).slice(0, 10)
  const page = files.find(file => /(^|\/)index\.html$/.test(file))
  let browser: OwnerRealChainSmokeReport['browser']
  if (page) {
    try {
      const run = await runOwnerRuntimeBrowserAssertions({ workspaceRoot: workingRoot, relativePath: page, intents: ['页面可加载', '棋盘可见'], timeoutMs: 20_000 })
      const checks = run.checks ?? []
      browser = { passed: !run.timedOut && checks.length > 0 && checks.every(item => item.status === 'passed'), checks: checks.length, failures: checks.filter(item => item.status !== 'passed').map(item => `${item.id}: ${item.detail}`.slice(0, 160)) }
    } catch (cause) {
      browser = { passed: false, checks: 0, failures: [String(cause).slice(0, 200)] }
    }
  }
  const reviewRun = await driveReviewer(project.id, store)
  return {
    projectId: project.id, channelId: input.channel.id, modelId, stage: 'development',
    status: execution?.status ?? 'unknown', ...(execution?.error ? { error: execution.error.slice(0, 400) } : {}),
    ...(execution?.resultSummary ? { resultExcerpt: execution.resultSummary.slice(0, 300) } : {}),
    files, sessionFiles, tools, gitStatus, artifactDirectory: workingRoot,
    ownerQualityState: 'not_checked', deliveryState: 'not_checked',
    validations: listDevelopmentValidations(store, project.id), ...(browser ? { browser } : {}), reviewer: reviewRun.report,
  }
}

/** 只列文件名与相对路径，不读取内容。 */
function listWorkspaceFiles(root: string, prefix = ''): string[] {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
  const seen: string[] = []
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = `${root}/${entry.name}`
      if (entry.isDirectory()) seen.push(...listWorkspaceFiles(full, relative))
      else if (statSync(full).isFile()) seen.push(relative)
      if (seen.length >= 60) break
    }
  } catch { /* 工作区不存在时返回已收集结果 */ }
  return seen
}

/** 建一个临时 Git 仓库作为开发工作区根目录；只用于冒烟。 */
function initGitRoot(seedPath?: string): string {
  const { mkdtempSync, realpathSync, lstatSync, readFileSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
  // macOS 的 /var 是指向 /private/var 的符号链接；统一用真实路径，避免 git 顶层路径不一致。
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'owner-dev-root-')))
  execFileSync('git', ['init', '-q', root])
  if (seedPath) {
    const stat = lstatSync(seedPath), bytes = readFileSync(seedPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 || !process.env.GRAVITAS_OWNER_CHAIN_SMOKE_SEED_SHA256
      || (require('node:crypto') as typeof import('node:crypto')).createHash('sha256').update(bytes).digest('hex') !== process.env.GRAVITAS_OWNER_CHAIN_SMOKE_SEED_SHA256) throw new Error('失败源码基线文件或摘要无法核验')
    writeFileSync(join(root, 'index.html'), bytes, { flag: 'wx' })
    execFileSync('git', ['-C', root, 'add', '--', 'index.html'])
  }
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-q', '-m', seedPath ? 'seed unchanged failed 2048 artifact' : 'init'])
  return root
}

/** 只统计工具名与次数，不读取参数或正文。 */
function summarizeSessionTools(sessionId: string | undefined): Record<string, number> {
  if (!sessionId) return {}
  const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const { getConfigDir } = require('./config-paths') as typeof import('./config-paths')
  const file = join(getConfigDir(), 'agent-sessions', `${sessionId}.jsonl`)
  if (!existsSync(file)) return {}
  const counts: Record<string, number> = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const message = JSON.parse(line) as { message?: { content?: Array<{ type?: string; name?: string }> } }
      for (const block of message.message?.content ?? []) {
        if (block.type !== 'tool_use' || !block.name) continue
        counts[block.name] = (counts[block.name] ?? 0) + 1
      }
    } catch { /* 单行损坏不影响统计 */ }
  }
  return counts
}

function readGitStatus(root: string): string[] {
  if (!root) return []
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
  try {
    return execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', timeout: 5000 }).split('\n').filter(Boolean)
  } catch { return [] }
}

/** 只汇报开发验证记录的身份与状态，不复制输出正文。 */
function listDevelopmentValidations(store: typeof import('./project-sqlite-store'), projectId: string): Array<{ taskId: string; status: string; method: string }> {
  const service = require('./development-validation-service') as typeof import('./development-validation-service')
  const rows: Array<{ taskId: string; status: string; method: string }> = []
  for (const task of store.listTasks(projectId)) {
    try {
      for (const item of service.listDevelopmentValidations(task.id).slice(0, 2)) {
        rows.push({ taskId: task.id, status: item.status, method: item.method ?? 'unknown' })
      }
    } catch { /* 没有验证记录时忽略 */ }
  }
  return rows.slice(0, 5)
}
