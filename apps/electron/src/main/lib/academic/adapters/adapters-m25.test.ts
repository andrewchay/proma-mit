import { describe, expect, test } from 'bun:test'

/**
 * PubMed / EuropePMC / Zotero adapter 契约测试（离线，注入 fetch）。
 * 验证请求构造、响应映射、获取等级不虚报、错误归类。
 */

const { createPubmedAdapter } = await import('./pubmed-adapter')
const { createEuropePmcAdapter } = await import('./europepmc-adapter')
const { createZoteroAdapter, mapZoteroItem } = await import('./zotero-adapter')

type FetchLike = typeof fetch

function multiFetch(handlers: Array<{ match: string; body: string; status?: number }>, seen: string[] = []) {
  return (async (url: string | URL | Request) => {
    const u = String(url)
    seen.push(u)
    const handler = handlers.find((h) => u.includes(h.match))
    if (!handler) return new Response('not found', { status: 404 })
    return new Response(handler.body, { status: handler.status ?? 200 })
  }) as unknown as FetchLike
}

// ===== PubMed =====

const PUBMED_SEARCH = JSON.stringify({ esearchresult: { count: '137', idlist: ['111', '222'] } })
const PUBMED_SUMMARY = JSON.stringify({
  result: {
    '111': {
      title: 'Noise Reduction and Listening Effort <i>in Adults</i>',
      authors: [{ name: 'Chen A' }, { name: 'Li B' }],
      pubdate: '2024 Mar',
      fulljournalname: 'Ear and Hearing',
      elocationid: 'doi: 10.1097/AUD.0000000000001500',
    },
    '222': { title: '', authors: [] },
  },
})

describe('PubMed adapter', () => {
  test('esearch + esummary 两步，映射元数据并归一化 PMID/DOI', async () => {
    const seen: string[] = []
    const adapter = createPubmedAdapter(
      multiFetch(
        [
          { match: 'esearch.fcgi', body: PUBMED_SEARCH },
          { match: 'esummary.fcgi', body: PUBMED_SUMMARY },
        ],
        seen,
      ),
    )
    const result = await adapter.search('noise reduction hearing aid', { limit: 20 })

    expect(seen.some((u) => u.includes('esearch.fcgi'))).toBe(true)
    expect(seen.some((u) => u.includes('esummary.fcgi'))).toBe(true)

    expect(result.totalCount).toBe(137)
    expect(result.truncated).toBe(true) // 137 > 2
    expect(result.sources).toHaveLength(1) // 222 的 title 为空被跳过

    const first = result.sources[0]!
    expect(first.title).toBe('Noise Reduction and Listening Effort in Adults')
    expect(first.authors).toEqual(['Chen A', 'Li B'])
    expect(first.year).toBe(2024)
    expect(first.venue).toBe('Ear and Hearing')
    expect(first.externalIds).toContainEqual({ namespace: 'pmid', value: '111' })
    expect(first.externalIds).toContainEqual({ namespace: 'doi', value: '10.1097/aud.0000000000001500' })
    // esummary 无摘要：不得冒充
    expect(first.retrievalStatus).toBe('metadata-only')
  })

  test('esearch 失败归类为错误', async () => {
    const adapter = createPubmedAdapter(
      multiFetch([{ match: 'esearch.fcgi', body: 'err', status: 429 }]),
    )
    const result = await adapter.search('x', { limit: 5 })
    expect(result.sources).toHaveLength(0)
    expect(result.errors[0]).toContain('429')
  })

  test('无结果时不请求 esummary', async () => {
    const seen: string[] = []
    const adapter = createPubmedAdapter(
      multiFetch(
        [{ match: 'esearch.fcgi', body: JSON.stringify({ esearchresult: { count: '0', idlist: [] } }) }],
        seen,
      ),
    )
    const result = await adapter.search('nothing', { limit: 5 })
    expect(result.sources).toHaveLength(0)
    expect(seen.some((u) => u.includes('esummary'))).toBe(false)
  })
})

// ===== EuropePMC =====

const EPMC_JSON = JSON.stringify({
  hitCount: 210,
  resultList: {
    result: [
      {
        id: '33333',
        pmid: '33333',
        pmcid: 'PMC1234567',
        doi: '10.1234/epmc.2023',
        title: 'Auditory Training: A Systematic Review',
        authorString: 'Zhang W, Li M, Wang X',
        journalTitle: 'Trends in Hearing',
        pubYear: '2023',
        abstractText: '<h4>Purpose</h4> To review auditory training.',
        isOpenAccess: 'Y',
      },
    ],
  },
})

