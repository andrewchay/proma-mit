import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import AdmZip from 'adm-zip'
import { PNG } from 'pngjs'
import { createContentDraft, resetContentOperationsForTests } from './content-operations'
import { closeNewMediaDb } from './new-media-sqlite-store'
import { saveDirectorDesign } from './director-design'
import { confirmDirectorPlan, createDirectorBrand, createDirectorPlan, createDirectorXiaohongshuDraft } from './director-workflow'
import {
  buildXiaohongshuHandoffPackage,
  confirmXiaohongshuPublished,
  exportXiaohongshuHandoff,
  getXiaohongshuHandoffAudit,
  getXiaohongshuBrowserDraft,
  listXiaohongshuHandoffs,
  prepareXiaohongshuHandoff,
  readXiaohongshuHandoffCover,
  recordXiaohongshuDraftReadback,
} from './xiaohongshu-handoff'

let testDir = ''
beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-xhs-handoff-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { await resetContentOperationsForTests() })
afterAll(() => { closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

describe('小红书发布交接', () => {
  test('浏览器交接只读取已确认总监方案的文案', async () => {
    const local = await createContentDraft('旧草稿', ['xiaohongshu'])
    const localHandoff = await prepareXiaohongshuHandoff(local.id)
    await expect(getXiaohongshuBrowserDraft(localHandoff.id)).rejects.toThrow('请先确认')
    const brand = await createDirectorBrand('英语品牌', '成人英语练习')
    const plan = await createDirectorPlan(brand.id, 'xiaohongshu', '每日口语')
    await confirmDirectorPlan(plan.id)
    const draft = await createDirectorXiaohongshuDraft({ planId: plan.id, title: '英语练习', body: '练习正文', hashtags: ['口语', '#英语'] })
    const png = PNG.sync.write(new PNG({ width: 1, height: 1 }))
    const asset = await saveDirectorDesign(draft.id, '<svg viewBox="0 0 1080 1440"></svg>', async () => png)
    const handoff = await prepareXiaohongshuHandoff(draft.id, asset.id)
    expect(await getXiaohongshuBrowserDraft(handoff.id)).toEqual({ title: '英语练习', body: '练习正文\n\n#口语 #英语' })
    expect(await readXiaohongshuHandoffCover(handoff.id)).toEqual(png)
    let checks = 0
    await expect(recordXiaohongshuDraftReadback(handoff.id, () => {
      if (++checks > 1) throw new Error('会话已取消')
    })).rejects.toThrow('会话已取消')
    expect((await listXiaohongshuHandoffs()).find(item => item.id === handoff.id)?.draftReadbackAt).toBeUndefined()
    await Promise.all([
      recordXiaohongshuDraftReadback(handoff.id),
      exportXiaohongshuHandoff(handoff.id, join(testDir, '交付包.zip')),
      recordXiaohongshuDraftReadback(handoff.id),
    ])
    const saved = (await listXiaohongshuHandoffs()).find(item => item.id === handoff.id)
    expect(saved?.draftReadbackAt).toBeNumber()
    expect(saved?.status).toBe('handed_off')
    expect((await getXiaohongshuHandoffAudit(handoff.id)).filter(entry => entry.event === 'draft_readback_verified')).toHaveLength(1)
  })

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
