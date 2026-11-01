import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeProjectDb, createProject, initProjectDb } from './project-sqlite-store'
import { recordProjectWebChangeObservation, type RecordWebChangeObservationInput } from './project-web-change-observations'
import { recordWebObservationFeedback } from './project-web-observation-feedback'
import { summarizeWebObservationQuality } from './project-web-observation-metrics'

const temp = mkdtempSync(join(tmpdir(), 'gravitas-web-metrics-'))
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = join(temp, 'config'); await initProjectDb() })
afterAll(() => { closeProjectDb(); rmSync(temp, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })

const SOURCE = { url: 'https://example.com/framework-v3', snippet: 'v3 存在破坏性变更。' }

function input(projectId: string, patch: Partial<RecordWebChangeObservationInput> = {}): RecordWebChangeObservationInput {
  return {
    projectId, runId: 'run-1', judgment: 'attention',
    facts: [{ title: '框架 v3 发布', url: SOURCE.url, quote: 'v3 存在破坏性变更。', publishedAt: null, isInference: false }],
    knownSources: [SOURCE],
    binding: { goalRevision: 1, contextFingerprint: null, topics: ['升级'] },
    evaluation: { modelId: 'fake', promptVersion: 1, sourcesCount: 1, truncated: false },
    createdAt: 1_800_000_000_000,
    ...patch,
  }
}

test('Given 没有任何观察 When 汇总 Then 比率为空而不是 0', () => {
  const project = createProject({ title: '空汇总项目', description: '' })
  const summary = summarizeWebObservationQuality(project.id)
  expect(summary.observations).toBe(0)
  expect(summary.duplicateRate).toBeNull()
  expect(summary.insufficientRate).toBeNull()
  expect(summary.factsTotal).toBe(0)
})

test('Given 多种判定 When 汇总 Then 分别计数并算出比率', () => {
  const project = createProject({ title: '汇总项目', description: '' })
  recordProjectWebChangeObservation(input(project.id, { runId: 'run-a' }))
  recordProjectWebChangeObservation(input(project.id, { runId: 'run-b', judgment: 'record_only', facts: [] }))
  recordProjectWebChangeObservation(input(project.id, { runId: 'run-c', judgment: 'insufficient_evidence', facts: [], failureReason: '模型输出无法解析' }))
  const first = recordProjectWebChangeObservation(input(project.id, { runId: 'run-d' }))!
  recordProjectWebChangeObservation(input(project.id, {
    runId: 'run-e', judgment: 'duplicate', facts: [], knownSources: [SOURCE],
    duplicateOf: first.id, duplicateReason: 'no_new_content',
    binding: { goalRevision: 1, contextFingerprint: null, topics: ['升级'] },
    evaluation: { modelId: 'fake', promptVersion: 1, sourcesCount: 1, truncated: true },
  }))
  const summary = summarizeWebObservationQuality(project.id)
  expect(summary.observations).toBe(5)
  expect(summary.byJudgment.attention).toBe(2)
  expect(summary.byJudgment.duplicate).toBe(1)
  expect(summary.byJudgment.insufficient_evidence).toBe(1)
  expect(summary.duplicateRate).toBe(0.2)
  expect(summary.insufficientRate).toBe(0.2)
  expect(summary.factsTotal).toBe(2)
  expect(summary.factsWithoutPublishedAt).toBe(2)
  expect(summary.truncatedObservations).toBe(1)
})

test('Given 有推断与反馈 When 汇总 Then 推断单列且反馈分别计数', () => {
  const project = createProject({ title: '推断汇总项目', description: '' })
  const observation = recordProjectWebChangeObservation(input(project.id, {
    facts: [
      { title: '框架 v3 发布', url: SOURCE.url, quote: 'v3 存在破坏性变更。', publishedAt: '2026-10-30', isInference: false },
      { title: '推断会影响升级', url: SOURCE.url, quote: '', publishedAt: null, isInference: true },
    ],
  }))!
  recordWebObservationFeedback({ projectId: project.id, observationId: observation.id, verdict: 'helpful' })
  const summary = summarizeWebObservationQuality(project.id)
  expect(summary.factsTotal).toBe(1)
  expect(summary.factsWithoutPublishedAt).toBe(0)
  expect(summary.inferencesTotal).toBe(1)
  expect(summary.feedback).toEqual({ helpful: 1, irrelevant: 0, snooze: 0 })
})

test('Given 指定起始时间 When 汇总 Then 只统计该时间之后的记录', () => {
  const project = createProject({ title: '时间窗汇总项目', description: '' })
  const now = Date.now()
  recordProjectWebChangeObservation(input(project.id, { runId: 'run-old', createdAt: now - 60_000 }))
  recordProjectWebChangeObservation(input(project.id, { runId: 'run-new', createdAt: now - 1_000 }))
  expect(summarizeWebObservationQuality(project.id, now - 30_000).observations).toBe(1)
})
