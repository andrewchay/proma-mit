import { expect, test } from 'bun:test'
import { validateSamples } from './performance-monitor-validation'

test('Given 性能样本携带多余内容 When 保存 Then 只保留允许的指标', () => {
  const input = [{ timestamp: Date.now(), kind: 'input', durationMs: 65, streaming: true, text: 'private content' }]
  expect(validateSamples(input)).toEqual([{ timestamp: input[0]!.timestamp, kind: 'input', durationMs: 65, streaming: true }])
})

test('Given 无效或过量的样本 When 保存 Then 拒绝', () => {
  const sample = { timestamp: Date.now(), kind: 'input', durationMs: 65, streaming: false }
  expect(() => validateSamples(Array(501).fill(sample))).toThrow()
  expect(() => validateSamples([{ ...sample, timestamp: Date.now() - 40_000 }])).toThrow()
  expect(() => validateSamples([{ ...sample, durationMs: NaN }])).toThrow()
  expect(() => validateSamples([{ ...sample, kind: 'text' }])).toThrow()
})