describe('EuropePMC adapter', () => {
  test('映射元数据与摘要，剥离 HTML 标签', async () => {
    const seen: string[] = []
    const adapter = createEuropePmcAdapter(
      multiFetch([{ match: 'europepmc', body: EPMC_JSON }], seen),
    )
    const result = await adapter.search('auditory training', { limit: 25 })

    expect(seen[0]).toContain('resultType=core')
    expect(result.totalCount).toBe(210)
    expect(result.truncated).toBe(true)

    const first = result.sources[0]!
    expect(first.title).toBe('Auditory Training: A Systematic Review')
    expect(first.authors).toEqual(['Zhang W', 'Li M', 'Wang X'])
    expect(first.abstract).toContain('To review auditory training')
    expect(first.retrievalStatus).toBe('abstract-only')
    expect(first.externalIds).toContainEqual({ namespace: 'pmcid', value: 'PMC1234567' })
    expect(first.licenseNote).toContain('open access')
  })

  test('HTTP 错误归类', async () => {
    const adapter = createEuropePmcAdapter(
      multiFetch([{ match: 'europepmc', body: 'err', status: 503 }]),
    )
    const result = await adapter.search('x', { limit: 5 })
    expect(result.errors[0]).toContain('503')
  })
})

// ===== Zotero =====

const ZOTERO_ITEMS = JSON.stringify([
  {
    key: 'ABCD1234',
    data: {
      key: 'ABCD1234',
      itemType: 'journalArticle',
      title: 'Hearing Aid Fitting Outcomes',
      creators: [{ creatorType: 'author', firstName: 'Jane', lastName: 'Doe' }],
      date: '2021',
      publicationTitle: 'International Journal of Audiology',
      DOI: '10.1080/1234',
      abstractNote: 'Fitting outcomes measured.',
    },
  },
  { key: 'EMPTY', data: { key: 'EMPTY', itemType: 'note', title: '' } },
])

describe('Zotero adapter（只读）', () => {
  test('本地 API 基址 + 只读请求，映射库条目', async () => {
    const seen: string[] = []
    const adapter = createZoteroAdapter(
      multiFetch([{ match: '/users/12345/items/top', body: ZOTERO_ITEMS }], seen),
      { baseUrl: 'http://localhost:23119/api', libraryId: '12345', libraryType: 'users' },
    )
    const result = await adapter.search('', { limit: 50 })

    expect(seen[0]).toContain('http://localhost:23119/api/users/12345/items/top')
    expect(result.sources).toHaveLength(1) // 无标题的 note 跳过

    const first = result.sources[0]!
    expect(first.title).toBe('Hearing Aid Fitting Outcomes')
    expect(first.authors).toEqual(['Jane Doe'])
    expect(first.year).toBe(2021)
    expect(first.venue).toBe('International Journal of Audiology')
    expect(first.externalIds).toContainEqual({ namespace: 'zotero', value: 'ABCD1234' })
    expect(first.retrievalStatus).toBe('abstract-only')
  })

  test('group library 与 collection 范围构造正确 URL', async () => {
    const seen: string[] = []
    const adapter = createZoteroAdapter(
      multiFetch([{ match: 'collections/COLL1/items/top', body: '[]' }], seen),
      { baseUrl: 'https://api.zotero.org/', libraryId: '999', libraryType: 'groups', collectionKey: 'COLL1' },
    )
    await adapter.search('hearing', { limit: 10 })
    expect(seen[0]).toContain('https://api.zotero.org/groups/999/collections/COLL1/items/top')
    expect(seen[0]).toContain('q=hearing')
  })

  test('HTTP 错误归类（不抛异常）', async () => {
    const adapter = createZoteroAdapter(
      multiFetch([{ match: 'items/top', body: 'denied', status: 403 }]),
      { baseUrl: 'https://api.zotero.org', libraryId: '1', libraryType: 'users' },
    )
    const result = await adapter.search('', { limit: 5 })
    expect(result.errors[0]).toContain('403')
  })

  test('mapZoteroItem：无标题返回 null，preprint 映射', () => {
    expect(mapZoteroItem({ itemType: 'journalArticle' })).toBeNull()
    const preprint = mapZoteroItem({
      key: 'P1',
      itemType: 'preprint',
      title: 'Preprint Title',
      creators: [{ name: 'Single Name' }],
    })
    expect(preprint?.title).toBe('Preprint Title')
    expect(preprint?.authors).toEqual(['Single Name'])
  })
})
