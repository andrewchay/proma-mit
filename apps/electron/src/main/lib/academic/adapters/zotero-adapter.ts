/**
 * Zotero 只读 adapter（M2.5，G2）
 *
 * 方案约束（§2 校正 + §7）：
 * - 首版只读；写回另行授权
 * - 不直接读写 zotero.sqlite；走官方 API
 * - 本地桌面 API 与 Web API 端点形状一致（基址不同），因此用同一实现
 * - 凭据不进代码：Web API key 由调用方经参数传入（生产走安全凭据流程）
 *
 * 取回 collection 内的 top-level items，映射为 SourceVersion 草稿。
 */

import type { SourceVersion, SourceType } from '@gravitas/shared'
import type { ScholarAdapter, ScholarSearchOptions, ScholarSearchResult } from './adapter-types'
import { makeExternalId } from '@gravitas/core/services/academic'

/** Zotero item 的 data 子集（只声明用到的字段） */
export interface ZoteroItemData {
  key?: string
  itemType?: string
  title?: string
  creators?: Array<{ creatorType?: string; firstName?: string; lastName?: string; name?: string }>
  date?: string
  publicationTitle?: string
  bookTitle?: string
  publisher?: string
  DOI?: string
  ISBN?: string
  url?: string
  abstractNote?: string
}

export interface ZoteroFetchConfig {
  /** API 基址：本地 http://localhost:23119/api 或 https://api.zotero.org */
  baseUrl: string
  /** 用户/群组库 ID */
  libraryId: string
  libraryType: 'users' | 'groups'
  /** Web API key（本地 API 不需要） */
  apiKey?: string
  /** collection key；缺省取整个库的 top-level items */
  collectionKey?: string
}

function mapZoteroItemType(itemType: string | undefined): SourceType {
  switch (itemType) {
    case 'journalArticle':
      return 'journal-article'
    case 'conferencePaper':
      return 'journal-article'
    case 'book':
      return 'book'
    case 'bookSection':
      return 'book-chapter'
    case 'thesis':
      return 'thesis'
    case 'preprint':
      return 'preprint'
    case 'webpage':
      return 'webpage'
    case 'dataset':
      return 'dataset'
    case 'interview':
      return 'interview'
    default:
      return 'other'
  }
}

function creatorsToAuthors(creators: ZoteroItemData['creators']): string[] {
  if (!Array.isArray(creators)) return []
  return creators
    .filter((c) => !c.creatorType || c.creatorType === 'author')
    .map((c) => c.name ?? [c.firstName, c.lastName].filter(Boolean).join(' '))
    .filter((n): n is string => Boolean(n && n.trim()))
}

export function mapZoteroItem(data: ZoteroItemData): SourceVersion | null {
  const title = data.title?.trim()
  if (!title) return null

  const externalIds = []
  if (data.DOI) externalIds.push(makeExternalId('doi', data.DOI))
  if (data.ISBN) externalIds.push(makeExternalId('isbn', data.ISBN))
  if (data.url) externalIds.push(makeExternalId('url', data.url))
  if (data.key) externalIds.push(makeExternalId('zotero', data.key))

  const yearMatch = data.date?.match(/(\d{4})/)
  const hasAbstract = Boolean(data.abstractNote)

  return {
    id: `zotero:${data.key ?? title}`,
    sourceId: '',
    versionLabel: 'library-item',
    externalIds,
    title,
    authors: creatorsToAuthors(data.creators),
    year: yearMatch ? parseInt(yearMatch[1]!, 10) : undefined,
    venue: data.publicationTitle ?? data.bookTitle ?? data.publisher,
    abstract: data.abstractNote,
    // 只读元数据导入：不声称已获取全文（附件导入后续里程碑）
    retrievalStatus: hasAbstract ? 'abstract-only' : 'metadata-only',
    retrievedAt: new Date().toISOString(),
  }
}

/** 把 Zotero 库当作一个"检索源"：按 collection 或整库拉取只读条目 */
export function createZoteroAdapter(fetchFn: typeof fetch, config: ZoteroFetchConfig): ScholarAdapter {
  return {
    databaseId: 'zotero',

    async search(query: string, options: ScholarSearchOptions): Promise<ScholarSearchResult> {
      const limit = Math.min(options.limit, 100)
      const base = config.baseUrl.replace(/\/$/, '')
      const scope = config.collectionKey
        ? `${base}/${config.libraryType}/${config.libraryId}/collections/${config.collectionKey}/items/top`
        : `${base}/${config.libraryType}/${config.libraryId}/items/top`

      const params = new URLSearchParams()
      params.set('format', 'json')
      params.set('limit', String(limit))
      params.set('itemType', '-attachment || note')
      if (query.trim()) params.set('q', query)

      const headers: Record<string, string> = {}
      if (config.apiKey) headers['Zotero-API-Key'] = config.apiKey

      let data: unknown
      try {
        const res = await fetchFn(`${scope}?${params.toString()}`, { headers })
        if (!res.ok) return { sources: [], truncated: false, errors: [`Zotero HTTP ${res.status}`] }
        data = await res.json()
      } catch (err) {
        return {
          sources: [],
          truncated: false,
          errors: [`Zotero ${err instanceof Error ? err.message : String(err)}`],
        }
      }

      if (!Array.isArray(data)) {
        return { sources: [], truncated: false, errors: ['Zotero 返回格式不是数组'] }
      }

      const sources: SourceVersion[] = []
      for (const entry of data as Array<{ data?: ZoteroItemData }>) {
        const mapped = mapZoteroItem(entry.data ?? {})
        if (mapped) sources.push(mapped)
      }

      return { sources, truncated: sources.length >= limit, errors: [] }
    },
  }
}
