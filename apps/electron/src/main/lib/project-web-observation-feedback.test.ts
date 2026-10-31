import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeProjectDb, createProject, initProjectDb } from './project-sqlite-store'
import { recordProjectWebChangeObservation, type RecordWebChangeObservationInput } from './project-web-change-observations'
import {
  isObservationMuted,
  listMutedSourceIds,
  listWebObservationFeedback,
  recordWebObservationFeedback,
} from './project-web-observation-feedback'
import { judgeAndRecordWebObservation } from './project-web-change-judgment'

const temp = mkdtempSync(join(tmpdir(), 'gravitas-web-feedback-'))
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = join(temp, 'config'); await initProjectDb() })
afterAll(() => { closeProjectDb(); rmSync(temp, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })

const DAY = 24 * 60 * 60 * 1000
const SOURCE = { url: 'https://example.com/framework-v3', snippet: 'v3 存在破坏性变更。' }

function observationInput(projectId: string, patch: Partial<RecordWebChangeObservationInput> = {}): RecordWebChangeObservationInput {
  return {
    projectId, runId: 'run-1', judgment: 'attention',
    facts: [{ title: '框架 v3 发布', url: SOURCE.url, quote: 'v3 存在破坏性变更。', publishedAt: null, isInference: false }],
    knownSources: [SOURCE], impact: '影响升级计划',
    binding: { goalRevision: 1, contextFingerprint: null, topics: ['升级'] },
    evaluation: { modelId: 'fake', promptVersion: 1, sourcesCount: 1, truncated: false },
    ...patch,
  }
}

test('Given 用户标记有帮助 When 记录 Then 只留一条且不静音来源', () => {
  const project = createProject({ title: '反馈项目', description: '' })
  const observation = recordProjectWebChangeObservation(observationInput(project.id))!
  const feedback = recordWebObservationFeedback({ projectId: project.id, observationId: observation.id, verdict: 'helpful' })!
  expect(feedback.verdict).toBe('helpful')
  expect(feedback.sourceIds).toEqual(['https://example.com/framework-v3'])
  expect(feedback.snoozeUntil).toBeNull()
  // 重复点击同一结论幂等。
  expect(recordWebObservationFeedback({ projectId: project.id, observationId: observation.id, verdict: 'helpful' })!.id).toBe(feedback.id)
  expect(listWebObservationFeedback(project.id)).toHaveLength(1)
  expect(listMutedSourceIds(project.id)).toEqual(new Set())
})

test('Given 用户标记不相关 When 记录 Then 该来源长期静音', () => {
  const project = createProject({ title: '不相关项目', description: '' })
  const observation = recordProjectWebChangeObservation(observationInput(project.id))!
  recordWebObservationFeedback({ projectId: project.id, observationId: observation.id, verdict: 'irrelevant', reason: '行业泛泛分析' })
  expect(listMutedSourceIds(project.id)).toEqual(new Set(['https://example.com/framework-v3']))
  expect(isObservationMuted(project.id, [{ url: SOURCE.url }])).toBe(true)
  // 有新来源时不该被静音挡住。
  expect(isObservationMuted(project.id, [{ url: SOURCE.url }, { url: 'https://example.com/other' }])).toBe(false)
})

test('Given 暂不关注 7 天 When 到期 Then 静音自动失效', () => {
  const project = createProject({ title: '暂不关注项目', description: '' })
  const observation = recordProjectWebChangeObservation(observationInput(project.id))!
  const now = 1_800_000_000_000
  const feedback = recordWebObservationFeedback({ projectId: project.id, observationId: observation.id, verdict: 'snooze', now })!
  expect(feedback.snoozeUntil).toBe(now + 7 * DAY)
  expect(listMutedSourceIds(project.id, now + DAY)).toEqual(new Set(['https://example.com/framework-v3']))
  expect(listMutedSourceIds(project.id, now + 8 * DAY)).toEqual(new Set())
})

test('Given 来源已被静音 When 判断为需要关注 Then 降级为只记录且写明原因', () => {
  const project = createProject({ title: '静音降级项目', description: '' })
  const first = recordProjectWebChangeObservation(observationInput(project.id))!
  recordWebObservationFeedback({ projectId: project.id, observationId: first.id, verdict: 'irrelevant' })
  const judged = judgeAndRecordWebObservation({
    projectId: project.id, runId: 'run-2',
    rawResponse: JSON.stringify({
      judgment: 'attention',
      facts: [{ title: '框架 v3 补丁', url: 'https://example.com/framework-v3?utm_source=rss', quote: 'v3 又更新了', publishedAt: null, isInference: false }],
      impact: '影响升级计划', suggestion: null, question: null, uncertainty: null, failureReason: null,
      relatedObservationIds: [], duplicateOf: null, duplicateReason: null,
    }),
    sources: [{ title: '框架 v3 补丁', url: SOURCE.url, snippet: 'v3 又有新补丁。' }],
    topics: ['升级'], goalRevision: 1, contextFingerprint: null, modelId: 'fake', promptVersion: 1, sourcesCount: 1, truncated: false,
  })
  expect(judged.judgment).toBe('record_only')
  expect(judged.observation!.judgment).toBe('record_only')
  expect(judged.observation!.uncertainty).toContain('标记为不相关')
  expect(judged.observation!.facts).toHaveLength(1)
})

test('Given 观察不存在或被改写 When 记录反馈 Then 不落库', () => {
  const project = createProject({ title: '反馈拒绝项目', description: '' })
  expect(recordWebObservationFeedback({ projectId: project.id, observationId: 'a'.repeat(64), verdict: 'helpful' })).toBeNull()
  expect(listWebObservationFeedback(project.id)).toEqual([])
  expect(() => recordWebObservationFeedback({ projectId: project.id, observationId: 'a'.repeat(64), verdict: 'whatever' as never })).toThrow('反馈结论无效')
})
