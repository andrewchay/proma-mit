/**
 * 学术检索 adapter 契约测试（离线，注入 fetch）
 *
 * 验证 OpenAlex / arXiv 的请求构造、响应映射、截断与错误处理；
 * 不打真实网络。真实端点 smoke 在联调阶段单独执行。
 */

import { describe, expect, test } from 'bun:test'

const { createOpenAlexAdapter } = await import('./openalex-adapter')
const { createArxivAdapter } = await import('./arxiv-adapter')

function fakeFetch(body: string, capture: { url?: string } = {}) {
  return (async (url: string | URL | Request) => {
    capture.url = String(url)
    return new Response(body, { status: 200 })
  }) as unknown as typeof fetch
}

const OPENALEX_JSON = JSON.stringify({
  meta: { count: 42 },
  results: [
    {
      id: 'https://openalex.org/W123',
      doi: 'https://doi.org/10.1234/OA.2024',
      title: 'OpenAlex Result Title',
      publication_year: 2024,
      authorships: [{ author: { display_name: 'Alice Chen' } }, { author: { display_name: 'Bob Li' } }],
      primary_location: { source: { display_name: 'Hearing Research' } },
      abstract_inverted_index: { 'Noise': [0], 'reduction': [1], 'helps': [2], 'listeners': [3] },
      open_access: { is_oa: true, oa_status: 'gold' },
    },
    {
      id: 'https://openalex.org/W456',
      doi: null,
      title: 'No DOI Result',
      publication_year: 2022,
      authorships: [],
    },
  ],
})

const ARXIV_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.12345v2</id>
    <title>Retrieval Augmented Generation Survey</title>
    <summary>We survey methods for grounding.</summary>
    <author><name>Author One</name></author>
    <author><name>Author Two</name></author>
    <published>2024-01-15T00:00:00Z</published>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2402.67890</id>
    <title>Second Paper</title>
    <summary>Abstract two.</summary>
    <author><name>Author Three</name></author>
    <published>2024-02-01T00:00:00Z</published>
  </entry>
</feed>`

describe('OpenAlex adapter', () => {
  test('构造查询并映射结果', async () => {
    const capture: { url?: string } = {}
    const adapter = createOpenAlexAdapter(fakeFetch(OPENALEX_JSON, capture))
    const result = await adapter.search('noise reduction hearing aid', { limit: 2 })

    expect(capture.url).toContain('api.openalex.org/works')
    expect(capture.url).toContain('search=noise')
    expect(capture.url).toContain('mailto=')
    expect(result.totalCount).toBe(42)
    expect(result.sources).toHaveLength(2)

    const first = result.sources[0]!
    expect(first.title).toBe('OpenAlex Result Title')
    expect(first.externalIds).toContainEqual({ namespace: 'doi', value: '10.1234/oa.2024' })
    expect(first.authors).toEqual(['Alice Chen', 'Bob Li'])
    expect(first.venue).toBe('Hearing Research')
    expect(first.abstract).toBe('Noise reduction helps listeners')
    expect(first.retrievalStatus).toBe('abstract-only')
  })

  test('HTTP 错误归类为可显示错误而不是抛出', async () => {
    const adapter = createOpenAlexAdapter((async () => new Response('oops', { status: 429 })) as unknown as typeof fetch)
    const result = await adapter.search('anything', { limit: 5 })
    expect(result.sources).toHaveLength(0)
    expect(result.errors[0]).toContain('429')
  })
})

describe('arXiv adapter', () => {
  test('解析 Atom feed 并规范化 arXiv id（去版本号）', async () => {
    const capture: { url?: string } = {}
    const adapter = createArxivAdapter(fakeFetch(ARXIV_ATOM, capture))
    const result = await adapter.search('retrieval augmented generation', { limit: 10 })

    expect(capture.url).toContain('export.arxiv.org/api/query')
    expect(result.sources).toHaveLength(2)
    const first = result.sources[0]!
    expect(first.externalIds).toContainEqual({ namespace: 'arxiv', value: '2401.12345' })
    expect(first.versionLabel).toBe('preprint')
    expect(first.title).toBe('Retrieval Augmented Generation Survey')
    expect(first.authors).toEqual(['Author One', 'Author Two'])
  })

  test('非 200 返回错误', async () => {
    const adapter = createArxivAdapter((async () => new Response('err', { status: 500 })) as unknown as typeof fetch)
    const result = await adapter.search('x', { limit: 5 })
    expect(result.errors[0]).toContain('500')
  })
})
