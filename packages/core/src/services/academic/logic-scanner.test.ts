/**
 * 逻辑漏洞扫描器测试
 */

import { describe, it, expect } from 'bun:test'
import { LogicScanner } from './logic-scanner'

describe('LogicScanner', () => {
  const scanner = new LogicScanner()

  // ============================================
  // 缺失前提
  // ============================================

  it('should detect missing premises for conclusion', () => {
    const text = `
      因此，我们可以得出结论，这种方法是最优的。
    `
    const gaps = scanner.scan(text)

    const missingPremise = gaps.find((g) => g.type === 'missing-premise')
    expect(missingPremise).toBeDefined()
    expect(missingPremise!.severity).toBe('major')
  })

  it('should not flag conclusion with supporting premises', () => {
    const text = `
      基于实验数据，我们发现准确率提升了 15%。
      由于这一显著改进，因此可以认为新方法是有效的。
    `
    const gaps = scanner.scan(text)

    const missingPremise = gaps.find((g) => g.type === 'missing-premise')
    expect(missingPremise).toBeUndefined()
  })

  // ============================================
  // 弱推理
  // ============================================

  it('should detect weak inference without quantitative evidence', () => {
    const text = `
      实验结果可能表明这种方法有一定效果。
    `
    const gaps = scanner.scan(text)

    const weakInference = gaps.find((g) => g.type === 'weak-inference')
    expect(weakInference).toBeDefined()
  })

  it('should not flag strong inference with data', () => {
    const text = `
      实验结果显示准确率从 80% 提升到 95%（p < 0.001），
      因此这种方法显著优于基线。
    `
    const gaps = scanner.scan(text)

    const weakInference = gaps.find((g) => g.type === 'weak-inference')
    expect(weakInference).toBeUndefined()
  })

  // ============================================
  // 未检验假设
  // ============================================

  it('should detect untested representativeness assumption', () => {
    const text = `
      我们的样本可以代表总体情况。
      因此，这一结论具有普遍适用性。
    `
    const gaps = scanner.scan(text)

    const untested = gaps.find((g) => g.type === 'untested-assumption')
    expect(untested).toBeDefined()
    expect(untested!.description).toContain('代表性')
  })

  it('should detect untested causal assumption', () => {
    const text = `
      训练时间的增加导致了性能的提升。
      因此，延长训练是提高效果的关键。
    `
    const gaps = scanner.scan(text)

    const untested = gaps.find((g) => g.type === 'untested-assumption')
    expect(untested).toBeDefined()
    expect(untested!.description).toContain('因果')
  })

  it('should not flag when assumption is explicit', () => {
    const text = `
      假设样本具有代表性（已通过卡方检验验证）。
      因此，这一结论可以推广到总体。
    `
    const gaps = scanner.scan(text)

    const untested = gaps.find((g) => g.type === 'untested-assumption')
    expect(untested).toBeUndefined()
  })

  // ============================================
  // 循环论证
  // ============================================

  it('should detect circular reasoning', () => {
    const text = `
      基于前期实验，这种方法被证明是有效的，实验结果非常理想。
      因此，这种方法是有效的。
    `
    const gaps = scanner.scan(text)

    const circular = gaps.find((g) => g.type === 'circular-reasoning')
    expect(circular).toBeDefined()
  })

  // ============================================
  // 矛盾检测
  // ============================================

  it('should detect contradictory assertions', () => {
    const text = `
      实验组的表现提高了 20%。

      相比之下，实验组的表现降低了 20%。
    `
    const gaps = scanner.scan(text)

    const contradiction = gaps.find((g) => g.description.includes('矛盾'))
    expect(contradiction).toBeDefined()
    expect(contradiction!.severity).toBe('major')
  })

  it('should not flag consistent assertions', () => {
    const text = `
      实验组 A 的表现提高了 20%。

      实验组 B 的表现降低了 10%。
    `
    const gaps = scanner.scan(text)

    const contradiction = gaps.find((g) => g.description.includes('矛盾'))
    expect(contradiction).toBeUndefined()
  })

  // ============================================
  // 空输入与边界
  // ============================================

  it('should handle empty text', () => {
    const gaps = scanner.scan('')
    expect(gaps).toEqual([])
  })

  it('should handle text without arguments', () => {
    const text = 'This is a purely descriptive text with no logical claims.'
    const gaps = scanner.scan(text)
    expect(gaps.length).toBe(0)
  })
})
