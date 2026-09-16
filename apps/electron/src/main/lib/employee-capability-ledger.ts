/**
 * AI 员工能力演化运营台账与周期复盘。
 *
 * 只读本地权威记录，不调用模型、不激活或回滚版本、不删除数据。
 * 代理指标（样本审核量、评测成本）不等于真实 ROI 或生产质量。
 */

import * as store from './project-sqlite-store'
import { listApprovals } from './approval-service'
import { listRecommendations } from './recommendation-service'
import { runCostAudit } from './cost-audit-service'

const DAY_MS = 24 * 60 * 60 * 1000

export interface EmployeeCapabilityLedgerEntry {
  agentId: string
  agentName: string
  versions: { total: number; active: number; superseded: number; rolledBack: number }
  samples: { total: number; pending: number; sanitized: number; excluded: number; cancelled: number }
  decisions: { approved: number; rejected: number; pending: number }
  rollbacks: number
  observations: {
    executionCount: number
    reworkRate: number | null
    failureRate: number | null
    decidedSampleCount: number
    sampleSufficient: boolean
  }
  /** 评测调用成本（USD）；仅为代理指标，不等于真实 ROI。 */
  evaluationCostUsd: number
  /** 人工审核代理指标：已脱敏样本数。 */
  reviewEffortProxy: number
}

export interface EmployeeCapabilityLedgerReport {
  windowDays: number
  generatedAt: number
  entries: EmployeeCapabilityLedgerEntry[]
  totals: {
    approved: number
    rejected: number
    pending: number
    rollbacks: number
    sanitizedSamples: number
    evaluationCostUsd: number
  }
  disclaimer: string
}

function emptyLedgerEntry(agentId: string, agentName: string): EmployeeCapabilityLedgerEntry {
  return {
    agentId,
    agentName,
    versions: { total: 0, active: 0, superseded: 0, rolledBack: 0 },
    samples: { total: 0, pending: 0, sanitized: 0, excluded: 0, cancelled: 0 },
    decisions: { approved: 0, rejected: 0, pending: 0 },
    rollbacks: 0,
    observations: { executionCount: 0, reworkRate: null, failureRate: null, decidedSampleCount: 0, sampleSufficient: false },
    evaluationCostUsd: 0,
    reviewEffortProxy: 0,
  }
}

/** 汇总单个员工的能力演化台账。 */
export function buildEmployeeCapabilityLedger(agentId: string, windowDays = 30, now = Date.now()): EmployeeCapabilityLedgerEntry {
  const employee = store.getAgentEmployee(agentId)
  if (!employee) throw new Error('AI 员工不存在')
  const entry = emptyLedgerEntry(agentId, employee.name)
  const versions = store.listAgentEmployeeCapabilityVersions(agentId)
  entry.versions = {
    total: versions.length,
    active: versions.filter((version) => version.status === 'active').length,
    superseded: versions.filter((version) => version.status === 'superseded').length,
    rolledBack: versions.filter((version) => version.status === 'rolled_back').length,
  }
  const samples = store.listAgentEmployeeLearningSamples(agentId)
  entry.samples = {
    total: samples.length,
    pending: samples.filter((sample) => sample.privacyStatus === 'pending').length,
    sanitized: samples.filter((sample) => sample.privacyStatus === 'sanitized').length,
    excluded: samples.filter((sample) => sample.privacyStatus === 'excluded').length,
    cancelled: samples.filter((sample) => sample.outcome === 'cancelled').length,
  }
  entry.reviewEffortProxy = entry.samples.sanitized

  const approvals = listApprovals().filter((approval) => approval.sourceType === 'employee_capability' && (approval.proposedChange as { agentId?: string } | undefined)?.agentId === agentId)
  entry.decisions = {
    approved: approvals.filter((approval) => approval.status === 'approved').length,
    rejected: approvals.filter((approval) => approval.status === 'rejected').length,
    pending: approvals.filter((approval) => approval.status === 'pending' || approval.status === 'edited').length,
  }
  entry.rollbacks = store.listAgentEmployeeCapabilityRollbackAudits(agentId).length

  const health = store.getAgentEmployeeCapabilityHealth(agentId, windowDays, now)
  const activeHealth = health.filter((item) => versions.some((version) => version.id === item.versionId && version.status === 'active'))
  entry.observations = {
    executionCount: health.reduce((sum, item) => sum + item.executionCount, 0),
    // 多版本共存时取 active 版本指标，避免把已被替换版本的数据混入当前结论。
    reworkRate: activeHealth.length === 1 ? activeHealth[0]!.reworkRate : null,
    failureRate: activeHealth.length === 1 ? activeHealth[0]!.failureRate : null,
    decidedSampleCount: health.reduce((sum, item) => sum + item.decidedSampleCount, 0),
    sampleSufficient: activeHealth.length === 1 ? activeHealth[0]!.sampleSufficient : false,
  }
  return entry
}

