import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeProjectDb, createProject, createTask, getProjectDb, initProjectDb } from './project-sqlite-store'
import { claimPilotCommandStart, getPilotGrantBudgetUsage, hashPilotTaskSource, reserveAndQueuePilotCommand } from './project-pilot-budget-ledger'
import { insertPilotGrantFixture } from './project-pilot-test-helpers'
import { pilotRequestFingerprint, registerPilotPriceEvidenceForTests } from './project-pilot-request-evidence'
import { reservePilotRequest, verifyPilotRequestBody } from './project-pilot-request-reservation'
import type { PilotRequestEnvelope } from './project-pilot-request-envelope'

const FINGERPRINT_A = 'a'.repeat(64)
const FINGERPRINT_B = 'b'.repeat(64)
const FINGERPRINT_C = 'c'.repeat(64)

registerPilotPriceEvidenceForTests({
  evidenceId: 'approved-v1', providerKind: 'openai', model: 'model-a',
  inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, extraCostCeilingMicros: 0,
  maxModelInputTokens: 10_000, maxModelOutputTokens: 10_000, reviewedAt: '2026-09-28', source: 'test-fixture',
})

const dir = mkdtempSync(join(tmpdir(), 'pilot-request-budget-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = dir; await initProjectDb() })
afterAll(() => {
  closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const project = createProject({ title: '请求预算', description: '' })
  const task = createTask(project.id, { title: '任务', description: '', workspaceId: 'workspace-a',
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  const grantId = `grant-${project.id}`
  insertPilotGrantFixture({ grantId, projectId: project.id, state: 'active', workspaceId: 'workspace-a',
    channelId: 'channel-a', modelId: 'model-a', maxCostMicros: 1000, maxRuns: 2,
    maxRework: 0, expiresAt: Date.now() + 100000, createdAt: Date.now() })
  const commandId = `cmd-${project.id}`
  const executionId = `exec-${project.id}`
  reserveAndQueuePilotCommand({ commandId, projectId: project.id, grantId, idempotencyKey: 'run',
    taskId: task.id, sourceVersion: task.updatedAt, sourceHash: hashPilotTaskSource(task),
    employeeId: 'executor', role: 'executor', reworkOrdinal: 0 }, { executionId, prompt: '执行' })
  claimPilotCommandStart(executionId, commandId, 1, 'session-a')
  return { project, grantId, commandId, executionId }
}

const envelope: PilotRequestEnvelope = {
  inputTokenCeiling: 100, outputTokenCeiling: 100,
  inputRateMicrosPerMillion: 1_000_000, outputRateMicrosPerMillion: 1_000_000,
  extraCostCeilingMicros: 0, priceEvidenceId: 'approved-v1', requestEvidenceId: FINGERPRINT_A,
}

test('Given running 命令 When 逐请求预留 Then 不重复消耗 grant 额度且请求占额不超命令预留', () => {
  const { grantId, commandId, executionId } = fixture()
  const base = { commandId, executionId, sessionId: 'session-a', envelope }
  expect(reservePilotRequest({ ...base, requestId: 'request-1' })).toBe(200)
  expect(reservePilotRequest({ ...base, requestId: 'request-2', envelope: { ...envelope, requestEvidenceId: FINGERPRINT_B } })).toBe(200)
  expect(getPilotGrantBudgetUsage(grantId)).toEqual({ runReservations: 1, committedCostMicros: 500 })
  expect(() => reservePilotRequest({ ...base, requestId: 'request-3', envelope: { ...envelope, requestEvidenceId: FINGERPRINT_C } }))
    .toThrow('超过可用额度')
  expect(() => reservePilotRequest({ ...base, requestId: 'request-1' })).toThrow('不得重复发送')
  // 换 requestId 重发同一请求体同样被拒绝；伪造费率或上界一律与证据不一致。
  expect(() => reservePilotRequest({ ...base, requestId: 'request-4' })).toThrow('指纹已预留')
  expect(() => reservePilotRequest({ ...base, requestId: 'request-5', envelope: { ...envelope, inputRateMicrosPerMillion: 5 } }))
    .toThrow('与价格证据不一致')
  expect(() => reservePilotRequest({ ...base, requestId: 'request-6', envelope: { ...envelope, outputTokenCeiling: 10_001 } }))
    .toThrow('与价格证据不一致')
  expect(getProjectDb().prepare('SELECT COUNT(*) AS n FROM pilot_request_reservations WHERE command_id = ?')
    .get(commandId)).toEqual({ n: 2 })
})

test('Given 来源/授权失效或预算证据不全 When 预留 Then 零请求写入', () => {
  const { commandId, executionId, grantId } = fixture()
  const base = { commandId, executionId, sessionId: 'wrong-session', requestId: 'invalid-1', envelope }
  expect(() => reservePilotRequest(base)).toThrow('归属')
  expect(() => reservePilotRequest({ ...base, sessionId: 'session-a', envelope: { ...envelope, priceEvidenceId: '' } }))
    .toThrow('未审核')
  expect(() => reservePilotRequest({ ...base, sessionId: 'session-a', envelope: { ...envelope, requestEvidenceId: 'body-v1' } }))
    .toThrow('指纹无效')
  expect(() => reservePilotRequest({ ...base, sessionId: 'session-a', envelope: { ...envelope, inputTokenCeiling: Number.NaN } }))
    .toThrow('上界无效')
  expect(() => reservePilotRequest({ ...base, sessionId: 'session-a', envelope: { ...envelope, outputTokenCeiling: 0 } }))
    .toThrow('上界无效')
  getProjectDb().prepare("UPDATE pilot_runtime_grants SET state = 'paused' WHERE id = ?").run(grantId)
  expect(() => reservePilotRequest({ ...base, sessionId: 'session-a' })).toThrow('授权')
  expect(getProjectDb().prepare('SELECT COUNT(*) AS n FROM pilot_request_reservations WHERE command_id = ?')
    .get(commandId)).toEqual({ n: 0 })
})

test('Given 已预留请求在崩溃后重开库 When 请求重发 Then 保持原占额并拒绝复用 ID', async () => {
  const { commandId, executionId } = fixture()
  const request = { commandId, executionId, sessionId: 'session-a', requestId: 'crash-window', envelope }
  expect(reservePilotRequest(request)).toBe(200)
  closeProjectDb()
  await initProjectDb()
  expect(() => reservePilotRequest(request)).toThrow('不得重复发送')
  expect(() => reservePilotRequest({ ...request, requestId: 'crash-window-2' })).toThrow('指纹已预留')
  expect(getProjectDb().prepare('SELECT reserved_cost_micros, state FROM pilot_request_reservations WHERE request_id = ?')
    .get(request.requestId)).toEqual({ reserved_cost_micros: 200, state: 'reserved' })
})

test('Given 子预留写入中断 When 重试 Then 事务回滚且余额不变', () => {
  const { commandId, executionId } = fixture()
  getProjectDb().exec(`CREATE TRIGGER request_insert_abort BEFORE INSERT ON pilot_request_reservations
    BEGIN SELECT RAISE(ABORT, 'request write interrupted'); END`)
  expect(() => reservePilotRequest({ commandId, executionId, sessionId: 'session-a', requestId: 'interrupted', envelope }))
    .toThrow('request write interrupted')
  expect(getProjectDb().prepare('SELECT COUNT(*) AS n FROM pilot_request_reservations WHERE command_id = ?')
    .get(commandId)).toEqual({ n: 0 })
  getProjectDb().exec('DROP TRIGGER request_insert_abort')
  expect(reservePilotRequest({ commandId, executionId, sessionId: 'session-a', requestId: 'fresh', envelope })).toBe(200)
})

test('Given 库表初始化 When 检查并发兜底 Then 请求体指纹唯一索引必须存在', () => {
  const index = getProjectDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_pilot_request_reservations_body'")
    .get() as { name: string } | undefined
  expect(index?.name).toBe('idx_pilot_request_reservations_body')
})

test('Given 请求已预留 When 发送前核验请求体 Then 指纹一致放行、被篡改或未预留一律拒绝', () => {
  const { commandId, executionId } = fixture()
  const body = '{"model":"model-a","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
  const boundEnvelope = { ...envelope, requestEvidenceId: pilotRequestFingerprint(body) }
  expect(reservePilotRequest({ commandId, executionId, sessionId: 'session-a', requestId: 'send-check', envelope: boundEnvelope })).toBe(200)
  expect(() => verifyPilotRequestBody('send-check', body)).not.toThrow()
  expect(() => verifyPilotRequestBody('send-check', `${body.slice(0, -2)}!}`)).toThrow('指纹不一致')
  expect(() => verifyPilotRequestBody('unknown-request', body)).toThrow('预留不存在')
  expect(() => verifyPilotRequestBody('', body)).toThrow('身份无效')
})
