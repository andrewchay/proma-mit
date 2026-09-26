import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashPilotTaskSource, reserveAndQueuePilotCommand, reservePilotCommandBudget } from './project-pilot-budget-ledger'
import { inspectPilotGrantRecovery } from './project-pilot-recovery'
import { insertPilotGrantFixture } from './project-pilot-test-helpers'
import { closeProjectDb, createAgentExecution, createProject, createTask, getProjectDb, initProjectDb, updateAgentExecution } from './project-sqlite-store'

const root = mkdtempSync(join(tmpdir(), 'project-pilot-recovery-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = root; await initProjectDb() })
afterAll(() => {
  closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const project = createProject({ title: '恢复对账项目', description: '' })
  const task = createTask(project.id, { title: '研发任务', description: '', workspaceId: 'pilot-workspace',
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  const grantId = `grant-${project.id}`
  const now = Date.now()
  insertPilotGrantFixture({ grantId, projectId: project.id, workspaceId: 'pilot-workspace',
    channelId: 'channel', modelId: 'model', maxCostMicros: 1_000, maxRuns: 1,
    maxRework: 0, expiresAt: now + 100_000, createdAt: now })
  const input = { commandId: `command-${project.id}`, projectId: project.id, grantId, idempotencyKey: 'first',
    taskId: task.id, sourceVersion: task.updatedAt, sourceHash: hashPilotTaskSource(task),
    employeeId: 'executor', role: 'executor' as const, reworkOrdinal: 0, reservedCostMicros: 600 }
  return { project, grantId, input, executionId: `execution-${project.id}`, now }
}

test('重启后只把完整预留和排队项列为需重检，不自动认领或重派', async () => {
  const { grantId, input, executionId, now } = fixture()
  reservePilotCommandBudget(input)
  expect(inspectPilotGrantRecovery(grantId, now)).toEqual({
    grantId, projectId: input.projectId, grantState: 'active',
    reservedRecheckCommandIds: [input.commandId], queuedRecheckExecutionIds: [], needsAttention: [],
  })
  closeProjectDb()
  await initProjectDb()
  reserveAndQueuePilotCommand(input, { executionId, prompt: '研发任务' })
  closeProjectDb()
  await initProjectDb()
  expect(inspectPilotGrantRecovery(grantId, now).queuedRecheckExecutionIds).toEqual([executionId])
  const row = getProjectDb().prepare('SELECT state FROM pilot_commands WHERE id = ?')
    .get(input.commandId) as { state: string }
  expect(row.state).toBe('queued')
})

test('授权过期或暂停、来源关联破损均需人工对账', () => {
  const expired = fixture()
  reservePilotCommandBudget(expired.input)
  expect(inspectPilotGrantRecovery(expired.grantId, expired.now + 200_000).needsAttention)
    .toEqual([{ commandId: expired.input.commandId, reason: '预留命令的授权已暂停或过期' }])
  const queued = fixture()
  reserveAndQueuePilotCommand(queued.input, { executionId: queued.executionId, prompt: '研发任务' })
  getProjectDb().prepare('DELETE FROM pilot_command_links WHERE command_id = ?').run(queued.input.commandId)
  expect(inspectPilotGrantRecovery(queued.grantId).needsAttention)
    .toEqual([{ commandId: queued.input.commandId, reason: '排队命令的授权、来源或执行关联无法核验' }])
  getProjectDb().prepare("UPDATE pilot_runtime_grants SET state = 'paused' WHERE id = ?").run(queued.grantId)
  expect(inspectPilotGrantRecovery(queued.grantId).queuedRecheckExecutionIds).toEqual([])
})

test('运行结果未知与终结状态矛盾都不能被归入可重检队列', () => {
  const running = fixture()
  reserveAndQueuePilotCommand(running.input, { executionId: running.executionId, prompt: '研发任务' })
  updateAgentExecution(running.executionId, { status: 'running', sessionId: 'session-1' })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'running' WHERE id = ?").run(running.input.commandId)
  expect(inspectPilotGrantRecovery(running.grantId).needsAttention)
    .toEqual([{ commandId: running.input.commandId, reason: '运行结果或费用未知，需人工对账' }])
  const inconsistent = fixture()
  reserveAndQueuePilotCommand(inconsistent.input, { executionId: inconsistent.executionId, prompt: '研发任务' })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'released', actual_cost_micros = 0 WHERE id = ?").run(inconsistent.input.commandId)
  expect(inspectPilotGrantRecovery(inconsistent.grantId).needsAttention)
    .toEqual([{ commandId: inconsistent.input.commandId, reason: '终结命令与执行状态不一致' }])
})

test('已释放命令若仍有孤儿执行归属，恢复时不能误判为干净', () => {
  const fixtureData = fixture()
  reservePilotCommandBudget(fixtureData.input)
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'released', actual_cost_micros = 0 WHERE id = ?").run(fixtureData.input.commandId)
  createAgentExecution({ id: fixtureData.executionId, projectId: fixtureData.project.id,
    entityType: 'task', entityId: fixtureData.input.taskId, agentId: 'executor', sessionId: '',
    prompt: '异常孤儿执行', pilotCommandId: fixtureData.input.commandId })
  expect(inspectPilotGrantRecovery(fixtureData.grantId).needsAttention)
    .toEqual([{ commandId: fixtureData.input.commandId, reason: '终结命令的执行归属无法核验' }])
})

test('仅取消且未记录 session 的关联执行可作为已释放命令状态对账', () => {
  const data = fixture()
  reserveAndQueuePilotCommand(data.input, { executionId: data.executionId, prompt: '研发任务' })
  updateAgentExecution(data.executionId, { status: 'cancelled', completedAt: Date.now() })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'released', actual_cost_micros = 0 WHERE id = ?").run(data.input.commandId)
  expect(inspectPilotGrantRecovery(data.grantId).needsAttention).toEqual([])
  getProjectDb().prepare('DELETE FROM pilot_command_links WHERE command_id = ?').run(data.input.commandId)
  expect(inspectPilotGrantRecovery(data.grantId).needsAttention)
    .toEqual([{ commandId: data.input.commandId, reason: '终结命令的来源关联无法核验' }])
  updateAgentExecution(data.executionId, { status: 'completed', sessionId: 'session-1' })
  expect(inspectPilotGrantRecovery(data.grantId).needsAttention)
    .toEqual([{ commandId: data.input.commandId, reason: '终结命令与执行状态不一致' }])
})

test('费用与命令状态矛盾时必须停等，不能按零费用或完整预留继续', () => {
  const reserved = fixture()
  reservePilotCommandBudget(reserved.input)
  getProjectDb().prepare('UPDATE pilot_commands SET actual_cost_micros = 20 WHERE id = ?').run(reserved.input.commandId)
  expect(inspectPilotGrantRecovery(reserved.grantId).needsAttention)
    .toEqual([{ commandId: reserved.input.commandId, reason: '命令费用与状态不一致' }])

  const released = fixture()
  reservePilotCommandBudget(released.input)
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'released', actual_cost_micros = 20 WHERE id = ?")
    .run(released.input.commandId)
  expect(inspectPilotGrantRecovery(released.grantId).needsAttention)
    .toEqual([{ commandId: released.input.commandId, reason: '命令费用与状态不一致' }])

  const settled = fixture()
  reserveAndQueuePilotCommand(settled.input, { executionId: settled.executionId, prompt: '研发任务' })
  updateAgentExecution(settled.executionId, { status: 'completed', sessionId: 'session-1', completedAt: Date.now() })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'settled', actual_cost_micros = NULL WHERE id = ?")
    .run(settled.input.commandId)
  expect(inspectPilotGrantRecovery(settled.grantId).needsAttention)
    .toEqual([{ commandId: settled.input.commandId, reason: '命令费用与状态不一致' }])

  const legacySettled = fixture()
  reserveAndQueuePilotCommand(legacySettled.input, { executionId: legacySettled.executionId, prompt: '研发任务' })
  updateAgentExecution(legacySettled.executionId, { status: 'completed', sessionId: 'session-1', completedAt: Date.now() })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'settled', actual_cost_micros = 20, usage_evidence = NULL WHERE id = ?")
    .run(legacySettled.input.commandId)
  expect(inspectPilotGrantRecovery(legacySettled.grantId).needsAttention)
    .toEqual([{ commandId: legacySettled.input.commandId, reason: '结算用量证据缺失或无效' }])

  const tamperedSettled = fixture()
  reserveAndQueuePilotCommand(tamperedSettled.input, { executionId: tamperedSettled.executionId, prompt: '研发任务' })
  updateAgentExecution(tamperedSettled.executionId, { status: 'completed', sessionId: 'session-1', completedAt: Date.now() })
  const evidence = JSON.stringify({
    source: 'provider_reported', executionId: tamperedSettled.executionId, sessionId: 'session-1',
    channelId: 'channel', modelId: 'model', providerRecordId: `provider-${tamperedSettled.executionId}`,
    inputTokens: 10, outputTokens: 2, costMicros: 20, capturedAt: Date.now(),
  })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'settled', actual_cost_micros = 21, usage_evidence = ? WHERE id = ?")
    .run(evidence, tamperedSettled.input.commandId)
  expect(inspectPilotGrantRecovery(tamperedSettled.grantId).needsAttention)
    .toEqual([{ commandId: tamperedSettled.input.commandId, reason: '结算用量证据与账本金额不一致' }])

  const unknownSettled = fixture()
  reserveAndQueuePilotCommand(unknownSettled.input, { executionId: unknownSettled.executionId, prompt: '研发任务' })
  updateAgentExecution(unknownSettled.executionId, { status: 'completed', sessionId: 'session-1', completedAt: Date.now() })
  const unknownEvidence = JSON.stringify({
    source: 'unknown', executionId: unknownSettled.executionId, sessionId: 'session-1',
    channelId: 'channel', modelId: 'model', reason: 'Provider 未返回用量', capturedAt: Date.now(),
  })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'settled', actual_cost_micros = 20, usage_evidence = ? WHERE id = ?")
    .run(unknownEvidence, unknownSettled.input.commandId)
  expect(inspectPilotGrantRecovery(unknownSettled.grantId).needsAttention)
    .toEqual([{ commandId: unknownSettled.input.commandId, reason: '结算用量证据与账本金额不一致' }])

  const futureSettled = fixture()
  reserveAndQueuePilotCommand(futureSettled.input, { executionId: futureSettled.executionId, prompt: '研发任务' })
  updateAgentExecution(futureSettled.executionId, { status: 'completed', sessionId: 'session-1', completedAt: Date.now() })
  const futureEvidence = JSON.stringify({
    source: 'provider_reported', executionId: futureSettled.executionId, sessionId: 'session-1',
    channelId: 'channel', modelId: 'model', providerRecordId: `provider-${futureSettled.executionId}`,
    inputTokens: 10, outputTokens: 2, costMicros: 20, capturedAt: Date.now() + 10_000,
  })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'settled', actual_cost_micros = 20, usage_evidence = ? WHERE id = ?")
    .run(futureEvidence, futureSettled.input.commandId)
  expect(inspectPilotGrantRecovery(futureSettled.grantId).needsAttention)
    .toEqual([{ commandId: futureSettled.input.commandId, reason: '结算用量证据缺失或无效' }])

  const changedOwner = fixture()
  reserveAndQueuePilotCommand(changedOwner.input, { executionId: changedOwner.executionId, prompt: '研发任务' })
  updateAgentExecution(changedOwner.executionId, { status: 'completed', sessionId: 'session-1', completedAt: Date.now() })
  const ownerEvidence = JSON.stringify({
    source: 'provider_reported', executionId: changedOwner.executionId, sessionId: 'session-1',
    channelId: 'channel', modelId: 'model', providerRecordId: `provider-${changedOwner.executionId}`,
    inputTokens: 10, outputTokens: 2, costMicros: 20, capturedAt: Date.now(),
  })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'settled', actual_cost_micros = 20, usage_evidence = ? WHERE id = ?")
    .run(ownerEvidence, changedOwner.input.commandId)
  getProjectDb().prepare('UPDATE agent_executions SET agent_id = ? WHERE id = ?').run('other-agent', changedOwner.executionId)
  expect(inspectPilotGrantRecovery(changedOwner.grantId).needsAttention)
    .toEqual([{ commandId: changedOwner.input.commandId, reason: '终结命令与执行状态不一致' }])
})

test('命令行丢失时仍扫描同项目 Pilot 执行与关联，不能返回空安全快照', () => {
  const data = fixture()
  reserveAndQueuePilotCommand(data.input, { executionId: data.executionId, prompt: '研发任务' })
  getProjectDb().prepare('DELETE FROM pilot_commands WHERE id = ?').run(data.input.commandId)
  const snapshot = inspectPilotGrantRecovery(data.grantId)
  expect(snapshot.queuedRecheckExecutionIds).toEqual([])
  expect(snapshot.needsAttention)
    .toEqual([{ commandId: data.input.commandId, reason: '项目存在无账本命令的 Pilot 执行或来源关联' }])
})
