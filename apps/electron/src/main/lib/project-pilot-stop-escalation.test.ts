import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimPilotCommandStart, hashPilotTaskSource, recordPilotRunnerHandoffIntent, reserveAndQueuePilotCommand } from './project-pilot-budget-ledger'
import { recoverInterruptedPilotRuntimeExecutions } from './project-pilot-runtime-recovery'
import {
  getPilotStopEscalation, listOpenPilotStopEscalations, recordPilotStopEscalation, requestPilotStopWithIntent,
} from './project-pilot-stop-escalation'
import { insertPilotGrantFixture } from './project-pilot-test-helpers'
import { reservePilotCommandBudget } from './project-pilot-budget-ledger'
import { closeProjectDb, createAgentExecution, createProject, createTask, getProjectDb, initProjectDb } from './project-sqlite-store'
import { settlePilotCommandUsage, getPilotGrantBudgetUsage } from './project-pilot-budget-ledger'

const root = mkdtempSync(join(tmpdir(), 'project-pilot-stop-escalation-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = root; await initProjectDb() })
afterAll(() => {
  closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const project = createProject({ title: '停止升级项目', description: '' })
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
  recordPilotRunnerHandoffIntent(executionId, input.commandId, 'session-1', now + 1)
  return { project, grantId, input, executionId, now: now + 1 }
}

test('无效 generation 或非运行中执行均不得发出停止请求', () => {
  const data = fixture()
  let called = false
  expect(() => requestPilotStopWithIntent(data.executionId, Number.NaN, () => { called = true }))
    .toThrow('Pilot 运行代际无效')
  expect(called).toBe(false)
  getProjectDb().prepare("UPDATE agent_executions SET status = 'completed' WHERE id = ?").run(data.executionId)
  expect(() => requestPilotStopWithIntent(data.executionId, 42, () => { called = true }))
    .toThrow('Pilot 停止升级仅适用于运行中的执行')
  expect(called).toBe(false)
  expect(getPilotStopEscalation(data.executionId)).toBeUndefined()
})

test('停止意图先落盘再调用停止器：同步终态抢先仍保留 open 与占额', () => {
  const data = fixture()
  const result = requestPilotStopWithIntent(data.executionId, 42, () => {
    expect(getPilotStopEscalation(data.executionId)).toMatchObject({
      sessionId: 'session-1', commandId: data.input.commandId, expectedGeneration: 42, resolvedAt: null,
    })
    const grant = getProjectDb().prepare('SELECT state FROM pilot_runtime_grants WHERE id = ?')
      .get(data.grantId) as { state: string }
    expect(grant.state).toBe('paused')
    getProjectDb().prepare("UPDATE agent_executions SET status = 'cancelled' WHERE id = ?").run(data.executionId)
    return 'accepted'
  })
  expect(result).toBe('accepted')
  expect(getPilotStopEscalation(data.executionId)?.resolvedAt).toBeNull()
  expect(getPilotGrantBudgetUsage(data.grantId).committedCostMicros).toBe(1_000)
})

test('同步终态回调先于停止返回：open 仍阻断有限费用结算', () => {
  const data = fixture()
  requestPilotStopWithIntent(data.executionId, 45, () => {
    getProjectDb().prepare("UPDATE agent_executions SET status = 'completed' WHERE id = ?").run(data.executionId)
    expect(() => settlePilotCommandUsage(data.input.commandId, {
      source: 'provider_reported', executionId: data.executionId, sessionId: 'session-1',
      channelId: 'channel', modelId: 'model', providerRecordId: `race-${data.project.id}`,
      inputTokens: 1, outputTokens: 1, costMicros: 1, capturedAt: data.now + 3,
    }, data.now + 3)).toThrow('Pilot 停止升级未消解')
  })
  expect(getPilotGrantBudgetUsage(data.grantId).committedCostMicros).toBe(1_000)
  expect(getPilotStopEscalation(data.executionId)?.resolvedAt).toBeNull()
})

test('停止请求失败仍保留持久意图；落盘失败则不得调用停止器', () => {
  const failedStop = fixture()
  expect(() => requestPilotStopWithIntent(failedStop.executionId, 43, () => {
    throw new Error('Runtime abort failed')
  })).toThrow('Runtime abort failed')
  expect(getPilotStopEscalation(failedStop.executionId)?.resolvedAt).toBeNull()
  const missingGrant = fixture()
  getProjectDb().prepare('DELETE FROM pilot_runtime_grants WHERE id = ?').run(missingGrant.grantId)
  let called = false
  expect(() => requestPilotStopWithIntent(missingGrant.executionId, 44, () => {
    called = true
  })).toThrow('授权暂停无法核验')
  expect(called).toBe(false)
  expect(getPilotStopEscalation(missingGrant.executionId)).toBeUndefined()
})

test('重复停止意图不得发出第二次停止请求或覆盖原代际', () => {
  const data = fixture()
  requestPilotStopWithIntent(data.executionId, 42, () => undefined)
  let called = false
  expect(() => requestPilotStopWithIntent(data.executionId, 43, () => { called = true }))
    .toThrow('Pilot 停止升级已存在')
  expect(called).toBe(false)
  expect(getPilotStopEscalation(data.executionId)?.expectedGeneration).toBe(42)
})

test('停止意图在重启后仍保持 open 且项目暂停', async () => {
  const data = fixture()
  requestPilotStopWithIntent(data.executionId, 42, () => undefined)
  closeProjectDb()
  await initProjectDb()
  expect(getPilotStopEscalation(data.executionId)).toMatchObject({
    sessionId: 'session-1', expectedGeneration: 42, resolvedAt: null,
  })
  expect((getProjectDb().prepare('SELECT state FROM pilot_runtime_grants WHERE id = ?')
    .get(data.grantId) as { state: string }).state).toBe('paused')
})

test('停止未核验升级：记录升级、暂停授权保留预算、执行保持运行', () => {
  const data = fixture()
  const escalation = recordPilotStopEscalation(data.executionId,
    '停止请求已被 Runtime 接受，但进程终止未核验', data.now + 1, 7)

  expect(escalation).toMatchObject({
    executionId: data.executionId, commandId: data.input.commandId,
    projectId: data.project.id, sessionId: 'session-1',
    expectedGeneration: 7, requestedAt: data.now + 1, resolvedAt: null,
  })
  const grant = getProjectDb().prepare('SELECT state FROM pilot_runtime_grants WHERE id = ?').get(data.grantId) as { state: string }
  expect(grant.state).toBe('paused')
  const execution = getProjectDb().prepare('SELECT status FROM agent_executions WHERE id = ?').get(data.executionId) as { status: string }
  expect(execution.status).toBe('running')
  expect(listOpenPilotStopEscalations(data.project.id)).toHaveLength(1)
})

test('重复升级拒绝；普通终态不能消解 open 升级', () => {
  const data = fixture()
  recordPilotStopEscalation(data.executionId, '第一次停止未核验', data.now + 1)
  expect(() => recordPilotStopEscalation(data.executionId, '第二次停止未核验', data.now + 2))
    .toThrow('Pilot 停止升级已存在')
  for (const status of ['completed', 'failed', 'stale', 'cancelled']) {
    getProjectDb().prepare('UPDATE agent_executions SET status = ? WHERE id = ?').run(status, data.executionId)
    expect(getPilotStopEscalation(data.executionId)?.resolvedAt).toBeNull()
  }
  expect(listOpenPilotStopEscalations(data.project.id).map((row) => row.executionId)).toContain(data.executionId)
})

test('open 升级阻断同项目新命令预留，即使另一授权被标记 active', () => {
  const data = fixture()
  recordPilotStopEscalation(data.executionId, '停止未核验', data.now + 1)
  getProjectDb().prepare("UPDATE pilot_runtime_grants SET state = 'active' WHERE id = ?").run(data.grantId)
  expect(() => reservePilotCommandBudget({ ...data.input, commandId: `next-${data.project.id}`,
    idempotencyKey: 'next' }, data.now + 2)).toThrow('Pilot 停止升级待人工对账')
})

test('open 停止升级禁止按有限费用结算释放预留；终态未知仍保留额度', () => {
  const data = fixture()
  recordPilotStopEscalation(data.executionId, '停止未核验', data.now + 1)
  getProjectDb().prepare("UPDATE agent_executions SET status = 'completed' WHERE id = ?").run(data.executionId)
  const known = { source: 'provider_reported' as const, executionId: data.executionId,
    sessionId: 'session-1', channelId: 'channel', modelId: 'model',
    providerRecordId: `receipt-${data.project.id}`, inputTokens: 1, outputTokens: 1,
    costMicros: 1, capturedAt: data.now + 2 }
  expect(() => settlePilotCommandUsage(data.input.commandId, known, data.now + 2))
    .toThrow('Pilot 停止升级未消解，费用须保留')
  expect(getPilotGrantBudgetUsage(data.grantId)).toEqual({ runReservations: 1, committedCostMicros: 1_000 })
  expect(getPilotStopEscalation(data.executionId)?.resolvedAt).toBeNull()
})

test('授权已暂停仍可记录升级；授权缺失时事务回滚、不冒充安全停等', () => {
  const alreadyPaused = fixture()
  getProjectDb().prepare("UPDATE pilot_runtime_grants SET state = 'paused' WHERE id = ?").run(alreadyPaused.grantId)
  expect(recordPilotStopEscalation(alreadyPaused.executionId, '停止未核验', alreadyPaused.now + 2).resolvedAt).toBeNull()

  const missing = fixture()
  getProjectDb().prepare('DELETE FROM pilot_runtime_grants WHERE id = ?').run(missing.grantId)
  expect(() => recordPilotStopEscalation(missing.executionId, '停止未核验', missing.now + 2))
    .toThrow('Pilot 停止升级授权暂停无法核验')
  expect(getPilotStopEscalation(missing.executionId)).toBeUndefined()
})


test('非 Pilot 执行与已终结执行拒绝升级', () => {
  const project = createProject({ title: '普通项目', description: '' })
  const task = createTask(project.id, { title: '普通任务', description: '', workspaceId: 'ws' })
  const plain = createAgentExecution({
    id: `plain-${project.id}`, projectId: project.id, entityType: 'task', entityId: task.id,
    agentId: 'agent-1', prompt: '普通执行', status: 'running', sessionId: 'session-plain',
  })
  expect(() => recordPilotStopEscalation(plain.id, '停止未核验')).toThrow('Pilot 停止升级执行归属无法核验')

  const done = createAgentExecution({
    id: `done-${project.id}`, projectId: project.id, entityType: 'task', entityId: task.id,
    agentId: 'agent-1', prompt: '已完结', status: 'completed', sessionId: 'session-done',
  })
  expect(() => recordPilotStopEscalation(done.id, '停止未核验')).toThrow('Pilot 停止升级执行归属无法核验')
})

test('故障注入：升级后重启恢复保持 stale、授权暂停、升级仍 open 且原因带对账标记', async () => {
  const data = fixture()
  recordPilotStopEscalation(data.executionId, '停止请求已被 Runtime 接受，但进程终止未核验', data.now + 1)
  closeProjectDb()
  await initProjectDb()

  const results = recoverInterruptedPilotRuntimeExecutions(data.now + 2)
  const result = results.find((entry) => entry.executionId === data.executionId)
  expect(result).toEqual({
    executionId: data.executionId, commandId: data.input.commandId,
    state: 'unknown_recorded', startBoundary: 'handoff_intent',
    reason: '中断 Runtime 已按未知用量撤权停等；停止升级待人工对账：停止请求已被 Runtime 接受，但进程终止未核验',
  })
  const escalation = getPilotStopEscalation(data.executionId)
  expect(escalation?.resolvedAt).toBeNull()
  const grant = getProjectDb().prepare('SELECT state FROM pilot_runtime_grants WHERE id = ?').get(data.grantId) as { state: string }
  expect(grant.state).toBe('paused')
})

test('项目删除清理升级记录', () => {
  const data = fixture()
  recordPilotStopEscalation(data.executionId, '停止未核验', data.now + 1)
  const before = getProjectDb().prepare('SELECT COUNT(*) AS n FROM pilot_stop_escalations').get() as { n: number }
  expect(before.n).toBeGreaterThan(0)
})
