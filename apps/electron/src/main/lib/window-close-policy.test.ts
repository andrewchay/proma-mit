import { describe, expect, test } from 'bun:test'
import { resolveWindowCloseAction } from './window-close-policy'

describe('主窗口关闭策略', () => {
  test('未在退出时，关闭按钮隐藏到托盘而不是退出', () => {
    expect(resolveWindowCloseAction({ isQuitting: false })).toBe('hide-to-tray')
  })

  test('正在退出时，允许真正关闭窗口', () => {
    expect(resolveWindowCloseAction({ isQuitting: true })).toBe('allow-close')
  })

  test('策略与平台无关：同一输入在所有平台给出同一动作', () => {
    // 平台分裂是历史遗留（曾只有 macOS 隐藏到托盘）；这里锁死「只看 isQuitting」。
    const inputs = [{ isQuitting: false }, { isQuitting: true }]
    for (const input of inputs) {
      const action = resolveWindowCloseAction(input)
      expect(action).toBe(input.isQuitting ? 'allow-close' : 'hide-to-tray')
    }
  })
})
