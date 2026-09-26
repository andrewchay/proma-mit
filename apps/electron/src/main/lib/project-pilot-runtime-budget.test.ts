import { describe, expect, test } from 'bun:test'
import { resolvePilotRuntimeBudgetLimitUsd, resolveRuntimeBudgetLimitUsd } from './project-pilot-runtime-budget'

describe('Pilot Runtime 单次费用超额停止阈值', () => {
  test('Given 已派生账本预留 When Runtime 支持停止阈值 Then 精确换算为调用级 USD 阈值', () => {
    expect(resolvePilotRuntimeBudgetLimitUsd('claude', 500_000)).toBe(0.5)
    expect(resolveRuntimeBudgetLimitUsd('claude', 0.5, 0.3)).toBe(0.3)
    expect(resolveRuntimeBudgetLimitUsd('claude', 0.5, undefined)).toBe(0.5)
  })

  test('Given Runtime 无停止阈值能力 When Pilot 准备调用 Then fail-closed', () => {
    expect(() => resolvePilotRuntimeBudgetLimitUsd('proma', 500_000)).toThrow('不支持单次费用超额停止阈值')
    expect(() => resolvePilotRuntimeBudgetLimitUsd('ai-sdk', 500_000)).toThrow('不支持单次费用超额停止阈值')
    expect(() => resolveRuntimeBudgetLimitUsd('pi', 0.5, undefined)).toThrow('不支持调用级费用超额停止阈值')
  })

  test('Given 无效或缺失预留 When 构造上限 Then 拒绝调用 Runtime', () => {
    expect(() => resolvePilotRuntimeBudgetLimitUsd('claude', 0)).toThrow('预留无法核验')
    expect(() => resolvePilotRuntimeBudgetLimitUsd('claude', 1.5)).toThrow('预留无法核验')
    expect(() => resolveRuntimeBudgetLimitUsd('claude', Number.NaN, undefined)).toThrow('费用停止阈值无效')
  })
})
