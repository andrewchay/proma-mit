import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeProjectDb, createAgentExecution, createProject, createTask, createTaskDependency, deleteProject, getProjectDb, getTask, initProjectDb, listAgentExecutionsByProject, updateAgentExecution, updateTask } from './project-sqlite-store'
import { assertPilotCommandStartRecord, getPilotGrantBudgetUsage, hashPilotTaskSource, reserveAndQueuePilotCommand, reservePilotCommandBudget, settlePilotCommandCost, type PilotCommandReservationInput } from './project-pilot-budget-ledger'
import { insertPilotGrantFixture } from './project-pilot-test-helpers'

const dir = mkdtempSync(join(tmpdir(), 'pilot-budget-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = dir; await initProjectDb() })
afterAll(() => {
  closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(dir, { recursive: true, force: true })
})

function fixture(state: 'paused' | 'active' = 'active', maxCostMicros = 1_000, maxRuns = 2) {
  const project = createProject({ title: '预算项目', description: '' })
  const task = createTask(project.id, { title: '研发任务', description: '', workspaceId: 'workspace-a',
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  const grantId = `grant-${project.id}`
  const now = Date.now()
  insertPilotGrantFixture({ grantId, projectId: project.id, state, workspaceId: 'workspace-a',
    channelId: 'channel-a', modelId: 'model-a', maxCostMicros, maxRuns, maxRework: 1,
    expiresAt: now + 100_000, createdAt: now })
  const input: PilotCommandReservationInput = {
    commandId: `command-${project.id}`, projectId: project.id, grantId, idempotencyKey: 'task-first-execution',
    taskId: task.id, sourceVersion: task.updatedAt, sourceHash: hashPilotTaskSource(task),
    employeeId: 'executor', role: 'executor', reworkOrdinal: 0, reservedCostMicros: 600,
  }
  return { project, task, grantId, input }
}

test('暂停授权、未知费用与无授权都不能预留或创建执行', () => {
  const { project, grantId, input } = fixture('paused')
  expect(() => reservePilotCommandBudget(input)).toThrow('活动授权不存在或已失效')
  expect(() => reservePilotCommandBudget({ ...input, reservedCostMicros: 0 })).toThrow('费用未知')
  expect(() => reservePilotCommandBudget({ ...input, grantId: 'missing' })).toThrow('活动授权不存在或已失效')
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 0, committedCostMicros: 0 })
  expect(listAgentExecutionsByProject(project.id)).toEqual([])
  const active = fixture('active')
  expect(() => reservePilotCommandBudget(active.input, Date.now() + 200_000)).toThrow('活动授权不存在或已失效')
  expect(() => reservePilotCommandBudget(active.input, Number.NaN)).toThrow('时钟无效')
  expect(() => reservePilotCommandBudget(active.input, -1)).toThrow('时钟无效')
})

test('同一命令幂等预留一次；不同键不能绕过未结命令保护', () => {
  const { project, grantId, input } = fixture('active', 1_000, 2)
  const first = reservePilotCommandBudget(input)
  expect(reservePilotCommandBudget(input)).toEqual(first)
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1, committedCostMicros: 600 })
  expect(() => reservePilotCommandBudget({ ...input, commandId: 'changed', reservedCostMicros: 500 })).toThrow('幂等键已对应其他内容')
  expect(() => reservePilotCommandBudget({ ...input, commandId: 'second', idempotencyKey: 'other', reservedCostMicros: 500 }))
    .toThrow('任务已有未结命令')
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'needs_reconcile' WHERE id = ?").run(input.commandId)
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1, committedCostMicros: 600 })
  expect(listAgentExecutionsByProject(project.id)).toEqual([])
})

test('跨项目、错角色、旧来源和未解除依赖在事务内拒绝，预算保持不变', () => {
  const { project, task, grantId, input } = fixture()
  const other = createProject({ title: '其他项目', description: '' })
  expect(() => reservePilotCommandBudget({ ...input, projectId: other.id })).toThrow('活动授权不存在或已失效')
  expect(() => reservePilotCommandBudget({ ...input, employeeId: 'reviewer' })).toThrow('命令员工不在授权角色内')
  updateTask(task.id, { title: '改过的任务' })
  expect(() => reservePilotCommandBudget(input)).toThrow('来源版本已变化')
  const currentTask = getTask(task.id)!
  const upstream = createTask(project.id, { title: '上游任务', description: '' })
  createTaskDependency(task.id, upstream.id)
  expect(() => reservePilotCommandBudget({ ...input, sourceVersion: currentTask.updatedAt,
    sourceHash: hashPilotTaskSource(currentTask) })).toThrow('依赖尚未解除')
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 0, committedCostMicros: 0 })
})

