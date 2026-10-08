import { describe, expect, test } from 'bun:test'
import type { VerificationArtifactRevision, VerificationReceipt } from '../types/index.ts'
import { parseVerificationArtifactRevision, parseVerificationReceipt } from './verification.ts'

const now = 10_000
const subject = {
  workspaceId: 'workspace-1', sessionId: 'session-1', runId: 'run-1', agentGoalId: 'goal-1',
  projectId: 'project-1', taskId: 'task-1', executionId: 'execution-1',
}
const options = { now, expectedSubject: subject }

function artifact(): VerificationArtifactRevision {
  return {
    version: 1, artifactId: 'snapshot-1', subject: { ...subject },
    baseRevision: 'a'.repeat(40), contentHash: 'b'.repeat(64), scopeHash: 'c'.repeat(64),
    capturedAt: 7_000, evidenceRef: 'snapshot:snapshot-1',
  }
}

function receipt(): VerificationReceipt {
  return {
    version: 1, receiptId: 'receipt-1', subject: { ...subject }, criteriaId: 'criterion-1',
    verifier: { id: 'bun-test', version: '1', configHash: 'd'.repeat(64), kind: 'test' },
    artifact: artifact(), toolCallId: 'tool-1', startedAt: 8_000, finishedAt: 9_000,
    exitCode: 0, result: 'passed', checksCollected: 3,
    evidenceRef: 'verification:receipt-1', source: 'main-process',
  }
}

describe('验证回执契约：只解码，不授予信任或业务完成', () => {
  test('合法回执可JSON往返，返回独立副本', () => {
    const input = receipt()
    const parsed = parseVerificationReceipt(JSON.parse(JSON.stringify(input)), options)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.errors.join('; '))
    expect(parsed.value).toEqual(input)
    input.artifact.contentHash = 'e'.repeat(64)
    expect(parsed.value.artifact.contentHash).toBe('b'.repeat(64))
    expect(parsed.value).not.toHaveProperty('trusted')
    expect(parsed.value).not.toHaveProperty('accepted')
  })

  test('产物修订可单独解析；非Git基线拒绝', () => {
    expect(parseVerificationArtifactRevision(artifact(), options).ok).toBe(true)
    expect(parseVerificationArtifactRevision({ ...artifact(), baseRevision: 'main' }, options).ok).toBe(false)
  })

  for (const field of ['workspaceId', 'sessionId', 'runId', 'agentGoalId', 'projectId', 'taskId', 'executionId'] as const) {
    test(`不同${field}的回执不互认`, () => {
      const input = receipt()
      input.subject[field] = 'other'
      expect(parseVerificationReceipt(input, options).ok).toBe(false)
    })
    test(`产物的${field}错配同样拒绝`, () => {
      const input = receipt()
      input.artifact.subject[field] = 'other'
      expect(parseVerificationReceipt(input, options).ok).toBe(false)
    })
  }

  test('无业务任务的AgentGoal允许省略业务身份，但不能与任务身份混用', () => {
    const standalone = { workspaceId: 'workspace-1', sessionId: 'session-1', runId: 'run-1', agentGoalId: 'goal-1' }
    const input = { ...receipt(), subject: standalone, artifact: { ...artifact(), subject: standalone } }
    expect(parseVerificationReceipt(input, { now, expectedSubject: standalone }).ok).toBe(true)
    expect(parseVerificationReceipt(input, options).ok).toBe(false)
    expect(parseVerificationReceipt(receipt(), { now, expectedSubject: standalone }).ok).toBe(false)
  })

  test('部分业务身份、额外身份字段和空身份拒绝', () => {
    const input = receipt()
    const { executionId: _executionId, ...partial } = input.subject
    expect(parseVerificationReceipt({ ...input, subject: partial }, options).ok).toBe(false)
    expect(parseVerificationReceipt({ ...input, subject: { ...subject, actor: 'system' } }, options).ok).toBe(false)
    expect(parseVerificationReceipt({ ...input, subject: { ...subject, runId: ' ' } }, options).ok).toBe(false)
  })

  test('缺字段、未知schema版本、数组、空值、额外trusted声明拒绝', () => {
    const { criteriaId: _criteriaId, ...missing } = receipt()
    for (const input of [null, [], {}, missing, { ...receipt(), version: 2 }, { ...receipt(), trusted: true }]) {
      expect(parseVerificationReceipt(input, options).ok).toBe(false)
    }
  })

  test('unknown/failed/skipped保留，不转换为passed', () => {
    for (const result of ['unknown', 'failed', 'skipped'] as const) {
      const parsed = parseVerificationReceipt({ ...receipt(), result, exitCode: null, checksCollected: null }, options)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.value.result).toBe(result)
    }
  })

  test('passed必须实际退出0；null、非0、非整数退出码拒绝', () => {
    for (const exitCode of [null, 1, -1, 0.5, Number.NaN]) {
      expect(parseVerificationReceipt({ ...receipt(), exitCode }, options).ok).toBe(false)
    }
  })

  test('测试passed必须有正的收集数，不认零收集或未知收集', () => {
    for (const checksCollected of [null, 0, -1, 1.5, Number.NaN]) {
      expect(parseVerificationReceipt({ ...receipt(), checksCollected }, options).ok).toBe(false)
    }
    const command = { ...receipt(), verifier: { ...receipt().verifier, kind: 'command' }, checksCollected: null }
    expect(parseVerificationReceipt(command, options).ok).toBe(true)
  })

  test('未来时间、倒序、验证开始之后的产物捕获和非法时钟拒绝', () => {
    for (const input of [
      { ...receipt(), finishedAt: now + 1 },
      { ...receipt(), startedAt: 9_001 },
      { ...receipt(), startedAt: -1 },
      { ...receipt(), artifact: { ...artifact(), capturedAt: 8_001 } },
      { ...receipt(), finishedAt: Number.POSITIVE_INFINITY },
      { ...receipt(), startedAt: 1.5 },
    ]) expect(parseVerificationReceipt(input, options).ok).toBe(false)
    expect(parseVerificationReceipt(receipt(), { ...options, now: Number.NaN }).ok).toBe(false)
  })

  test('hash、验证器、工具引用和来源不合规范时拒绝', () => {
    for (const input of [
      { ...receipt(), artifact: { ...artifact(), contentHash: 'not-a-hash' } },
      { ...receipt(), artifact: { ...artifact(), scopeHash: 'b'.repeat(63) } },
      { ...receipt(), verifier: { ...receipt().verifier, configHash: '' } },
      { ...receipt(), verifier: { ...receipt().verifier, kind: 'llm' } },
      { ...receipt(), toolCallId: '' },
      { ...receipt(), evidenceRef: '' },
      { ...receipt(), source: 'model' },
      { ...receipt(), result: 'accepted' },
    ]) expect(parseVerificationReceipt(input, options).ok).toBe(false)
  })

  test('非字符串result及从原型继承的伪JSON对象拒绝', () => {
    expect(parseVerificationReceipt({ ...receipt(), result: { toString: () => 'passed' } }, options).ok).toBe(false)
    expect(parseVerificationReceipt(Object.create(receipt()), options).ok).toBe(false)
    expect(parseVerificationArtifactRevision(Object.create(artifact()), options).ok).toBe(false)
  })

  test('无效expectedSubject也fail-closed，而不是宽松匹配', () => {
    expect(parseVerificationReceipt(receipt(), { now, expectedSubject: { ...subject, taskId: '' } }).ok).toBe(false)
  })
})
