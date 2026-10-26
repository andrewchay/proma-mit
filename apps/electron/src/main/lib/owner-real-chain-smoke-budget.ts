/** 真实链路冒烟的硬性费用上限；只做本地断言，不代替服务商账单。 */
export const OWNER_REAL_CHAIN_SMOKE_MAX_COST_MICROS = 1_400_000

export function ensureSmokeBudget(maxCostMicros: number): void {
  if (!Number.isSafeInteger(maxCostMicros) || maxCostMicros <= 0 || maxCostMicros > OWNER_REAL_CHAIN_SMOKE_MAX_COST_MICROS) {
    throw new Error(`真实链路冒烟超出已授权上限：${maxCostMicros} > ${OWNER_REAL_CHAIN_SMOKE_MAX_COST_MICROS}`)
  }
}
