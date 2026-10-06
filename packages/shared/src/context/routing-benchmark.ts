/**
 * M6-05 离线路由评测。
 *
 * 对固定 scenario 集对比「可解释路由」与「朴素 baseline（取第一个候选）」：
 * 成本、隐私违规数、决策可解释性。纯离线，产出报告，绝不自动启用任何路由。
 */
import type { ModelPricing } from './cost-model'
import { routeModelRequest, type RoutingUsage } from './explainable-router'
import type { RouteCandidate, RoutingPolicy } from './routing-policy'

export interface RoutingScenario {
  id: string
  candidates: readonly RouteCandidate[]
  policy: RoutingPolicy
  usage: RoutingUsage
}

export interface RoutingScenarioReport {
  id: string
  baselineId: string | null
  routedId: string | null
  baselineCost: number
  routedCost: number
  savingsRate: number
  /** baseline 选中的候选若过不了 policy，即记一次隐私/合规违规。 */
  privacyViolations: number
  allDecisionsExplained: boolean
}

export interface RoutingBenchmarkReport {
  version: 1
  benchmarkId: 'routing-policy-benchmark'
  scenarios: RoutingScenarioReport[]
  totalBaselineCost: number
  totalRoutedCost: number
  savingsRate: number
  privacyViolations: number
  autoEnabled: false
}

export function runRoutingBenchmark(input: {
  scenarios: readonly RoutingScenario[]
  pricing: ModelPricing
}): RoutingBenchmarkReport {
  const reports = input.scenarios.map((scenario) => evaluateScenario(scenario, input.pricing))
  const totalBaselineCost = reports.reduce((total, report) => total + report.baselineCost, 0)
  const totalRoutedCost = reports.reduce((total, report) => total + report.routedCost, 0)
  return {
    version: 1,
    benchmarkId: 'routing-policy-benchmark',
    scenarios: reports,
    totalBaselineCost,
    totalRoutedCost,
    savingsRate: totalBaselineCost === 0 ? 0 : 1 - totalRoutedCost / totalBaselineCost,
    privacyViolations: reports.reduce((total, report) => total + report.privacyViolations, 0),
    autoEnabled: false,
  }
}

function evaluateScenario(scenario: RoutingScenario, pricing: ModelPricing): RoutingScenarioReport {
  const decision = routeModelRequest({
    candidates: scenario.candidates,
    policy: scenario.policy,
    pricing,
    usage: scenario.usage,
  })

  const baselineCandidate = scenario.candidates[0]
  let baselineId: string | null = null
  let baselineCost = 0
  let privacyViolations = 0
  if (baselineCandidate) {
    baselineId = baselineCandidate.id
    const baselineAllowed = routeModelRequest({
      candidates: [baselineCandidate],
      policy: scenario.policy,
      pricing,
      usage: scenario.usage,
    })
    if (baselineAllowed.chosenId === null) {
      // baseline 选择了过不了 policy 的候选：记一次违规
      privacyViolations = 1
    } else {
      baselineCost = baselineAllowed.cost?.total ?? 0
    }
  }

  const routedCost = decision.cost?.total ?? 0
  const allDecisionsExplained = decision.rejections.every((rejection) => rejection.reason.trim().length > 0)
    && decision.reasons.every((reason) => reason.trim().length > 0)
    && (decision.chosenId !== null || decision.rejections.length > 0)

  return {
    id: scenario.id,
    baselineId,
    routedId: decision.chosenId,
    baselineCost,
    routedCost,
    savingsRate: baselineCost === 0 ? 0 : 1 - routedCost / baselineCost,
    privacyViolations,
    allDecisionsExplained,
  }
}
