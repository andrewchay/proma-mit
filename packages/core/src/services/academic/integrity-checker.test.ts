/**
 * 完整性检查服务测试
 */

import { describe, it, expect } from 'bun:test'
import { IntegrityChecker, checkPaperIntegrity } from './integrity-checker'
import { createMemoryCitationAdapter } from './citation-verifier'
import type { DatabaseRecord } from './citation-verifier'

describe('IntegrityChecker', () => {
  const mockDb: DatabaseRecord[] = [
    {
      doi: '10.1234/example.2023',
      title: 'Machine Learning for NLP',
      authors: ['Smith, J.'],
      year: 2023,
    },
  ]

  const adapter = createMemoryCitationAdapter(mockDb)

  // ============================================
  // 综合检查
  // ============================================

  it('should generate complete integrity report', async () => {
    const checker = new IntegrityChecker({ citationAdapters: [adapter] })
    const report = await checker.check({
      paperId: 'paper-1',
      text: 'Smith et al. (2023) proposed ML for NLP. 10.1234/example.2023 The accuracy is 95%.',
    })

    expect(report.paperId).toBe('paper-1')
    expect(report.checkedAt).toBeGreaterThan(0)
    expect(report.citations).toBeDefined()
    expect(report.dataIssues).toBeDefined()
    expect(report.logicGaps).toBeDefined()
    expect(report.overallScore).toBeGreaterThanOrEqual(0)
    expect(report.overallScore).toBeLessThanOrEqual(100)
    expect(typeof report.isSubmittable).toBe('boolean')
  })

  it('should mark submittable when no issues', async () => {
    const checker = new IntegrityChecker({ citationAdapters: [adapter] })
    const report = await checker.check({
      paperId: 'paper-clean',
      text: 'This is a clean paper with no citations or data.',
    })

    expect(report.isSubmittable).toBe(true)
    expect(report.overallScore).toBe(100)
  })

  it('should not mark submittable with errors', async () => {
    const checker = new IntegrityChecker({ citationAdapters: [adapter] })
    const report = await checker.check({
      paperId: 'paper-bad',
      text: 'The accuracy is 95.5%.',
      tables: [{ id: 'table-1', title: 'Results', data: 'Accuracy: 94.2%' }],
    })

    expect(report.isSubmittable).toBe(false)
    expect(report.overallScore).toBeLessThan(100)
  })

  // ============================================
  // 评分计算
  // ============================================

  it('should deduct score for invalid citations', async () => {
    const checker = new IntegrityChecker({ citationAdapters: [adapter] })
    const report = await checker.check({
      paperId: 'paper-cite',
      text: 'Unknown paper (2024) claimed something.',
      citations: [{ rawText: 'Unknown', title: 'Non-existent' }],
    })

    expect(report.overallScore).toBeLessThan(100)
    expect(report.citations.some((c) => !c.isValid)).toBe(true)
  })

  it('should deduct score for data errors', async () => {
    const checker = new IntegrityChecker()
    const report = await checker.check({
      paperId: 'paper-data',
      text: 'The value is 100.',
      tables: [{ id: 'table-1', title: 'Data', data: 'Value: 105' }],
    })

    expect(report.overallScore).toBeLessThan(100)
    expect(report.dataIssues.some((d) => d.severity === 'error')).toBe(true)
  })

  it('should deduct score for major logic gaps', async () => {
    const checker = new IntegrityChecker()
    const report = await checker.check({
      paperId: 'paper-logic',
      text: '因此，我们可以得出结论。',
    })

    expect(report.overallScore).toBeLessThan(100)
    expect(report.logicGaps.some((g) => g.severity === 'major')).toBe(true)
  })

  // ============================================
  // AI 披露声明
  // ============================================

  it('should generate AI disclosure when assisted', async () => {
    const checker = new IntegrityChecker()
    const report = await checker.check({
      paperId: 'paper-ai',
      text: 'Clean text.',
      aiAssistedSections: ['introduction', 'abstract'],
    })

    expect(report.aiDisclosure).toContain('AI 使用披露声明')
    expect(report.aiDisclosure).toContain('introduction')
    expect(report.aiDisclosure).toContain('abstract')
  })

  it('should generate no-AI disclosure when not assisted', async () => {
    const checker = new IntegrityChecker()
    const report = await checker.check({
      paperId: 'paper-no-ai',
      text: 'Clean text.',
      aiAssistedSections: [],
    })

    expect(report.aiDisclosure).toContain('未使用')
  })

  // ============================================
  // 配置控制
  // ============================================

  it('should skip citation check when disabled', async () => {
    const checker = new IntegrityChecker({
      enableCitationCheck: false,
      citationAdapters: [adapter],
    })
    const report = await checker.check({
      paperId: 'paper-skip',
      text: 'Smith et al. (2023) 10.1234/example.2023',
    })

    expect(report.citations.length).toBe(0)
  })

  it('should skip data check when disabled', async () => {
    const checker = new IntegrityChecker({ enableDataCheck: false })
    const report = await checker.check({
      paperId: 'paper-skip',
      text: 'The value is 100.',
      tables: [{ id: 'table-1', title: 'Data', data: 'Value: 200' }],
    })

    expect(report.dataIssues.length).toBe(0)
  })

  it('should skip logic scan when disabled', async () => {
    const checker = new IntegrityChecker({ enableLogicScan: false })
    const report = await checker.check({
      paperId: 'paper-skip',
      text: '因此，结论成立。',
    })

    expect(report.logicGaps.length).toBe(0)
  })

  // ============================================
  // 便捷函数
  // ============================================

  it('should work with checkPaperIntegrity helper', async () => {
    const report = await checkPaperIntegrity({
      paperId: 'paper-helper',
      text: 'Clean paper.',
    })

    expect(report.paperId).toBe('paper-helper')
    expect(report.isSubmittable).toBe(true)
  })
})
