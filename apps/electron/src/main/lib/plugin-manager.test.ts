import { describe, expect, mock, test } from 'bun:test'
import { buildElectronMock } from './testing/electron-mock'
import type { PluginManifest } from '@gravitas/shared'

// 纯 Bun/单测环境没有真实 Electron runtime。`listPluginStates()` 会遍历内置
// BUILTIN_RUNTIMES，其中的 computer-use 插件经 `require('./plugins/computer-use-plugin')`
// 触发 computer-use-service 的 `import * as electron`——非 Electron 进程下解析
// node_modules/electron 启动器命名导出会报 `WebContentsView not found`。
// 参照 web-bridge-tools.test.ts / computer-use-plugin.test.ts 的做法：加载前把
// electron mock 成最小可用实现，并用「顶层动态 import」确保 mock 先注册生效。

mock.module('electron', () => buildElectronMock())

const {
  registerPlugin,
  importPluginFromManifest,
  listPluginStates,
  setPluginEnabled,
  removePlugin,
} = await import('./plugin-manager')
import type { PluginStateView } from './plugin-manager'

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

  test('第三方插件停用后 isEnabled 应为 false（修“停用无效”）', async () => {
    registerPlugin(makeManifest('com.test.plugin-c'))
    const view = listPluginStates().find((s) => s.id === 'com.test.plugin-c')
    expect(view?.enabled).toBe(true)
    const updated = await setPluginEnabled('com.test.plugin-c', false)
    expect(updated?.enabled).toBe(false)
    // 重新列出仍为停用（enabledFlag 生效，而非恒 true）
    expect(listPluginStates().find((s) => s.id === 'com.test.plugin-c')?.enabled).toBe(false)
  })

  test('第三方插件可删除（仅 local）', () => {
    registerPlugin(makeManifest('com.test.plugin-d'))
    expect(listPluginStates().some((s) => s.id === 'com.test.plugin-d')).toBe(true)
    expect(removePlugin('com.test.plugin-d')).toBe(true)
    expect(listPluginStates().some((s) => s.id === 'com.test.plugin-d')).toBe(false)
    // 已删除的不能再删
    expect(removePlugin('com.test.plugin-d')).toBe(false)
  })

  test('内置插件不可删除（removePlugin 拒绝）', () => {
    expect(removePlugin('com.gravitas.dynamic-island')).toBe(false)
  })

  test('非法/缺字段 manifest 被拒（PH2 结构校验）', () => {
    expect(importPluginFromManifest(null)).toBe(false)
    expect(importPluginFromManifest({ name: 'no-id' })).toBe(false)
    expect(importPluginFromManifest({ id: 'com.test.no-name' })).toBe(false)
    expect(importPluginFromManifest('not-an-object')).toBe(false)
  })

  test('surfaces 传非数组不会崩渲染（规整为空数组），id 超限被拒', () => {
    // surfaces 传字符串（非数组）— 规整为 []，注册成功但 listPluginStates 不抛错
    const ok = registerPlugin({ ...makeManifest('com.test.bad-surfaces'), surfaces: 'overlay' as unknown as never } as unknown as PluginManifest)
    expect(ok).toBe(true)
    // id 过长被拒
    expect(importPluginFromManifest({ ...makeManifest('x'.repeat(300)) })).toBe(false)
    expect(removePlugin('com.test.bad-surfaces')).toBe(true)
  })
})
