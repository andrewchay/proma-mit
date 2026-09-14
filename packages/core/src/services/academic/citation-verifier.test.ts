/**
 * 引用验证器测试
 */

import { describe, it, expect } from 'bun:test'
import { CitationVerifier, createMemoryCitationAdapter } from './citation-verifier'
import type { DatabaseRecord } from './citation-verifier'

describe('CitationVerifier', () => {
  // 内存数据库（模拟外部 API）
  const mockDb: DatabaseRecord[] = [
    {
      doi: '10.1234/example.2023',
      title: 'Machine Learning for Natural Language Processing',
      authors: ['Smith, J.', 'Doe, A.'],
      year: 2023,
      journal: 'Journal of AI',
    },
    {
      doi: '10.5678/test.2022',
      title: 'Deep Learning in Computer Vision',
      authors: ['Wang, L.', 'Zhang, M.'],
      year: 2022,
      journal: 'CVPR',
    },
  ]

  const adapter = createMemoryCitationAdapter(mockDb)
  const verifier = new CitationVerifier([adapter])

  // ============================================
  // DOI 验证
  // ============================================

  it('should validate correct DOI format', async () => {
    const result = await verifier.verifyCitation({
      rawText: 'test',
      doi: '10.1234/example.2023',
    })
    expect(result.isValid).toBe(true)
  })

  it('should flag invalid DOI format', async () => {
    const result = await verifier.verifyCitation({
      rawText: 'test',
      doi: 'invalid-doi',
    })
    expect(result.isValid).toBe(false)
    expect(result.issue).toContain('DOI 格式无效')
  })

  // ============================================
  // 数据库交叉核对
  // ============================================

  it('should find citation by DOI in database', async () => {
    const result = await verifier.verifyCitation({
      rawText: 'Smith et al. (2023) proposed...',
      doi: '10.1234/example.2023',
      title: 'Machine Learning for Natural Language Processing',
      authors: ['Smith'],
      year: 2023,
    })
    expect(result.isValid).toBe(true)
  })

  it('should find citation by title in database', async () => {
    const result = await verifier.verifyCitation({
      rawText: 'Wang and Zhang (2022) showed...',
      title: 'Deep Learning in Computer Vision',
      authors: ['Wang'],
      year: 2022,
    })
    expect(result.isValid).toBe(true)
  })

  it('should report missing citation in database', async () => {
    const result = await verifier.verifyCitation({
      rawText: 'Unknown paper (2024) claimed...',
      title: 'Non-existent Paper Title',
    })
    expect(result.isValid).toBe(false)
    expect(result.issue).toContain('未能在外部数据库中找到')
  })

  // ============================================
  // 字段匹配检查
  // ============================================

  it('should detect year mismatch', async () => {
    const result = await verifier.verifyCitation({
      rawText: 'Smith et al. (2021) proposed...',
      doi: '10.1234/example.2023',
      title: 'Machine Learning for Natural Language Processing',
      authors: ['Smith'],
      year: 2021, // 错误年份
    })
    expect(result.isValid).toBe(false)
    expect(result.issue).toContain('年份不一致')
  })

  it('should detect title mismatch', async () => {
    const result = await verifier.verifyCitation({
      rawText: 'test',
      doi: '10.1234/example.2023',
      title: 'Completely Different Title',
      authors: ['Smith'],
      year: 2023,
    })
    expect(result.isValid).toBe(false)
    expect(result.issue).toContain('标题匹配度低')
  })

  it('should detect author mismatch', async () => {
    const result = await verifier.verifyCitation({
      rawText: 'test',
      doi: '10.1234/example.2023',
      title: 'Machine Learning for Natural Language Processing',
      authors: ['Johnson'], // 错误作者
      year: 2023,
    })
    expect(result.isValid).toBe(false)
    expect(result.issue).toContain('作者信息不匹配')
  })

  // ============================================
  // 批量验证
  // ============================================

  it('should verify multiple citations', async () => {
    const citations = [
      { rawText: 'c1', doi: '10.1234/example.2023' },
      { rawText: 'c2', doi: '10.5678/test.2022' },
      { rawText: 'c3', title: 'Non-existent' },
    ]

    const results = await verifier.verifyCitations(citations)
    expect(results.length).toBe(3)
    expect(results[0]!.isValid).toBe(true)
    expect(results[1]!.isValid).toBe(true)
    expect(results[2]!.isValid).toBe(false)
  })

  // ============================================
  // 引用提取
  // ============================================

  it('should extract DOI citations from text', () => {
    const text = 'This study builds on Smith et al. (2023) 10.1234/example.2023 and Wang (2022).'
    const citations = verifier.extractCitations(text)

    expect(citations.length).toBeGreaterThan(0)
    expect(citations.some((c) => c.doi === '10.1234/example.2023')).toBe(true)
  })

  it('should extract bracket citations from text', () => {
    const text = 'Previous work [1,2] showed that [3-5] confirmed.'
    const citations = verifier.extractCitations(text)

    expect(citations.length).toBeGreaterThan(0)
    expect(citations.some((c) => c.rawText.includes('[1,2]'))).toBe(true)
  })

  it('should deduplicate extracted citations', () => {
    const text = 'Same DOI 10.1234/example.2023 appears twice 10.1234/example.2023.'
    const citations = verifier.extractCitations(text)

    const doiCitations = citations.filter((c) => c.doi === '10.1234/example.2023')
    expect(doiCitations.length).toBe(1)
  })

  // ============================================
  // 配置选项
  // ============================================

  it('should require DOI when configured', async () => {
    const strictVerifier = new CitationVerifier([adapter], { requireDoi: true })
    const result = await strictVerifier.verifyCitation({
      rawText: 'test',
      title: 'Some Title',
    })
    expect(result.isValid).toBe(false)
    expect(result.issue).toContain('缺少 DOI')
  })

  it('should not require DOI by default', async () => {
    const result = await verifier.verifyCitation({
      rawText: 'test',
      title: 'Deep Learning in Computer Vision',
      authors: ['Wang'],
    })
    expect(result.isValid).toBe(true)
  })

  // ============================================
  // 建议生成
  // ============================================

  it('should suggest correct DOI when missing', async () => {
    const result = await verifier.verifyCitation({
      rawText: 'test',
      title: 'Machine Learning for Natural Language Processing',
      authors: ['Smith'],
      year: 2023,
    })
    expect(result.suggestion).toContain('10.1234/example.2023')
  })

  it('should suggest checking title when mismatch', async () => {
    const result = await verifier.verifyCitation({
      rawText: 'test',
      doi: '10.1234/example.2023',
      title: 'Wrong Title',
      authors: ['Smith'],
      year: 2023,
    })
    expect(result.suggestion).toContain('核对标题')
  })
})
