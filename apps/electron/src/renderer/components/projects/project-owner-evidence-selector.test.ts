import { expect, test } from 'bun:test'
import type { OwnerExecutionCommandView } from '@gravitas/shared'
import { selectEvidenceCommands } from './project-owner-evidence-selector'

const cmd = (over: Partial<OwnerExecutionCommandView>): OwnerExecutionCommandView => ({
  commandId: 'c', grantId: 'g', taskId: 't', taskTitle: '任务', employeeId: 'e', role: 'executor',
  reworkOrdinal: 0, state: 'settled', executionId: 'x', executionStatus: 'failed',
  acceptanceCriteria: [], reservedCostMicros: 1, actualCostMicros: 1,
  grantAuthorization: { grantState: 'paused', dispatchMode: 'autonomous', maxCostMicros: 1, maxRuns: 1, maxRework: 0, expiresAt: 1, roleBudgetCaps: [] },
  ackFingerprint: 'a'.repeat(64), createdAt: 1, updatedAt: 1,
  // 默认带一份终态证据，便于各用例只关注单个维度；「没有证据」的用例显式传 undefined。
  terminalEvidence: {
    schemaVersion: 1, executionId: 'x', commandId: 'c', role: 'executor', executionStatus: 'failed',
    provider: null, reason: 'provider_stop', detail: '失败说明',
    tools: { calls: 0, results: 0, lastToolName: null, lastResultStatus: null, incompleteBatch: false },
    cost: { state: 'settled', actualCostMicros: 1, requestCount: 1 }, development: null, capturedAt: 1,
  },
  ...over,
})

test('Given失败命令 When选择证据 Then包含它', () => {
  const result = selectEvidenceCommands([cmd({ commandId: 'failed', executionStatus: 'failed' })])
  expect(result.map(c => c.commandId)).toEqual(['failed'])
})

test('Given完成命令 When选择证据 Then也包含它', () => {
  const result = selectEvidenceCommands([cmd({ commandId: 'done', executionStatus: 'completed' })])
  expect(result.map(c => c.commandId)).toEqual(['done'])
})

test('Given运行中或排队命令 When选择证据 Then排除它们', () => {
  const result = selectEvidenceCommands([
    cmd({ commandId: 'running', executionStatus: 'running' }),
    cmd({ commandId: 'queued', executionStatus: 'queued' }),
  ])
  expect(result).toEqual([])
})

test('Given没有证据的命令 When选择 Then排除', () => {
  const result = selectEvidenceCommands([cmd({ commandId: 'no-evidence', terminalEvidence: undefined })])
  expect(result).toEqual([])
})

test('Given多个终态命令 When选择 Then按更新时间倒序', () => {
  const result = selectEvidenceCommands([
    cmd({ commandId: 'old', updatedAt: 1 }),
    cmd({ commandId: 'new', updatedAt: 9 }),
  ])
  expect(result.map(c => c.commandId)).toEqual(['new', 'old'])
})
