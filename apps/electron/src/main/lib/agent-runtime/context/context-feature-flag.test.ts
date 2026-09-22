import { describe, expect, test } from 'bun:test'
import { isTypedContextCompilerEnabled } from './context-feature-flag'

describe('Typed Context Compiler feature flag', () => {
  test('workspace 与 session 均未配置时默认关闭', () => {
    expect(isTypedContextCompilerEnabled({})).toBe(false)
  })

  test('workspace 可以提供默认值', () => {
    expect(isTypedContextCompilerEnabled({ workspaceEnabled: true })).toBe(true)
  })

  test('session 显式值覆盖 workspace 默认值', () => {
    expect(isTypedContextCompilerEnabled({ workspaceEnabled: true, sessionEnabled: false })).toBe(false)
    expect(isTypedContextCompilerEnabled({ workspaceEnabled: false, sessionEnabled: true })).toBe(true)
  })
})
