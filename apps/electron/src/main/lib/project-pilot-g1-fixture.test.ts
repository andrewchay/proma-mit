import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPilotGrantBudgetUsage, hashPilotTaskSource, reserveAndQueuePilotCommand } from './project-pilot-budget-ledger'
import { startPilotBackgroundReconcile } from './project-pilot-background-reconcile'
import { getCurrentPilotIntents } from './project-pilot-intent-store'
import { resolvePilotApproval, listPilotInbox } from './project-pilot-approval'
import { updateTask as updateTaskWithEvents } from './project-service'
import { confirmPilotGrantPause, inspectPilotGrantPauseRecovery, previewPilotGrantPauseImpact } from './project-pilot-grant-pause'
import { getActivePilotGrant } from './project-pilot-grant-issue'
import { savePilotPolicyDraft } from './project-pilot-policy'
import { evaluatePilotPolicyBindings } from './project-pilot-readiness'
import { insertPilotGrantFixture } from './project-pilot-test-helpers'
import { closeProjectDb, createAgentExecution, createProject, createTask, createTaskDependency, getAgentExecution,
  getProjectDb, getTask, initProjectDb, listAgentExecutionsByProject, createAgentEmployee,
  updateAgentExecution, updateTask } from './project-sqlite-store'
import type { AgentEmployee } from './project-types'

const root = mkdtempSync(join(tmpdir(), 'project-pilot-g1-git-'))
const repo = join(root, 'sample-repo')
const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const workspaceId = 'g1-isolated-git'
const channelId = 'g1-no-provider'
const modelId = 'g1-no-model-call'
const now = Date.now()

beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = root
  mkdirSync(repo)
  const initialized = Bun.spawnSync(['git', 'init', '--quiet', repo])
  if (initialized.exitCode !== 0) throw new Error(`G1 Git 样例项目创建失败: ${initialized.stderr.toString()}`)
  writeFileSync(join(repo, 'README.md'), '# Project Pilot G1 isolated fixture\n')
  await initProjectDb()
})
afterAll(() => {
  closeProjectDb()
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
  rmSync(root, { recursive: true, force: true })
})

async function waitForPilot(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return
    await Bun.sleep(20)
  }
  expect(predicate()).toBe(true)
}

const backgroundFixture = {
  inspectReadiness: (projectId: string) => ({ projectId, policyRevision: 1, bindingsValid: true, blockers: [] }),
  startExecution: async () => false,
  inspectGrantStatus: (projectId: string) => getActivePilotGrant(projectId) ? 'active' : 'paused',
}

function employee(id: 'executor' | 'reviewer'): AgentEmployee {
  return { id, name: id, role: id === 'executor' ? '执行' : '技术评审', description: '',
    runtime: 'proma', channelId, modelId, workspaceIds: [workspaceId], executionProfile: 'development',
    permissionMode: 'safe', enabled: true, totalTasks: 0, completedTasks: 0, failureCount: 0,
    createdAt: now, updatedAt: now }
}

