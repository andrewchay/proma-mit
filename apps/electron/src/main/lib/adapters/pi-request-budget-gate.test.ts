import { expect, test } from 'bun:test'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { createPiRequestBudgetGate } from './pi-request-budget-gate'

const receipt = (cost: number, input = 1): AssistantMessage => ({
  role: 'assistant', api: 'fixture', provider: 'fixture', model: 'offline', timestamp: 1,
  content: [{ type: 'text', text: 'offline' }], stopReason: 'stop',
  usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } },
})

test('终态检查：缺回执、未知费用、超阈值拒绝成功；有效低额允许', () => {
  const empty = createPiRequestBudgetGate(0.5)
  expect(() => empty.assertComplete()).toThrow('没有可归属的 Runtime 费用回执')
  const missing = createPiRequestBudgetGate(0.5)
  missing.beforeRequest()
  expect(() => missing.assertComplete()).toThrow('模型请求没有 Runtime 费用回执')
  missing.afterResponse(receipt(Number.NaN))
  expect(() => missing.assertComplete()).toThrow('费用缺失')
  const exceeded = createPiRequestBudgetGate(0.5)
  exceeded.beforeRequest()
  exceeded.afterResponse(receipt(0.5))
  expect(() => exceeded.assertComplete()).toThrow('达到或超过阈值')
  const valid = createPiRequestBudgetGate(0.5)
  valid.beforeRequest()
  valid.afterResponse(receipt(0.1))
  expect(() => valid.assertComplete()).not.toThrow()
})

test('Provider 请求体只在已准入且未阻断时可继续；无准入或费用异常拒绝', () => {
  const gate = createPiRequestBudgetGate(0.5)
  expect(() => gate.beforePayload()).toThrow('Provider 请求体没有有效的模型请求准入')
  expect(gate.blocked).toBeDefined()
  expect(() => gate.beforeRequest()).toThrow('费用门禁阻断')
  const valid = createPiRequestBudgetGate(0.5)
  valid.beforeRequest()
  expect(() => valid.beforePayload()).not.toThrow()
  valid.afterResponse(receipt(0.1))
  expect(() => valid.beforePayload()).toThrow('Provider 请求体没有有效的模型请求准入')
  expect(() => valid.assertComplete()).toThrow('请求体没有有效的模型请求准入')
})

test('同一请求未收到回执时不得再次准入，重复/无归属回执保守停等', () => {
  const gate = createPiRequestBudgetGate(0.5)
  gate.beforeRequest()
  expect(() => gate.beforeRequest()).toThrow('上一请求未结束')
  gate.afterResponse(receipt(0.1))
  gate.afterResponse(receipt(0.1))
  expect(gate.reportedUsd).toBe(0.1)
  expect(gate.blocked).toContain('无法关联请求')
  expect(() => gate.beforeRequest()).toThrow('费用门禁阻断')
})

test('本地零价（含无 token）、异常价格和未知回执一律不得当作免费', () => {
  for (const cost of [0, Number.NaN, -0.1]) {
    const gate = createPiRequestBudgetGate(0.5)
    gate.beforeRequest()
    gate.afterResponse(receipt(cost))
    expect(gate.blocked).toContain('费用缺失')
  }
  const noTokens = createPiRequestBudgetGate(0.5)
  noTokens.beforeRequest()
  noTokens.afterResponse(receipt(0, 0))
  expect(noTokens.blocked).toContain('费用缺失')
})
