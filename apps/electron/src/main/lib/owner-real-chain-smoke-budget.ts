/** 真实链路冒烟的硬性费用上限；只做本地断言，不代替服务商账单。 */
export const OWNER_REAL_CHAIN_SMOKE_MAX_COST_MICROS = 1_400_000

/** 跨隔离 profile 的既有消费必须由调用方带入，不能换 profile 重置授权。 */
export function remainingSmokeBudget(priorCostMicros: number): number {
  if (!Number.isSafeInteger(priorCostMicros) || priorCostMicros < 0 || priorCostMicros >= OWNER_REAL_CHAIN_SMOKE_MAX_COST_MICROS) throw new Error('真实冒烟既有费用无效或已达上限')
  return OWNER_REAL_CHAIN_SMOKE_MAX_COST_MICROS - priorCostMicros
}

export function ensureSmokeBudget(maxCostMicros: number): void {
  if (!Number.isSafeInteger(maxCostMicros) || maxCostMicros <= 0 || maxCostMicros > OWNER_REAL_CHAIN_SMOKE_MAX_COST_MICROS) {
    throw new Error(`真实链路冒烟超出已授权上限：${maxCostMicros} > ${OWNER_REAL_CHAIN_SMOKE_MAX_COST_MICROS}`)
  }
}

/** 已获用户确认的累计60笔上限；在规划准入与员工预留的同一事务内核对。 */
export function assertSmokeRequestAllowance(count: number, limit: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 60) throw new Error('真实冒烟请求次数边界无效')
  if (count >= limit) throw new Error(`真实冒烟已达到 ${limit} 次请求上限，拒绝新增请求`)
}

export function assertOwnerSmokeRequestLimit(): void {
  if (process.env.GRAVITAS_PACKAGE_SMOKE !== '1' || !process.env.GRAVITAS_OWNER_CHAIN_SMOKE_CHANNEL_ID) return
  const { existsSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const { getConfigDir } = require('./config-paths') as typeof import('./config-paths')
  if (!process.env.PROMA_TEST_CONFIG_DIR || !existsSync(join(getConfigDir(), '.package-smoke-empty'))) throw new Error('真实冒烟请求必须处于新建隔离 profile')
  const database = (require('./project-sqlite-store') as typeof import('./project-sqlite-store')).getProjectDb()
  if (!database.isTransactionActive()) throw new Error('冒烟请求计数必须在发送准入事务内检查')
  const row = database.prepare(`SELECT (SELECT COUNT(*) FROM project_owner_planning_admissions)
    + (SELECT COUNT(*) FROM project_owner_execution_request_reservations) AS count`).get() as { count: number }
  const priorRequests = Number(process.env.GRAVITAS_OWNER_CHAIN_SMOKE_PRIOR_REQUESTS ?? 0)
  if (!Number.isSafeInteger(priorRequests) || priorRequests < 0) throw new Error('真实冒烟既有请求次数无效')
  assertSmokeRequestAllowance(row.count + priorRequests, Number(process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS ?? 8))
}
