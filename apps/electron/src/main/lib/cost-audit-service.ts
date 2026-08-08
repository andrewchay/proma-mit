/**
 * 费用审计服务 — Cost Audit Service（PH2-C）
 *
 * 定时/按需对 Token 用量与费用做「审计」：汇总、趋势对比、Top 消耗、异常告警。
 * 供 Agent（RunCostAudit 工具）与自动 Audit 任务读取，主动报告费用异常。
 *
 * 数据源：token-usage-service.getTokenUsageRecords（有 sessionId/modelId/costTotal/totalTokens/workspaceId/timestamp）。
 * 不含模型配置或个人凭据。
 */

export interface CostAuditInput {
  /** 审计窗口长度（毫秒）；默认最近 7 天 */
  windowMs?: number
  /** 告警阈值：费用突增倍率（当前 vs 上一窗口） */
  spikeRatio?: number
}

export interface CostAuditItem {
  sessionId: string
  modelId?: string
  workspaceId?: string
  costTotal: number
  totalTokens: number
}

export interface CostAuditReport {
  windowStart: number
  windowEnd: number
  totalCost: number
  totalTokens: number
  previousTotalCost: number
  costChangeRatio: number | null
  byModel: Array<{ modelId: string; costTotal: number }>
  byWorkspace: Array<{ workspaceId: string; costTotal: number }>
  topSessions: Array<{ sessionId: string; costTotal: number }>
  alerts: string[]
  hasAlerts: boolean
}

/** 懒加载数据源（token-usage-service 依赖 electron，避免单测/无 electron 环境加载崩溃） */
function records(): (q: import('@gravitas/shared').TokenUsageQuery) => Array<{
  sessionId: string; modelId?: string; workspaceId?: string; costTotal?: number; totalTokens?: number
}> {
  const { getTokenUsageRecords } = require('./token-usage-service') as { getTokenUsageRecords: (q: import('@gravitas/shared').TokenUsageQuery) => Array<any> }
  return getTokenUsageRecords
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_SPIKE_RATIO = 2

type UsageRow = { sessionId: string; modelId?: string; workspaceId?: string; costTotal?: number; totalTokens?: number }

export function runCostAudit(input: CostAuditInput = {}): CostAuditReport {
  const now = Date.now()
  const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS
  const spikeRatio = input.spikeRatio ?? DEFAULT_SPIKE_RATIO
  const windowStart = now - windowMs
  const prevStart = windowStart - windowMs

  const get = records()
  const current = get({ from: windowStart, to: now, limit: 5000 }) as UsageRow[]
  const previous = get({ from: prevStart, to: windowStart, limit: 5000 }) as UsageRow[]

  const totalCost = sumCost(current)
  const totalTokens = current.reduce((s, r) => s + (r.totalTokens ?? 0), 0)
  const previousTotalCost = sumCost(previous)

  // 按模型
  const byModelMap = new Map<string, number>()
  for (const r of current) {
    const key = r.modelId ?? 'unknown'
    byModelMap.set(key, (byModelMap.get(key) ?? 0) + (r.costTotal ?? 0))
  }
  const byModel = [...byModelMap.entries()].map(([modelId, costTotal]) => ({ modelId, costTotal })).sort((a, b) => b.costTotal - a.costTotal)

  // 按工作区
  const byWsMap = new Map<string, number>()
  for (const r of current) {
    const key = r.workspaceId ?? 'default'
    byWsMap.set(key, (byWsMap.get(key) ?? 0) + (r.costTotal ?? 0))
  }
  const byWorkspace = [...byWsMap.entries()].map(([workspaceId, costTotal]) => ({ workspaceId, costTotal })).sort((a, b) => b.costTotal - a.costTotal)

  // Top 会话（按会话聚合）
  const bySession = new Map<string, CostAuditItem>()
  for (const r of current) {
    const item = bySession.get(r.sessionId) ?? { sessionId: r.sessionId, modelId: r.modelId, workspaceId: r.workspaceId, costTotal: 0, totalTokens: 0 }
    item.costTotal += r.costTotal ?? 0
    item.totalTokens += r.totalTokens ?? 0
    item.modelId = r.modelId ?? item.modelId
    bySession.set(r.sessionId, item)
  }
  const topSessions = [...bySession.values()]
    .sort((a, b) => b.costTotal - a.costTotal)
    .slice(0, 8)
    .map((s) => ({ sessionId: s.sessionId, costTotal: s.costTotal }))

  // 异常告警
  const alerts: string[] = []
  if (totalCost > 0 && previousTotalCost > 0) {
    const changeRatio = totalCost / previousTotalCost
    if (changeRatio >= spikeRatio) {
      alerts.push(`费用环比增长 ${(changeRatio * 100).toFixed(0)}%（上一窗口 $${previousTotalCost.toFixed(3)} → 当前 $${totalCost.toFixed(3)}）`)
    }
  }
  if (topSessions.length > 0 && topSessions[0]!.costTotal > 0 && topSessions[0]!.costTotal > totalCost * 0.4) {
    alerts.push(`单个会话「${topSessions[0]!.sessionId.slice(0, 12)}…」消耗占总费用 ${(topSessions[0]!.costTotal / (totalCost || 1) * 100).toFixed(0)}%，需关注`)
  }
  if (byModel.length > 0 && byModel[0]!.costTotal > totalCost * 0.7) {
    alerts.push(`模型「${byModel[0]!.modelId}」占费用 ${(byModel[0]!.costTotal / (totalCost || 1) * 100).toFixed(0)}%）`)
  }

  return {
    windowStart,
    windowEnd: now,
    totalCost,
    totalTokens,
    previousTotalCost,
    costChangeRatio: previousTotalCost > 0 ? totalCost / previousTotalCost : null,
    byModel,
    byWorkspace,
    topSessions,
    alerts,
    hasAlerts: alerts.length > 0,
  }
}

/** 生成人类可读的费用审计摘要（给 Agent 解释用）。 */
export function costAuditToText(report: CostAuditReport): string {
  const lines = [
    `费用审计（${new Date(report.windowStart).toLocaleDateString('zh-CN')} ~ ${new Date(report.windowEnd).toLocaleDateString('zh-CN')}）`,
    `本次总费用: $${report.totalCost.toFixed(3)} · 总 token: ${report.totalTokens}`,
    `上一窗口费用: $${report.previousTotalCost.toFixed(3)}${report.costChangeRatio ? ` · 环比 ${(report.costChangeRatio * 100).toFixed(0)}%` : ''}`,
  ]
  if (report.byModel.length > 0) lines.push(`按模型: ${report.byModel.map((m) => `${m.modelId} $${m.costTotal.toFixed(3)}`).join('、')}`)
  if (report.byWorkspace.length > 0) lines.push(`按工作区: ${report.byWorkspace.map((w) => `${w.workspaceId} $${w.costTotal.toFixed(3)}`).join('、')}`)
  if (report.topSessions.length > 0) lines.push(`Top 会话: ${report.topSessions.map((s) => `${s.sessionId.slice(0, 10)} $${s.costTotal.toFixed(3)}`).join('、')}`)
  if (report.hasAlerts) {
    lines.push(`⚠ 告警:`)
    for (const a of report.alerts) lines.push(` - ${a}`)
  } else {
    lines.push('✓ 费用处于正常区间，无异常告警')
  }
  return lines.join('\n')
}

function sumCost(rows: Array<{ costTotal?: number }>): number {
  return rows.reduce((s, r) => s + (r.costTotal ?? 0), 0)
}
