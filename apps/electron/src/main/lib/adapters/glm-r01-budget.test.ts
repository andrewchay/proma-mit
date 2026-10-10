import { describe, expect, test } from 'bun:test'
import { GlmR01Budget } from './glm-r01-budget'

describe('GLM R01 请求前人民币预算预留', () => {
  test('成功预留后单调递增，不自动退还', () => {
    const b = new GlmR01Budget()
    b.reserve(8000)
    expect(b.requests).toBe(1)
    expect(b.reservedCny).toBeGreaterThan(0)
    const before = b.reservedCny
    b.reserve(8000)
    expect(b.reservedCny).toBe(before * 2)
  })
  test('超预算拒绝，不改变账本', () => {
    const b = new GlmR01Budget(0.01)
    expect(() => b.reserve(8000)).toThrow('预算')
    expect(b.reservedCny).toBe(0)
    expect(b.requests).toBe(0)
  })
  test('成功请求的完整usage只结算一次，失败和未知预留不释放', () => {
    const b = new GlmR01Budget(10, 3.5385024)
    const receipt = b.reserve(29966)
    const reserved = b.reservedCny
    b.settle(receipt, 7000, 50)
    expect(b.reservedCny).toBeCloseTo(3.5385024 + 0.00574, 8)
    expect(b.reservedCny).toBeLessThan(reserved)
    expect(() => b.settle(receipt, 7000, 50)).toThrow()
    const unknown = b.reserve(29966)
    expect(() => b.settle(unknown, Number.NaN, 50)).toThrow()
    expect(b.reservedCny).toBeGreaterThan(3.5385024 + 0.00574)
  })
  test('真实schema的29966字节请求允许预留，费用仍累计', () => {
    const b = new GlmR01Budget()
    b.reserve(29966)
    expect(b.requests).toBe(1)
    expect(b.reservedCny).toBeGreaterThan(0.05)
    expect(b.reservedCny).toBeLessThan(0.07)
  })
  test('长请求及非法预算 fail-closed', () => {
    expect(() => new GlmR01Budget(11)).toThrow()
    expect(() => new GlmR01Budget(Number.NaN)).toThrow()
    const b = new GlmR01Budget()
    expect(() => b.reserve(100_000)).toThrow('输入额度')
    expect(() => b.reserve(-1)).toThrow()
  })
})
