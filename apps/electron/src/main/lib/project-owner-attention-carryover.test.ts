import { expect, test } from 'bun:test'
import { decideAttentionCarryover } from './project-owner-management-conversation'

const base = {
  state: 'attention', usedRequests: 2, reservedCostMicros: 300_000,
  attentionCheck: { reason: 'non_continueable_outcome' },
  delegation: { maxRequests: 4, maxCostMicros: 1_000_000, perRequestCeilingMicros: 200_000, autonomousExecution: false },
}

test('Given 结论不可继续且预算仍够一次请求 When 决定 Then 放行新请求', () => {
  expect(decideAttentionCarryover(base)).toBe('proceed')
})

test('Given 结论不可继续但剩余预算不足 When 决定 Then 明确停在预算不足', () => {
  expect(decideAttentionCarryover({ ...base, reservedCostMicros: 900_000 })).toBe('budget_blocked')
  expect(decideAttentionCarryover({ ...base, usedRequests: 4 })).toBe('budget_blocked')
})

test('Given 其他暂停原因（如用量未知） When 决定 Then 仍然阻断，不放行', () => {
  for (const reason of ['missing_usage', 'invalid_usage', 'missing_receipt', 'missing_execution', 'output_limit']) {
    expect(decideAttentionCarryover({ ...base, attentionCheck: { reason } })).toBe('blocked')
  }
})

test('Given 非attention状态 When 决定 Then 交由原有分支处理', () => {
  expect(decideAttentionCarryover({ ...base, state: 'active' })).toBe('blocked')
  expect(decideAttentionCarryover({ ...base, state: 'exhausted' })).toBe('blocked')
})

test('Given 缺少委托或委托对象 When 决定 Then 不放行', () => {
  expect(decideAttentionCarryover({ ...base, delegation: null })).toBe('blocked')
})

test('Given 自主执行且请求次数用尽 When 决定 Then 只按预算判断是否放行', () => {
  const autonomous = { ...base, usedRequests: 99, delegation: { ...base.delegation, autonomousExecution: true } }
  expect(decideAttentionCarryover(autonomous)).toBe('proceed')
  expect(decideAttentionCarryover({ ...autonomous, reservedCostMicros: 900_000 })).toBe('budget_blocked')
})
