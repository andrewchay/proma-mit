import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import AdmZip from 'adm-zip'
import { createContentDraft, resetContentOperationsForTests } from './content-operations'
import { closeNewMediaDb } from './new-media-sqlite-store'
import {
  buildXiaohongshuHandoffPackage,
  confirmXiaohongshuPublished,
  exportXiaohongshuHandoff,
  getXiaohongshuHandoffAudit,
  prepareXiaohongshuHandoff,
} from './xiaohongshu-handoff'

let testDir = ''
beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-xhs-handoff-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { await resetContentOperationsForTests() })
afterAll(() => { closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

describe('小红书发布交接', () => {
  test('准备交接不会伪装成已发布', async () => {
    const draft = await createContentDraft('秋季新品体验 #新品', ['xiaohongshu'])
    const handoff = await prepareXiaohongshuHandoff(draft.id)
    expect(handoff.status).toBe('draft_ready')
    expect(handoff.warnings).toContain('当前草稿未关联封面或媒体素材，请在小红书发布页补充并核验。')
    await expect(confirmXiaohongshuPublished(handoff.id, 'Carol')).rejects.toThrow('必须先完成发布交接')
  })

  test('交付包使用稳定文件且不包含本地绝对路径', async () => {
    const draft = await createContentDraft('真实体验分享 #测评', ['xiaohongshu'])
    const handoff = await prepareXiaohongshuHandoff(draft.id)
    const buffer = await buildXiaohongshuHandoffPackage(handoff.id)
    const zip = new AdmZip(buffer)
    expect(zip.getEntries().map((entry) => entry.entryName).sort()).toEqual(['README.md', 'content.json', 'content.txt', 'manifest.json'])
    expect(zip.readAsText('content.txt')).toContain('真实体验分享')
    expect(buffer.includes(Buffer.from(testDir))).toBe(false)
  })

  test('导出后只能由用户确认发布，并保留审计', async () => {
    const draft = await createContentDraft('门店活动内容', ['xiaohongshu'])
    const handoff = await prepareXiaohongshuHandoff(draft.id)
    const destination = join(testDir, handoff.packageFileName)
    const exported = await exportXiaohongshuHandoff(handoff.id, destination)
    expect(existsSync(destination)).toBe(true)
    expect(readFileSync(destination).length).toBeGreaterThan(0)
    expect(exported.status).toBe('handed_off')
    expect(exported.packageSha256).toHaveLength(64)

    const confirmed = await confirmXiaohongshuPublished(handoff.id, 'Carol')
    expect(confirmed.status).toBe('user_confirmed_published')
    expect((await getXiaohongshuHandoffAudit(handoff.id)).map((entry) => entry.event)).toEqual(['prepared', 'exported', 'user_confirmed_published'])
  })
})
