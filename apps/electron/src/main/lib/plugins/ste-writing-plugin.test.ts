import { describe, expect, mock, test } from 'bun:test'
import { buildElectronMock } from '../testing/electron-mock'

// 与 computer-use-plugin.test.ts 相同的原因：collectContributingPrompts 会遍历
// 全部内置插件 runtime（含 computer-use 的导入链），在纯 bun 环境下需要先把
// electron mock 成最小可用实现，并使用「顶层动态 import」保证 mock 先注册。
mock.module('electron', () => buildElectronMock())

const { steWritingPluginRuntime, steWritingPromptSections, STE_WRITING_PROMPT_SECTION } = await import(
  './ste-writing-plugin'
)
const { collectContributingPrompts } = await import('../plugin-manager')

describe('STE 简化写作插件', () => {
  const runtime = steWritingPluginRuntime()

  test('manifest 声明：稳定 id、settings surface、全平台支持', () => {
    expect(runtime.manifest.id).toBe('com.gravitas.ste-writing')
    expect(runtime.manifest.surfaces).toContain('settings')
    expect(runtime.manifest.platforms).toContain('darwin')
    expect(runtime.manifest.platforms).toContain('win32')
    expect(runtime.manifest.platforms).toContain('linux')
  })

  test('默认启用：settings 无 steWriting 配置时 isEnabled 为 true', () => {
    expect(runtime.isEnabled()).toBe(true)
  })

  test('平台支持：全平台返回 true（提示注入不依赖桌面能力）', () => {
    expect(runtime.isSupported()).toBe(true)
  })

  test('启用时 contributePrompts 返回包含底线规则的段落', () => {
    const prompts = runtime.contributePrompts?.() ?? []
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('STE 简化写作规范')
    expect(prompts[0]).toContain('一句一个意思')
    expect(prompts[0]).toContain('答案先行')
    expect(prompts[0]).toContain('ste-writing')
  })

  test('纯函数 steWritingPromptSections：启用返回段落，停用返回空数组（信息零残留）', () => {
    expect(steWritingPromptSections(true)).toEqual([STE_WRITING_PROMPT_SECTION])
    expect(steWritingPromptSections(false)).toEqual([])
  })

  test('collectContributingPrompts 会收编本插件的片段（默认启用态）', () => {
    const prompts = collectContributingPrompts()
    const stePrompts = prompts.filter((p) => p.includes('STE 简化写作规范'))
    expect(stePrompts.length).toBe(1)
  })
})
