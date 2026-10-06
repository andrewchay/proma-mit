import { describe, expect, test } from 'bun:test'

/**
 * 证据政策测试：无定位器拒绝、页码校验、来源归属校验、
 * agent-suggested 需人工确认。
 */

const {
  describeLocator,
  evidenceConfirmationStatus,
  validateEvidenceExcerpt,
  validateEvidenceLocator,
} = await import('@gravitas/core/services/academic')

const versions = [
  { id: 'v-1', sourceId: 's-1', versionLabel: 'published', externalIds: [], title: 'T', authors: [], retrievalStatus: 'full-text', retrievedAt: '2026-01-01T00:00:00.000Z' },
]

describe('证据定位器校验', () => {
  test('合法定位器通过', () => {
    expect(() => validateEvidenceLocator({ kind: 'pdf-page', page: 3 })).not.toThrow()
    expect(() => validateEvidenceLocator({ kind: 'timestamp', startSeconds: 90, endSeconds: 130 })).not.toThrow()
    expect(() => validateEvidenceLocator({ kind: 'table', tableId: 'T2', row: '3' })).not.toThrow()
  })

  test('非法页码与未知类型拒绝', () => {
    expect(() => validateEvidenceLocator({ kind: 'page', page: 0 })).toThrow('正整数')
    expect(() => validateEvidenceLocator({ kind: 'section', label: ' ' })).toThrow('不能为空')
    expect(() => validateEvidenceLocator({ kind: 'magic' } as never)).toThrow('未知定位器类型')
    expect(() =>
      validateEvidenceLocator({ kind: 'timestamp', startSeconds: 100, endSeconds: 100 }),
    ).toThrow('晚于')
  })

  test('证据必须挂到项目内的来源版本', () => {
    expect(() =>
      validateEvidenceExcerpt(
        { text: '原文片段', locator: { kind: 'page', page: 5 }, sourceVersionId: 'v-other' },
        versions as never,
      ),
    ).toThrow('来源版本')
  })

  test('agent-suggested 标为 needs_review，manual 即 confirmed', () => {
    expect(evidenceConfirmationStatus({ extractionMode: 'agent-suggested' })).toBe('needs_review')
    expect(evidenceConfirmationStatus({ extractionMode: 'manual' })).toBe('confirmed')
  })

  test('定位器可读描述', () => {
    expect(describeLocator({ kind: 'pdf-page', page: 7, anchor: '图 2' })).toContain('第 7 页')
    expect(describeLocator({ kind: 'timestamp', startSeconds: 30, endSeconds: 60 })).toBe('30s–60s')
  })
})
