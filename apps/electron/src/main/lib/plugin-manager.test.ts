import { describe, expect, test } from 'bun:test'
import { registerPlugin, importPluginFromManifest, listPluginStates } from './plugin-manager'
import type { PluginManifest } from '@gravitas/shared'

/**
 * PH2-F 插件/SDK 开放测试：
 * - registerPlugin/importPluginFromManifest 注册第三方插件
 * - listPluginStates 包含导入的插件
 * - 不允许覆盖内置或重复 id
 */

function makeManifest(id: string): PluginManifest {
  return {
    schemaVersion: 1,
    id,
    version: '1.0.0',
    name: `插件 ${id}`,
    description: '测试第三方插件',
    publisher: 'test',
    platforms: ['darwin', 'win32', 'linux'],
    activationEvents: ['onAppReady'],
    subscriptions: ['app.started'],
    surfaces: [],
    permissions: { events: false },
    entrypoints: {},
  } as PluginManifest
}

describe('插件/SDK 开放（PH2-F）', () => {
  test('registerPlugin 注册后出现在插件列表', () => {
    const ok = registerPlugin(makeManifest('com.test.plugin-a'))
    expect(ok).toBe(true)
    const states = listPluginStates()
    expect(states.some((s) => s.id === 'com.test.plugin-a')).toBe(true)
  })

  test('importPluginFromManifest 可注册', () => {
    const ok = importPluginFromManifest(makeManifest('com.test.plugin-b'))
    expect(ok).toBe(true)
  })

  test('不允许覆盖内置插件或重复 id', () => {
    expect(importPluginFromManifest(makeManifest('com.gravitas.dynamic-island'))).toBe(false)
    expect(importPluginFromManifest(makeManifest('com.test.plugin-b'))).toBe(false) // 已存在
  })
})
