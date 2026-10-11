import { describe, expect, test } from 'bun:test'
import { getNextSelectableAgentPermissionMode, SELECTABLE_AGENT_PERMISSION_MODES } from './permission-mode-selector-model'

describe('Agent Header 权限模式选择', () => {
  test('只暴露计划、自动审批和完全自动三档', () => {
    expect(SELECTABLE_AGENT_PERMISSION_MODES).toEqual(['plan', 'auto', 'bypassPermissions'])
  })

  test('三档循环切换且旧 safe 会话首次切换进入计划模式', () => {
    expect(getNextSelectableAgentPermissionMode('plan')).toBe('auto')
    expect(getNextSelectableAgentPermissionMode('auto')).toBe('bypassPermissions')
    expect(getNextSelectableAgentPermissionMode('bypassPermissions')).toBe('plan')
    expect(getNextSelectableAgentPermissionMode('safe')).toBe('plan')
  })
})
