/** STE 离线测试只替换无关插件与目录工具的宿主依赖，不替换 STE、settings 或 manager。 */
import { mock } from 'bun:test'
import type { BuiltinPluginRuntime } from '../plugin-manager'

export function isolateSteWritingHostDependencies(): void {
  mock.module('../tool-definition-store', () => ({
    collectDirectoryTools: () => [],
    collectDirectoryToolPrompts: () => [],
  }))
  mock.module('../dynamic-island/dynamic-island-service', () => ({ isDynamicIslandPrimary: () => false }))
  for (const [slug, factory] of [
    ['computer-use', 'computerUsePluginRuntime'],
    ['marketing', 'marketingPluginRuntime'],
    ['new-media', 'newMediaPluginRuntime'],
    ['outbound-sourcing', 'outboundSourcingPluginRuntime'],
    ['academic', 'academicPluginRuntime'],
  ] as const) {
    const runtime: BuiltinPluginRuntime = {
      manifest: {
        schemaVersion: 1, id: `com.gravitas.${slug}`, version: '1.0.0', name: slug,
        publisher: 'test', platforms: [], activationEvents: [], subscriptions: [], surfaces: [], permissions: {}, entrypoints: {},
      },
      isEnabled: () => false,
      setEnabled: async () => true,
      isSupported: () => false,
    }
    mock.module(`../plugins/${slug}-plugin`, () => ({ [factory]: () => runtime }))
  }
}
