import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeProjectDb, createProject, initProjectDb } from './project-sqlite-store'
import {
  applyDeterministicDedup,
  getAuthorizedProjectWebChangeObservation,
  listPriorObservationsBySource,
  recordProjectWebChangeObservation,
  snippetDigestOf,
  type RecordWebChangeObservationInput,
} from './project-web-change-observations'

const temp = mkdtempSync(join(tmpdir(), 'gravitas-web-dedup-'))
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = join(temp, 'config'); await initProjectDb() })
afterAll(() => { closeProjectDb(); rmSync(temp, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })

const SOURCE = { url: 'https://example.com/framework-v3', snippet: 'v3 发布，存在破坏性变更。' }
const CHANGED = { url: SOURCE.url, snippet: 'v3.1 修复了 v3 的破坏性变更。' }
const OTHER = { url: 'https://example.com/pricing', snippet: '价格调整公告。' }

function input(projectId: string, patch: Partial<RecordWebChangeObservationInput> = {}): RecordWebChangeObservationInput {
  return {
    projectId,
    runId: 'run-1',
    judgment: 'attention',
    facts: [{ title: '框架 v3 发布', url: SOURCE.url, quote: 'v3 发布，存在破坏性变更。', publishedAt: null, isInference: false }],
    knownSources: [SOURCE],
    impact: '影响升级计划',
    binding: { goalRevision: 1, contextFingerprint: 'fp', topics: ['升级'] },
    evaluation: { promptVersion: 1, sourcesCount: 1, truncated: false },
    ...patch,
  }
}

test('Given 同一来源内容未变 When 判定 Then 归为重复并指向原记录', () => {
  const project = createProject({ title: '去重项目', description: '' })
  const first = recordProjectWebChangeObservation(input(project.id))!
  const result = applyDeterministicDedup({
    projectId: project.id,
    judgment: 'attention',
    facts: [{ url: SOURCE.url }],
    sources: [SOURCE],
  })
  expect(result.judgment).toBe('duplicate')
  expect(result.duplicateOf).toBe(first.id)
  expect(result.duplicateReason).toBe('no_new_content')
  expect(result.repeatedSourceIds).toEqual(['https://example.com/framework-v3'])
})

test('Given 同一来源出现新内容 When 判定 Then 保留原判定并只建立关联', () => {
  const project = createProject({ title: '新内容项目', description: '' })
  const first = recordProjectWebChangeObservation(input(project.id))!
  const result = applyDeterministicDedup({
    projectId: project.id,
    judgment: 'attention',
    facts: [{ url: SOURCE.url }],
    sources: [CHANGED],
  })
  expect(result.judgment).toBe('attention')
  expect(result.duplicateOf).toBeNull()
  expect(result.relatedObservationIds).toEqual([first.id])
  expect(result.repeatedSourceIds).toEqual([])
})

test('Given 既有记录没有摘要指纹 When 判定 Then 保守按同源重复处理', () => {
  const project = createProject({ title: '旧记录项目', description: '' })
  const legacy = recordProjectWebChangeObservation(input(project.id, { knownSources: [{ url: SOURCE.url }] }))!
  expect(legacy.facts[0]!.snippetDigest).toBeNull()
  const result = applyDeterministicDedup({ projectId: project.id, judgment: 'attention', facts: [{ url: SOURCE.url }], sources: [CHANGED] })
  expect(result.judgment).toBe('duplicate')
  expect(result.duplicateReason).toBe('same_source')
})

test('Given 多来源只有部分重复 When 判定 Then 保留判定且关联只指向真实重复的记录', () => {
  const project = createProject({ title: '部分重复项目', description: '' })
  const first = recordProjectWebChangeObservation(input(project.id))!
  const result = applyDeterministicDedup({
    projectId: project.id,
    judgment: 'decision_required',
    facts: [{ url: SOURCE.url }, { url: OTHER.url }],
    sources: [SOURCE, OTHER],
  })
  expect(result.judgment).toBe('decision_required')
  expect(result.relatedObservationIds).toEqual([first.id])
  expect(result.repeatedSourceIds).toEqual(['https://example.com/framework-v3'])
})

test('Given 模型已判重复且指向有效 When 去重 Then 不自作主张改写', () => {
  const project = createProject({ title: '模型判定项目', description: '' })
  const first = recordProjectWebChangeObservation(input(project.id))!
  const result = applyDeterministicDedup({
    projectId: project.id,
    judgment: 'duplicate',
    duplicateOf: first.id,
    duplicateReason: 'same_event',
    facts: [{ url: OTHER.url }],
    sources: [OTHER],
  })
  expect(result.judgment).toBe('duplicate')
  expect(result.duplicateOf).toBe(first.id)
  expect(result.duplicateReason).toBe('same_event')
})

test('Given 没有历史观察 When 去重 Then 原样返回且不建立关联', () => {
  const project = createProject({ title: '首次观察项目', description: '' })
  const result = applyDeterministicDedup({ projectId: project.id, judgment: 'attention', facts: [{ url: SOURCE.url }], sources: [SOURCE] })
  expect(result).toEqual({ judgment: 'attention', duplicateOf: null, duplicateReason: null, relatedObservationIds: [], repeatedSourceIds: [] })
})

test('Given 重复记录不参与历史 When 查找最近观察 Then 指向有实质内容的那条', () => {
  const project = createProject({ title: '指针链项目', description: '' })
  const first = recordProjectWebChangeObservation(input(project.id))!
  const duplicate = recordProjectWebChangeObservation(input(project.id, {
    runId: 'run-2', judgment: 'duplicate', facts: [], duplicateOf: first.id, duplicateReason: 'no_new_content', knownSources: [],
  }))!
  const prior = listPriorObservationsBySource(project.id)
  expect(prior.get('https://example.com/framework-v3')!.id).toBe(first.id)
  expect(prior.get('https://example.com/framework-v3')!.id).not.toBe(duplicate.id)
})

test('Given 已完成 40 次扫描 When 再次命中最早来源 Then 仍按账本判为重复而不依赖流水窗口', () => {
  const project = createProject({ title: '窗口外项目', description: '' })
  const earliest = recordProjectWebChangeObservation(input(project.id, { runId: 'run-0' }))!
  for (let index = 1; index <= 40; index += 1) {
    const url = `https://example.com/p/${index}`
    recordProjectWebChangeObservation(input(project.id, {
      runId: `run-${index}`,
      facts: [{ title: `来源 ${index}`, url, quote: `摘要 ${index}`, publishedAt: null, isInference: false }],
      knownSources: [{ url, snippet: `摘要 ${index}` }],
    }))
  }
  const result = applyDeterministicDedup({ projectId: project.id, judgment: 'attention', facts: [{ url: SOURCE.url }], sources: [SOURCE] })
  expect(result.judgment).toBe('duplicate')
  expect(result.duplicateOf).toBe(earliest.id)
})

test('Given 去重结论 When 写入账本 Then 重复记录与建立关联的记录都可核验', () => {
  const project = createProject({ title: '落库去重项目', description: '' })
  const first = recordProjectWebChangeObservation(input(project.id))!
  const dedup = applyDeterministicDedup({ projectId: project.id, judgment: 'attention', facts: [{ url: SOURCE.url }], sources: [SOURCE] })
  const duplicated = recordProjectWebChangeObservation({
    projectId: project.id, runId: 'run-9', judgment: dedup.judgment, facts: [], knownSources: [SOURCE],
    relatedObservationIds: dedup.relatedObservationIds, duplicateOf: dedup.duplicateOf, duplicateReason: dedup.duplicateReason,
    binding: { goalRevision: 1, contextFingerprint: 'fp', topics: ['升级'] },
    evaluation: { promptVersion: 1, sourcesCount: 1, truncated: false },
  })!
  expect(duplicated.judgment).toBe('duplicate')
  expect(duplicated.duplicateOf).toBe(first.id)
  expect(getAuthorizedProjectWebChangeObservation(project.id, duplicated.id)!.duplicateOf).toBe(first.id)
  expect(getAuthorizedProjectWebChangeObservation(project.id, first.id)).toEqual(first)
})

test('Given 摘要空白或缺失 When 计算指纹 Then 返回空表示无法判断内容变化', () => {
  expect(snippetDigestOf('   ')).toBeNull()
  expect(snippetDigestOf(undefined)).toBeNull()
  expect(snippetDigestOf('abc')).toBe(snippetDigestOf('  abc  '))
  expect(snippetDigestOf('abc')).not.toBe(snippetDigestOf('abd'))
})