test('grant 发行后活动行边界损坏时拒绝新命令', () => {
  const { project, grantId, input } = fixture()
  getProjectDb().prepare('UPDATE pilot_runtime_grants SET max_runs = max_runs + 1 WHERE id = ?').run(grantId)
  expect(() => reservePilotCommandBudget(input)).toThrow('活动授权与当前策略不一致')
  expect(listAgentExecutionsByProject(project.id)).toEqual([])
})

test('同库预留跨重启保留；同项目第二任务受预算约束，删除项目清理账本', async () => {
  const { project, grantId, input } = fixture('active', 800, 2)
  reservePilotCommandBudget(input)
  closeProjectDb()
  await initProjectDb()
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1, committedCostMicros: 600 })
  const another = createTask(project.id, { title: '第二个任务', description: '', workspaceId: 'workspace-a',
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  const next = { ...input, commandId: `second-${project.id}`, idempotencyKey: 'task-second-execution',
    taskId: another.id, sourceVersion: another.updatedAt, sourceHash: hashPilotTaskSource(another) }
  expect(() => reservePilotCommandBudget({ ...next, reservedCostMicros: 201 })).toThrow('费用额度不足')
  expect(reservePilotCommandBudget({ ...next, reservedCostMicros: 200 }).state).toBe('reserved')
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 2, committedCostMicros: 800 })
  const third = createTask(project.id, { title: '第三个任务', description: '', workspaceId: 'workspace-a',
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  expect(() => reservePilotCommandBudget({ ...next, commandId: `third-${project.id}`, idempotencyKey: 'task-third-execution',
    taskId: third.id, sourceVersion: third.updatedAt, sourceHash: hashPilotTaskSource(third), reservedCostMicros: 1 }))
    .toThrow('执行次数额度已耗尽')
  expect(deleteProject(project.id)).toBe(true)
  expect(() => getPilotGrantBudgetUsage(grantId)).toThrow('授权不存在')
})


test('启动核验要求命令、执行、活动 grant 与当前任务来源全部一致', () => {
  const { project, task, grantId, input } = fixture()
  const executionId = `execution-${project.id}`
  createAgentExecution({ id: executionId, projectId: project.id, entityType: 'task', entityId: task.id,
    agentId: 'executor', sessionId: '', prompt: 'fixture', pilotCommandId: input.commandId })
  expect(() => assertPilotCommandStartRecord(executionId, input.commandId, 1)).toThrow('已预留命令与执行不匹配')
  reservePilotCommandBudget(input)
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'queued', execution_id = ? WHERE id = ?")
    .run(executionId, input.commandId)
  expect(assertPilotCommandStartRecord(executionId, input.commandId, 1).executionId).toBe(executionId)
  expect(() => assertPilotCommandStartRecord(executionId, input.commandId, 1, Number.NaN)).toThrow('时钟无效')
  expect(() => assertPilotCommandStartRecord(executionId, input.commandId, 1, -1)).toThrow('时钟无效')
  expect(() => assertPilotCommandStartRecord(executionId, input.commandId, 2)).toThrow('活动授权已失效')
  getProjectDb().prepare("UPDATE pilot_runtime_grants SET state = 'paused' WHERE id = ?").run(grantId)
  expect(() => assertPilotCommandStartRecord(executionId, input.commandId, 1)).toThrow('活动授权已失效')
  getProjectDb().prepare("UPDATE pilot_runtime_grants SET state = 'active' WHERE id = ?").run(grantId)
  updateTask(task.id, { title: '来源已修改' })
  expect(() => assertPilotCommandStartRecord(executionId, input.commandId, 1)).toThrow('命令来源已变化')
})


test('预留、排队执行与关联同事务提交；重复命令不创建第二个执行', () => {
  const { project, grantId, input } = fixture()
  const queue = { executionId: `queue-${project.id}`, prompt: '执行任务' }
  const first = reserveAndQueuePilotCommand(input, queue)
  expect(first.command.state).toBe('queued')
  expect(first.command.executionId).toBe(queue.executionId)
  expect(first.execution.pilotCommandId).toBe(input.commandId)
  const link = getProjectDb().prepare('SELECT command_id, execution_id FROM pilot_command_links WHERE command_id = ?')
    .get(input.commandId) as { command_id: string; execution_id: string } | undefined
  expect(link).toEqual({ command_id: input.commandId, execution_id: queue.executionId })
  expect(reserveAndQueuePilotCommand(input, queue)).toEqual(first)
  expect(() => reserveAndQueuePilotCommand(input, { ...queue, executionId: 'other' }))
    .toThrow('其他排队执行')
  expect(listAgentExecutionsByProject(project.id)).toHaveLength(1)
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1, committedCostMicros: 600 })
})

