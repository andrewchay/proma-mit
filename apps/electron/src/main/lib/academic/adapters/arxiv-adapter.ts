/**
 * arXiv 检索 adapter（M2）
 *
 * Atom feed，免登录。结果一律是预印本：versionLabel=preprint，
 * 不得冒充正式发表版本（方案 §5.4 区分预印本与正式版）。
 */

import type { SourceVersion } from '@gravitas/shared'
import type { ScholarAdapter, ScholarSearchOptions, ScholarSearchResult } from './adapter-types'
import { readTextOrError } from './adapter-types'
import { makeExternalId } from '@gravitas/core/services/academic'

const API_BASE = 'http://export.arxiv.org/api/query'

export function createArxivAdapter(fetchFn: typeof fetch): ScholarAdapter {
  return {
    databaseId: 'arxiv',

    async search(query: string, options: ScholarSearchOptions): Promise<ScholarSearchResult> {
      const params = new URLSearchParams()
      params.set('search_query', `all:${query}`)
      params.set('max_results', String(Math.min(options.limit, 100)))
      const url = `${API_BASE}?${params.toString()}`

      const text = await readTextOrError(fetchFn, url)
      if (typeof text === 'object' && '__error' in text) {
        return { sources: [], truncated: false, errors: [`arXiv ${text.__error}`] }
      }

      const sources: SourceVersion[] = []
      const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
      let entryMatch: RegExpExecArray | null
      while ((entryMatch = entryRegex.exec(text)) !== null) {
        const entry = entryMatch[1]!
        const id = matchTag(entry, 'id')
        const title = matchTag(entry, 'title')
        if (!id || !title) continue

        const arxivId = id.replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/i, '')
        const authors: string[] = []
        const authorRegex = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g
        let authorMatch: RegExpExecArray | null
        while ((authorMatch = authorRegex.exec(entry)) !== null) {
          authors.push(authorMatch[1]!.trim())
        }

        const published = matchTag(entry, 'published')
        sources.push({
          id: `arxiv:${arxivId}`,
          sourceId: '',
          versionLabel: 'preprint',
          externalIds: [makeExternalId('arxiv', arxivId)],
          title: title.replace(/\s+/g, ' ').trim(),
          authors,
          year: published ? parseInt(published.slice(0, 4), 10) || undefined : undefined,
          venue: 'arXiv',
          abstract: matchTag(entry, 'summary')?.replace(/\s+/g, ' ').trim(),
          retrievalStatus: 'abstract-only',
          retrievedAt: new Date().toISOString(),
        })
      }

      return {
        sources,
        truncated: sources.length >= Math.min(options.limit, 100),
        errors: [],
      }
    },
  }
}

function matchTag(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
  return m?.[1]
}
