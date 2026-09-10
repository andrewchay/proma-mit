import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { updateSettings } from './settings-service'
import { getMarketingPluginDir, syncMarketingSkillsForWorkspace } from './marketing-skills-sync'

/**
 * 营销 Skills 工作区分发四态测试（增 / 换 / 升 / 清）。
 * 用 PROMA_TEST_CONFIG_DIR 隔离，不触碰真实 ~/.proma-mit。
 */
const tmpConfigDir = mkdtempSync(join(tmpdir(), 'mkt-skills-sync-test-'))
const bundledSkillsDir = join(import.meta.dir, '../../../marketing-skills')

beforeAll(() => {
  process.env.PROMA_TEST_CONFIG_DIR = tmpConfigDir
  // 模拟 seedMarketingSkills 产物：bundle → 用户目录
  cpSync(bundledSkillsDir, join(tmpConfigDir, 'marketing-skills'), { recursive: true })
})

afterAll(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
  delete process.env.PROMA_TEST_CONFIG_DIR
  rmSync(tmpConfigDir, { recursive: true, force: true })
})

const slug = 'test-ws'

describe('marketing-skills-sync', () => {
  test('未订阅：不生成 .marketing-plugin（不默认带入）', () => {
    updateSettings({ marketingCapabilities: [] })
    syncMarketingSkillsForWorkspace(slug)
    expect(existsSync(getMarketingPluginDir(slug))).toBe(false)
  })

  test('订阅 influencer：分发 22 个 skill + plugin.json', () => {
    updateSettings({ marketingCapabilities: ['influencer'] })
    syncMarketingSkillsForWorkspace(slug)
    const skillsDir = join(getMarketingPluginDir(slug), 'skills')
    expect(existsSync(skillsDir)).toBe(true)
    expect(readdirSync(skillsDir).length).toBe(22)
    expect(readdirSync(skillsDir)).toContain('ma-kol-scraper')
    expect(readdirSync(skillsDir)).toContain('ma-pgy-invite')
    expect(existsSync(join(getMarketingPluginDir(slug), '.claude-plugin', 'plugin.json'))).toBe(true)
  })

  test('切换到 paid-media：换域（22 → 16，influencer 独有被移除）', () => {
    updateSettings({ marketingCapabilities: ['paid-media'] })
    syncMarketingSkillsForWorkspace(slug)
    const skillsDir = join(getMarketingPluginDir(slug), 'skills')
    const after = readdirSync(skillsDir)
    expect(after.length).toBe(16)
    expect(after).toContain('ma-campaign-optimizer')
    expect(after).not.toContain('ma-kol-scraper')
  })

  test('清空订阅：整体清理 .marketing-plugin（取消订阅即消失）', () => {
    updateSettings({ marketingCapabilities: [] })
    syncMarketingSkillsForWorkspace(slug)
    expect(existsSync(getMarketingPluginDir(slug))).toBe(false)
  })
})
