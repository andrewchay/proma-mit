/**
 * PubMed 检索 adapter（M2.5，G2）
 *
 * 走 NCBI E-utilities（公开，免登录）：
 *   1) esearch.fcgi?db=pubmed&term=...&retmax=N&retmode=json → idlist
 *   2) esummary.fcgi?db=pubmed&id=...&retmode=json → 元数据
 *
 * 两步都需要，故 adapter 内部串行两次请求。失败归类为可显示错误，
 * 不抛出（部分失败语义由 source-service 处理）。
 */

import type { SourceVersion } from '@gravitas/shared'
import type { ScholarAdapter, ScholarSearchOptions, ScholarSearchResult } from './adapter-types'
import { readJsonOrError } from './adapter-types'
import { makeExternalId } from '@gravitas/core/services/academic'

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
const TOOL_PARAM = 'tool=gravitas&email=gravitas-app@local'

interface ESearchResponse {
  esearchresult?: { idlist?: string[]; count?: string }
}

interface ESummaryResponse {
  result?: Record<string, unknown>
}

export function createPubmedAdapter(fetchFn: typeof fetch): ScholarAdapter {
  return {
    databaseId: 'pubmed',

    async search(query: string, options: ScholarSearchOptions): Promise<ScholarSearchResult> {
      const limit = Math.min(options.limit, 100)
      const searchUrl = `${EUTILS}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${limit}&retmode=json&${TOOL_PARAM}`

      const searchData = await readJsonOrError(fetchFn, searchUrl)
      if (searchData && typeof searchData === 'object' && '__error' in searchData) {
        return { sources: [], truncated: false, errors: [`PubMed ${searchData.__error}`] }
      }
      const ids = (searchData as ESearchResponse).esearchresult?.idlist ?? []
      const total = parseInt((searchData as ESearchResponse).esearchresult?.count ?? '0', 10) || 0
      if (ids.length === 0) {
        return { sources: [], totalCount: total, truncated: false, errors: [] }
      }

      const summaryUrl = `${EUTILS}/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json&${TOOL_PARAM}`
      const summaryData = await readJsonOrError(fetchFn, summaryUrl)
      if (summaryData && typeof summaryData === 'object' && '__error' in summaryData) {
        return { sources: [], totalCount: total, truncated: false, errors: [`PubMed esummary ${summaryData.__error}`] }
      }

      const result = (summaryData as ESummaryResponse).result ?? {}
      const sources: SourceVersion[] = []
      for (const pmid of ids) {
        const raw = result[pmid] as Record<string, unknown> | undefined
        if (!raw || raw.error) continue

        const title = typeof raw.title === 'string' ? raw.title.replace(/<[^>]+>/g, '').trim() : ''
        if (!title) continue

        const authors = Array.isArray(raw.authors)
          ? (raw.authors as Array<{ name?: string }>).map((a) => a.name).filter((n): n is string => Boolean(n))
          : []
        const externalIds = [makeExternalId('pmid', pmid)]
        if (typeof raw.elocationid === 'string') {
          const doi = raw.elocationid.match(/10\.\S+/)
          if (doi) externalIds.push(makeExternalId('doi', doi[0]))
        }
        const yearRaw = typeof raw.pubdate === 'string' ? raw.pubdate.slice(0, 4) : ''

        sources.push({
          id: `pubmed:${pmid}`,
          sourceId: '',
          versionLabel: 'published',
          externalIds,
          title,
          authors,
          year: /^\d{4}$/.test(yearRaw) ? parseInt(yearRaw, 10) : undefined,
          venue: typeof raw.fulljournalname === 'string' ? raw.fulljournalname : undefined,
          // esummary 不含摘要：PubMed 结果一律 metadata-only，不冒充摘要/全文
          retrievalStatus: 'metadata-only',
          retrievedAt: new Date().toISOString(),
        })
      }

      return { sources, totalCount: total, truncated: total > ids.length, errors: [] }
    },
  }
}
