import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'
import type { MixedBatchCommand } from './project-owner-mixed-batch-recovery'

const directory = mkdtempSync(join(tmpdir(), 'owner-mixed-batch-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))

const store = await import('./project-sqlite-store')
const recovery = await import('./project-owner-mixed-batch-recovery')

beforeAll(async () => { await store.initProjectDb() })
afterAll(() => {
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

function row(overrides: Partial<MixedBatchCommand> & Record<string, unknown>): MixedBatchCommand {
  return {
    id: 'cmd', role: 'executor', state: 'settled', execution_id: 'exec', rework_ordinal: 0,
    actual_cost_micros: 100, usage_evidence: JSON.stringify({ source: 'request_settled' }),
    execution_status: 'failed', task_id: 'task-dev',
    ...overrides,
  } as MixedBatchCommand
}

test('Given规格与评审已通过、研发失败 When评估接替 Then允许且列出需保留的已完成步骤', () => {
  const result = recovery.assessMixedBatch({
    commands: [
      row({ id: 'spec', role: 'executor', task_id: 'task-spec', execution_status: 'completed' }),
      row({ id: 'spec-review', role: 'reviewer', task_id: 'task-spec', execution_status: 'completed' }),
      row({ id: 'dev', role: 'executor', task_id: 'task-dev', execution_status: 'failed' }),
    ],
    pendingRequestReservations: 0,
    acceptedByTask: new Map([['task-spec', 'a'.repeat(64)]]),
    taskArtifactHash: new Map([['task-spec', 'a'.repeat(64)], ['task-dev', null]]),
    grantState: 'paused',
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.retainedTaskIds).toEqual(['task-spec'])
  expect(result.failedCommandIds).toEqual(['dev'])
})

test('Given同一任务有executor和reviewer两条完成命令 When评估接替 Then按任务去重', () => {
  const result = recovery.assessMixedBatch({
    commands: [
      row({ id: 'spec-exec', role: 'executor', task_id: 'task-spec', execution_status: 'completed' }),
      row({ id: 'spec-review', role: 'reviewer', task_id: 'task-spec', execution_status: 'completed' }),
      row({ id: 'dev', role: 'executor', task_id: 'task-dev' }),
    ],
    pendingRequestReservations: 0,
    acceptedByTask: new Map([['task-spec', 'a'.repeat(64)]]),
    taskArtifactHash: new Map([['task-spec', 'a'.repeat(64)], ['task-dev', null]]),
    grantState: 'paused',
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.retainedTaskIds).toEqual(['task-spec'])
})

test('Given仍有活动执行 When评估接替 Then拒绝并给出具体阻断项', () => {
  const result = recovery.assessMixedBatch({
    commands: [row({ id: 'dev', execution_status: 'running', state: 'running' })],
    pendingRequestReservations: 0, acceptedByTask: new Map(),
    taskArtifactHash: new Map([['task-dev', null]]), grantState: 'paused',
  })
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.blockers).toContain('仍有运行中或排队的命令，不能接替')
})

test('Given费用未知 When评估接替 Then拒绝并保留占额说明', () => {
  const result = recovery.assessMixedBatch({
    commands: [row({ id: 'dev', actual_cost_micros: null, usage_evidence: null })],
    pendingRequestReservations: 0, acceptedByTask: new Map(),
    taskArtifactHash: new Map([['task-dev', null]]), grantState: 'paused',
  })
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.blockers.join()).toContain('费用未知')
})

test('Given已完成任务缺少验收依据 When评估接替 Then拒绝以免重复执行', () => {
  const result = recovery.assessMixedBatch({
    commands: [row({ id: 'spec', execution_status: 'completed', task_id: 'task-spec' }), row({ id: 'dev' })],
    pendingRequestReservations: 0, acceptedByTask: new Map(),
    taskArtifactHash: new Map([['task-spec', 'b'.repeat(64)], ['task-dev', null]]), grantState: 'paused',
  })
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.blockers.join()).toContain('缺少可核对的验收依据')
})

test('Given授权待对账 When评估接替 Then拒绝并说明需先对账', () => {
  const result = recovery.assessMixedBatch({
    commands: [row({ id: 'dev' })],
    pendingRequestReservations: 0, acceptedByTask: new Map(),
    taskArtifactHash: new Map([['task-dev', null]]), grantState: 'needs_reconcile',
  })
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.blockers.join()).toContain('待对账')
})

test('Given没有失败命令 When评估接替 Then拒绝并说明无可恢复步骤', () => {
  const result = recovery.assessMixedBatch({
    commands: [row({ id: 'done', execution_status: 'completed', task_id: 'task-done' })],
    pendingRequestReservations: 0, acceptedByTask: new Map([['task-done', 'a'.repeat(64)]]),
    taskArtifactHash: new Map([['task-done', 'a'.repeat(64)]]), grantState: 'paused',
  })
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.blockers.join()).toContain('没有失败命令')
})

test('Given全部步骤失败 When准备接替 Then交回既有接替规则而不是自己接替', () => {
  // 全失败批次必须走 supersedeFailedBatch（含方案形状校验与用量结算）；
  // 混合接替只负责「部分完成、部分失败」，不能把全失败也吞掉。
  const subject = { projectId: 'project-mixed-guard' }
  expect(() => recovery.planMixedBatchSupersession(subject, 'materialization-does-not-exist'))
    .toThrow('混合批次暂不能接替')
})
