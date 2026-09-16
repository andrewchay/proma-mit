import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScholarAdapter, ScholarSearchResult } from './adapters/adapter-types'

/**
 * 来源服务集成测试（M2 第一批）：
 * - RIS/BibTeX 导入落事件流
 * - 跨库检索记录运行日志（部分失败可见）
 * - 去重候选与筛选决定
 * 全部在 PROMA_TEST_CONFIG_DIR 隔离。
 */

let tempDir: string
const originalEnv = { ...process.env }

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'source-service-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

async function loadAll() {
  const svc = await import(`./source-service?t=${Math.random()}`)
  const projectSvc = await import(`./research-service?t=${Math.random()}`)
  const store = await import(`./research-store?t=${Math.random()}`)
  return { svc, projectSvc, store }
}

/** 创建项目并返回 id */
async function setupProject(projectSvc: {
  createResearchProject: (input: { title: string; domain: string; methodPath: string }) => Promise<{ id: string }>
}): Promise<string> {
  const project = await projectSvc.createResearchProject({
    title: '文献测试项目',
    domain: 'audiology',
    methodPath: 'quantitative',
  })
  return project.id
}

function fakeAdapter(databaseId: string, result: Partial<ScholarSearchResult>): ScholarAdapter {
  return {
    databaseId,
    search: async () => ({
      sources: [],
      truncated: false,
      errors: [],
      ...result,
    }),
  }
}

describe('source-service 文献闭环', () => {
  test('RIS 导入后来源可列出，DOI 规范化', async () => {
    const { svc, projectSvc } = await loadAll()
    const projectId = await setupProject(projectSvc)

    const imported = await svc.importBibliography(
      projectId,
      'ris',
      'TY  - JOUR\nTI  - Imported Study\nAU  - Author A\nDO  - 10.1/ABC\nER  - \n',
    )
    expect(imported).toHaveLength(1)
    expect(imported[0]!.versions[0]!.externalIds).toEqual([
      { namespace: 'doi', value: '10.1/abc' },
    ])

    const sources = await svc.listSources(projectId)
    expect(sources).toHaveLength(1)
    expect(sources[0]!.versions[0]!.title).toBe('Imported Study')
  })

  test('跨库检索：结果导入 + 运行日志含截断与部分失败', async () => {
    const { svc, projectSvc } = await loadAll()
    const projectId = await setupProject(projectSvc)

    const okAdapter = fakeAdapter('openalex', {
      sources: [
        {
          id: 'oa:1',
          sourceId: '',
          versionLabel: 'published',
          externalIds: [{ namespace: 'doi', value: '10.9/x' }],
          title: 'Search Hit One',
          authors: [],
          retrievalStatus: 'metadata-only',
          retrievedAt: '2026-09-16T10:00:00.000Z',
        },
      ],
      totalCount: 5,
      truncated: true,
      errors: [],
    })
    const failAdapter = fakeAdapter('arxiv', { errors: ['arXiv HTTP 500'] })

    const run = await svc.searchExternalSources(
      projectId,
      'hearing aids',
      ['openalex', 'arxiv'],
      { limit: 10 },
      { adapters: [okAdapter, failAdapter] },
    )

    expect(run.status).toBe('partial')
    expect(run.resultCount).toBe(1)
    expect(run.truncated).toBe(true)
    expect(run.importedSourceIds).toHaveLength(1)
    expect(run.errors[0]).toContain('arXiv')

    const sources = await svc.listSources(projectId)
    expect(sources).toHaveLength(1)
    expect(sources[0]!.versions[0]!.title).toBe('Search Hit One')

    const runs = await svc.listSearchRuns(projectId)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.databases).toEqual(['openalex', 'arxiv'])
  })

  test('同 DOI 的两个来源产生 exact-id 去重候选', async () => {
    const { svc, projectSvc } = await loadAll()
    const projectId = await setupProject(projectSvc)

    await svc.importBibliography(projectId, 'bibtex',
      '@article{a,\n  title = {Same Paper},\n  doi = {10.5/same}\n}\n')
    const adapter = fakeAdapter('openalex', {
      sources: [
        {
          id: 'oa:dup',
          sourceId: '',
          versionLabel: 'published',
          externalIds: [{ namespace: 'doi', value: '10.5/SAME' }],
          title: 'Same Paper (OA)',
          authors: [],
          retrievalStatus: 'metadata-only',
          retrievedAt: '2026-09-16T10:00:00.000Z',
        },
      ],
      truncated: false,
      errors: [],
    })
    await svc.searchExternalSources(projectId, 'same paper', ['openalex'], { limit: 5 }, { adapters: [adapter] })

    const candidates = await svc.findProjectDedupCandidates(projectId)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.kind).toBe('exact-id')
  })

  test('筛选决定必须带理由', async () => {
    const { svc, projectSvc } = await loadAll()
    const projectId = await setupProject(projectSvc)
    const [source] = await svc.importBibliography(
      projectId,
      'ris',
      'TY  - JOUR\nTI  - Screen Me\nER  - \n',
    )

    const decision = await svc.recordScreening(projectId, {
      sourceId: source!.id,
      round: 'title-abstract',
      decision: 'include',
      reason: '直接研究降噪与聆听负荷的关系',
    })
    expect(decision.decision).toBe('include')

    const all = await svc.listScreeningDecisions(projectId)
    expect(all).toHaveLength(1)

    expect(
      svc.recordScreening(projectId, {
        sourceId: source!.id,
        round: 'title-abstract',
        decision: 'exclude',
        reason: ' ',
      }),
    ).rejects.toThrow('理由')
  })

  test('空检索词与未知数据库拒绝', async () => {
    const { svc, projectSvc } = await loadAll()
    const projectId = await setupProject(projectSvc)

    expect(
      svc.searchExternalSources(projectId, ' ', ['openalex'], { limit: 5 }),
    ).rejects.toThrow('检索词')
    expect(
      svc.searchExternalSources(projectId, 'x', ['scopus'], { limit: 5 }),
    ).rejects.toThrow('未知数据库')
  })
})
