import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'; import { join } from 'node:path'; import { tmpdir } from 'node:os'
import { closeNewMediaDb } from './new-media-sqlite-store'
import { getSocialReport, getTrendOpportunities, ingestMetricSnapshot, ingestTrend, resetAnalyticsTrendsForTests } from './analytics-trends'
let testDir = ''
beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-new-media-analytics-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { await resetAnalyticsTrendsForTests() })
afterAll(() => { closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })
describe('新媒体运营指标与热点雷达', () => {
  test('按平台汇总指标并计算互动率', async () => { const now = Date.now(); await ingestMetricSnapshot({ platform: 'xiaohongshu', contentId: 'xhs-1', capturedAt: now, impressions: 1000, engagements: 80, followersGained: 12 }); await ingestMetricSnapshot({ platform: 'wechat-official-account', contentId: 'wx-1', capturedAt: now, impressions: 500, engagements: 20, followersGained: 3 }); closeNewMediaDb(); const report = await getSocialReport(now - 1, now + 1); expect(report.totalImpressions).toBe(1500); expect(report.totalEngagements).toBe(100); expect(report.engagementRate).toBeCloseTo(0.0667); expect(report.byPlatform.xiaohongshu?.followersGained).toBe(12) })
  test('高风险热点默认避免借势，即使关联度较高', async () => { await ingestTrend({ title: '品牌A相关争议', summary: '品牌A被曝光的争议事件', source: '人工核验', observedAt: Date.now(), heat: 95, relatedKeywords: ['品牌A'], risk: 'high' }); const opportunity = (await getTrendOpportunities(['品牌A']))[0]; expect(opportunity).toBeDefined(); expect(opportunity?.relevanceScore).toBeGreaterThan(65); expect(opportunity?.recommendation).toBe('avoid') })
  test('低风险且高关联热点建议行动', async () => { await ingestTrend({ title: '品牌A秋季新品灵感', summary: '秋季新品内容趋势', source: '人工核验', observedAt: Date.now(), heat: 80, relatedKeywords: ['品牌A', '秋季'], risk: 'low' }); const opportunity = (await getTrendOpportunities(['品牌A']))[0]; expect(opportunity?.recommendation).toBe('act') })
})
