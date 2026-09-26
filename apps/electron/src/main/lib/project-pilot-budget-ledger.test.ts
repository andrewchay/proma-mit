import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeProjectDb, createAgentExecution, createProject, createTask, createTaskDependency, deleteProject, getAgentExecution, getProjectDb, getTask, initProjectDb, listAgentExecutionsByProject, updateAgentExecution, updateTask } from './project-sqlite-store'
import { assertPilotCommandStartRecord, cancelQueuedPilotCommand, claimPilotCommandStart, getPilotGrantBudgetUsage, hashPilotTaskSource, reserveAndQueuePilotCommand, reservePilotCommandBudget, settlePilotCommandUsage, type PilotCommandReservationInput, type PilotUsageEvidence } from './project-pilot-budget-ledger'
import { insertPilotGrantFixture } from './project-pilot-test-helpers'
import { settlePilotExecutionRuntimeUsage, settlePilotExecutionUnknownUsage } from './project-pilot-runtime-usage'
import type { SDKResultMessage } from '@gravitas/shared'
import { cancelLinkedQueuedPilotExecutions, registerPilotCommandLink } from './project-pilot-command-links'
import { inspectPilotGrantRecovery } from './project-pilot-recovery'

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
    employeeId: 'executor', role: 'executor', reworkOrdinal: 0,
  }
  return { project, task, grantId, input }
}

const usageEvidence = (executionId: string, costMicros: number): Extract<PilotUsageEvidence, { source: 'provider_reported' }> => ({
  source: 'provider_reported', executionId, sessionId: 'session-1', channelId: 'channel-a', modelId: 'model-a',
  providerRecordId: `provider-${executionId}`, inputTokens: 100, outputTokens: 20, costMicros, capturedAt: Date.now(),
})

const unknownUsage = (executionId: string): PilotUsageEvidence => ({
  source: 'unknown', executionId, sessionId: 'session-1', channelId: 'channel-a', modelId: 'model-a',
  reason: 'Provider 未返回可核验用量', capturedAt: Date.now(),
})

test('暂停授权、未知费用与无授权都不能预留或创建执行', () => {
  const { project, grantId, input } = fixture('paused')
  expect(() => reservePilotCommandBudget(input)).toThrow('活动授权不存在或已失效')
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
  expect(first.reservedCostMicros).toBe(500)
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1, committedCostMicros: 500 })
  expect(() => reservePilotCommandBudget({ ...input, commandId: 'changed' })).toThrow('幂等键已对应其他内容')
  expect(() => reservePilotCommandBudget({ ...input, commandId: 'second', idempotencyKey: 'other' }))
    .toThrow('任务已有未结命令')
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'needs_reconcile' WHERE id = ?").run(input.commandId)
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1, committedCostMicros: 500 })
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
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1, committedCostMicros: 400 })
  const another = createTask(project.id, { title: '第二个任务', description: '', workspaceId: 'workspace-a',
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  const next = { ...input, commandId: `second-${project.id}`, idempotencyKey: 'task-second-execution',
    taskId: another.id, sourceVersion: another.updatedAt, sourceHash: hashPilotTaskSource(another) }
  expect(reservePilotCommandBudget(next)).toMatchObject({ state: 'reserved', reservedCostMicros: 400 })
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 2, committedCostMicros: 800 })
  const third = createTask(project.id, { title: '第三个任务', description: '', workspaceId: 'workspace-a',
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  expect(() => reservePilotCommandBudget({ ...next, commandId: `third-${project.id}`, idempotencyKey: 'task-third-execution',
    taskId: third.id, sourceVersion: third.updatedAt, sourceHash: hashPilotTaskSource(third) }))
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
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1, committedCostMicros: 500 })
})