/** 评测成本按窗口归集（复用既有成本审计，不新增模型调用）。 */
function resolveEvaluationCostUsd(windowDays: number): number {
  try {
    const report = runCostAudit({ windowMs: windowDays * DAY_MS })
    return report.totalCost
  } catch (error) {
    console.warn('[员工台账] 成本归集失败，按 0 处理:', error instanceof Error ? error.message : error)
    return 0
  }
}

/**
 * 生成周期复盘报告。不含会话原文、附件、路径与样本摘要正文。
 */
export function buildEmployeeCapabilityReviewReport(input: { agentIds?: string[]; windowDays?: number; now?: number } = {}): EmployeeCapabilityLedgerReport {
  const windowDays = input.windowDays ?? 30
  const now = input.now ?? Date.now()
  const employees = store.listAgentEmployees().filter((employee) => !input.agentIds || input.agentIds.includes(employee.id))
  const entries = employees.map((employee) => buildEmployeeCapabilityLedger(employee.id, windowDays, now))
  const totalCost = resolveEvaluationCostUsd(windowDays)
  // 成本无法按员工精确拆分，只挂到总额，避免制造虚假归因。
  return {
    windowDays,
    generatedAt: now,
    entries,
    totals: {
      approved: entries.reduce((sum, entry) => sum + entry.decisions.approved, 0),
      rejected: entries.reduce((sum, entry) => sum + entry.decisions.rejected, 0),
      pending: entries.reduce((sum, entry) => sum + entry.decisions.pending, 0),
      rollbacks: entries.reduce((sum, entry) => sum + entry.rollbacks, 0),
      sanitizedSamples: entries.reduce((sum, entry) => sum + entry.samples.sanitized, 0),
      evaluationCostUsd: totalCost,
    },
    disclaimer: '评测成本与审核量为代理指标，不等于真实 ROI 或外部生产质量结论。',
  }
}

/** 生成人类可读的 Markdown 报告（不含敏感内容）。 */
export function reviewReportToMarkdown(report: EmployeeCapabilityLedgerReport): string {
  const lines = [
    `# AI 员工能力演化周期复盘`,
    '',
    `- 窗口：最近 ${report.windowDays} 天`,
    `- 生成时间：${new Date(report.generatedAt).toLocaleString('zh-CN')}`,
    `- 说明：${report.disclaimer}`,
    '',
    '## 汇总',
    '',
    `- 候选批准 ${report.totals.approved} · 拒绝 ${report.totals.rejected} · 待审批 ${report.totals.pending}`,
    `- 人工回滚 ${report.totals.rollbacks} · 已脱敏样本 ${report.totals.sanitizedSamples}`,
    `- 窗口内评测成本（代理）$${report.totals.evaluationCostUsd.toFixed(3)}`,
    '',
    '## 按员工',
    '',
  ]
  for (const entry of report.entries) {
    const percent = (value: number | null): string => value === null ? '—' : `${(value * 100).toFixed(1)}%`
    lines.push(
      `### ${entry.agentName}`,
      '',
      `- 版本：共 ${entry.versions.total} · active ${entry.versions.active} · superseded ${entry.versions.superseded} · rolled_back ${entry.versions.rolledBack}`,
      `- 样本：共 ${entry.samples.total} · 待审核 ${entry.samples.pending} · 已脱敏 ${entry.samples.sanitized} · 已排除 ${entry.samples.excluded} · 取消 ${entry.samples.cancelled}`,
      `- 审批：批准 ${entry.decisions.approved} · 拒绝 ${entry.decisions.rejected} · 待审批 ${entry.decisions.pending}`,
      `- 滚动窗口执行 ${entry.observations.executionCount} · 返工率 ${percent(entry.observations.reworkRate)} · 失败率 ${percent(entry.observations.failureRate)}${entry.observations.sampleSufficient ? '' : '（样本量不足，结论待观察）'}`,
      '',
    )
  }
  return lines.join('\n')
}
