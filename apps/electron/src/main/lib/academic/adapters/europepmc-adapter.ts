/**
 * EuropePMC 检索 adapter（M2.5，G2）
 *
 * REST API（公开）：https://www.ebi.ac.uk/europepmc/webservices/rest/search
 *   ?query=...&format=json&pageSize=N&resultType=core
 * resultType=core 才含 abstractText；有摘要标 abstract-only，
 * 有 openAccess 且 PMCID 时可达 full-text 线索（不下载正文）。
 */

import type { SourceVersion } from '@gravitas/shared'
import type { ScholarAdapter, ScholarSearchOptions, ScholarSearchResult } from './adapter-types'
import { readJsonOrError } from './adapter-types'
import { makeExternalId } from '@gravitas/core/services/academic'

const API_BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search'

interface EuropePmcResult {
  id?: string
  source?: string
  pmid?: string
  pmcid?: string
  doi?: string
  title?: string
  authorString?: string
  journalTitle?: string
  pubYear?: string
  abstractText?: string
  isOpenAccess?: string
  inEPMC?: string
}

export function createEuropePmcAdapter(fetchFn: typeof fetch): ScholarAdapter {
  return {
    databaseId: 'europepmc',

    async search(query: string, options: ScholarSearchOptions): Promise<ScholarSearchResult> {
      const pageSize = Math.min(options.limit, 100)
      const params = new URLSearchParams()
      params.set('query', query)
      params.set('format', 'json')
      params.set('pageSize', String(pageSize))
      params.set('resultType', 'core')
      for (const [k, v] of Object.entries(options.filters ?? {})) params.set(k, v)

      const data = await readJsonOrError(fetchFn, `${API_BASE}?${params.toString()}`)
      if (data && typeof data === 'object' && '__error' in data) {
        return { sources: [], truncated: false, errors: [`EuropePMC ${data.__error}`] }
      }

      const payload = data as { hitCount?: number; resultList?: { result?: EuropePmcResult[] } }
      const results = payload.resultList?.result ?? []
      const hitCount = payload.hitCount ?? 0

      const sources: SourceVersion[] = results
        .filter((r) => r.title)
        .map((r) => {
          const externalIds = []
          if (r.doi) externalIds.push(makeExternalId('doi', r.doi))
          if (r.pmid) externalIds.push(makeExternalId('pmid', r.pmid))
          if (r.pmcid) externalIds.push(makeExternalId('pmcid', r.pmcid))

          const hasAbstract = Boolean(r.abstractText)
          const retrievalStatus: SourceVersion['retrievalStatus'] = hasAbstract
            ? 'abstract-only'
            : 'metadata-only'

          return {
            id: `europepmc:${r.id ?? r.doi ?? r.title}`,
            sourceId: '',
            versionLabel: 'published',
            externalIds,
            title: stripTags(r.title!),
            authors: r.authorString
              ? r.authorString.split(/,|;/).map((a) => a.trim()).filter(Boolean)
              : [],
            year: r.pubYear && /^\d{4}$/.test(r.pubYear) ? parseInt(r.pubYear, 10) : undefined,
            venue: r.journalTitle,
            abstract: r.abstractText ? stripTags(r.abstractText) : undefined,
            retrievalStatus,
            licenseNote: r.isOpenAccess === 'Y' ? 'open access（正文未下载）' : undefined,
            retrievedAt: new Date().toISOString(),
          }
        })

      return {
        sources,
        totalCount: hitCount,
        truncated: hitCount > results.length,
        errors: [],
      }
    },
  }
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}
