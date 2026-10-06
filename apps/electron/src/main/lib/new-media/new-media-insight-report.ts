/**
 * 导入数据洞察汇总。
 *
 * 目标不是「算出好看的报表」，而是如实呈现当前手上有什么数据：
 * - 账号来源（专业号）与商业来源（蒲公英/聚光）永远分开展示，不合并汇总。
 * - 明确列出时间范围内的缺失日期与数据新鲜度，避免把旧数据当当期结论。
 * - 不计算 ROI / 转化收益：本地只有消耗与平台侧转化计数，缺少收入归因数据，
 *   任何比率的计算都必须由人工在明确口径下另行完成。
 */
import type { NewMediaPlatform } from '@gravitas/shared'
import type { NewMediaImportSourceKind } from './new-media-import-contract'
import { getNewMediaImportContract, isCommercialSource } from './new-media-import-contract'
import { listNewMediaImportedRows } from './new-media-report-import'
import { listMetricSnapshots } from './analytics-trends'

import type {
  NewMediaInsightReport,
  NewMediaInsightSection,
  NewMediaInsightSourceSummary,
} from '@gravitas/shared'

export type {
  NewMediaInsightReport,
  NewMediaInsightSection,
  NewMediaInsightSourceSummary,
}

type NewMediaInsightMetric =
  | 'impressions'
  | 'reads'
  | 'likes'
  | 'collects'
  | 'comments'
  | 'shares'
  | 'followersGained'
  | 'clicks'
  | 'interactions'
  | 'conversions'
  | 'spend'

const METRIC_FIELDS: NewMediaInsightMetric[] = [
  'impressions', 'reads', 'likes', 'collects', 'comments', 'shares',
  'followersGained', 'clicks', 'interactions', 'conversions', 'spend',
]

function dayKeyOf(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function enumerateDays(periodStart: number, periodEnd: number): string[] {
  const days: string[] = []
  const cursor = new Date(dayKeyOf(periodStart))
  const end = new Date(dayKeyOf(periodEnd))
  // 上限 366 天，避免异常入参生成超大数组。
  for (let index = 0; index < 366 && cursor <= end; index += 1) {
    days.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}

export interface BuildInsightReportInput {
  periodStart: number
  periodEnd: number
  platform?: NewMediaPlatform
}

export async function getNewMediaInsightReport(input: BuildInsightReportInput): Promise<NewMediaInsightReport> {
  const { periodStart, periodEnd } = input
  if (!Number.isFinite(periodStart) || !Number.isFinite(periodEnd) || periodStart > periodEnd) throw new Error('时间范围无效')

  const rows = (await listNewMediaImportedRows()).filter((row) => {
    if (input.platform && row.platform !== input.platform) return false
    return row.capturedAt >= periodStart && row.capturedAt <= periodEnd
  })
  const snapshots = (await listMetricSnapshots()).filter((snapshot) => snapshot.capturedAt >= periodStart && snapshot.capturedAt <= periodEnd)

  const expectedDays = enumerateDays(periodStart, periodEnd)
  const build = (scope: 'account' | 'commercial'): NewMediaInsightSection => {
    const scoped = rows.filter((row) => (scope === 'commercial' ? row.commercial : !row.commercial))
    const totals: Partial<Record<NewMediaInsightMetric, number>> = {}
    const measured = new Set<NewMediaInsightMetric>()
    const covered = new Set<string>()
    let lastCapturedAt: number | undefined
    const bySource = new Map<NewMediaImportSourceKind, { rowCount: number; batchIds: Set<string>; lastCapturedAt?: number }>()

    for (const row of scoped) {
      covered.add(dayKeyOf(row.capturedAt))
      if (lastCapturedAt === undefined || row.capturedAt > lastCapturedAt) lastCapturedAt = row.capturedAt
      const entry = bySource.get(row.sourceKind) ?? { rowCount: 0, batchIds: new Set<string>(), lastCapturedAt: undefined }
      entry.rowCount += 1
      entry.batchIds.add(row.batchId)
      if (entry.lastCapturedAt === undefined || row.capturedAt > entry.lastCapturedAt) entry.lastCapturedAt = row.capturedAt
      bySource.set(row.sourceKind, entry)

      for (const [field, value] of Object.entries(row.metrics)) {
        if (!METRIC_FIELDS.includes(field as NewMediaInsightMetric)) continue
        const metric = field as NewMediaInsightMetric
        measured.add(metric)
        totals[metric] = (totals[metric] ?? 0) + value
      }
    }

    const coveredDays = [...covered].sort()
    const missingDays = expectedDays.filter((day) => !covered.has(day))
    const section: NewMediaInsightSection = {
      scope,
      totals,
      measuredMetrics: METRIC_FIELDS.filter((metric) => measured.has(metric)),
      sources: [...bySource.entries()].map(([sourceKind, entry]) => ({
        sourceKind,
        label: getNewMediaImportContract(sourceKind).label,
        commercial: isCommercialSource(sourceKind),
        rowCount: entry.rowCount,
        batchCount: entry.batchIds.size,
        lastCapturedAt: entry.lastCapturedAt,
        boundary: getNewMediaImportContract(sourceKind).boundary,
      })),
      coveredDays,
      missingDays,
    }
    if (lastCapturedAt !== undefined) {
      section.lastCapturedAt = lastCapturedAt
      const today = new Date()
      const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
      section.freshnessLagDays = Math.max(0, Math.round((todayUtc - Date.parse(`${dayKeyOf(lastCapturedAt)}T00:00:00Z`)) / 86_400_000))
    }
    return section
  }

  return {
    periodStart,
    periodEnd,
    generatedAt: Date.now(),
    account: build('account'),
    commercial: build('commercial'),
    manualSnapshotCount: snapshots.length,
    disclaimers: [
      '账号口径数据仅来自专业号自有内容报表，不代表其他账号或全平台。',
      '商业投放数据（蒲公英/聚光）只覆盖已授权范围，不与账号数据合并汇总。',
      '本地不计算 ROI、ROAS 或转化收益：缺少收入与归因数据，任何此类比率都需人工在明确口径下另行核实。',
      '平台报表可能延迟更新，导入前请核对数据截止日期。',
    ],
  }
}
