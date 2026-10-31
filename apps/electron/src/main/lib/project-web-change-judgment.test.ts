import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeProjectDb, createProject, initProjectDb } from './project-sqlite-store'
import { deleteProject } from './project-service'
import { judgeAndRecordWebObservation } from './project-web-change-judgment'
import { getAuthorizedProjectWebChangeObservation, recordProjectWebChangeObservation } from './project-web-change-observations'
import {
  WEB_WATCH_RUN_RETENTION,
  getProjectWebWatchConfigPath,
  getProjectWebWatchRunsPath,
} from './project-web-watch-store'
import { rotateProjectWebWatchRuns } from './project-web-watch-service'

const temp = mkdtempSync(join(tmpdir(), 'gravitas-web-judgment-'))
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = join(temp, 'config'); await initProjectDb() })
afterAll(() => { closeProjectDb(); rmSync(temp, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })

const SOURCE = { title: '框架 v3 发布', url: 'https://example.com/framework-v3', snippet: 'v3 发布，存在破坏性变更。', publishedAt: '2026-10-30' }

function base(projectId: string, patch: Partial<Parameters<typeof judgeAndRecordWebObservation>[0]> = {}) {
  return {
    projectId,
    runId: 'run-1',
    rawResponse: JSON.stringify({
      judgment: 'attention',
      facts: [{ title: SOURCE.title, url: SOURCE.url, quote: 'v3 发布，存在破坏性变更。', publishedAt: '2026-10-30', isInference: false }],
      impact: '影响升级任务的评估工作',
      suggestion: null,
      question: null,
      uncertainty: null,
      failureReason: null,
      relatedObservationIds: [],
      duplicateOf: null,
      duplicateReason: null,
    }),
    sources: [SOURCE],
    topics: ['框架升级'],
    goalRevision: 4,
    contextFingerprint: null,
    modelId: 'model-a',
    promptVersion: 1,
    sourcesCount: 1,
    truncated: false,
    ...patch,
  }
}

test('Given 模型给出相关变化 When 判断 Then 落 attention 观察并保留来源与截断标记', () => {
  const project = createProject({ title: '判断项目', description: '' })
  const result = judgeAndRecordWebObservation(base(project.id))
  expect(result.judgment).toBe('attention')
  expect(result.failureReason).toBeNull()
  expect(result.observation).not.toBeNull()
  expect(result.observation!.facts[0]!.sourceId).toBe('https://example.com/framework-v3')
  expect(result.observation!.evaluation.modelId).toBe('model-a')
  expect(getAuthorizedProjectWebChangeObservation(project.id, result.observation!.id)).not.toBeNull()
})

test('Given 同一来源内容未变 When 再次判断 Then 归为重复并指向原记录', () => {
  const project = createProject({ title: '重复判断项目', description: '' })
  const first = judgeAndRecordWebObservation(base(project.id))
  const second = judgeAndRecordWebObservation(base(project.id, { runId: 'run-2', existingObservationIds: [first.observation!.id] }))
  expect(second.judgment).toBe('duplicate')
  expect(second.observation!.duplicateOf).toBe(first.observation!.id)
  expect(second.observation!.duplicateReason).toBe('no_new_content')
})

test('Given 模型输出无法解析 When 判断 Then 落 insufficient_evidence 并保留原因', () => {
  const project = createProject({ title: '解析失败项目', description: '' })
  const result = judgeAndRecordWebObservation(base(project.id, { rawResponse: '我觉得这次变更挺重要的' }))
  expect(result.judgment).toBe('insufficient_evidence')
  expect(result.failureReason).toBeTruthy()
  expect(result.observation!.judgment).toBe('insufficient_evidence')
  expect(result.observation!.failureReason).toBe(result.failureReason!)
  expect(result.observation!.impact).toBeNull()
})

test('Given 模型调用本身失败 When 判断 Then 保留调用原因而不是编造结论', () => {
  const project = createProject({ title: '调用失败项目', description: '' })
  const result = judgeAndRecordWebObservation(base(project.id, { rawResponse: null, callFailureReason: 'AI 分析请求失败 (502)' }))
  expect(result.judgment).toBe('insufficient_evidence')
  expect(result.failureReason).toBe('AI 分析请求失败 (502)')
  expect(result.observation!.failureReason).toBe('AI 分析请求失败 (502)')
  expect(result.observation!.facts).toEqual([])
})

test('Given 判断结论被去重改写 When 落库 Then 账本判定与返回值一致', () => {
  const project = createProject({ title: '一致项目', description: '' })
  const first = judgeAndRecordWebObservation(base(project.id))
  const legacy = recordProjectWebChangeObservation({
    projectId: project.id, runId: 'run-legacy', judgment: 'record_only', facts: [], knownSources: [SOURCE],
    binding: { topics: ['框架升级'] }, evaluation: { promptVersion: 1, sourcesCount: 1, truncated: false },
  })!
  expect(first.observation!.id).not.toBe(legacy.id)
  const result = judgeAndRecordWebObservation(base(project.id, { runId: 'run-3' }))
  expect(result.judgment).toBe('duplicate')
  expect(result.observation!.judgment).toBe(result.judgment)
  expect(result.repeatedSourceIds).toEqual(['https://example.com/framework-v3'])
})

test('Given 扫描流水超过保留上限 When 轮转 Then 只保留最近 90 次', () => {
  const project = createProject({ title: '轮转项目', description: '' })
  const path = getProjectWebWatchRunsPath(project.id)
  const lines = Array.from({ length: 95 }, (_, index) => JSON.stringify({ id: `run-${index}`, projectId: project.id, startedAt: index, endedAt: index, coverageFrom: 0, coverageTo: 0, status: 'success', queries: [], sources: [], newSources: [] }))
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
  rotateProjectWebWatchRuns(project.id)
  const kept = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  expect(kept).toHaveLength(WEB_WATCH_RUN_RETENTION)
  expect(JSON.parse(kept[0]!).id).toBe('run-5')
  expect(JSON.parse(kept.at(-1)!).id).toBe('run-94')
})

test('Given 项目被删除 When 清理 Then 本机扫描配置与流水一并移除', async () => {
  const project = createProject({ title: '待删扫描项目', description: '' })
  writeFileSync(getProjectWebWatchConfigPath(project.id), JSON.stringify({ projectId: project.id, enabled: false, topics: [], localTime: '09:00', updatedAt: 1 }), 'utf8')
  writeFileSync(getProjectWebWatchRunsPath(project.id), '', 'utf8')
  expect(existsSync(getProjectWebWatchConfigPath(project.id))).toBe(true)
  expect(await deleteProject(project.id)).toBe(true)
  expect(existsSync(getProjectWebWatchConfigPath(project.id))).toBe(false)
  expect(existsSync(getProjectWebWatchRunsPath(project.id))).toBe(false)
})
