import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { completeOwnerDevelopmentValidationAttempt, readOwnerDevelopmentValidationAttempt, reserveOwnerDevelopmentValidationAttempt } from './development-validation-attempt.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'owner-validation-attempt-'))
  directories.push(directory)
  return {
    directory,
    input: {
      ownerCommandId: 'command-1', projectId: 'project-1', grantId: 'grant-1',
      taskId: 'task-1', stepLinkId: 'step-1', sourceHash: 'c'.repeat(64),
      executionId: 'execution-1', workspaceId: 'workspace-1',
      command: 'bun test src/example.test.ts', snapshotContentHash: 'a'.repeat(64),
      verificationConfigHash: 'd'.repeat(64), validationId: `val-${'b'.repeat(64)}`, startedAt: 1,
    },
  }
}

test('Given Owner验证首次预留 When同一命令再次请求 Then保留running并拒绝重跑', () => {
  const { directory, input } = fixture()
  expect(reserveOwnerDevelopmentValidationAttempt(directory, input).kind).toBe('reserved')
  expect(reserveOwnerDevelopmentValidationAttempt(directory, input).kind).toBe('unknown')
  expect(readOwnerDevelopmentValidationAttempt(directory, input.validationId)?.state).toBe('running')
})

test('Given验证回执已完成 When恢复同一Owner命令 Then返回同一结果而不创建新尝试', () => {
  const { directory, input } = fixture()
  reserveOwnerDevelopmentValidationAttempt(directory, input)
  completeOwnerDevelopmentValidationAttempt(directory, input)
  const restored = reserveOwnerDevelopmentValidationAttempt(directory, input)
  expect(restored.kind).toBe('completed')
  expect(restored.attempt.validationId).toBe(input.validationId)
})

test('Given相同尝试ID被不同命令来源复用 When预留 Then拒绝来源冲突', () => {
  const { directory, input } = fixture()
  reserveOwnerDevelopmentValidationAttempt(directory, input)
  expect(() => reserveOwnerDevelopmentValidationAttempt(directory, { ...input, command: 'bun test other.test.ts' })).toThrow('来源冲突')
})