test('启动认领在同一事务推进命令与执行，失败时不留下半启动状态', () => {
  const { project, input } = fixture()
  const queue = { executionId: `claim-${project.id}`, prompt: '执行任务' }
  reserveAndQueuePilotCommand(input, queue)
  const claimed = claimPilotCommandStart(queue.executionId, input.commandId, 1, 'session-claim')
  expect(claimed.command.state).toBe('running')
  expect(claimed.execution).toMatchObject({ status: 'running', sessionId: 'session-claim' })
  expect(() => claimPilotCommandStart(queue.executionId, input.commandId, 1, 'other-session'))
    .toThrow('排队状态无法核验')

  const rollback = fixture()
  const rollbackQueue = { executionId: `claim-rollback-${rollback.project.id}`, prompt: '执行任务' }
  reserveAndQueuePilotCommand(rollback.input, rollbackQueue)
  getProjectDb().exec(`CREATE TRIGGER pilot_claim_abort BEFORE UPDATE ON pilot_commands
    WHEN NEW.id = '${rollback.input.commandId}' AND NEW.state = 'running'
    BEGIN SELECT RAISE(ABORT, 'claim interrupted'); END`)
  expect(() => claimPilotCommandStart(rollbackQueue.executionId, rollback.input.commandId, 1, 'session-rollback'))
    .toThrow('claim interrupted')
  expect(getAgentExecution(rollbackQueue.executionId)).toMatchObject({ status: 'queued', sessionId: '' })
  expect(assertPilotCommandStartRecord(rollbackQueue.executionId, rollback.input.commandId, 1).state).toBe('queued')
})

test('取消尚未启动的 Pilot 执行会原子释放费用与次数预留，且不依赖活动授权', () => {
  const { project, grantId, input } = fixture()
  const executionId = `cancel-${project.id}`
  reserveAndQueuePilotCommand(input, { executionId, prompt: '执行任务' })
  getProjectDb().prepare("UPDATE pilot_runtime_grants SET state = 'paused', expires_at = 0 WHERE id = ?").run(grantId)
  const cancelled = cancelQueuedPilotCommand(executionId, '任务已改派')
  expect(cancelled.execution).toMatchObject({ status: 'cancelled', sessionId: '', error: '任务已改派' })
  expect(cancelled.command).toMatchObject({ state: 'released', actualCostMicros: 0, executionId })
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 0, committedCostMicros: 0 })
})

test('取消 Pilot 排队执行任一写入失败时回滚执行和命令状态', () => {
  const { project, grantId, input } = fixture()
  const executionId = `cancel-rollback-${project.id}`
  reserveAndQueuePilotCommand(input, { executionId, prompt: '执行任务' })
  getProjectDb().exec(`CREATE TRIGGER pilot_cancel_abort BEFORE UPDATE ON pilot_commands
    WHEN NEW.id = '${input.commandId}' AND NEW.state = 'released'
    BEGIN SELECT RAISE(ABORT, 'cancel interrupted'); END`)
  expect(() => cancelQueuedPilotCommand(executionId, '任务已暂停')).toThrow('cancel interrupted')
  expect(getAgentExecution(executionId)).toMatchObject({ status: 'queued', sessionId: '' })
  expect(assertPilotCommandStartRecord(executionId, input.commandId, 1).state).toBe('queued')
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1, committedCostMicros: 500 })
})

test('旧批量暂停入口遇到账本命令时也原子释放预留', () => {
  const { project, grantId, input } = fixture()
  const target = { executionId: `legacy-pause-${project.id}`, commandId: input.commandId }
  reserveAndQueuePilotCommand(input, { executionId: target.executionId, prompt: '执行任务' })
  getProjectDb().exec(`CREATE TRIGGER pilot_legacy_cancel_abort BEFORE UPDATE ON pilot_commands
    WHEN NEW.id = '${input.commandId}' AND NEW.state = 'released'
    BEGIN SELECT RAISE(ABORT, 'legacy cancel interrupted'); END`)
  expect(() => cancelLinkedQueuedPilotExecutions(project.id, [target])).toThrow('legacy cancel interrupted')
  expect(getAgentExecution(target.executionId)?.status).toBe('queued')
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1, committedCostMicros: 500 })
  getProjectDb().exec('DROP TRIGGER pilot_legacy_cancel_abort')
  expect(cancelLinkedQueuedPilotExecutions(project.id, [target])).toEqual([target.executionId])
  expect(getAgentExecution(target.executionId)?.status).toBe('cancelled')
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 0, committedCostMicros: 0 })
  const nextTask = createTask(project.id, { title: '接续任务', description: '', workspaceId: 'workspace-a',
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  reservePilotCommandBudget({ ...input, commandId: `next-${project.id}`, idempotencyKey: 'next-task',
    taskId: nextTask.id, sourceVersion: nextTask.updatedAt, sourceHash: hashPilotTaskSource(nextTask) })
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1, committedCostMicros: 500 })
})

