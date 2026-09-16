/**
 * 文献来源应用服务（M2 第一批）
 *
 * 职责：导入（RIS/BibTeX）、外部检索（adapter + 检索日志）、
 * 去重候选、筛选决定。全部落为研究项目事件流（research-store），
 * 与项目状态共用权威记录。
 */

import { randomUUID } from 'node:crypto'
import type {
  ExternalId,
  ResearchProject,
  ScreeningDecision,
  SearchRunRecord,
  Source,
  SourceType,
  SourceVersion,
} from '@gravitas/shared'
import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'
import { findDedupCandidates, type DedupCandidate } from '@gravitas/core/services/academic'
import { parseBibtex, parseRis, type BibliographicDraft } from '@gravitas/core/services/academic'
import { appendEvent, loadProjectState } from './research-store'
import type { ScholarAdapter, ScholarSearchOptions } from './adapters/adapter-types'
import { createOpenAlexAdapter } from './adapters/openalex-adapter'
import { createArxivAdapter } from './adapters/arxiv-adapter'

export interface SourceServiceDeps {
  adapters?: ScholarAdapter[]
  /** 注入 fetch（测试）；缺省使用全局 fetch（生产经统一代理接入） */
  fetchFn?: typeof fetch
}

const DEFAULT_DATABASES: Record<string, (fetchFn: typeof fetch) => ScholarAdapter> = {
  openalex: createOpenAlexAdapter,
  arxiv: createArxivAdapter,
}

function resolveAdapters(deps: SourceServiceDeps): ScholarAdapter[] {
  if (deps.adapters) return deps.adapters
  const fetchFn = deps.fetchFn ?? fetch
  return Object.entries(DEFAULT_DATABASES).map(([id, create]) => create(fetchFn))
}

async function requireProject(projectId: string): Promise<ResearchProject> {
  const state = await loadProjectState(projectId)
  if (!state.project) {
    throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `研究项目不存在: ${projectId}`)
  }
  return state.project
}

/** 从事件流重建项目全部来源 */
export async function listSources(projectId: string): Promise<Source[]> {
  await requireProject(projectId)
  const { readProjectEvents } = await import('./research-store')
  const events = await readProjectEvents(projectId)
  const sources = new Map<string, Source>()
  for (const envelope of events) {
    if (envelope.payload.type === 'source_imported') {
      const s = envelope.payload.source
      sources.set(s.id, s)
    }
  }
  return [...sources.values()]
}

// ===== 导入 =====

/** 从 RIS/BibTeX 文本导入来源 */
export async function importBibliography(
  projectId: string,
  format: 'ris' | 'bibtex',
  text: string,
): Promise<Source[]> {
  await requireProject(projectId)
  const drafts: BibliographicDraft[] =
    format === 'ris' ? parseRis(text) : parseBibtex(text)
  if (drafts.length === 0) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `未从 ${format} 文本解析出任何文献记录`)
  }

  const imported: Source[] = []
  for (const draft of drafts) {
    const source = buildSource(projectId, draft.sourceType, draft)
    await appendEvent(projectId, {
      commandId: `source-${randomUUID()}`,
      payload: { type: 'source_imported', source, origin: 'import' },
    })
    imported.push(source)
  }
  return imported
}

function buildSource(
  projectId: string,
  sourceType: SourceType,
  draft: {
    title: string
    authors: string[]
    year?: number
    venue?: string
    abstract?: string
    externalIds: ExternalId[]
  },
  versionLabel = 'published',
  retrievalStatus: SourceVersion['retrievalStatus'] = draft.abstract ? 'abstract-only' : 'metadata-only',
): Source {
  const now = new Date().toISOString()
  const sourceId = randomUUID()
  const version: SourceVersion = {
    id: `${sourceId}-v1`,
    sourceId,
    versionLabel,
    externalIds: draft.externalIds,
    title: draft.title,
    authors: draft.authors,
    year: draft.year,
    venue: draft.venue,
    abstract: draft.abstract,
    retrievalStatus,
    retrievedAt: now,
  }
  return {
    id: sourceId,
    projectId,
    type: sourceType,
    versions: [version],
    createdAt: now,
    updatedAt: now,
  }
}

// ===== 外部检索 =====

