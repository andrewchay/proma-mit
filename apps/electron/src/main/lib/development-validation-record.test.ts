import { describe, expect, test } from 'bun:test'
import type { DevelopmentValidationResult } from '@gravitas/shared'
import { parseDevelopmentValidationRecord } from './development-validation-record.ts'

const expected = { id: 'val-123', taskId: 'task-1', executionId: 'execution-1' }
const now = 10_000
function record(): DevelopmentValidationResult {
  return {
    ...expected, command: 'node verify.cjs', startedAt: 1_000, finishedAt: 2_000,
    exitCode: 0, timedOut: false, status: 'passed', snapshotContentHash: 'a'.repeat(64),
    outputTail: 'PASS', outputTruncated: false,
    binding: {
      version: 1, projectId: 'project-1', workspaceId: 'workspace-1', sessionId: 'session-1',
      snapshotId: 'snapshot-1', baseCommit: 'b'.repeat(40), scopeHash: 'c'.repeat(64), verificationConfigHash: 'd'.repeat(64),
    },
  }
}

describe('研发验证记录：严格JSON解码不授予信任', () => {
  test('新绑定和无绑定legacy均可读取，不改写原件', () => {
    const input = record()
    const parsed = parseDevelopmentValidationRecord(input, expected, now)
    expect(parsed).toEqual(input)
    input.outputTail = 'changed'
    expect(parsed?.outputTail).toBe('PASS')
    const { binding: _binding, ...legacy } = record()
    expect(parseDevelopmentValidationRecord(legacy, expected, now)?.binding).toBeUndefined()
  })

  test('身份错配、额外trusted声明和继承对象拒绝', () => {
    for (const input of [
      { ...record(), ...{ id: 'other' } }, { ...record(), taskId: 'other' },
      { ...record(), executionId: 'other' }, { ...record(), trusted: true },
      Object.create(record()), [], null,
    ]) expect(parseDevelopmentValidationRecord(input, expected, now)).toBeUndefined()
  })

  test('非0伪passed、timeout矛盾和未知状态拒绝', () => {
    for (const input of [
      { ...record(), exitCode: 1 }, { ...record(), exitCode: null },
      { ...record(), exitCode: -1 }, { ...record(), status: 'timeout' },
      { ...record(), timedOut: true }, { ...record(), status: 'accepted' },
    ]) expect(parseDevelopmentValidationRecord(input, expected, now)).toBeUndefined()
    expect(parseDevelopmentValidationRecord({ ...record(), status: 'timeout', timedOut: true, exitCode: null }, expected, now)?.status).toBe('timeout')
    expect(parseDevelopmentValidationRecord({ ...record(), status: 'failed', exitCode: null }, expected, now)?.status).toBe('failed')
  })

  test('未来/倒序/非法时钟、空命令和超限输出拒绝', () => {
    for (const input of [
      { ...record(), finishedAt: now + 1 }, { ...record(), startedAt: 3_000 },
      { ...record(), startedAt: Number.NaN }, { ...record(), command: ' ' },
      { ...record(), outputTail: 'a'.repeat(8001) }, { ...record(), outputTruncated: null },
    ]) expect(parseDevelopmentValidationRecord(input, expected, now)).toBeUndefined()
    expect(parseDevelopmentValidationRecord(record(), expected, Number.NaN)).toBeUndefined()
  })

  test('不支持的binding版本、缺身份和坏hash不能降级legacy', () => {
    for (const binding of [
      null, { ...record().binding, version: 2 }, { ...record().binding, projectId: '' },
      { ...record().binding, scopeHash: 'bad' }, { ...record().binding, baseCommit: '--output=bad' },
      { ...record().binding, trusted: true },
    ]) expect(parseDevelopmentValidationRecord({ ...record(), binding }, expected, now)).toBeUndefined()
    expect(parseDevelopmentValidationRecord({ ...record(), snapshotContentHash: 'bad' }, expected, now)).toBeUndefined()
  })
})