test('旧批量暂停入口不能把缺失活动授权账本的排队执行当成旧数据取消', () => {
  const { project } = fixture()
  const target = { executionId: `missing-ledger-${project.id}`, commandId: `missing-command-${project.id}` }
  createAgentExecution({ id: target.executionId, projectId: project.id, entityType: 'task', entityId: 'task-missing',
    agentId: 'executor', sessionId: '', prompt: 'fixture', pilotCommandId: target.commandId })
  registerPilotCommandLink({ ...target, projectId: project.id, policyRevision: 1 })
  expect(() => cancelLinkedQueuedPilotExecutions(project.id, [target])).toThrow('授权账本缺少排队命令')
  expect(getAgentExecution(target.executionId)?.status).toBe('queued')
})

test('Runtime 终结但没有可信回执时以 unknown 结算并暂停授权', () => {
  const { project, grantId, input } = fixture()
  const queue = { executionId: `unknown-${project.id}`, prompt: '执行任务' }
  reserveAndQueuePilotCommand(input, queue)
  claimPilotCommandStart(queue.executionId, input.commandId, 1, 'session-unknown')
  updateAgentExecution(queue.executionId, { status: 'completed', completedAt: Date.now() })
  const policyPath = join(dir, 'project-pilot-policies.json')
  const hiddenPolicyPath = `${policyPath}.hidden`
  renameSync(policyPath, hiddenPolicyPath)
  try {
    // 终结费用必须使用已冻结 grant；即使可变策略文件暂时不可读，也要撤权停等。
    expect(settlePilotExecutionUnknownUsage(queue.executionId, 'SDK 未提供 Provider 回执')).toEqual({
      commandId: input.commandId,
      state: 'needs_reconcile',
      actualCostMicros: null,
      grantPaused: true,
    })
  } finally {
    renameSync(hiddenPolicyPath, policyPath)
  }
  expect(getProjectDb().prepare('SELECT state FROM pilot_runtime_grants WHERE id = ?').get(grantId))
    .toEqual({ state: 'paused' })
})

test('终结用量因来源关联损坏无法结算时仍保守撤权', () => {
  const { project, grantId, input } = fixture()
  const executionId = `unknown-damaged-${project.id}`
  reserveAndQueuePilotCommand(input, { executionId, prompt: '执行任务' })
  claimPilotCommandStart(executionId, input.commandId, 1, 'session-damaged')
  updateAgentExecution(executionId, { status: 'failed', completedAt: Date.now() })
  getProjectDb().prepare('DELETE FROM pilot_command_links WHERE command_id = ?').run(input.commandId)
  expect(() => settlePilotExecutionUnknownUsage(executionId, 'Provider 未返回回执')).toThrow('命令关联无法核验')
  expect(getProjectDb().prepare('SELECT state FROM pilot_runtime_grants WHERE id = ?').get(grantId))
    .toEqual({ state: 'paused' })
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
  const evidence = usageEvidence(executionId, 450)
  const settled = settlePilotCommandUsage(input.commandId, evidence)
  expect(settled).toEqual({ commandId: input.commandId, state: 'settled', actualCostMicros: 450, grantPaused: false })
  expect(settlePilotCommandUsage(input.commandId, evidence)).toEqual(settled)
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1, committedCostMicros: 450 })
  expect(() => settlePilotCommandUsage(input.commandId, usageEvidence(executionId, 451))).toThrow('状态不可结算')
})

