import { expect, test } from 'bun:test'
import { resolveAgentStreamTarget } from './agent-stream-target'

const main = { isDestroyed: () => false }
test('Given 新员工无窗口映射 When 选择目标 Then 使用明确主窗口', () => {
  expect(resolveAgentStreamTarget(undefined, main)).toBe(main)
})
test('Given 父会话窗口有效 When 选择目标 Then 保留父窗口', () => {
  const origin = { isDestroyed: () => false }
  expect(resolveAgentStreamTarget(origin, main)).toBe(origin)
})
test('Given 父窗口销毁 When 选择目标 Then 回退主窗口', () => {
  expect(resolveAgentStreamTarget({ isDestroyed: () => true }, main)).toBe(main)
})
test('Given 无有效主窗口 When 选择目标 Then 不向辅助窗口发送', () => {
  expect(resolveAgentStreamTarget(undefined, null)).toBeNull()
  expect(resolveAgentStreamTarget(undefined, { isDestroyed: () => true })).toBeNull()
})
