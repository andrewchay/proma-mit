import { describe, expect, test } from 'bun:test'
import { mergeNestedSettings } from './settings-service'
import type { AppSettings } from '../../types'

const baseSettings = {
  themeMode: 'dark',
  agentRuntime: 'pi',
  onboardingCompleted: true,
  environmentCheckSkipped: false,
  notificationsEnabled: true,
} as unknown as AppSettings

describe('settings-service 嵌套合并', () => {
  test('更新 computerUse 子字段不丢其它子字段（深合并）', () => {
    const current = {
      ...baseSettings,
      computerUse: { enabled: true, readOnlyOnly: false },
    } as AppSettings
    const merged = mergeNestedSettings(current, { computerUse: { readOnlyOnly: true } })
    expect(merged.computerUse).toEqual({ enabled: true, readOnlyOnly: true })
  })

  test('首次设置 computerUse 时直接采用整个新对象', () => {
    const merged = mergeNestedSettings(baseSettings, { computerUse: { enabled: false, readOnlyOnly: false } })
    expect(merged.computerUse).toEqual({ enabled: false, readOnlyOnly: false })
  })

  test('computerUse 传 undefined 时保留原有块（浅合并语义，不误删）', () => {
    const current = { ...baseSettings, computerUse: { enabled: false, readOnlyOnly: true } } as AppSettings
    const merged = mergeNestedSettings(current, { themeMode: 'light' })
    expect(merged.computerUse).toEqual({ enabled: false, readOnlyOnly: true })
    expect(merged.themeMode).toBe('light')
  })

  test('非嵌套对象字段保持普通浅合并', () => {
    const merged = mergeNestedSettings({ ...baseSettings, agentMaxTurns: 5 } as AppSettings, { themeMode: 'system' })
    expect(merged.themeMode).toBe('system')
    expect(merged.agentMaxTurns).toBe(5)
  })
})