test('排队阶段失败则回滚预留；已有预留遇授权暂停也不能排队', () => {
  const { project, grantId, input } = fixture()
  expect(() => reserveAndQueuePilotCommand(input, { executionId: '', prompt: '执行任务' }))
    .toThrow('排队执行参数无效')
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 0, committedCostMicros: 0 })
  const duplicate = createAgentExecution({ id: `queue-${project.id}`, projectId: project.id,
    entityType: 'task', entityId: input.taskId, agentId: 'executor', sessionId: '', prompt: '普通执行' })
  expect(() => reserveAndQueuePilotCommand(input, { executionId: duplicate.id, prompt: '执行任务' }))
    .toThrow()
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 0, committedCostMicros: 0 })
  reservePilotCommandBudget(input)
  getProjectDb().prepare("UPDATE pilot_runtime_grants SET state = 'paused' WHERE id = ?").run(grantId)
  expect(() => reserveAndQueuePilotCommand(input, { executionId: `new-${project.id}`, prompt: '执行任务' }))
    .toThrow('活动授权不存在或已失效')
  expect(listAgentExecutionsByProject(project.id)).toHaveLength(1)
})


test('已有 queued 命令重放也必须核验来源关联', () => {
  const { project, input } = fixture()
  const queue = { executionId: `queue-${project.id}`, prompt: '执行任务' }
  reserveAndQueuePilotCommand(input, queue)
  getProjectDb().prepare('DELETE FROM pilot_command_links WHERE command_id = ?').run(input.commandId)
  expect(() => reserveAndQueuePilotCommand(input, queue)).toThrow('命令关联无法核验')
  expect(listAgentExecutionsByProject(project.id)).toHaveLength(1)
})

test('来源关联冲突发生在执行创建后，整笔事务回滚', () => {
  const { project, grantId, input } = fixture()
  getProjectDb().prepare(`INSERT INTO pilot_command_links
    (command_id, project_id, policy_revision, execution_id, created_at) VALUES (?, ?, 1, ?, ?)`)
    .run(input.commandId, project.id, `old-${project.id}`, Date.now())
  expect(() => reserveAndQueuePilotCommand(input, { executionId: `queue-${project.id}`, prompt: '执行任务' }))
    .toThrow('命令关联已被其他执行占用')
  expect(listAgentExecutionsByProject(project.id)).toEqual([])
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 0, committedCostMicros: 0 })
})


test('终结执行的已知费用结算并释放未用预留，重复结算幂等', () => {
  const { project, grantId, input } = fixture()
  const executionId = `execution-${project.id}`
  reserveAndQueuePilotCommand(input, { executionId, prompt: '执行任务' })
  updateAgentExecution(executionId, { status: 'completed', sessionId: 'session-1', completedAt: Date.now() })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'running' WHERE id = ?").run(input.commandId)
  const settled = settlePilotCommandCost(input.commandId, 450)
  expect(settled).toEqual({ commandId: input.commandId, state: 'settled', actualCostMicros: 450, grantPaused: false })
  expect(settlePilotCommandCost(input.commandId, 450)).toEqual(settled)
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1, committedCostMicros: 450 })
  expect(() => settlePilotCommandCost(input.commandId, 451)).toThrow('状态不可结算')
})

test('未知或超预留费用保留预算占额并暂停后续派发', () => {
  for (const actualCostMicros of [null, 900]) {
    const { project, grantId, input } = fixture()
    const executionId = `execution-${project.id}`
    reserveAndQueuePilotCommand(input, { executionId, prompt: '执行任务' })
    updateAgentExecution(executionId, { status: 'failed', sessionId: 'session-1', completedAt: Date.now() })
    getProjectDb().prepare("UPDATE pilot_commands SET state = 'running' WHERE id = ?").run(input.commandId)
    expect(settlePilotCommandCost(input.commandId, actualCostMicros)).toEqual({
      commandId: input.commandId, state: 'needs_reconcile', actualCostMicros, grantPaused: true,
    })
    expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1,
      committedCostMicros: actualCostMicros ?? 600 })
    const grant = getProjectDb().prepare('SELECT state FROM pilot_runtime_grants WHERE id = ?')
      .get(grantId) as { state: string }
    expect(grant.state).toBe('paused')
  }
})

test('执行未终结、费用无效或已释放的排队命令不能结算', () => {
  const { project, grantId, input } = fixture()
  const executionId = `execution-${project.id}`
  reserveAndQueuePilotCommand(input, { executionId, prompt: '执行任务' })
  expect(() => settlePilotCommandCost(input.commandId, 100)).toThrow('执行未终结')
  expect(() => settlePilotCommandCost(input.commandId, Number.NaN)).toThrow('结算费用无效')
  expect(() => settlePilotCommandCost(input.commandId, -1)).toThrow('结算费用无效')
  updateAgentExecution(executionId, { status: 'cancelled', completedAt: Date.now() })
  expect(() => settlePilotCommandCost(input.commandId, 0)).toThrow('状态不可结算')
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1, committedCostMicros: 600 })
})