test('Runtime 原始终态带费用时保存不可变回执并按 runtime_reported 结算', () => {
  const { project, grantId, input } = fixture()
  const executionId = `runtime-${project.id}`
  const capturedAt = Date.now()
  reserveAndQueuePilotCommand(input, { executionId, prompt: '执行任务' })
  updateAgentExecution(executionId, { status: 'completed', sessionId: 'session-1', completedAt: capturedAt })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'running' WHERE id = ?").run(input.commandId)
  const runtimeResult: SDKResultMessage = {
    type: 'result', subtype: 'success', session_id: 'session-1',
    usage: { input_tokens: 100, output_tokens: 20 }, total_cost_usd: 0.00045,
  }
  const settled = settlePilotExecutionRuntimeUsage(executionId, 'claude', runtimeResult, capturedAt)
  expect(settled).toEqual({ commandId: input.commandId, state: 'settled', actualCostMicros: 450, grantPaused: false })
  expect(settlePilotExecutionRuntimeUsage(executionId, 'claude', runtimeResult, capturedAt)).toEqual(settled)
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1, committedCostMicros: 450 })
  const receipt = getProjectDb().prepare(`SELECT id, raw_payload, payload_hash, cost_micros
    FROM pilot_runtime_usage_receipts WHERE execution_id = ?`).get(executionId) as {
      id: string; raw_payload: string; payload_hash: string; cost_micros: number
    }
  expect(receipt.id).toHaveLength(64)
  expect(receipt.payload_hash).toHaveLength(64)
  expect(JSON.parse(receipt.raw_payload)).toEqual(runtimeResult)
  expect(receipt.cost_micros).toBe(450)
  expect(() => getProjectDb().prepare('UPDATE pilot_runtime_usage_receipts SET cost_micros = 1 WHERE id = ?')
    .run(receipt.id)).toThrow('immutable')
  const evidence = getProjectDb().prepare('SELECT usage_evidence FROM pilot_commands WHERE id = ?')
    .get(input.commandId) as { usage_evidence: string }
  expect(JSON.parse(evidence.usage_evidence)).toMatchObject({
    source: 'runtime_reported', runtimeReceiptId: receipt.id, payloadHash: receipt.payload_hash,
    inputTokens: 100, outputTokens: 20, costMicros: 450,
  })
  expect(inspectPilotGrantRecovery(grantId).needsAttention).toEqual([])
  getProjectDb().exec('DROP TRIGGER pilot_runtime_usage_receipts_immutable')
  try {
    getProjectDb().prepare('UPDATE pilot_runtime_usage_receipts SET raw_payload = ? WHERE id = ?')
      .run('{}', receipt.id)
    expect(inspectPilotGrantRecovery(grantId).needsAttention).toEqual([{
      commandId: input.commandId, reason: 'Runtime 用量回执原始记录缺失或不一致',
    }])
    getProjectDb().prepare('UPDATE pilot_runtime_usage_receipts SET raw_payload = ? WHERE id = ?')
      .run(receipt.raw_payload, receipt.id)
  } finally {
    getProjectDb().exec(`CREATE TRIGGER pilot_runtime_usage_receipts_immutable
      BEFORE UPDATE ON pilot_runtime_usage_receipts
      BEGIN SELECT RAISE(ABORT, 'Pilot Runtime usage receipt is immutable'); END`)
  }
  expect(inspectPilotGrantRecovery(grantId).needsAttention).toEqual([])
  getProjectDb().prepare('DELETE FROM pilot_runtime_usage_receipts WHERE id = ?').run(receipt.id)
  expect(inspectPilotGrantRecovery(grantId).needsAttention).toEqual([{
    commandId: input.commandId, reason: 'Runtime 用量回执原始记录缺失或不一致',
  }])
})

test('Runtime 只有 token 时保留原始回执但按未知费用撤权待对账', () => {
  const { project, grantId, input } = fixture()
  const executionId = `runtime-unknown-${project.id}`
  const capturedAt = Date.now()
  reserveAndQueuePilotCommand(input, { executionId, prompt: '执行任务' })
  updateAgentExecution(executionId, { status: 'completed', sessionId: 'session-1', completedAt: capturedAt })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'running' WHERE id = ?").run(input.commandId)
  const runtimeResult: SDKResultMessage = {
    type: 'result', subtype: 'success', session_id: 'session-1',
    usage: { input_tokens: 100, output_tokens: 20 },
  }
  expect(settlePilotExecutionRuntimeUsage(executionId, 'proma', runtimeResult, capturedAt)).toEqual({
    commandId: input.commandId, state: 'needs_reconcile', actualCostMicros: null, grantPaused: true,
  })
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1, committedCostMicros: 500 })
  const command = getProjectDb().prepare('SELECT usage_evidence FROM pilot_commands WHERE id = ?')
    .get(input.commandId) as { usage_evidence: string }
  expect(JSON.parse(command.usage_evidence)).toMatchObject({
    source: 'unknown', reason: 'Runtime 终态回执未提供费用，不能用本地估价替代实际结算',
    runtimeReceiptId: expect.any(String), payloadHash: expect.any(String),
  })
  expect(getProjectDb().prepare('SELECT cost_micros FROM pilot_runtime_usage_receipts WHERE execution_id = ?')
    .get(executionId)).toEqual({ cost_micros: null })
  expect(getProjectDb().prepare('SELECT state FROM pilot_runtime_grants WHERE id = ?').get(grantId))
    .toEqual({ state: 'paused' })
})

