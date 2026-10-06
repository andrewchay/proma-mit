import { expect, test } from 'bun:test'
import { calculatePilotRequestCeiling, type PilotRequestEnvelope } from './project-pilot-request-envelope'

const envelope: PilotRequestEnvelope = {
  inputTokenCeiling: 1000, outputTokenCeiling: 100,
  inputRateMicrosPerMillion: 2_000_000, outputRateMicrosPerMillion: 4_000_000,
  extraCostCeilingMicros: 100, priceEvidenceId: 'approved-price-v1', requestEvidenceId: 'final-body-v1',
}

test('Given 已核验的输入输出和价格包络 When 余额足够 Then 向上取整计算单请求预留', () => {
  expect(calculatePilotRequestCeiling(envelope, 2500)).toBe(2500)
  expect(calculatePilotRequestCeiling({ ...envelope, inputTokenCeiling: 1, outputTokenCeiling: 1,
    inputRateMicrosPerMillion: 1, outputRateMicrosPerMillion: 1, extraCostCeilingMicros: 0 }, 1)).toBe(1)
})

test('Given 余额不足或价格/请求证据缺失 When 请求预算 Then 发送前拒绝', () => {
  expect(() => calculatePilotRequestCeiling(envelope, 2499)).toThrow('超过可用额度')
  expect(() => calculatePilotRequestCeiling({ ...envelope, priceEvidenceId: '' }, 2500)).toThrow('缺少可核验参数')
  expect(() => calculatePilotRequestCeiling({ ...envelope, requestEvidenceId: '' }, 2500)).toThrow('缺少可核验参数')
  expect(() => calculatePilotRequestCeiling({ ...envelope, outputTokenCeiling: 0 }, 2500)).toThrow('缺少可核验参数')
})

test('Given 无效或超精度输入 When 请求预算 Then 不允许溢出/截断', () => {
  for (const invalid of [NaN, Infinity, -1, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => calculatePilotRequestCeiling({ ...envelope, inputTokenCeiling: invalid }, 2500)).toThrow('缺少可核验参数')
  }
  expect(() => calculatePilotRequestCeiling({ ...envelope, inputTokenCeiling: Number.MAX_SAFE_INTEGER },
    Number.MAX_SAFE_INTEGER)).toThrow('超过可用额度')
})
