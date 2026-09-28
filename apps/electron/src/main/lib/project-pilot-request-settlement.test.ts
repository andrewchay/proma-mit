import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeProjectDb, createProject, createTask, getProjectDb, initProjectDb } from './project-sqlite-store'
import { claimPilotCommandStart, hashPilotTaskSource, reserveAndQueuePilotCommand } from './project-pilot-budget-ledger'
import { insertPilotGrantFixture } from './project-pilot-test-helpers'
import { registerPilotPriceEvidenceForTests } from './project-pilot-request-evidence'
import { reservePilotRequest } from './project-pilot-request-reservation'
import { markPilotRequestNeedsReconcile, settlePilotRequestUsage } from './project-pilot-request-settlement'
import type { PilotRequestEnvelope } from './project-pilot-request-envelope'

const FINGERPRINT_A = 'a'.repeat(64)
const FINGERPRINT_B = 'b'.repeat(64)
const FINGERPRINT_C = 'c'.repeat(64)

registerPilotPriceEvidenceForTests({
  evidenceId: 'approved-v1', providerKind: 'openai', model: 'model-a',
  inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, extraCostCeilingMicros: 0,
  maxModelInputTokens: 10_000, maxModelOutputTokens: 10_000, reviewedAt: '2026-09-28', source: 'test-fixture',
})

