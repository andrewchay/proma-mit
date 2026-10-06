import { describe, expect, test } from 'bun:test'

/**
 * 来源身份与去重测试（方案 §6.1）：
 * - DOI 规范化（前缀、大小写、版本）
 * - 精确标识命中 → 去重候选；仅标题相似 → 需人工复核
 * - 预印本与正式版关联但不静默合并
 */

const { normalizeExternalId, externalIdKey, findDedupCandidates } = await import(
  '@gravitas/core/services/academic'
)

describe('外部标识规范化', () => {
  test('DOI 去掉 https://doi.org/ 前缀并转小写', () => {
    expect(normalizeExternalId('doi', 'https://doi.org/10.1234/ABC.def')).toBe('10.1234/abc.def')
    expect(normalizeExternalId('doi', '10.1234/XYZ')).toBe('10.1234/xyz')
  })

  test('arXiv 去掉版本号与 abs/ 前缀', () => {
    expect(normalizeExternalId('arxiv', '2401.12345v2')).toBe('2401.12345')
    expect(normalizeExternalId('arxiv', 'http://arxiv.org/abs/2401.12345v3')).toBe('2401.12345')
  })

  test('PMID/ISBN 只做去空白', () => {
    expect(normalizeExternalId('pmid', ' 12345678 ')).toBe('12345678')
    expect(normalizeExternalId('isbn', '978-3-16-148410-0')).toBe('9783161484100')
  })

  test('externalIdKey 生成命名空间化的稳定键', () => {
    expect(externalIdKey({ namespace: 'doi', value: '10.1234/A' })).toBe('doi:10.1234/a')
  })
})

describe('去重候选', () => {
  const now = '2026-09-16T10:00:00.000Z'

  type V = {
    id: string
    sourceId: string
    versionLabel: string
    externalIds: { namespace: string; value: string }[]
    title: string
    authors: string[]
    retrievalStatus: 'metadata-only' | 'abstract-only' | 'full-text'
    retrievedAt: string
    year?: number
    venue?: string
    abstract?: string
  }
  function version(overrides: Partial<V>): V {
    return {
      id: 'v-' + Math.random().toString(36).slice(2, 8),
      sourceId: 's',
      versionLabel: 'published',
      externalIds: [],
      title: '',
      authors: [],
      retrievalStatus: 'metadata-only' as const,
      retrievedAt: now,
      ...overrides,
    }
  }

  test('相同 DOI → 确切去重候选', () => {
    const versions = [
      version({ sourceId: 's1', externalIds: [{ namespace: 'doi', value: '10.1234/abc' }], title: 'Study A' }),
      version({ sourceId: 's2', externalIds: [{ namespace: 'doi', value: '10.1234/ABC' }], title: 'Study A (preprint)' }),
    ]
    const candidates = findDedupCandidates(versions as never)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].kind).toBe('exact-id')
    expect(candidates[0].versionIds).toHaveLength(2)
  })

  test('标题高度相似且无标识 → 需人工复核的候选', () => {
    const versions = [
      version({ sourceId: 's1', title: 'Hearing Aid Noise Reduction: A Randomized Trial' }),
      version({ sourceId: 's2', title: 'Hearing Aid Noise Reduction: A Randomized  Trial' }),
    ]
    const candidates = findDedupCandidates(versions as never)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].kind).toBe('similar-title')
  })

  test('不同文献不产生候选', () => {
    const versions = [
      version({ sourceId: 's1', title: 'Study A', externalIds: [{ namespace: 'doi', value: '10.1/a' }] }),
      version({ sourceId: 's2', title: 'Study B', externalIds: [{ namespace: 'doi', value: '10.2/b' }] }),
    ]
    expect(findDedupCandidates(versions as never)).toHaveLength(0)
  })
})
