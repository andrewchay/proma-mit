import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimPilotCommandStart, hashPilotTaskSource, recordPilotRunnerHandoffIntent, reserveAndQueuePilotCommand } from './project-pilot-budget-ledger'
import { recoverInterruptedPilotRuntimeExecutions } from './project-pilot-runtime-recovery'
import {
  getPilotStopEscalation, listOpenPilotStopEscalations,
  recordPilotStopEscalation, resolvePilotStopEscalation,
} from './project-pilot-stop-escalation'
import { insertPilotGrantFixture } from './project-pilot-test-helpers'
import { closeProjectDb, createAgentExecution, createProject, createTask, getProjectDb, initProjectDb } from './project-sqlite-store'

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

test('同一执行重复升级被拒绝；消解后也不能再次升级', () => {
  const data = fixture()
  recordPilotStopEscalation(data.executionId, '第一次停止未核验', data.now + 1)
  expect(() => recordPilotStopEscalation(data.executionId, '第二次停止未核验', data.now + 2))
    .toThrow('Pilot 停止升级已存在')

  resolvePilotStopEscalation(data.executionId, 'Runtime 停止完成', 'stoppedByUser=true', data.now + 3)
  expect(() => recordPilotStopEscalation(data.executionId, '停止未核验', data.now + 4))
    .toThrow('Pilot 停止升级已消解，不能重复升级')
})

test('消解要求结论与证据；重复消解被拒绝', () => {
  const data = fixture()
  recordPilotStopEscalation(data.executionId, '停止未核验', data.now + 1)
  expect(() => resolvePilotStopEscalation(data.executionId, '', 'evidence', data.now + 2)).toThrow('Pilot 停止升级消解结论无效')
  expect(() => resolvePilotStopEscalation(data.executionId, 'ok', '', data.now + 2)).toThrow('Pilot 停止升级消解证据无效')

  const resolved = resolvePilotStopEscalation(data.executionId, '停止已核验', 'processTermination=VERIFIED', data.now + 2)
  expect(resolved.resolvedAt).toBe(data.now + 2)
  expect(resolved.resolution).toBe('停止已核验')
  expect(() => resolvePilotStopEscalation(data.executionId, '再次消解', 'x', data.now + 3)).toThrow('Pilot 停止升级已消解')
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
