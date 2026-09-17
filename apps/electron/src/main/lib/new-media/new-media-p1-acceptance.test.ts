/**
 * P1 端到端验收：小红书发布交接 + 官方报表导入。
 *
 * 覆盖台账 P1-10 的 DoD：
 * - 交接全链路没有自动发布，且未导出前不能标记已发布。
 * - 三类报表（专业号/蒲公英/聚光）均可导入。
 * - 同一文件重复导入不重复计数。
 * - 错误文件被拒绝且不产生任何入库数据。
 * - 导入数据只在对应口径内汇总。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import AdmZip from 'adm-zip'
import { createContentDraft } from './content-operations'
import {
  buildXiaohongshuHandoffPackage,
  confirmXiaohongshuPublished,
  exportXiaohongshuHandoff,
  getXiaohongshuHandoffAudit,
  prepareXiaohongshuHandoff,
} from './xiaohongshu-handoff'
import {
  commitNewMediaImport,
  listNewMediaImportBatches,
  listNewMediaImportedRows,
  parseImportFile,
  previewNewMediaImport,
} from './new-media-report-import'
import { getNewMediaInsightReport } from './new-media-insight-report'
import { listNewMediaAudit } from './new-media-audit'
import { clearNewMediaRecordsForTests, closeNewMediaDb } from './new-media-sqlite-store'

let testDir = ''
beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-nm-e2e-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { await clearNewMediaRecordsForTests() })
afterAll(() => { closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

const encoder = new TextEncoder()
const csv = (name: string, content: string) => parseImportFile({ fileName: name, bytes: encoder.encode(content) })

const PROFESSIONAL = [
  '日期,笔记标题,笔记ID,曝光量,阅读量,点赞数,收藏数,评论数,分享数,涨粉数',
  '2026-09-01,秋日穿搭,note-1,"18,000",4200,180,66,24,9,18',
  '2026-09-02,秋日穿搭,note-1,21000,5100,205,71,28,11,22',
].join('\n')

const PUGONGYING = [
  '日期,笔记标题,笔记ID,合作品牌,曝光量,阅读量,互动量,消耗,转化数,涨粉数',
  '2026-09-03,品牌联名,note-7,某品牌,150000,18000,2400,9000,55,120',
].join('\n')

const JUGUANG = [
  '广告计划,日期,消耗,曝光量,点击量,互动量,转化数',
  '计划A,2026-09-03,5200,220000,8800,1600,70',
  '计划A,2026-09-04,4800,200000,7900,1450,64',
].join('\n')

describe('P1-10 小红书交接与报表导入端到端', () => {
  test('交接全链路不自动发布，未导出不得标记已发布', async () => {
    const draft = await createContentDraft('秋日穿搭分享 #穿搭', ['xiaohongshu'])
    const handoff = await prepareXiaohongshuHandoff(draft.id)
    expect(handoff.status).toBe('draft_ready')
    await expect(confirmXiaohongshuPublished(handoff.id, 'Carol')).rejects.toThrow('必须先完成发布交接')

    const buffer = await buildXiaohongshuHandoffPackage(handoff.id)
    const zip = new AdmZip(buffer)
    expect(zip.getEntries().map((entry) => entry.entryName).sort()).toEqual(['README.md', 'content.json', 'content.txt', 'manifest.json'])
    expect(zip.readAsText('README.md')).toContain('不会登录账号、调用私有接口或自动发布')

    const destination = join(testDir, handoff.packageFileName)
    const exported = await exportXiaohongshuHandoff(handoff.id, destination)
    expect(exported.status).toBe('handed_off')
    // 导出文件必须与批次记录的校验值一致（交付包内含生成时间，不能与另一次构建比较字节数）。
    const written = readFileSync(destination)
    expect(exported.packageSha256).toBeDefined()
    expect(createHash('sha256').update(written).digest('hex')).toBe(exported.packageSha256 as string)
    expect(new AdmZip(written).readAsText('content.txt')).toContain('秋日穿搭分享')

    const confirmed = await confirmXiaohongshuPublished(handoff.id, 'Carol')
    expect(confirmed.status).toBe('user_confirmed_published')
    expect((await getXiaohongshuHandoffAudit(handoff.id)).map((entry) => entry.event)).toEqual(['prepared', 'exported', 'user_confirmed_published'])
    // 审计中必须表明这是用户确认而非平台回执
    expect((await getXiaohongshuHandoffAudit(handoff.id)).at(-1)?.detail).toContain('不是平台 API 回执')
  })

  test('三类报表均可导入，并各自归入口径', async () => {
    const professional = await commitNewMediaImport({ sourceKind: 'xiaohongshu-professional', accountId: 'acc-1', parsed: await csv('专业号.csv', PROFESSIONAL), importedBy: 'Carol', confirmed: true })
    const pugongying = await commitNewMediaImport({ sourceKind: 'xiaohongshu-pugongying', accountId: 'acc-1', parsed: await csv('蒲公英.csv', PUGONGYING), importedBy: 'Carol', confirmed: true })
    const juguang = await commitNewMediaImport({ sourceKind: 'xiaohongshu-juguang', accountId: 'acc-1', parsed: await csv('聚光.csv', JUGUANG), importedBy: 'Carol', confirmed: true })

    expect([professional.importedRows, pugongying.importedRows, juguang.importedRows]).toEqual([2, 1, 2])
    expect([professional.commercial, pugongying.commercial, juguang.commercial]).toEqual([false, true, true])

    const report = await getNewMediaInsightReport({ periodStart: Date.parse('2026-09-01T00:00:00Z'), periodEnd: Date.parse('2026-09-05T00:00:00Z') })
    expect(report.account.totals.impressions).toBe(39000)
    expect(report.account.totals.followersGained).toBe(40)
    expect(report.commercial.totals.spend).toBe(19000)
    expect(report.commercial.totals.conversions).toBe(189)
    expect(report.account.sources.map((source) => source.sourceKind)).toEqual(['xiaohongshu-professional'])
    expect(report.commercial.sources.map((source) => source.sourceKind).sort()).toEqual(['xiaohongshu-juguang', 'xiaohongshu-pugongying'])
    expect(report.disclaimers.some((item) => item.includes('不计算 ROI'))).toBe(true)
    expect(await listNewMediaAudit({ domain: 'import' })).toHaveLength(3)
  })

  test('同一文件重复导入不重复计数', async () => {
    const content = PROFESSIONAL
    await commitNewMediaImport({ sourceKind: 'xiaohongshu-professional', accountId: 'acc-1', parsed: await csv('专业号.csv', content), importedBy: 'Carol', confirmed: true })

    const replayParsed = await csv('专业号.csv', content)
    await expect(commitNewMediaImport({ sourceKind: 'xiaohongshu-professional', accountId: 'acc-1', parsed: replayParsed, importedBy: 'Carol', confirmed: true })).rejects.toThrow('已导入过')

    const forced = await commitNewMediaImport({ sourceKind: 'xiaohongshu-professional', accountId: 'acc-1', parsed: await csv('专业号.csv', content), importedBy: 'Carol', confirmed: true, allowDuplicateFile: true })
    expect(forced.importedRows).toBe(0)
    expect(forced.skippedDuplicateRows).toBe(2)
    expect((await listNewMediaImportedRows()).length).toBe(2)

    const report = await getNewMediaInsightReport({ periodStart: Date.parse('2026-09-01T00:00:00Z'), periodEnd: Date.parse('2026-09-05T00:00:00Z') })
    expect(report.account.totals.impressions).toBe(39000)
  })

  test('错误文件被拒绝且不产生任何入库数据与血缘', async () => {
    await expect(csv('报表.pdf', 'x')).rejects.toThrow('不支持的导入文件类型')
    await expect(csv('空文件.csv', '')).rejects.toThrow('导入文件为空')
    await expect(csv('空表.csv', '\n')).rejects.toThrow('文件中没有可解析的表格内容')

    const wrongColumns = await csv('缺列.csv', '笔记标题,点赞数\n笔记A,10\n')
    await expect(previewNewMediaImport({ sourceKind: 'xiaohongshu-professional', accountId: 'acc-1', parsed: wrongColumns })).rejects.toThrow('缺少必要列：日期')

    const allInvalid = await csv('全非法.csv', '日期,曝光量\n未填写,1200\n2026-13-99,900\n')
    await expect(commitNewMediaImport({ sourceKind: 'xiaohongshu-professional', accountId: 'acc-1', parsed: allInvalid, importedBy: 'Carol', confirmed: true })).rejects.toThrow()

    expect(await listNewMediaImportBatches()).toEqual([])
    expect(await listNewMediaImportedRows()).toEqual([])
    expect(await listNewMediaAudit({ domain: 'import' })).toEqual([])
  })
})
