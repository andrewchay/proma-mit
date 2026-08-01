/**
 * Pi 上下文自动压缩阈值计算单元测试
 */

import { describe, expect, test } from 'bun:test'
import {
  calculatePiAutoCompactionReserveTokens,
  calculatePiAutoCompactionThresholdTokens,
  PI_AUTO_COMPACTION_THRESHOLD_RATIO,
} from './pi-compaction'

describe('Pi 上下文压缩阈值', () => {
  test('reserveTokens = contextWindow 的 20%（向上取整）', () => {
    expect(calculatePiAutoCompactionReserveTokens(200_000)).toBe(40_000)
    expect(calculatePiAutoCompactionReserveTokens(100_000)).toBe(20_000)
    expect(calculatePiAutoCompactionReserveTokens(1)).toBe(1)
  })

  test('触发阈值 = contextWindow - reserveTokens（即 80%）', () => {
    expect(calculatePiAutoCompactionThresholdTokens(200_000)).toBe(160_000)
    expect(calculatePiAutoCompactionThresholdTokens(100_000)).toBe(80_000)
  })

  test('非法窗口抛错', () => {
    expect(() => calculatePiAutoCompactionReserveTokens(0)).toThrow()
    expect(() => calculatePiAutoCompactionReserveTokens(Number.NaN)).toThrow()
    expect(() => calculatePiAutoCompactionReserveTokens(Number.POSITIVE_INFINITY)).toThrow()
  })

  test('阈值比例常量符合上游约定', () => {
    expect(PI_AUTO_COMPACTION_THRESHOLD_RATIO).toBe(0.8)
  })
})
