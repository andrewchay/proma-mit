/**
 * HandoffBudget 单元测试
 */

import { describe, test, expect } from 'bun:test'
import { checkHandoffBudget, enforceHandoffBudget } from './handoff-budget'

describe('HandoffBudget', () => {
  test('短文本在预算内', () => {
    const result = checkHandoffBudget('已交付结果：修复了 bug\n下一步：运行测试')
    expect(result.withinBudget).toBe(true)
    expect(result.overLineBudget).toBe(false)
    expect(result.overCharBudget).toBe(false)
  })

  test('超过字符预算触发压缩', () => {
    const long = 'x'.repeat(2000)
    const result = checkHandoffBudget(long)
    expect(result.withinBudget).toBe(false)
    expect(result.overCharBudget).toBe(true)
  })

  test('超过行数预算触发压缩', () => {
    const manyLines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    const result = checkHandoffBudget(manyLines)
    expect(result.withinBudget).toBe(false)
    expect(result.overLineBudget).toBe(true)
  })

  test('enforce 压缩并保留预算提示', () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i} with some content`).join('\n')
    const { text, truncated, result } = enforceHandoffBudget(long)
    expect(truncated).toBe(true)
    expect(text).toContain('交接内容已随 budget 压缩')
    expect(result.overLineBudget).toBe(true)
  })

  test('预算内文本不被改动', () => {
    const ok = '简短交接内容'
    const { text, truncated } = enforceHandoffBudget(ok)
    expect(truncated).toBe(false)
    expect(text).toBe(ok)
  })
})