test('Runtime 回执引用不能伪造，且同一执行不能改写原始终态', () => {
  const { project, input } = fixture()
  const executionId = `runtime-forged-${project.id}`
  const capturedAt = Date.now()
  reserveAndQueuePilotCommand(input, { executionId, prompt: '执行任务' })
  updateAgentExecution(executionId, { status: 'completed', sessionId: 'session-1', completedAt: capturedAt })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'running' WHERE id = ?").run(input.commandId)
  expect(() => settlePilotCommandUsage(input.commandId, {
    source: 'runtime_reported', executionId, sessionId: 'session-1', channelId: 'channel-a', modelId: 'model-a',
    runtimeReceiptId: 'missing', payloadHash: 'a'.repeat(64), inputTokens: 1, outputTokens: 1,
    costMicros: 1, capturedAt,
  })).toThrow('Runtime 用量回执与原始记录不匹配')
  const original: SDKResultMessage = {
    type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.0001,
  }
  expect(() => settlePilotExecutionRuntimeUsage(executionId, 'claude', {
    ...original, session_id: 'other-session',
  }, capturedAt)).toThrow('Runtime 回执会话与执行会话不匹配')
  settlePilotExecutionRuntimeUsage(executionId, 'claude', original, capturedAt)
  expect(() => settlePilotExecutionRuntimeUsage(executionId, 'claude', {
    ...original, total_cost_usd: 0.0002,
  }, capturedAt)).toThrow('已有不同的 Runtime 用量回执')
})

test('未知或超预留费用保留预算占额并暂停后续派发', () => {
  for (const actualCostMicros of [null, 900]) {
    const { project, grantId, input } = fixture()
    const executionId = `execution-${project.id}`
    reserveAndQueuePilotCommand(input, { executionId, prompt: '执行任务' })
    updateAgentExecution(executionId, { status: 'failed', sessionId: 'session-1', completedAt: Date.now() })
    getProjectDb().prepare("UPDATE pilot_commands SET state = 'running' WHERE id = ?").run(input.commandId)
    const evidence = actualCostMicros === null ? unknownUsage(executionId) : usageEvidence(executionId, actualCostMicros)
    expect(settlePilotCommandUsage(input.commandId, evidence)).toEqual({
      commandId: input.commandId, state: 'needs_reconcile', actualCostMicros, grantPaused: true,
    })
    expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1,
      committedCostMicros: actualCostMicros ?? 500 })
    const grant = getProjectDb().prepare('SELECT state FROM pilot_runtime_grants WHERE id = ?')
      .get(grantId) as { state: string }
    expect(grant.state).toBe('paused')
  }
})

