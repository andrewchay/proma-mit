/**
 * AI 员工能力版本健康告警。
 *
 * 只根据本地记录生成提醒，不自动判罪、不自动回滚、不调用模型。
 * 样本量不足时不产生质量结论类告警。
 */

import { getAgentEmployeeCapabilityHealth } from './project-sqlite-store'
import type { AgentEmployeeCapabilityHealth } from './project-types'

export type CapabilityAlertCode = 'consecutive_failures' | 'rework_spike' | 'stale_observation'

export interface CapabilityAlert {
  code: CapabilityAlertCode
  severity: 'info' | 'warning'
  versionId: string
  message: string
  /** 数据依据，便于人工核对。 */
  evidence: string
}

export interface CapabilityAlertInput {
  health: AgentEmployeeCapabilityHealth[]
  /** 连续失败样本阈值（默认 3）。 */
  consecutiveFailureThreshold?: number
  /** 返工率告警阈值（默认 0.5）。 */
  reworkRateThreshold?: number
  /** 长时间无样本的天数阈值（默认 21）。 */
  staleDays?: number
  now?: number
}

/**
 * 生成告警。
 * 「长时间无样本」只说明观察不足，不表示质量变差。
 */
export function buildCapabilityAlerts(input: CapabilityAlertInput): CapabilityAlert[] {
  const consecutiveFailureThreshold = input.consecutiveFailureThreshold ?? 3
  const reworkRateThreshold = input.reworkRateThreshold ?? 0.5
  const staleDays = input.staleDays ?? 21
  const now = input.now ?? Date.now()
  const alerts: CapabilityAlert[] = []

  for (const item of input.health) {
    // 失败率告警需要足够样本，避免把 1/1 当成趋势。
    if (item.sampleSufficient && item.failureRate !== null && item.decidedSampleCount >= consecutiveFailureThreshold && item.failureRate >= 1) {
      alerts.push({ code: 'consecutive_failures', severity: 'warning', versionId: item.versionId, message: '该版本已判定样本全部失败，建议人工核查', evidence: `已判定 ${item.decidedSampleCount} 条，失败率 ${(item.failureRate * 100).toFixed(1)}%` })
    }
    if (item.sampleSufficient && item.reworkRate !== null && item.reworkRate >= reworkRateThreshold) {
      alerts.push({ code: 'rework_spike', severity: 'warning', versionId: item.versionId, message: '该版本返工率偏高，建议核查任务说明或能力内容', evidence: `已判定 ${item.decidedSampleCount} 条，返工率 ${(item.reworkRate * 100).toFixed(1)}%` })
    }
    if (item.decidedSampleCount === 0) {
      alerts.push({ code: 'stale_observation', severity: 'info', versionId: item.versionId, message: '该版本暂无已判定样本，尚不能判断质量', evidence: '只说明观察不足，不代表质量变差' })
    } else if (item.lastExecutedAt && now - item.lastExecutedAt > staleDays * 24 * 60 * 60 * 1000) {
      alerts.push({ code: 'stale_observation', severity: 'info', versionId: item.versionId, message: `该版本已超过 ${staleDays} 天没有新的执行记录`, evidence: `最近执行：${new Date(item.lastExecutedAt).toLocaleString('zh-CN')}` })
    }
  }
  return alerts
}

export function buildCapabilityAlertsForAgent(agentId: string, windowDays = 30, overrides: Omit<CapabilityAlertInput, 'health'> = {}): CapabilityAlert[] {
  return buildCapabilityAlerts({ ...overrides, health: getAgentEmployeeCapabilityHealth(agentId, windowDays) })
}