const dir = mkdtempSync(join(tmpdir(), 'pilot-request-settle-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = dir; await initProjectDb() })
afterAll(() => {
  closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(dir, { recursive: true, force: true })
})

const envelope: PilotRequestEnvelope = {
  inputTokenCeiling: 100, outputTokenCeiling: 100,
  inputRateMicrosPerMillion: 1_000_000, outputRateMicrosPerMillion: 1_000_000,
  extraCostCeilingMicros: 0, priceEvidenceId: 'approved-v1', requestEvidenceId: FINGERPRINT_A,
}

function fixture() {
  const project = createProject({ title: '结算', description: '' })
  const task = createTask(project.id, { title: '任务', description: '', workspaceId: 'workspace-a',
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  const grantId = `grant-${project.id}`
  insertPilotGrantFixture({ grantId, projectId: project.id, state: 'active', workspaceId: 'workspace-a',
    channelId: 'channel-a', modelId: 'glm-5.3-flash', maxCostMicros: 1000, maxRuns: 2,
    maxRework: 0, expiresAt: Date.now() + 100000, createdAt: Date.now() })
  const commandId = `cmd-${project.id}`
  const executionId = `exec-${project.id}`
  reserveAndQueuePilotCommand({ commandId, projectId: project.id, grantId, idempotencyKey: 'run',
    taskId: task.id, sourceVersion: task.updatedAt, sourceHash: hashPilotTaskSource(task),
    employeeId: 'executor', role: 'executor', reworkOrdinal: 0 }, { executionId, prompt: '执行' })
  claimPilotCommandStart(executionId, commandId, 1, 'session-a')
  return { commandId, executionId }
}

function row(requestId: string) {
  return getProjectDb().prepare(`SELECT state, reserved_cost_micros AS reserved, settled_cost_micros AS settled
    FROM pilot_request_reservations WHERE request_id = ?`).get(requestId) as
    { state: string; reserved: number; settled: number | null } | undefined
}

test('Given 实际用量低于预留 When 结算 Then settled 按实际计费并释放差额', () => {
  const { commandId, executionId } = fixture()
  const base = { commandId, executionId, sessionId: 'session-a', envelope }
  expect(reservePilotRequest({ ...base, requestId: 'settle-1' })).toBe(200)
  const result = settlePilotRequestUsage('settle-1', { promptTokens: 50, completionTokens: 20 })
  expect(result).toEqual({ outcome: 'settled', settledCostMicros: 70 })
  expect(row('settle-1')).toEqual({ state: 'settled', reserved: 200, settled: 70 })
  // 释放后可再预留：500 − 70 实际 − 200 新预留 = 230 余量；300 的第三笔应被拒。
  expect(reservePilotRequest({ ...base, requestId: 'settle-2', envelope: { ...envelope, requestEvidenceId: FINGERPRINT_B } })).toBe(200)
  expect(() => reservePilotRequest({ ...base, requestId: 'settle-3', envelope: { ...envelope, requestEvidenceId: FINGERPRINT_C, inputTokenCeiling: 150, outputTokenCeiling: 150 } }))
    .toThrow('超过可用额度')
})

test('Given 实际用量超出预留 When 结算 Then 转 needs_reconcile 且占额不释放', () => {
  const { commandId, executionId } = fixture()
  const base = { commandId, executionId, sessionId: 'session-a', envelope }
  expect(reservePilotRequest({ ...base, requestId: 'over-1' })).toBe(200)
  const result = settlePilotRequestUsage('over-1', { promptTokens: 150, completionTokens: 100 })
  expect(result).toEqual({ outcome: 'needs_reconcile', reason: '实际用量费用超过预留上界' })
  expect(row('over-1')?.state).toBe('needs_reconcile')
  // 占额保持 200：剩余 300，299 仍可预留、302 被拒。
  expect(reservePilotRequest({ ...base, requestId: 'over-2', envelope: { ...envelope, requestEvidenceId: FINGERPRINT_B, inputTokenCeiling: 149, outputTokenCeiling: 150 } }))
    .toBe(299)
  expect(() => reservePilotRequest({ ...base, requestId: 'over-3', envelope: { ...envelope, requestEvidenceId: FINGERPRINT_C, inputTokenCeiling: 151, outputTokenCeiling: 151 } }))
    .toThrow('超过可用额度')
})

test('Given 幂等与非法输入 When 结算 Then 已结算返回原值、待对账不改判、异常输入拒绝', () => {
  const { commandId, executionId } = fixture()
  const base = { commandId, executionId, sessionId: 'session-a', envelope }
  expect(reservePilotRequest({ ...base, requestId: 'idem-1' })).toBe(200)
  expect(settlePilotRequestUsage('idem-1', { promptTokens: 10, completionTokens: 10 }))
    .toEqual({ outcome: 'settled', settledCostMicros: 20 })
  expect(settlePilotRequestUsage('idem-1', { promptTokens: 99, completionTokens: 99 }))
    .toEqual({ outcome: 'settled', settledCostMicros: 20 })
  expect(() => settlePilotRequestUsage('unknown-id', { promptTokens: 1, completionTokens: 1 })).toThrow('不存在')
  expect(() => settlePilotRequestUsage('idem-1', { promptTokens: -1, completionTokens: 0 })).toThrow('用量无效')
  expect(() => settlePilotRequestUsage('', { promptTokens: 1, completionTokens: 1 })).toThrow('身份无效')
  // 已结算行不受待对账标记影响；reserved 行标记后结算被拒绝且不改判。
  markPilotRequestNeedsReconcile('idem-1')
  expect(row('idem-1')?.state).toBe('settled')
  expect(reservePilotRequest({ ...base, requestId: 'idem-2', envelope: { ...envelope, requestEvidenceId: FINGERPRINT_B } })).toBe(200)
  markPilotRequestNeedsReconcile('idem-2')
  expect(row('idem-2')?.state).toBe('needs_reconcile')
  expect(settlePilotRequestUsage('idem-2', { promptTokens: 1, completionTokens: 1 }))
    .toEqual({ outcome: 'needs_reconcile', reason: '预留此前已进入待对账，保持占额' })
})

test('Given 旧库表缺 settled 列 When 重新初始化 Then 重建迁移保留占额并支持结算状态', async () => {
  const { commandId, executionId } = fixture()
  const base = { commandId, executionId, sessionId: 'session-a', envelope }
  expect(reservePilotRequest({ ...base, requestId: 'migrate-1' })).toBe(200)
  // 模拟上一版本（de82e991）的旧表结构。
  getProjectDb().exec(`
    DROP TABLE pilot_request_reservations;
    CREATE TABLE pilot_request_reservations (
      request_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      request_evidence_id TEXT NOT NULL,
      price_evidence_id TEXT NOT NULL,
      reserved_cost_micros INTEGER NOT NULL CHECK (reserved_cost_micros > 0),
      state TEXT NOT NULL CHECK (state IN ('reserved', 'needs_reconcile')),
      created_at INTEGER NOT NULL
    );
    INSERT INTO pilot_request_reservations VALUES ('migrate-1', '${commandId}', '${executionId}', 'session-a',
      '${FINGERPRINT_A}', 'approved-v1', 200, 'reserved', 1);`)
  closeProjectDb()
  await initProjectDb()
  const columns = getProjectDb().prepare('PRAGMA table_info(pilot_request_reservations)').all() as Array<{ name: string }>
  expect(columns.some((column) => column.name === 'settled_cost_micros')).toBe(true)
  expect(row('migrate-1')).toEqual({ state: 'reserved', reserved: 200, settled: null })
  // 迁移后 CHECK 接受 settled 状态。
  expect(settlePilotRequestUsage('migrate-1', { promptTokens: 40, completionTokens: 60 }))
    .toEqual({ outcome: 'settled', settledCostMicros: 100 })
  // 唯一索引在重建后仍然存在。
  expect(getProjectDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_pilot_request_reservations_body'")
    .get()).toBeTruthy()
})
