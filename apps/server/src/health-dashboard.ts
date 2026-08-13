/**
 * health-dashboard — 贵慢重准四维健康度聚合
 *
 * ◾ 贵（cost）：本月成本 + 趋势
 * ◾ 慢（latency）：P95 延迟 vs 目标
 * ◾ 重（volume）：token / 运行量
 * ◾ 准（accuracy）：成功率（幻觉率占位，P8-3 接评估数据后增强）
 *
 * computeHealthDashboard 为纯函数，接受各数据源聚合结果，便于独立测试与替换数据源。
 */

export type HealthGrade = 'good' | 'warn' | 'poor'

export interface HealthDashboardInput {
  monthlyCostMicroUsd: number
  p95LatencyMs: number
  totalTokens: number
  totalRuns: number
  successRuns: number
  monthlyBudgetMicroUsd?: number
  /** 可选：幻觉率（0..1），接入 eval 数据后填充 */
  hallucinationRate?: number
  /** 可选：本月初时间戳，用于成本趋势计算 */
  monthStartedAt?: number
}

export interface HealthDashboard {
  cost: { monthlyMicroUsd: number; trend: 'up' | 'down' | 'flat' }
  latency: { p95Ms: number; targetMs: number; grade: HealthGrade }
  volume: { totalTokens: number; totalRuns: number }
  accuracy: { successRate: number; hallucinationRate?: number; grade: HealthGrade }
  budget: { monthlyLimitMicroUsd?: number; usedPercent: number }
}

const LATENCY_TARGET_MS = 2_000
const LATENCY_WARN_MS = 4_000

/** 延迟分档：≤2s good、≤4s warn、>4s poor */
export function gradeLatency(p95Ms: number): HealthGrade {
  if (p95Ms <= LATENCY_TARGET_MS) return 'good'
  if (p95Ms <= LATENCY_WARN_MS) return 'warn'
  return 'poor'
}

/** 成功率分档：≥97% good、≥90% warn、<90% poor */
export function gradeSuccessRate(rate: number): HealthGrade {
  if (rate >= 0.97) return 'good'
  if (rate >= 0.9) return 'warn'
  return 'poor'
}

export function computeHealthDashboard(input: HealthDashboardInput): HealthDashboard {
  const { monthlyCostMicroUsd, p95LatencyMs, totalTokens, totalRuns, successRuns, monthlyBudgetMicroUsd } = input

  const successRate = totalRuns > 0 ? Number((successRuns / totalRuns).toFixed(4)) : 0
  const usedPercent = monthlyBudgetMicroUsd && monthlyBudgetMicroUsd > 0
    ? Number(((monthlyCostMicroUsd / monthlyBudgetMicroUsd) * 100).toFixed(1))
    : 0

  return {
    cost: {
      monthlyMicroUsd: monthlyCostMicroUsd,
      // 趋势简化：有预算时按占用率粗判，无预算 flat（后续接时序数据增强）
      trend: usedPercent >= 80 ? 'up' : usedPercent > 0 ? 'flat' : 'flat',
    },
    latency: { p95Ms: p95LatencyMs, targetMs: LATENCY_TARGET_MS, grade: gradeLatency(p95LatencyMs) },
    volume: { totalTokens, totalRuns },
    accuracy: {
      successRate,
      hallucinationRate: input.hallucinationRate,
      grade: gradeSuccessRate(successRate),
    },
    budget: {
      monthlyLimitMicroUsd: monthlyBudgetMicroUsd,
      usedPercent,
    },
  }
}
