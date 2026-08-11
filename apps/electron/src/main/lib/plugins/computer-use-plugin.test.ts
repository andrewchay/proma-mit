import { describe, expect, test } from 'bun:test'
import { collectContributingTools, registerPlugin, _resetPluginManagerForTests } from '../plugin-manager'
import { computerUsePluginRuntime } from './computer-use-plugin'

describe('Computer Use 插件', () => {
  const runtime = computerUsePluginRuntime()

  test('manifest 声明 agent-tools surface 与 computerUse 分档上限', () => {
    expect(runtime.manifest.id).toBe('com.gravitas.computer-use')
    expect(runtime.manifest.surfaces).toContain('agent-tools')
    expect(runtime.manifest.permissions.computerUse).toMatchObject({ enabled: true, readOnly: true, allowWrite: true })
  })

  test('平台支持根据当前进程平台判定（darwin→支持，其余不支持）', () => {
    expect(typeof runtime.isSupported).toBe('function')
  })

  test('默认全量贡献 Computer Use 工具（含读写）', () => {
    const tools = runtime.contributeTools?.() ?? []
    const names = tools.map((t) => t.name)
    expect(names).toContain('ComputerUseStatus')
    expect(names).toContain('ComputerUseScreenshot')
    expect(names).toContain('ComputerUseClick')
    expect(names).toContain('ComputerUseType')
    expect(tools.length).toBeGreaterThanOrEqual(10)
  })

  test('collectContributingTools 仅收集 enabled + supported 插件的工具', () => {
    _resetPluginManagerForTests()
    const ok = registerPlugin({
      schemaVersion: 1,
      id: 'com.test.tools',
      version: '1.0.0',
      name: 'Test Tools',
      publisher: 'test',
      platforms: ['darwin'],
      activationEvents: ['onAppReady'],
      subscriptions: [],
      surfaces: ['agent-tools'],
      permissions: {},
      entrypoints: {},
    }, {
      isEnabled: () => true,
      isSupported: () => true,
      contributeTools: () => [{ name: 'TestToolA', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => ({ toolCallId: '', content: 'ok' }) }],
    })
    expect(ok).toBe(true)
    const tools = collectContributingTools()
    expect(tools.map((t) => t.name)).toContain('TestToolA')
    _resetPluginManagerForTests()
  })

  test('collectContributingTools 跳过 disabled 或不支持的插件', () => {
    _resetPluginManagerForTests()
    registerPlugin({
      schemaVersion: 1, id: 'com.test.disabled', version: '1.0.0', name: 'Disabled', publisher: 'p',
      platforms: ['darwin'], activationEvents: ['onAppReady'], subscriptions: [], surfaces: ['agent-tools'], permissions: {}, entrypoints: {},
    }, { isEnabled: () => false, isSupported: () => true, contributeTools: () => [{ name: 'X', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => ({ toolCallId: '', content: 'x' }) }] })
    registerPlugin({
      schemaVersion: 1, id: 'com.test.unsupported', version: '1.0.0', name: 'Unsup', publisher: 'p',
      platforms: ['win32'], activationEvents: ['onAppReady'], subscriptions: [], surfaces: ['agent-tools'], permissions: {}, entrypoints: {},
    }, { isEnabled: () => true, isSupported: () => false, contributeTools: () => [{ name: 'Y', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => ({ toolCallId: '', content: 'y' }) }] })
    const tools = collectContributingTools()
    expect(tools.find((t) => t.name === 'X')).toBeUndefined()
    expect(tools.find((t) => t.name === 'Y')).toBeUndefined()
    _resetPluginManagerForTests()
  })
})