/**
 * 跨库检索并记录运行日志。
 *
 * 每库结果导入为 metadata/abstract-only 来源；单库失败不中断其他库，
 * 错误进 SearchRunRecord.errors（部分失败可见，不冒充完整覆盖）。
 */
export async function searchExternalSources(
  projectId: string,
  query: string,
  databaseIds: string[],
  options: ScholarSearchOptions,
  deps: SourceServiceDeps = {},
): Promise<SearchRunRecord> {
  await requireProject(projectId)
  if (!query.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '检索词不能为空')
  }
  const adapters = resolveAdapters(deps).filter((a) => databaseIds.includes(a.databaseId))
  if (adapters.length === 0) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `未知数据库: ${databaseIds.join(', ')}`)
  }

  const startedAt = new Date().toISOString()
  const importedSourceIds: string[] = []
  const errors: string[] = []
  let resultCount = 0
  let truncated = false

  for (const adapter of adapters) {
    try {
      const result = await adapter.search(query, options)
      resultCount += result.sources.length
      truncated = truncated || result.truncated
      for (const adapterError of result.errors ?? []) {
        errors.push(`${adapter.databaseId}: ${adapterError}`)
      }
      for (const version of result.sources) {
        const source = buildSource(
          projectId,
          version.versionLabel === 'preprint' ? 'preprint' : 'journal-article',
          {
            title: version.title,
            authors: version.authors,
            year: version.year,
            venue: version.venue,
            abstract: version.abstract,
            externalIds: version.externalIds,
          },
          version.versionLabel,
          version.retrievalStatus,
        )
        await appendEvent(projectId, {
          commandId: `source-${randomUUID()}`,
          payload: { type: 'source_imported', source, origin: 'search' },
        })
        importedSourceIds.push(source.id)
      }
    } catch (err) {
      errors.push(`${adapter.databaseId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const run: SearchRunRecord = {
    id: randomUUID(),
    projectId,
    query,
    databases: adapters.map((a) => a.databaseId),
    startedAt,
    finishedAt: new Date().toISOString(),
    status: errors.length === 0 ? 'completed' : importedSourceIds.length > 0 ? 'partial' : 'error',
    resultCount,
    importedSourceIds,
    truncated,
    errors,
  }
  await appendEvent(projectId, {
    commandId: `search-${randomUUID()}`,
    payload: { type: 'search_recorded', run },
  })
  return run
}

/** 查询项目的检索运行历史 */
export async function listSearchRuns(projectId: string): Promise<SearchRunRecord[]> {
  await requireProject(projectId)
  const { readProjectEvents } = await import('./research-store')
  const events = await readProjectEvents(projectId)
  return events
    .filter((e) => e.payload.type === 'search_recorded')
    .map((e) => (e.payload as { run: SearchRunRecord }).run)
}

// ===== 去重与筛选 =====

/** 项目的去重候选（exact-id 可自动提示；similar-title 需人工） */
export async function findProjectDedupCandidates(projectId: string): Promise<DedupCandidate[]> {
  const sources = await listSources(projectId)
  const versions = sources.flatMap((s) => s.versions)
  return findDedupCandidates(versions)
}

/** 记录筛选决定 */
export async function recordScreening(
  projectId: string,
  input: { sourceId: string; round: ScreeningDecision['round']; decision: ScreeningDecision['decision']; reason: string },
): Promise<ScreeningDecision> {
  await requireProject(projectId)
  if (!input.reason.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '筛选决定必须记录理由')
  }
  const decision: ScreeningDecision = {
    id: randomUUID(),
    projectId,
    sourceId: input.sourceId,
    round: input.round,
    decision: input.decision,
    reason: input.reason,
    recordedAt: new Date().toISOString(),
  }
  await appendEvent(projectId, {
    commandId: `screening-${randomUUID()}`,
    payload: { type: 'screening_recorded', decision },
  })
  return decision
}

/** 列出项目的筛选决定 */
export async function listScreeningDecisions(projectId: string): Promise<ScreeningDecision[]> {
  await requireProject(projectId)
  const { readProjectEvents } = await import('./research-store')
  const events = await readProjectEvents(projectId)
  return events
    .filter((e) => e.payload.type === 'screening_recorded')
    .map((e) => (e.payload as { decision: ScreeningDecision }).decision)
}
