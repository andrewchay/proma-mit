import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolateSteWritingHostDependencies } from '../testing/ste-writing-test-isolation'

isolateSteWritingHostDependencies()
const tempDir = mkdtempSync(join(tmpdir(), 'ste-plugin-'))
const originalConfigDir = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = tempDir
const { steWritingPluginRuntime, steWritingPromptSections, STE_WRITING_PROMPT_SECTION } = await import('./ste-writing-plugin')
const { collectContributingPrompts, setPluginEnabled } = await import('../plugin-manager')
const { getSettingsPath } = await import('../config-paths')
const settingsPath = getSettingsPath()
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
  if (originalConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfigDir
})
beforeEach(() => rmSync(settingsPath, { recursive: true, force: true }))

function stePrompts(): string[] {
  return collectContributingPrompts().filter((prompt) => prompt.includes('STE 简化写作规范'))
}

describe('STE 简化写作插件', () => {
  test('缺省启用并贡献自然语言指导；manifest 保持稳定', () => {
    const runtime = steWritingPluginRuntime()
    expect(runtime.manifest.id).toBe('com.gravitas.ste-writing')
    expect(runtime.manifest.surfaces).toContain('settings')
    expect(runtime.manifest.platforms).toEqual(['darwin', 'win32', 'linux'])
    expect(runtime.isEnabled()).toBe(true)
    expect(runtime.isSupported()).toBe(true)
    expect(stePrompts()).toEqual([STE_WRITING_PROMPT_SECTION])
    expect(steWritingPromptSections(false)).toEqual([])
  })

  test('真实 manager 停用、重复停用、重启、重复启用均成功，并落盘影响 collector', async () => {
    for (const enabled of [false, false, true, true]) {
      const state = await setPluginEnabled('com.gravitas.ste-writing', enabled)
      expect(state?.enabled).toBe(enabled)
      expect(JSON.parse(readFileSync(settingsPath, 'utf8')).steWriting.enabled).toBe(enabled)
      expect(stePrompts()).toEqual(steWritingPromptSections(enabled))
    }
  })

  test('配置损坏时停止注入、启停明确失败且不覆盖损坏内容', async () => {
    writeFileSync(settingsPath, '{broken')
    expect(steWritingPluginRuntime().isEnabled()).toBe(false)
    expect(stePrompts()).toEqual([])
    expect(await setPluginEnabled('com.gravitas.ste-writing', false)).toBeNull()
    expect(readFileSync(settingsPath, 'utf8')).toBe('{broken')
  })

  test('写入失败时不能返回成功或改变 collector', async () => {
    // 悬空链接：读取按缺省处理，但落盘因父目录不存在明确失败；全程只操作临时目录。
    symlinkSync(join(tempDir, 'missing-parent', 'settings.json'), settingsPath)
    expect(await setPluginEnabled('com.gravitas.ste-writing', false)).toBeNull()
    expect(stePrompts()).toEqual([STE_WRITING_PROMPT_SECTION])
  })

  test('设置文件是目录时读取失败，不能被默认值冒充成功', async () => {
    mkdirSync(settingsPath)
    expect(await setPluginEnabled('com.gravitas.ste-writing', true)).toBeNull()
    expect(stePrompts()).toEqual([])
  })

  test('保留事实、风险、安全和结构化输出优先级，不宣称硬强制', () => {
    for (const phrase of ['schema、JSON、XML', '数字必须有证据', '不编造', '风险、限制和不确定性', '不是机制硬强制', '不改变任何工具权限']) {
      expect(STE_WRITING_PROMPT_SECTION).toContain(phrase)
    }
  })
})
