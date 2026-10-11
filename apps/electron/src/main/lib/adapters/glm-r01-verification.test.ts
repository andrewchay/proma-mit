import { expect, test } from 'bun:test'
import { matchesNumericAnswer, captureRunDiagnostics } from './glm-r01-verification'

test('数值任务接受等价十进制格式，不接受解释、空值或非有限数', () => {
  expect(matchesNumericAnswer('1.00\n', 1)).toBe(true)
  expect(matchesNumericAnswer(' 16.500 ', 16.5)).toBe(true)
  expect(matchesNumericAnswer('1e0', 1)).toBe(true)
  expect(matchesNumericAnswer('-2.0', -2)).toBe(true)
  for (const value of ['', '结果是1', '1 cats', 'NaN', 'Infinity', '0x1', '1,00']) expect(matchesNumericAnswer(value, 1)).toBe(false)
  expect(matchesNumericAnswer('1.01', 1)).toBe(false)
})

test('保存终态回复及工具错误并明确截断，便于失败定位', () => {
  const d = captureRunDiagnostics({ text: 'x1.txt,x2.txt', toolErrorTexts: ['permission denied'], errorTexts: [] })
  expect(d.finalReply).toBe('x1.txt,x2.txt')
  expect(d.toolErrors).toEqual(['permission denied'])
  expect(d.finalReplyTruncated).toBe(false)
  const long = captureRunDiagnostics({ text: 'x'.repeat(9000), toolErrorTexts: [], errorTexts: ['provider error'] })
  expect(long.finalReply.length).toBe(8000)
  expect(long.finalReplyTruncated).toBe(true)
  expect(long.runtimeErrors).toEqual(['provider error'])
})
