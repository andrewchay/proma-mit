import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'
import type { OwnerTechnicalReviewEvidence } from './project-owner-technical-review'
import type { DevelopmentValidationResult } from '@gravitas/shared'

const directory = mkdtempSync(join(tmpdir(), 'owner-counter-supplement-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
const store = await import('./project-sqlite-store')
const { applyOwnerCounterSupplement, canSupplementOwnerCounterReview, readOwnerCounterSupplement } = await import('./project-owner-counter-supplement')
const { OWNER_COUNTER_SUPPLEMENT_COMMAND } = await import('./development-validation-service')
const { ownerExecutionHash } = await import('./project-owner-execution-hash')

beforeAll(() => store.initProjectDb())
afterAll(() => {
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

const artifactHash = 'a'.repeat(64)
function fixture(): OwnerTechnicalReviewEvidence {
  const source = { projectId: 'project', taskId: 'task', grantId: 'grant', stepLinkId: 'link', sourceHash: 'source', reworkOrdinal: 0 }
  const validationEvidence = [{ command: 'browser:html.loads', validationId: 'val-1', attemptState: 'completed' as const, status: 'passed' as const }]
  return {
    ...source, schemaVersion: 3, verdict: 'blocked', blockerReason: '交互未验证', findings: [], summary: '仅有加载回执',
    reviewerCommandId: 'reviewer', reviewerExecutionId: 'review-execution', executorCommandId: 'executor', executorExecutionId: 'execution',
    artifactHash, artifactVerified: true, responseSha256: 'b'.repeat(64), createdAt: Date.now() - 1000, validationEvidence,
    developmentArtifact: { ...source, planRevision: 2, executorCommandId: 'executor', executorExecutionId: 'execution', contentHash: artifactHash, content: 'snapshot', validationEvidence },
    criteria: [
      { criterion: '打开文件后初值显示0', status: 'met', evidence: '源码依据', quote: '<span>0</span>' },
      { criterion: '点击加一后为1，再点重置后为0', status: 'not_verified', evidence: '没有模拟点击', quote: null },
    ],
  }
}

test('Given只有计数器交互缺口 When检查补测资格 Then拒绝缺陷和额外的验收标准', () => {
  const review = fixture()
  expect(canSupplementOwnerCounterReview(review)).toBe(true)
  expect(canSupplementOwnerCounterReview({ ...review, criteria: [...review.criteria, { criterion: '断网可用', status: 'not_verified', evidence: '未知' }] })).toBe(false)
  expect(canSupplementOwnerCounterReview({ ...review, criteria: [review.criteria[0]!, { ...review.criteria[1]!, status: 'not_met' }] })).toBe(false)
})

test('Given原计数器同一冻结版本有两项可信浏览器回执 When回读 Then形成补测后的评审并保留历史', () => {
  const review = fixture()
  const checks = [
    { id: 'html.loads', title: '加载', status: 'passed' as const, detail: '加载成功' },
    { id: 'counter.increment-reset', title: '交互', status: 'passed' as const, detail: '观察到计数：0 → 1 → 0' },
  ]
  const output = JSON.stringify(checks), now = Date.now()
  const validation: DevelopmentValidationResult = {
    id: `val-${'2'.repeat(64)}`, command: OWNER_COUNTER_SUPPLEMENT_COMMAND, taskId: review.taskId, executionId: review.executorExecutionId,
    startedAt: now - 1, finishedAt: now, exitCode: 0, timedOut: false, status: 'passed', snapshotContentHash: artifactHash,
    outputTail: output, outputTruncated: false, rawOutputSha256: createHash('sha256').update(output).digest('hex'),
    rawOutputByteLength: Buffer.byteLength(output), checks, method: 'browser_assertions',
    binding: { version: 1, projectId: review.projectId, workspaceId: 'workspace', sessionId: 'session', snapshotId: 'snapshot', baseCommit: 'c'.repeat(40), scopeHash: 'd'.repeat(64), verificationConfigHash: 'e'.repeat(64) },
  }
  const save = (candidate: DevelopmentValidationResult) => {
    const body = { reviewerCommandId: review.reviewerCommandId, reviewHash: review.responseSha256, artifactHash, validation: candidate }
    store.getProjectDb().prepare('INSERT INTO project_owner_counter_supplements(validation_id,reviewer_command_id,created_at,payload,integrity_hash) VALUES (?,?,?,?,?)')
      .run(candidate.id, review.reviewerCommandId, candidate.finishedAt, JSON.stringify(body), ownerExecutionHash(body))
  }
  expect(applyOwnerCounterSupplement(review)).toBe(review)
  save(validation)
  expect(applyOwnerCounterSupplement(review).criteria[1]).toMatchObject({ status: 'met', quote: OWNER_COUNTER_SUPPLEMENT_COMMAND })
  expect(applyOwnerCounterSupplement(review).verdict).toBe('approved')
  expect(review.criteria[1]?.status).toBe('not_verified')
  expect(applyOwnerCounterSupplement(review, 'val-other')).toBe(review)
  expect(() => applyOwnerCounterSupplement({ ...review, executorExecutionId: 'other' })).toThrow('跨成果或执行来源')
  save({ ...validation, id: `val-${'3'.repeat(64)}`, checks: [checks[0]!] })
  expect(() => readOwnerCounterSupplement(review.reviewerCommandId, `val-${'3'.repeat(64)}`)).toThrow('补测记录不一致')
})
