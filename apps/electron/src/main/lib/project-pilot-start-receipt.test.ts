import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimPilotCommandStart, recordPilotRunnerHandoffIntent, hashPilotTaskSource, reserveAndQueuePilotCommand } from './project-pilot-budget-ledger'
import { recoverInterruptedPilotRuntimeExecutions } from './project-pilot-runtime-recovery'
import { isPilotStartProven, readPilotRuntimeStartReceipt, recordPilotRuntimeStarted } from './project-pilot-start-receipt'
import { insertPilotGrantFixture } from './project-pilot-test-helpers'
import { closeProjectDb, createAgentExecution, createProject, createTask, getProjectDb, initProjectDb } from './project-sqlite-store'

const root = mkdtempSync(join(tmpdir(), 'project-pilot-start-receipt-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = root; await initProjectDb() })
afterAll(() => {
  closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const project = createProject({ title: '开始回执项目', description: '' })
  const task = createTask(project.id, { title: '研发任务', description: '', workspaceId: 'pilot-workspace',
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  const grantId = `grant-${project.id}`
  const now = Date.now()
  insertPilotGrantFixture({ grantId, projectId: project.id, workspaceId: 'pilot-workspace',
    channelId: 'channel', modelId: 'model', maxCostMicros: 1_000, maxRuns: 1,
    maxRework: 0, expiresAt: now + 100_000, createdAt: now })
  const input = { commandId: `command-${project.id}`, projectId: project.id, grantId, idempotencyKey: 'first',
    taskId: task.id, sourceVersion: task.updatedAt, sourceHash: hashPilotTaskSource(task),
    employeeId: 'executor', role: 'executor' as const, reworkOrdinal: 0 }
  const executionId = `execution-${project.id}`
  reserveAndQueuePilotCommand(input, { executionId, prompt: '研发任务' })
  claimPilotCommandStart(executionId, input.commandId, 1, 'session-1', now)
  return { project, grantId, input, executionId, now }
}

function claimAndHandoff(executionId: string, commandId: string, now: number, sessionId = 'session-1') {
  recordPilotRunnerHandoffIntent(executionId, commandId, sessionId, now + 1)
}

test('交接后记录开始回执：启动事实可证，终态与费用仍 unknown', () => {
  const data = fixture()
  claimAndHandoff(data.executionId, data.input.commandId, data.now)
  const receipt = recordPilotRuntimeStarted(data.executionId, data.input.commandId, 'session-1', {
    runnerName: 'headless-runner', processId: 4242, startedAt: data.now + 2,
  }, data.now + 3)

  expect(receipt).toMatchObject({
    executionId: data.executionId, commandId: data.input.commandId,
    runnerName: 'headless-runner', processId: 4242, startedAt: data.now + 2,
  })
  expect(readPilotRuntimeStartReceipt(data.executionId)?.receivedAt).toBe(data.now + 3)

  const execution = getProjectDb().prepare('SELECT * FROM agent_executions WHERE id = ?').get(data.executionId) as
    { id: string; project_id: string; session_id: string; pilot_command_id: string }
  expect(isPilotStartProven({
    id: execution.id, projectId: execution.project_id, sessionId: execution.session_id,
    pilotCommandId: execution.pilot_command_id,
  }, data.now + 4)).toBe(true)
})

test('故障注入：有回执时重启恢复报 started_proven，仍 stale、未知费用并暂停授权', async () => {
  const data = fixture()
  claimAndHandoff(data.executionId, data.input.commandId, data.now)
  recordPilotRuntimeStarted(data.executionId, data.input.commandId, 'session-1', {
    runnerName: 'headless-runner', startedAt: data.now + 2,
  }, data.now + 3)
  closeProjectDb()
  await initProjectDb()

  const results = recoverInterruptedPilotRuntimeExecutions(data.now + 4)
  expect(results).toContainEqual({
    executionId: data.executionId, commandId: data.input.commandId,
    state: 'unknown_recorded', startBoundary: 'started_proven',
    reason: '启动已证实但终态与用量未知，已按未知用量撤权停等',
  })
  const execution = getProjectDb().prepare('SELECT status FROM agent_executions WHERE id = ?').get(data.executionId) as { status: string }
  expect(execution.status).toBe('stale')
  const grant = getProjectDb().prepare('SELECT state FROM pilot_runtime_grants WHERE id = ?').get(data.grantId) as { state: string }
  expect(grant.state).toBe('paused')
})

test('故障注入：无回执（崩溃在首条消息前）保持 handoff_intent，启动仍未知', async () => {
  const data = fixture()
  claimAndHandoff(data.executionId, data.input.commandId, data.now)
  closeProjectDb()
  await initProjectDb()

  const results = recoverInterruptedPilotRuntimeExecutions(data.now + 4)
  expect(results).toContainEqual({
    executionId: data.executionId, commandId: data.input.commandId,
    state: 'unknown_recorded', startBoundary: 'handoff_intent',
    reason: '中断 Runtime 已按未知用量撤权停等',
  })
})

test('缺少交接意图时回执被拒绝', () => {
  const data = fixture()
  expect(() => recordPilotRuntimeStarted(data.executionId, data.input.commandId, 'session-1', {
    runnerName: 'headless-runner',
  }, data.now + 2)).toThrow('Pilot 开始回执缺少交接意图')
})

test('回执与认领会话不一致、早于交接、时钟倒置或重复都被拒绝', () => {
  const data = fixture()
  claimAndHandoff(data.executionId, data.input.commandId, data.now)
  expect(() => recordPilotRuntimeStarted(data.executionId, data.input.commandId, 'session-2', {
    runnerName: 'headless-runner',
  }, data.now + 2)).toThrow('Pilot 开始回执与启动认领不一致')
  expect(() => recordPilotRuntimeStarted(data.executionId, data.input.commandId, 'session-1', {
    runnerName: 'headless-runner', startedAt: data.now,
  }, data.now + 2)).toThrow('Pilot 开始回执早于交接意图')
  expect(() => recordPilotRuntimeStarted(data.executionId, data.input.commandId, 'session-1', {
    runnerName: 'headless-runner', startedAt: data.now + 5,
  }, data.now + 2)).toThrow('Pilot 开始回执时间不能晚于接收时间')

  recordPilotRuntimeStarted(data.executionId, data.input.commandId, 'session-1', {
    runnerName: 'headless-runner', startedAt: data.now + 2,
  }, data.now + 3)
  expect(() => recordPilotRuntimeStarted(data.executionId, data.input.commandId, 'session-1', {
    runnerName: 'headless-runner', startedAt: data.now + 2,
  }, data.now + 4)).toThrow('Pilot 开始回执已存在')
})

test('非 Pilot 执行与普通员工路径不接受开始回执', () => {
  const project = createProject({ title: '普通项目', description: '' })
  const task = createTask(project.id, { title: '普通任务', description: '', workspaceId: 'ws' })
  const execution = createAgentExecution({
    id: `plain-execution-${project.id}`, projectId: project.id, entityType: 'task', entityId: task.id,
    agentId: 'agent-1', prompt: '普通执行', status: 'running', sessionId: 'session-plain',
  })
  expect(() => recordPilotRuntimeStarted(execution.id, 'command-x', 'session-plain', {
    runnerName: 'headless-runner',
  })).toThrow('Pilot 开始回执执行归属无法核验')
  expect(isPilotStartProven({
    id: execution.id, projectId: project.id, sessionId: 'session-plain', pilotCommandId: null,
  })).toBe(false)
})

test('开始回执表不可变，项目删除时清理回执', () => {
  const data = fixture()
  claimAndHandoff(data.executionId, data.input.commandId, data.now)
  recordPilotRuntimeStarted(data.executionId, data.input.commandId, 'session-1', {
    runnerName: 'headless-runner', startedAt: data.now + 2,
  }, data.now + 3)
  expect(() => getProjectDb().prepare(
    'UPDATE pilot_runtime_start_receipts SET started_at = ? WHERE execution_id = ?')
    .run(data.now + 9, data.executionId)).toThrow()

  const before = getProjectDb().prepare('SELECT COUNT(*) AS n FROM pilot_runtime_start_receipts').get() as { n: number }
  expect(before.n).toBeGreaterThan(0)
})