test('用量证据必须绑定执行、会话、渠道和模型，可追溯估算必须携带价格来源', () => {
  const { project, input } = fixture()
  const executionId = `execution-${project.id}`
  reserveAndQueuePilotCommand(input, { executionId, prompt: '执行任务' })
  updateAgentExecution(executionId, { status: 'completed', sessionId: 'session-1', completedAt: Date.now() })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'running' WHERE id = ?").run(input.commandId)
  const invalidSource = { ...usageEvidence(executionId, 300), source: 'bogus' } as unknown as PilotUsageEvidence
  expect(() => settlePilotCommandUsage(input.commandId, invalidSource)).toThrow('用量证据来源无效')
  expect(() => settlePilotCommandUsage(input.commandId, { ...usageEvidence(executionId, 300), capturedAt: Date.now() + 10_000 }))
    .toThrow('用量证据时间无效')
  expect(() => settlePilotCommandUsage(input.commandId, { ...usageEvidence(executionId, 300), channelId: 'other' }))
    .toThrow('用量证据与执行、会话、渠道或模型不匹配')
  getProjectDb().prepare('UPDATE agent_executions SET agent_id = ? WHERE id = ?').run('other-agent', executionId)
  expect(() => settlePilotCommandUsage(input.commandId, usageEvidence(executionId, 300)))
    .toThrow('执行未终结或账本归属无法核验')
  getProjectDb().prepare('UPDATE agent_executions SET agent_id = ? WHERE id = ?').run('executor', executionId)
  getProjectDb().prepare('DELETE FROM pilot_command_links WHERE command_id = ?').run(input.commandId)
  expect(() => settlePilotCommandUsage(input.commandId, usageEvidence(executionId, 300)))
    .toThrow('命令关联无法核验')
  getProjectDb().prepare(`INSERT INTO pilot_command_links
    (command_id, project_id, policy_revision, execution_id, created_at) VALUES (?, ?, 1, ?, ?)`)
    .run(input.commandId, project.id, executionId, Date.now())
  const estimate: PilotUsageEvidence = {
    source: 'traceable_estimate', executionId, sessionId: 'session-1', channelId: 'channel-a', modelId: 'model-a',
    priceSource: 'vendor-price-snapshot-2026-09-26', inputTokens: 100, outputTokens: 20,
    costMicros: 300, capturedAt: Date.now(),
  }
  expect(() => settlePilotCommandUsage(input.commandId, { ...estimate, priceSource: '' })).toThrow('用量或计价证据无效')
  expect(settlePilotCommandUsage(input.commandId, estimate).state).toBe('settled')
  const row = getProjectDb().prepare('SELECT usage_evidence FROM pilot_commands WHERE id = ?')
    .get(input.commandId) as { usage_evidence: string }
  expect(JSON.parse(row.usage_evidence)).toEqual(estimate)
})

test('同一 Provider 用量回执不能跨命令重复结算', () => {
  const first = fixture()
  const second = fixture()
  const firstExecutionId = `execution-${first.project.id}`
  const secondExecutionId = `execution-${second.project.id}`
  reserveAndQueuePilotCommand(first.input, { executionId: firstExecutionId, prompt: '执行任务' })
  reserveAndQueuePilotCommand(second.input, { executionId: secondExecutionId, prompt: '执行任务' })
  updateAgentExecution(firstExecutionId, { status: 'completed', sessionId: 'session-1', completedAt: Date.now() })
  updateAgentExecution(secondExecutionId, { status: 'completed', sessionId: 'session-1', completedAt: Date.now() })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'running' WHERE id IN (?, ?)")
    .run(first.input.commandId, second.input.commandId)
  const providerRecordId = 'provider-shared-receipt'
  settlePilotCommandUsage(first.input.commandId, { ...usageEvidence(firstExecutionId, 300), providerRecordId })
  // 模拟从仅有 usage_evidence、尚无唯一键的上一版本数据库升级。
  getProjectDb().prepare('UPDATE pilot_commands SET usage_record_key = NULL WHERE id = ?').run(first.input.commandId)
  expect(() => settlePilotCommandUsage(second.input.commandId,
    { ...usageEvidence(secondExecutionId, 300), providerRecordId }))
    .toThrow('Provider 用量回执已被其他命令使用')
})

test('执行未终结、费用无效或已释放的排队命令不能结算', () => {
  const { project, grantId, input } = fixture()
  const executionId = `execution-${project.id}`
  reserveAndQueuePilotCommand(input, { executionId, prompt: '执行任务' })
  expect(() => settlePilotCommandUsage(input.commandId, usageEvidence(executionId, 100))).toThrow('执行未终结')
  expect(() => settlePilotCommandUsage(input.commandId, usageEvidence(executionId, Number.NaN))).toThrow('用量或计价证据无效')
  expect(() => settlePilotCommandUsage(input.commandId, usageEvidence(executionId, -1))).toThrow('用量或计价证据无效')
  updateAgentExecution(executionId, { status: 'cancelled', sessionId: 'session-1', completedAt: Date.now() })
  expect(() => settlePilotCommandUsage(input.commandId, usageEvidence(executionId, 0))).toThrow('状态不可结算')
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1, committedCostMicros: 500 })
})
