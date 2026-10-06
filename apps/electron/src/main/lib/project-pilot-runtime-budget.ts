import { AGENT_RUNTIME_CAPABILITIES, type AgentRuntime } from '@gravitas/shared'

const MICROS_PER_USD = 1_000_000

/** 将账本预留额转换为 Runtime 的调用级预算停止阈值；不支持时必须在调用 Provider 前拒绝。 */
export function resolvePilotRuntimeBudgetLimitUsd(runtime: AgentRuntime, reservedCostMicros: number): number {
  if (!Number.isSafeInteger(reservedCostMicros) || reservedCostMicros <= 0) {
    throw new Error('Pilot 单次费用预留无法核验')
  }
  if (!AGENT_RUNTIME_CAPABILITIES[runtime].supportsBudgetStopThreshold) {
    throw new Error(`Pilot Runtime ${runtime} 不支持单次费用超额停止阈值`)
  }
  const limit = reservedCostMicros / MICROS_PER_USD
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('Pilot 单次费用停止阈值无法核验')
  return limit
}

/** 合并应用级与调用级停止阈值；两者同时存在时采用更严格的值。 */
export function resolveRuntimeBudgetLimitUsd(
  runtime: AgentRuntime,
  requestedLimitUsd: number | undefined,
  configuredLimitUsd: number | undefined,
): number | undefined {
  if (requestedLimitUsd !== undefined) {
    if (!Number.isFinite(requestedLimitUsd) || requestedLimitUsd <= 0) throw new Error('Runtime 费用停止阈值无效')
    if (!AGENT_RUNTIME_CAPABILITIES[runtime].supportsBudgetStopThreshold) {
      throw new Error(`Runtime ${runtime} 不支持调用级费用超额停止阈值`)
    }
  }
  const configured = configuredLimitUsd !== undefined && Number.isFinite(configuredLimitUsd) && configuredLimitUsd > 0
    ? configuredLimitUsd
    : undefined
  if (requestedLimitUsd === undefined) {
    return AGENT_RUNTIME_CAPABILITIES[runtime].supportsBudgetStopThreshold ? configured : undefined
  }
  return configured === undefined ? requestedLimitUsd : Math.min(requestedLimitUsd, configured)
}
