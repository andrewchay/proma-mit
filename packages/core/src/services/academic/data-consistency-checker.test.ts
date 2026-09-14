/**
 * 数据一致性检查器测试
 */

import { describe, it, expect } from 'bun:test'
import { DataConsistencyChecker } from './data-consistency-checker'

describe('DataConsistencyChecker', () => {
  const checker = new DataConsistencyChecker()

  // ============================================
  // 数字一致性
  // ============================================

  it('should detect number mismatch between text and table', () => {
    const result = checker.check({
      text: 'The accuracy reached 95.5%.',
      tables: [
        { id: 'table-1', title: 'Results', data: 'Accuracy: 94.2%' },
      ],
    })

    const mismatch = result.find((r) => r.type === 'number-mismatch')
    expect(mismatch).toBeDefined()
    expect(mismatch!.severity).toBe('error')
  })

  it('should pass when numbers match', () => {
    const result = checker.check({
      text: 'The accuracy reached 95.5%.',
      tables: [
        { id: 'table-1', title: 'Results', data: 'Accuracy: 95.5%' },
      ],
    })

    const mismatch = result.find((r) => r.type === 'number-mismatch')
    expect(mismatch).toBeUndefined()
  })

  it('should detect number mismatch between text and figure', () => {
    const result = checker.check({
      text: 'The model achieved 88% precision.',
      figures: [
        { id: 'figure-1', caption: 'Performance', data: 'Precision: 82%' },
      ],
    })

    const mismatch = result.find((r) => r.type === 'number-mismatch')
    expect(mismatch).toBeDefined()
  })

  // ============================================
  // 单位一致性
  // ============================================

  it('should detect unit inconsistency', () => {
    const result = checker.check({
      text: 'Weight is 5 kg and volume is 100 mL.',
      tables: [
        { id: 'table-1', title: 'Data', data: 'Weight: 5000 g' },
      ],
    })

    const unitIssue = result.find((r) => r.type === 'unit-inconsistent')
    expect(unitIssue).toBeDefined()
    expect(unitIssue!.description).toContain('kg')
    expect(unitIssue!.description).toContain('g')
  })

  // ============================================
  // 引用完整性
  // ============================================

  it('should detect missing table reference', () => {
    const result = checker.check({
      text: 'As shown in Table 1, the results are significant.',
      tables: [], // 没有 table-1
    })

    const missing = result.find((r) => r.type === 'missing-reference')
    expect(missing).toBeDefined()
    expect(missing!.description).toContain('Table 1')
  })

  it('should detect missing figure reference', () => {
    const result = checker.check({
      text: 'Figure 2 illustrates the trend.',
      figures: [], // 没有 figure-2
    })

    const missing = result.find((r) => r.type === 'missing-reference')
    expect(missing).toBeDefined()
    expect(missing!.description).toContain('Figure 2')
  })

  it('should pass when references exist', () => {
    const result = checker.check({
      text: 'As shown in Table 1 and Figure 2.',
      tables: [{ id: 'table-1', title: 'Results', data: '' }],
      figures: [{ id: 'figure-2', caption: 'Trend', data: '' }],
    })

    const missing = result.find((r) => r.type === 'missing-reference')
    expect(missing).toBeUndefined()
  })

  // ============================================
  // 计算验证
  // ============================================

  it('should detect calculation error in addition', () => {
    const result = checker.check({
      text: 'The total is 50 + 30 = 90.',
    })

    const calcError = result.find((r) => r.description.includes('计算错误'))
    expect(calcError).toBeDefined()
    expect(calcError!.description).toContain('80')
  })

  it('should pass correct calculation', () => {
    const result = checker.check({
      text: 'The total is 50 + 30 = 80.',
    })

    const calcError = result.find((r) => r.description.includes('计算错误'))
    expect(calcError).toBeUndefined()
  })

  it('should detect percentage calculation error', () => {
    const result = checker.check({
      text: '25 of 100 is 20%.',
    })

    const pctError = result.find((r) => r.description.includes('百分比计算错误'))
    expect(pctError).toBeDefined()
    expect(pctError!.description).toContain('25.0%')
  })

  it('should pass correct percentage calculation', () => {
    const result = checker.check({
      text: '25 of 100 is 25%.',
    })

    const pctError = result.find((r) => r.description.includes('百分比计算错误'))
    expect(pctError).toBeUndefined()
  })

  // ============================================
  // 容差配置
  // ============================================

  it('should respect tolerance for minor differences', () => {
    const tolerantChecker = new DataConsistencyChecker({ tolerancePercent: 5 })
    const result = tolerantChecker.check({
      text: 'The value is 100.0.',
      tables: [
        { id: 'table-1', title: 'Data', data: 'Value: 103.0' },
      ],
    })

    // 3% 差异在 5% 容差内，不应报告
    const mismatch = result.find((r) => r.type === 'number-mismatch')
    expect(mismatch).toBeUndefined()
  })

  // ============================================
  // 空输入
  // ============================================

  it('should handle empty input', () => {
    const result = checker.check({ text: '' })
    expect(result).toEqual([])
  })

  it('should handle text with no data points', () => {
    const result = checker.check({
      text: 'This is a purely descriptive paragraph without any numbers.',
    })
    expect(result).toEqual([])
  })
})
