import { randomUUID } from 'node:crypto'
import type { NewMediaPlatform } from './content-operations'
import { clearNewMediaRecordsForTests, listNewMediaRecords, putNewMediaRecord } from './new-media-sqlite-store'

export interface MetricSnapshot { id: string; platform: NewMediaPlatform; contentId: string; capturedAt: number; impressions: number; engagements: number; followersGained: number }
export interface SocialReport { periodStart: number; periodEnd: number; totalImpressions: number; totalEngagements: number; engagementRate: number; followersGained: number; byPlatform: Partial<Record<NewMediaPlatform, { impressions: number; engagements: number; followersGained: number }>> }
export interface TrendItem { id: string; title: string; summary: string; source: string; observedAt: number; heat: number; relatedKeywords: string[]; risk: 'low' | 'medium' | 'high' }
export interface TrendOpportunity { trend: TrendItem; relevanceScore: number; recommendation: 'act' | 'monitor' | 'avoid'; rationale: string }
const SNAPSHOT_KIND = 'metric-snapshot'
const TREND_KIND = 'trend-item'
function assertNonNegative(value: number, field: string): void { if (!Number.isFinite(value) || value < 0) throw new Error(`${field} 必须是非负数字`) }

export async function ingestMetricSnapshot(input: Omit<MetricSnapshot, 'id'>): Promise<MetricSnapshot> {
  if (!input.contentId.trim()) throw new Error('内容标识不能为空')
  assertNonNegative(input.impressions, '曝光量'); assertNonNegative(input.engagements, '互动量'); assertNonNegative(input.followersGained, '新增粉丝数')
  return putNewMediaRecord(SNAPSHOT_KIND, { id: randomUUID(), ...input })
}
export async function listMetricSnapshots(): Promise<MetricSnapshot[]> { return listNewMediaRecords(SNAPSHOT_KIND) }
export async function getSocialReport(periodStart: number, periodEnd: number): Promise<SocialReport> {
  if (!Number.isFinite(periodStart) || !Number.isFinite(periodEnd) || periodStart > periodEnd) throw new Error('时间范围无效')
  const matched = (await listMetricSnapshots()).filter((snapshot) => snapshot.capturedAt >= periodStart && snapshot.capturedAt <= periodEnd)
  const byPlatform: SocialReport['byPlatform'] = {}; let totalImpressions = 0; let totalEngagements = 0; let followersGained = 0
  for (const snapshot of matched) {
    totalImpressions += snapshot.impressions; totalEngagements += snapshot.engagements; followersGained += snapshot.followersGained
    const current = byPlatform[snapshot.platform] ?? { impressions: 0, engagements: 0, followersGained: 0 }
    current.impressions += snapshot.impressions; current.engagements += snapshot.engagements; current.followersGained += snapshot.followersGained; byPlatform[snapshot.platform] = current
  }
  return { periodStart, periodEnd, totalImpressions, totalEngagements, engagementRate: totalImpressions === 0 ? 0 : Number((totalEngagements / totalImpressions).toFixed(4)), followersGained, byPlatform }
}
export async function ingestTrend(input: Omit<TrendItem, 'id' | 'relatedKeywords'> & { relatedKeywords: string[] }): Promise<TrendItem> {
  if (!input.title.trim() || !input.summary.trim() || !input.source.trim()) throw new Error('热点标题、摘要和来源不能为空')
  if (!Number.isFinite(input.heat) || input.heat < 0 || input.heat > 100) throw new Error('热度必须在 0 到 100 之间')
  return putNewMediaRecord(TREND_KIND, { id: randomUUID(), ...input, relatedKeywords: [...new Set(input.relatedKeywords.map((keyword) => keyword.trim()).filter(Boolean))] })
}
export async function listTrends(): Promise<TrendItem[]> { return listNewMediaRecords(TREND_KIND) }
export async function getTrendOpportunities(brandKeywords: string[]): Promise<TrendOpportunity[]> {
  const normalized = [...new Set(brandKeywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean))]
  if (normalized.length === 0) throw new Error('至少提供一个品牌关键词')
  return (await listTrends()).map((trend) => {
    const text = `${trend.title} ${trend.summary} ${trend.relatedKeywords.join(' ')}`.toLowerCase(); const matches = normalized.filter((keyword) => text.includes(keyword)).length
    const relevanceScore = Math.min(100, matches * 45 + Math.round(trend.heat * 0.55)); const recommendation: TrendOpportunity['recommendation'] = trend.risk === 'high' ? 'avoid' : relevanceScore >= 65 && trend.risk === 'low' ? 'act' : 'monitor'
    const rationale = trend.risk === 'high' ? '热点存在高风险，建议避免借势并持续关注。' : matches > 0 ? `与 ${matches} 个品牌关键词相关，结合当前热度建议${recommendation === 'act' ? '快速准备合规内容' : '先观察讨论走向'}。` : '未发现明确品牌关联，建议仅监控，不投入内容资源。'
    return { trend, relevanceScore, recommendation, rationale }
  }).sort((a, b) => b.relevanceScore - a.relevanceScore)
}
export async function resetAnalyticsTrendsForTests(): Promise<void> { await clearNewMediaRecordsForTests() }
