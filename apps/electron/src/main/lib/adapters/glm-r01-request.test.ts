import { expect, test } from 'bun:test'
import { normalizeGlmR01Request } from './glm-r01-request'
import { GlmR01Budget } from './glm-r01-budget'

test('本地gateway恢复智谱system角色与官方端点兼容参数，不修改原文', () => {
  const messages = [{ role: 'developer', content: 'constraint' }, { role: 'user', content: 'OK' }]
  const result = normalizeGlmR01Request({ messages, store: false, reasoning_effort: 'none', max_completion_tokens: 64000 }, 2048)
  expect(result.messages).toEqual([{ role: 'system', content: 'constraint' }, { role: 'user', content: 'OK' }])
  expect(messages[0]!.role).toBe('developer')
  expect(result.max_tokens).toBe(2048)
  expect(result.max_completion_tokens).toBeUndefined()
  expect(result.store).toBeUndefined()
  expect(result.reasoning_effort).toBeUndefined()
  expect(result.thinking).toEqual({ type: 'disabled' })
})

test('预算跨批次保留既有预留，不能每次重跑都重新得到10元', () => {
  const budget = new GlmR01Budget(10, 3.424544)
  budget.reserve(29966)
  expect(budget.reservedCny).toBeGreaterThan(3.424544)
  expect(() => new GlmR01Budget(10, 11)).toThrow()
})
