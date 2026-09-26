import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPilotGrantBudgetUsage, hashPilotTaskSource, reserveAndQueuePilotCommand } from './project-pilot-budget-ledger'
import { confirmPilotGrantPause, inspectPilotGrantPauseRecovery, previewPilotGrantPauseImpact } from './project-pilot-grant-pause'
import { savePilotPolicyDraft } from './project-pilot-policy'
import { evaluatePilotPolicyBindings } from './project-pilot-readiness'
import { insertPilotGrantFixture } from './project-pilot-test-helpers'
import { closeProjectDb, createAgentExecution, createProject, createTask, createTaskDependency, getAgentExecution,
  getProjectDb, getTask, initProjectDb, listAgentExecutionsByProject, updateTask } from './project-sqlite-store'
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
  expect(preflight.bindingsValid).toBe(true)
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
      sourceHash: hashPilotTaskSource(task), employeeId: role, role, reworkOrdinal: 0,
      reservedCostMicros: 600 }
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
      employeeId: 'executor', role: 'executor' as const, reworkOrdinal: 0, reservedCostMicros: 600 }
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


test('排队事务中断后重启无半成品，重试只生成一个命令与执行', async () => {
  const project = createProject({ title: 'G1 崩溃窗口样例', description: '' })
  const grantId = `grant-${project.id}`
  const task = createTask(project.id, { title: '可重试任务', description: '', workspaceId,
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  insertPilotGrantFixture({ grantId, projectId: project.id, workspaceId, channelId, modelId,
    maxCostMicros: 600, maxRuns: 1, maxRework: 0, expiresAt: now + 3_600_000, createdAt: now })
  const input = { commandId: `command-${project.id}`, projectId: project.id, grantId, idempotencyKey: 'first',
    taskId: task.id, sourceVersion: task.updatedAt, sourceHash: hashPilotTaskSource(task),
    employeeId: 'executor', role: 'executor' as const, reworkOrdinal: 0, reservedCostMicros: 600 }
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
