/**
 * OpenAlex 检索 adapter（M2）
 *
 * 公开 API、免登录；带 mailto 进入 polite pool（方案 §7）。
 * 仅映射元数据与摘要（abstract-only）：OpenAlex 不提供全文，
 * retrievalStatus 不得虚报为 full-text。
 */

import type { SourceVersion } from '@gravitas/shared'
import type { ScholarAdapter, ScholarSearchOptions, ScholarSearchResult } from './adapter-types'
import { readJsonOrError, rebuildInvertedAbstract } from './adapter-types'
import { makeExternalId } from '@gravitas/core/services/academic'

const API_BASE = 'https://api.openalex.org/works'
const MAILTO = 'gravitas-app@local'

interface OpenAlexWork {
  id?: string
  doi?: string | null
  pmid?: string | null
  title?: string | null
  display_name?: string | null
  publication_year?: number | null
  authorships?: Array<{ author?: { display_name?: string } }>
  primary_location?: { source?: { display_name?: string | null } | null } | null
  abstract_inverted_index?: Record<string, number[]> | null
  open_access?: { is_oa?: boolean; oa_status?: string } | null
}

export function createOpenAlexAdapter(fetchFn: typeof fetch): ScholarAdapter {
  return {
    databaseId: 'openalex',

    async search(query: string, options: ScholarSearchOptions): Promise<ScholarSearchResult> {
      const params = new URLSearchParams()
      params.set('search', query)
      params.set('per-page', String(Math.min(options.limit, 200)))
      params.set('mailto', MAILTO)
      for (const [k, v] of Object.entries(options.filters ?? {})) params.set(k, v)
      const url = `${API_BASE}?${params.toString()}`

      const data = await readJsonOrError(fetchFn, url)
      if (data && typeof data === 'object' && '__error' in data) {
        return { sources: [], truncated: false, errors: [`OpenAlex ${data.__error}`] }
      }

      const payload = data as { meta?: { count?: number }; results?: OpenAlexWork[] }
      const results = payload.results ?? []
      const sources: SourceVersion[] = results
        .filter((w) => w.title || w.display_name)
        .map((w) => {
          const externalIds = []
          if (w.doi) externalIds.push(makeExternalId('doi', w.doi))
          if (w.pmid) externalIds.push(makeExternalId('pmid', String(w.pmid).replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//, '')))
          return {
            id: draftId(w.id ?? w.doi ?? w.title!),
            sourceId: '',
            versionLabel: 'published',
            externalIds,
            title: w.title ?? w.display_name!,
            authors: (w.authorships ?? [])
              .map((a) => a.author?.display_name)
              .filter((n): n is string => Boolean(n)),
            year: w.publication_year ?? undefined,
            venue: w.primary_location?.source?.display_name ?? undefined,
            abstract: rebuildInvertedAbstract(w.abstract_inverted_index),
            retrievalStatus: w.abstract_inverted_index ? ('abstract-only' as const) : ('metadata-only' as const),
            retrievedAt: new Date().toISOString(),
          }
        })

      return {
        sources,
        totalCount: payload.meta?.count,
        truncated: (payload.meta?.count ?? 0) > results.length,
        errors: [],
      }
    },
  }
}

function draftId(raw: string): string {
  const key = raw.replace(/^https?:\/\/openalex\.org\//, '').replace(/^https?:\/\/doi\.org\//, '')
  return `openalex:${key}`
}