test('隔离 Git 项目完成无模型的双角色命令、预算和暂停纵向切片', async () => {
  const project = createProject({ title: 'Project Pilot G1 隔离样例', description: '仅确定性验收，不调用模型' })
  const policy = savePilotPolicyDraft(project.id, { workspaceId, employeeIds: ['executor', 'reviewer'],
    executorEmployeeId: 'executor', reviewerEmployeeId: 'reviewer', channelId, modelId,
    maxCostMicros: 1_200, maxRuns: 2, maxRework: 1, expiresAt: now + 3_600_000 }, null)
  const preflight = evaluatePilotPolicyBindings(project.id, policy, { projectExists: true,
    workspace: { rootPath: repo }, gitMarkerExists: Bun.file(join(repo, '.git', 'HEAD')).size > 0,
    channel: { enabled: true, models: [{ id: modelId, enabled: true }] },
    employees: [employee('executor'), employee('reviewer')] }, now)
  expect(preflight.bindingsValid).toBe(false)
  expect(preflight.blockers).toEqual([
    '员工 executor 的 Runtime 不支持 Pilot 单次费用超额停止阈值',
    '员工 reviewer 的 Runtime 不支持 Pilot 单次费用超额停止阈值',
  ])
  expect(policy.state).toBe('paused')

  // 测试 grant 与已保存策略快照一致；本测试仍不调用模型或 Runtime。
  const grantId = `g1-grant-${project.id}`
  insertPilotGrantFixture({ grantId, projectId: project.id, workspaceId, channelId, modelId,
    maxCostMicros: 1_200, maxRuns: 2, maxRework: 1, expiresAt: policy.expiresAt, createdAt: now })
  const upstream = createTask(project.id, { title: '依赖任务', description: '' })
  const executionTask = createTask(project.id, { title: '实现样例变更', description: '', workspaceId,
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  createTaskDependency(executionTask.id, upstream.id)
  const command = (taskId: string, role: 'executor' | 'reviewer', ordinal: number) => {
    const task = getTask(taskId)!
    return { commandId: `g1-command-${project.id}-${ordinal}`, projectId: project.id, grantId,
      idempotencyKey: `g1-${role}-${ordinal}`, taskId, sourceVersion: task.updatedAt,
      sourceHash: hashPilotTaskSource(task), employeeId: role, role, reworkOrdinal: 0 }
  }
  expect(() => reserveAndQueuePilotCommand(command(executionTask.id, 'executor', 1),
    { executionId: `g1-execution-${project.id}`, prompt: '实现样例变更' })).toThrow('依赖尚未解除')
  updateTask(upstream.id, { status: 'completed' })
  const first = reserveAndQueuePilotCommand(command(executionTask.id, 'executor', 1),
    { executionId: `g1-execution-${project.id}`, prompt: '实现样例变更' })
  expect(first.execution.status).toBe('queued')
  expect(reserveAndQueuePilotCommand(command(executionTask.id, 'executor', 1),
    { executionId: first.execution.id, prompt: '实现样例变更' }).execution.id).toBe(first.execution.id)

  const reviewTask = createTask(project.id, { title: '技术评审样例', description: '', workspaceId,
    assignee: { userId: 'agent-reviewer', displayName: '技术评审员工' } })
  const second = reserveAndQueuePilotCommand(command(reviewTask.id, 'reviewer', 2),
    { executionId: `g1-review-${project.id}`, prompt: '评审样例变更' })
  expect(second.command.role).toBe('reviewer')
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 2, committedCostMicros: 1_200 })
  const thirdTask = createTask(project.id, { title: '超额任务', description: '', workspaceId,
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  expect(() => reserveAndQueuePilotCommand(command(thirdTask.id, 'executor', 3),
    { executionId: `g1-over-budget-${project.id}`, prompt: '不应派发' })).toThrow('执行次数额度已耗尽')
  updateTask(executionTask.id, { title: '来源已变化的任务' })
  expect(() => reserveAndQueuePilotCommand(first.command,
    { executionId: first.execution.id, prompt: '实现样例变更' })).toThrow('命令来源已变化')
  const ordinary = createAgentExecution({ id: `ordinary-${project.id}`, projectId: project.id,
    entityType: 'task', entityId: executionTask.id, agentId: 'executor', sessionId: '', prompt: '普通执行' })
  const impact = previewPilotGrantPauseImpact(grantId)
  expect(impact.queued.map((item) => item.executionId)).toEqual([first.execution.id, second.execution.id].sort())
  expect(confirmPilotGrantPause(impact, []).cancelledExecutionIds).toEqual(impact.queued.map((item) => item.executionId))
  expect(getAgentExecution(first.execution.id)?.status).toBe('cancelled')
  expect(getAgentExecution(second.execution.id)?.status).toBe('cancelled')
  expect(getAgentExecution(ordinary.id)?.status).toBe('queued')
  closeProjectDb()
  await initProjectDb()
  expect(inspectPilotGrantPauseRecovery(grantId)).toEqual({ state: 'queue_reconciled', pendingStopExecutionIds: [] })
  expect(() => reserveAndQueuePilotCommand(command(reviewTask.id, 'reviewer', 3),
    { executionId: `late-${project.id}`, prompt: '不应继续派发' })).toThrow('活动授权不存在或已失效')
})

test('A01/A02：固定隔离 Git 仓库无页面双并行派发，依赖事件后自动续派', async () => {
  expect(Bun.file(join(repo, '.git', 'HEAD')).size).toBeGreaterThan(0)
  const executor = createAgentEmployee({ name: 'G1 后台执行', role: '工程师', description: '',
    channelId, modelId, workspaceId, workspaceIds: [workspaceId], runtime: 'proma', executionProfile: 'development' })
  const reviewer = createAgentEmployee({ name: 'G1 后台评审', role: '技术评审', description: '',
    channelId, modelId, workspaceId, workspaceIds: [workspaceId], runtime: 'proma', executionProfile: 'development' })
  const project = createProject({ title: 'G1 无页面并行依赖', description: '同一隔离 Git 仓库的确定性事件链' })
  const grantId = `g1-grant-${project.id}`
  insertPilotGrantFixture({ grantId, projectId: project.id, workspaceId, channelId, modelId,
    executorEmployeeId: executor.id, reviewerEmployeeId: reviewer.id,
    maxCostMicros: 1_800, maxRuns: 3, maxRework: 0, expiresAt: now + 3_600_000, createdAt: now })
  const makeTask = (title: string) => createTask(project.id, { title, description: '仅入账，不触达模型', workspaceId,
    assignee: { userId: `agent-${executor.id}`, displayName: executor.name } })
  const upstream = makeTask('并行上游')
  const parallel = makeTask('独立并行')
  const downstream = makeTask('依赖上游')
  createTaskDependency(downstream.id, upstream.id)
  const pending = await getCurrentPilotIntents(project.id)
  expect(pending.find((item) => item.sourceId === downstream.id)?.kind).toBe('dependency_wait')
  const stop = startPilotBackgroundReconcile(backgroundFixture)
  try {
    await waitForPilot(() => (getProjectDb().prepare('SELECT count(*) AS n FROM pilot_commands WHERE project_id = ?')
      .get(project.id) as { n: number }).n === 2)
    const first = getProjectDb().prepare('SELECT source_task_id FROM pilot_commands WHERE project_id = ?')
      .all(project.id) as Array<{ source_task_id: string }>
    expect(new Set(first.map((item) => item.source_task_id))).toEqual(new Set([upstream.id, parallel.id]))
    expect(getPilotGrantBudgetUsage(grantId).runReservations).toBe(2)
    await updateTaskWithEvents(upstream.id, { status: 'completed' }, { source: 'system' })
    await waitForPilot(() => (getProjectDb().prepare('SELECT count(*) AS n FROM pilot_commands WHERE source_task_id = ?')
      .get(downstream.id) as { n: number }).n === 1)
    expect(getPilotGrantBudgetUsage(grantId).runReservations).toBe(3)
    expect(listAgentExecutionsByProject(project.id)).toHaveLength(3)
  } finally {
    stop()
  }
})

test('A04/A05：固定隔离 Git 仓库询问后旧版拒绝、批准自动续跑且重复答复不重放', async () => {
  const executor = createAgentEmployee({ name: 'G1 审批执行', role: '工程师', description: '',
    channelId, modelId, workspaceId, workspaceIds: [workspaceId], runtime: 'proma', executionProfile: 'development' })
  const reviewer = createAgentEmployee({ name: 'G1 审批评审', role: '技术评审', description: '',
    channelId, modelId, workspaceId, workspaceIds: [workspaceId], runtime: 'proma', executionProfile: 'development' })
  const project = createProject({ title: 'G1 审批续跑', description: '无 Provider 测试' })
  const grantId = `g1-grant-${project.id}`
  insertPilotGrantFixture({ grantId, projectId: project.id, workspaceId, channelId, modelId,
    executorEmployeeId: executor.id, reviewerEmployeeId: reviewer.id,
    maxCostMicros: 1_200, maxRuns: 2, maxRework: 0, expiresAt: now + 3_600_000, createdAt: now })
  const task = createTask(project.id, { title: '需要人工答复', description: '仅模拟执行结果', workspaceId,
    assignee: { userId: `agent-${executor.id}`, displayName: executor.name } })
  const stop = startPilotBackgroundReconcile(backgroundFixture)
  try {
    await waitForPilot(() => (getProjectDb().prepare('SELECT count(*) AS n FROM pilot_commands WHERE source_task_id = ?')
      .get(task.id) as { n: number }).n === 1)
    const command = getProjectDb().prepare('SELECT id, execution_id FROM pilot_commands WHERE source_task_id = ?')
      .get(task.id) as { id: string; execution_id: string }
    const summary = '【需要人工：提问】目标分支名称？'
    getProjectDb().prepare("UPDATE pilot_commands SET state = 'settled', actual_cost_micros = 30 WHERE id = ?").run(command.id)
    updateAgentExecution(command.execution_id, { status: 'completed', completedAt: Date.now(), resultSummary: summary })
    await updateTaskWithEvents(task.id, { status: 'paused', completionNotes: summary }, { source: 'system' })
    const stale = (await listPilotInbox(project.id)).find((item) => item.sourceType === 'approval')!
    expect(stale).toMatchObject({ taskId: task.id, sourceVersion: getTask(task.id)!.updatedAt })
    await updateTaskWithEvents(task.id, { description: '目标仍需确认' }, { source: 'system' })
    await expect(resolvePilotApproval(project.id, task.id, 'approved',
      { sourceVersion: stale.sourceVersion, note: 'main' })).rejects.toThrow('版本已失效')
    expect((getProjectDb().prepare('SELECT count(*) AS n FROM pilot_commands WHERE source_task_id = ?')
      .get(task.id) as { n: number }).n).toBe(1)
    const current = (await listPilotInbox(project.id)).find((item) => item.sourceType === 'approval')!
    await resolvePilotApproval(project.id, task.id, 'approved', { sourceVersion: current.sourceVersion, note: 'main' })
    await waitForPilot(() => (getProjectDb().prepare('SELECT count(*) AS n FROM pilot_commands WHERE source_task_id = ?')
      .get(task.id) as { n: number }).n === 2)
    await expect(resolvePilotApproval(project.id, task.id, 'approved',
      { sourceVersion: current.sourceVersion, note: '重复批准' })).rejects.toThrow('没有待答复')
    expect(getPilotGrantBudgetUsage(grantId).runReservations).toBe(2)
    expect((await getCurrentPilotIntents(project.id)).some((item) => item.kind === 'approval_request')).toBe(false)
  } finally {
    stop()
  }
})

test('两个隔离 Git 项目不能混用 grant、任务或工作区；暂停一方不撤销另一方', () => {
  const secondRepo = join(root, 'other-sample-repo')
  mkdirSync(secondRepo)
  const initialized = Bun.spawnSync(['git', 'init', '--quiet', secondRepo])
  if (initialized.exitCode !== 0) throw new Error('第二个 G1 Git 样例项目创建失败')
  const a = createProject({ title: '隔离 A', description: '' })
  const b = createProject({ title: '隔离 B', description: '' })
  const grantA = `grant-${a.id}`
  const grantB = `grant-${b.id}`
  const workspaceB = 'g1-isolated-git-b'
  const insertGrant = (grantId: string, projectId: string, workspace: string) => insertPilotGrantFixture({
    grantId, projectId, workspaceId: workspace, channelId, modelId, maxCostMicros: 600,
    maxRuns: 1, maxRework: 0, expiresAt: now + 3_600_000, createdAt: now,
  })
  insertGrant(grantA, a.id, workspaceId)
  insertGrant(grantB, b.id, workspaceB)
  const taskA = createTask(a.id, { title: '相近任务', description: '', workspaceId,
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  const taskB = createTask(b.id, { title: '相近任务', description: '', workspaceId: workspaceB,
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  const input = (projectId: string, grantId: string, taskId: string) => {
    const task = getTask(taskId)!
    return { commandId: `command-${projectId}`, projectId, grantId, idempotencyKey: 'first',
      taskId, sourceVersion: task.updatedAt, sourceHash: hashPilotTaskSource(task),
      employeeId: 'executor', role: 'executor' as const, reworkOrdinal: 0 }
  }
  expect(Bun.file(join(repo, '.git', 'HEAD')).size).toBeGreaterThan(0)
  expect(Bun.file(join(secondRepo, '.git', 'HEAD')).size).toBeGreaterThan(0)
  expect(() => reserveAndQueuePilotCommand(input(b.id, grantA, taskB.id),
    { executionId: `wrong-${b.id}`, prompt: '不得跨项目' })).toThrow('活动授权不存在或已失效')
  expect(() => reserveAndQueuePilotCommand(input(a.id, grantA, taskB.id),
    { executionId: `wrong-${a.id}`, prompt: '不得混用任务' })).toThrow('任务、项目、工作区或负责人不匹配')
  const wrongWorkspaceTask = createTask(a.id, { title: '错工作区', description: '', workspaceId: workspaceB,
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  expect(() => reserveAndQueuePilotCommand(input(a.id, grantA, wrongWorkspaceTask.id),
    { executionId: `wrong-workspace-${a.id}`, prompt: '不得混用工作区' }))
    .toThrow('任务、项目、工作区或负责人不匹配')
  const runA = reserveAndQueuePilotCommand(input(a.id, grantA, taskA.id),
    { executionId: `execution-${a.id}`, prompt: 'A 项目' })
  const runB = reserveAndQueuePilotCommand(input(b.id, grantB, taskB.id),
    { executionId: `execution-${b.id}`, prompt: 'B 项目' })
  confirmPilotGrantPause(previewPilotGrantPauseImpact(grantA), [])
  expect(getAgentExecution(runA.execution.id)?.status).toBe('cancelled')
  expect(getAgentExecution(runB.execution.id)?.status).toBe('queued')
})


test('A09a 局部：审批凭据写入失败并重开，任务未假批准且可安全重试', async () => {
  const executor = createAgentEmployee({ name: 'G1 崩溃审批执行', role: '工程师', description: '',
    channelId, modelId, workspaceId, workspaceIds: [workspaceId], runtime: 'proma', executionProfile: 'development' })
  const reviewer = createAgentEmployee({ name: 'G1 崩溃审批评审', role: '技术评审', description: '',
    channelId, modelId, workspaceId, workspaceIds: [workspaceId], runtime: 'proma', executionProfile: 'development' })
  const project = createProject({ title: 'G1 审批事务回滚', description: '' })
  const grantId = `grant-${project.id}`
  insertPilotGrantFixture({ grantId, projectId: project.id, workspaceId, channelId, modelId,
    executorEmployeeId: executor.id, reviewerEmployeeId: reviewer.id,
    maxCostMicros: 1_200, maxRuns: 2, maxRework: 0, expiresAt: now + 3_600_000, createdAt: now })
  const task = createTask(project.id, { title: '审批事务', description: '', workspaceId,
    assignee: { userId: `agent-${executor.id}`, displayName: executor.name } })
  const source = getTask(task.id)!
  const first = reserveAndQueuePilotCommand({ commandId: `command-${project.id}`, projectId: project.id, grantId,
    idempotencyKey: 'initial', taskId: task.id, sourceVersion: source.updatedAt, sourceHash: hashPilotTaskSource(source),
    employeeId: executor.id, role: 'executor', reworkOrdinal: 0 },
  { executionId: `execution-${project.id}`, prompt: '模拟完成请求' })
  const summary = '【需要人工：决策】是否继续？'
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'settled', actual_cost_micros = 30 WHERE id = ?").run(first.command.commandId)
  updateAgentExecution(first.execution.id, { status: 'completed', completedAt: Date.now(), resultSummary: summary })
  updateTask(task.id, { status: 'paused', completionNotes: summary })
  const version = getTask(task.id)!.updatedAt
  getProjectDb().exec(`CREATE TRIGGER pilot_g1_approval_abort BEFORE INSERT ON pilot_approval_resolutions
    WHEN NEW.task_id = '${task.id}' BEGIN SELECT RAISE(ABORT, 'approval fixture interrupted'); END`)
  await expect(resolvePilotApproval(project.id, task.id, 'approved', { sourceVersion: version, note: '继续' }))
    .rejects.toThrow('approval fixture interrupted')
  closeProjectDb()
  await initProjectDb()
  expect(getTask(task.id)).toMatchObject({ status: 'paused', updatedAt: version, completionNotes: summary })
  expect(getProjectDb().prepare('SELECT count(*) AS n FROM pilot_approval_resolutions WHERE task_id = ?').get(task.id))
    .toEqual({ n: 0 })
  getProjectDb().exec('DROP TRIGGER pilot_g1_approval_abort')
  await resolvePilotApproval(project.id, task.id, 'approved', { sourceVersion: version, note: '继续' })
  expect(getTask(task.id)?.status).toBe('pending')
  expect(getProjectDb().prepare('SELECT count(*) AS n FROM pilot_approval_resolutions WHERE task_id = ?').get(task.id))
    .toEqual({ n: 1 })
})

test('排队事务中断后重启无半成品，重试只生成一个命令与执行', async () => {
  const project = createProject({ title: 'G1 崩溃窗口样例', description: '' })
  const grantId = `grant-${project.id}`
  const task = createTask(project.id, { title: '可重试任务', description: '', workspaceId,
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  insertPilotGrantFixture({ grantId, projectId: project.id, workspaceId, channelId, modelId,
    maxCostMicros: 600, maxRuns: 1, maxRework: 0, expiresAt: now + 3_600_000, createdAt: now })
  const input = { commandId: `command-${project.id}`, projectId: project.id, grantId, idempotencyKey: 'first',
    taskId: task.id, sourceVersion: task.updatedAt, sourceHash: hashPilotTaskSource(task),
    employeeId: 'executor', role: 'executor' as const, reworkOrdinal: 0 }
  const queue = { executionId: `execution-${project.id}`, prompt: '可重试任务' }
  getProjectDb().exec(`CREATE TRIGGER pilot_g1_abort BEFORE INSERT ON pilot_command_links
    WHEN NEW.command_id = '${input.commandId}' BEGIN SELECT RAISE(ABORT, 'fixture interrupted'); END`)
  expect(() => reserveAndQueuePilotCommand(input, queue)).toThrow('fixture interrupted')
  closeProjectDb()
  await initProjectDb()
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 0, committedCostMicros: 0 })
  expect(listAgentExecutionsByProject(project.id)).toEqual([])
  getProjectDb().exec('DROP TRIGGER pilot_g1_abort')
  const first = reserveAndQueuePilotCommand(input, queue)
  closeProjectDb()
  await initProjectDb()
  expect(reserveAndQueuePilotCommand(input, queue).command).toEqual(first.command)
  expect(listAgentExecutionsByProject(project.id)).toHaveLength(1)
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1, committedCostMicros: 600 })
})
