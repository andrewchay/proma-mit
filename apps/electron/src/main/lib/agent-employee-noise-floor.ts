export interface OwnerJudgmentObservation {
  at: number
  outcome: 'business_accepted' | 'changes_requested'
}

export interface ReworkNoiseFloor {
  mode: 'historical' | 'fixed_fallback'
  meanReworkRate: number | null
  standardDeviation: number | null
  alertThreshold: number
  windowCount: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const LOOKBACK_DAYS = 90
const ROLLING_WINDOW_DAYS = 30
const STEP_DAYS = 7
const MINIMUM_WINDOW_SAMPLES = 5
const MINIMUM_VALID_WINDOWS = 5
const FIXED_REWORK_THRESHOLD = 0.5

/** 用近期 90 天的 30 天滚动 Owner 返工率估算波动；样本不足时显式回退固定阈值。 */
export function calculateReworkNoiseFloor(observations: OwnerJudgmentObservation[], now = Date.now()): ReworkNoiseFloor {
  const since = now - LOOKBACK_DAYS * DAY_MS
  const eligible = observations.filter((item) => Number.isFinite(item.at) && item.at >= since && item.at <= now)
  const rates: number[] = []

  for (let end = now; end - ROLLING_WINDOW_DAYS * DAY_MS >= since; end -= STEP_DAYS * DAY_MS) {
    const window = eligible.filter((item) => item.at > end - ROLLING_WINDOW_DAYS * DAY_MS && item.at <= end)
    if (window.length < MINIMUM_WINDOW_SAMPLES) continue
    rates.push(window.filter((item) => item.outcome === 'changes_requested').length / window.length)
  }

  if (rates.length < MINIMUM_VALID_WINDOWS) {
    return { mode: 'fixed_fallback', meanReworkRate: null, standardDeviation: null, alertThreshold: FIXED_REWORK_THRESHOLD, windowCount: rates.length }
  }

  const meanReworkRate = rates.reduce((sum, value) => sum + value, 0) / rates.length
  const variance = rates.reduce((sum, value) => sum + (value - meanReworkRate) ** 2, 0) / rates.length
  const standardDeviation = Math.sqrt(variance)
  return {
    mode: 'historical',
    meanReworkRate: Math.round(meanReworkRate * 1000) / 1000,
    standardDeviation: Math.round(standardDeviation * 1000) / 1000,
    alertThreshold: FIXED_REWORK_THRESHOLD,
    windowCount: rates.length,
  }
}
