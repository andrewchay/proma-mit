import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeProjectDb, createProject, deleteProject, getProjectDb, initProjectDb } from './project-sqlite-store'
import {
  getAuthorizedProjectWebChangeObservation,
  listProjectWebChangeObservations,
  normalizeWebSourceId,
  pruneProjectWebChangeObservations,
  recordProjectWebChangeObservation,
  type RecordWebChangeObservationInput,
} from './project-web-change-observations'

const temp = mkdtempSync(join(tmpdir(), 'gravitas-web-observation-'))
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = join(temp, 'config'); await initProjectDb() })
afterAll(() => { closeProjectDb(); rmSync(temp, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })

const SOURCE = { url: 'https://example.com/blog/release?utm_source=feed' }

function input(projectId: string, patch: Partial<RecordWebChangeObservationInput> = {}): RecordWebChangeObservationInput {
  return {
    projectId,
    runId: 'run-1',
    judgment: 'attention',
    facts: [{ title: '新版本发布', url: SOURCE.url, quote: 'v2 已发布，接口有变更', publishedAt: '2026-10-30', isInference: false }],
    knownSources: [SOURCE],
    impact: '本项目依赖该接口，需要评估兼容性',
    suggestion: '先确认变更范围，再决定是否调整计划',
    binding: { goalRevision: 3, contextFingerprint: 'fp-1', topics: ['依赖版本'] },
    evaluation: { modelId: 'model-a', promptVersion: 1, sourcesCount: 12, truncated: false },
    ...patch,
  }
}

test('Given 一次扫描的判断结果 When 重复写入 Then 身份稳定且内容一致时幂等', () => {
  const project = createProject({ title: '观察项目', description: '' })
  const first = recordProjectWebChangeObservation(input(project.id))!
  expect(first.judgment).toBe('attention')
  expect(first.facts[0]!.sourceId).toBe('https://example.com/blog/release')
  expect(getAuthorizedProjectWebChangeObservation(project.id, first.id)).toEqual(first)
  const again = recordProjectWebChangeObservation(input(project.id))!
  expect(again.id).toBe(first.id)
  expect((getProjectDb().prepare('SELECT COUNT(*) AS c FROM project_web_change_observations WHERE project_id = ?').get(project.id) as { c: number }).c).toBe(1)
})

test('Given 同一批次出现不同判断内容 When 再次写入 Then 追加新记录而不覆盖旧记录', () => {
  const project = createProject({ title: '追加项目', description: '' })
  const first = recordProjectWebChangeObservation(input(project.id))!
  const second = recordProjectWebChangeObservation(input(project.id, { judgment: 'record_only' }))!
  expect(second.id).not.toBe(first.id)
  expect(listProjectWebChangeObservations(project.id).map((item) => item.judgment).sort()).toEqual(['attention', 'record_only'])
})

test('Given 来源不在本次扫描结果内 When 记录 Then 拒绝且不落库', () => {
  const project = createProject({ title: '伪造来源项目', description: '' })
  expect(() => recordProjectWebChangeObservation(input(project.id, {
    facts: [{ title: '编造来源', url: 'https://made-up.example.com/news', quote: '原文', isInference: false }],
  }))).toThrow('来源链接不在本次扫描结果内')
  expect(listProjectWebChangeObservations(project.id)).toEqual([])
})

test('Given 待决问题或重复来源缺失 When 记录 Then 拒绝', () => {
  const project = createProject({ title: '必填字段项目', description: '' })
  expect(() => recordProjectWebChangeObservation(input(project.id, { judgment: 'decision_required', question: null }))).toThrow('待决问题不能为空')
  expect(() => recordProjectWebChangeObservation(input(project.id, { judgment: 'duplicate', duplicateOf: null }))).toThrow('重复指向的观察不能为空')
  expect(() => recordProjectWebChangeObservation(input(project.id, { judgment: 'duplicate', duplicateOf: 'not-exist', duplicateReason: 'same_source' }))).toThrow('重复指向的观察不存在')
  expect(() => recordProjectWebChangeObservation(input(project.id, { judgment: 'insufficient_evidence' }))).toThrow('失败原因不能为空')
})

test('Given 事实缺少引用或未标明事实与推断 When 记录 Then 拒绝', () => {
  const project = createProject({ title: '引用缺失项目', description: '' })
  expect(() => recordProjectWebChangeObservation(input(project.id, {
    facts: [{ title: '标题', url: SOURCE.url, quote: '', isInference: false }],
  }))).toThrow('来源引用不能为空')
  const inference = recordProjectWebChangeObservation(input(project.id, {
    facts: [{ title: '标题', url: SOURCE.url, quote: '', isInference: true }],
  }))!
  expect(inference.facts[0]!.quote).toBe('')
})

test('Given 发布时间无法确认 When 记录 Then 保留空值而不顶替为扫描日期', () => {
  const project = createProject({ title: '时间未知项目', description: '' })
  const observation = recordProjectWebChangeObservation(input(project.id, {
    facts: [{ title: '旧文重发', url: SOURCE.url, quote: '正文无日期', isInference: false }],
  }))!
  expect(observation.facts[0]!.publishedAt).toBeNull()
  expect(() => recordProjectWebChangeObservation(input(project.id, { runId: 'run-bad', facts: [{ title: 'x', url: SOURCE.url, quote: 'q', publishedAt: '昨天', isInference: false }] })))
    .toThrow('发布时间必须是 ISO 日期或留空')
})

test('Given 落库记录被改写 When 取用 Then 复核失败返回空', () => {
  const project = createProject({ title: '篡改项目', description: '' })
  const observation = recordProjectWebChangeObservation(input(project.id))!
  const altered = { ...observation, impact: '被改成另一件事' }
  getProjectDb().prepare('UPDATE project_web_change_observations SET payload = ? WHERE id = ?').run(JSON.stringify(altered), observation.id)
  expect(getAuthorizedProjectWebChangeObservation(project.id, observation.id)).toBeNull()
})

test('Given 观察关联旧记录 When 记录 Then 只存指针且不覆盖旧记录', () => {
  const project = createProject({ title: '关联项目', description: '' })
  const first = recordProjectWebChangeObservation(input(project.id))!
  const second = recordProjectWebChangeObservation(input(project.id, { runId: 'run-2', relatedObservationIds: [first.id] }))!
  expect(second.relatedObservationIds).toEqual([first.id])
  expect(getAuthorizedProjectWebChangeObservation(project.id, first.id)).toEqual(first)
  expect(() => recordProjectWebChangeObservation(input(project.id, { runId: 'run-3', relatedObservationIds: ['not-exist'] }))).toThrow('关联观察不存在于本项目')
})

test('Given 超过保留条数或早于保留窗口 When 裁剪 Then 只保留最近 500 条与 90 天内记录', () => {
  const project = createProject({ title: '保留策略项目', description: '' })
  const now = 1_800_000_000_000
  for (let index = 0; index < 502; index += 1) {
    recordProjectWebChangeObservation(input(project.id, { runId: `run-${index}`, createdAt: now + index }))
  }
  pruneProjectWebChangeObservations(project.id, now + 1000)
  const rows = getProjectDb().prepare('SELECT created_at FROM project_web_change_observations WHERE project_id = ? ORDER BY created_at').all(project.id) as Array<{ created_at: number }>
  expect(rows.length).toBe(500)
  expect(rows[0]!.created_at).toBe(now + 2)
  // 历史记录（回填或跨版本遗留）早于 90 天时按时间窗清理。
  getProjectDb().prepare('UPDATE project_web_change_observations SET created_at = ? WHERE project_id = ? AND created_at = ?').run(now - 91 * 24 * 60 * 60 * 1000, project.id, now + 2)
  expect(pruneProjectWebChangeObservations(project.id, now)).toBe(1)
  expect((getProjectDb().prepare('SELECT COUNT(*) AS c FROM project_web_change_observations WHERE project_id = ?').get(project.id) as { c: number }).c).toBe(499)
})

test('Given 项目被删除 When 读取观察 Then 记录随项目清理且不再可用', () => {
  const project = createProject({ title: '待删项目', description: '' })
  const observation = recordProjectWebChangeObservation(input(project.id))!
  expect(deleteProject(project.id)).toBe(true)
  expect(listProjectWebChangeObservations(project.id)).toEqual([])
  expect(getAuthorizedProjectWebChangeObservation(project.id, observation.id)).toBeNull()
  expect(recordProjectWebChangeObservation(input(project.id))).toBeNull()
})

test('Given 含跟踪参数的链接 When 归一化来源 Then 去掉片段与跟踪参数', () => {
  expect(normalizeWebSourceId('https://Example.com/a/?utm_source=x&id=7#top')).toBe('https://example.com/a?id=7')
  expect(normalizeWebSourceId('https://example.com')).toBe('https://example.com/')
  expect(normalizeWebSourceId('ftp://example.com/a')).toBeNull()
  expect(normalizeWebSourceId('not a url')).toBeNull()
})
