import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { commitNewMediaImport, parseImportFile } from './new-media-report-import'
import { getNewMediaInsightReport } from './new-media-insight-report'
import { ingestMetricSnapshot } from './analytics-trends'
import { clearNewMediaRecordsForTests, closeNewMediaDb } from './new-media-sqlite-store'

let testDir = ''
beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-nm-insight-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { await clearNewMediaRecordsForTests() })
afterAll(() => { closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

const encoder = new TextEncoder()
const DAY = 86_400_000
const periodStart = Date.parse('2026-09-01T00:00:00Z')
const periodEnd = Date.parse('2026-09-05T00:00:00Z')
const range = { periodStart, periodEnd }

async function importCsv(sourceKind: 'xiaohongshu-professional' | 'xiaohongshu-pugongying', accountId: string, name: string, content: string) {
  const parsed = await parseImportFile({ fileName: name, bytes: encoder.encode(content) })
  return commitNewMediaImport({ sourceKind, accountId, parsed, importedBy: 'Carol', confirmed: true })
}

describe('P1-09 导入数据洞察', () => {
  test('账号与商业数据分开展示，不合并汇总', async () => {
    await importCsv('xiaohongshu-professional', 'acc-1', '专业号.csv', [
      '日期,曝光量,点赞数,涨粉数',
      '2026-09-01,10000,300,20',
      '2026-09-02,20000,400,30',
    ].join('\n'))
    await importCsv('xiaohongshu-pugongying', 'acc-1', '蒲公英.csv', [
      '日期,笔记标题,合作品牌,曝光量,互动量,消耗',
      '2026-09-01,联名笔记,某品牌,80000,1200,4500',
    ].join('\n'))

    const report = await getNewMediaInsightReport(range)
    expect(report.account.totals.impressions).toBe(30000)
    expect(report.account.totals.spend).toBeUndefined()
    expect(report.account.scope).toBe('account')

    expect(report.commercial.scope).toBe('commercial')
    expect(report.commercial.totals.spend).toBe(4500)
    expect(report.commercial.totals.impressions).toBe(80000)
    expect(report.commercial.sources[0]?.boundary).toContain('不能代表账号整体')
    // 商业数据不得混进账号口径
    expect(report.account.totals.impressions).not.toBe(110000)
  })

  test('明确列出缺失日期与数据新鲜度', async () => {
    await importCsv('xiaohongshu-professional', 'acc-1', '专业号.csv', [
      '日期,曝光量',
      '2026-09-01,10000',
      '2026-09-04,12000',
    ].join('\n'))

    const report = await getNewMediaInsightReport(range)
    expect(report.account.coveredDays).toEqual(['2026-09-01', '2026-09-04'])
    expect(report.account.missingDays).toEqual(['2026-09-02', '2026-09-03', '2026-09-05'])
    expect(report.account.freshnessLagDays).toBeGreaterThan(0)
    expect(report.commercial.coveredDays).toEqual([])
    expect(report.commercial.measuredMetrics).toEqual([])
  })

  test('只呈现实际出现过的指标，不用 0 冒充', async () => {
    await importCsv('xiaohongshu-professional', 'acc-1', '专业号.csv', '日期,曝光量\n2026-09-01,10000\n')
    const report = await getNewMediaInsightReport(range)
    expect(report.account.measuredMetrics).toEqual(['impressions'])
    expect(report.account.totals).toEqual({ impressions: 10000 })
  })

  test('声明不计算 ROI，且人工快照单独计数', async () => {
    await ingestMetricSnapshot({ platform: 'xiaohongshu', contentId: 'note-1', capturedAt: periodStart + DAY, impressions: 500, engagements: 20, followersGained: 1 })
    const report = await getNewMediaInsightReport(range)
    expect(report.manualSnapshotCount).toBe(1)
    expect(report.account.totals.impressions).toBeUndefined()
    expect(report.disclaimers.some((item) => item.includes('不计算 ROI'))).toBe(true)
    expect(report.disclaimers.some((item) => item.includes('商业投放数据'))).toBe(true)
    expect(JSON.stringify(report)).not.toContain('roiValue')
  })

  test('时间范围异常被拒绝', async () => {
    await expect(getNewMediaInsightReport({ periodStart: periodEnd, periodEnd: periodStart })).rejects.toThrow('时间范围无效')
    await expect(getNewMediaInsightReport({ periodStart: Number.NaN, periodEnd: periodEnd })).rejects.toThrow('时间范围无效')
  })
})
