/**
 * 「上一条请求结论不可继续」时，新消息能否继续发送的**唯一判定**。
 *
 * 为什么单独成文件：这段逻辑同时被对话层、调度器和认领闸门使用。
 * 放在 conversation.ts 里会让 delegation.ts 反向依赖它，形成循环依赖，
 * 而三处判定一旦不一致，就会出现「会话层告知用户将处理、认领闸门却抛错回滚」
 * 的静默丢失——消息看起来发出去了，实际一条都没到上游。
 *
 * 本模块是纯函数，不读库、不产生副作用，便于各处复用与单独测试。
 */

export interface OwnerAttentionCarryoverView {
  state: string
  usedRequests: number
  reservedCostMicros: number
  attentionCheck?: { reason: string }
  delegation: {
    maxRequests: number
    maxCostMicros: number
    perRequestCeilingMicros: number
    autonomousExecution?: boolean
  } | null
}

/**
 * 判定结果：
 * - `proceed`：上条仅「结论不可继续」且预算足够，新消息可作为新请求继续。
 * - `budget_blocked`：可接续但剩余预算不足以覆盖一次保守上界，须先说明。
 * - `blocked`：其他情形，不允许继续（交由调用方给出对应的暂停说明）。
 *
 * 原则：旧请求保持保守预留、费用记为未知、绝不重试；新消息作为新请求。
 * 但剩余预算不足以覆盖一次保守上界时必须停下说明，不能靠放行绕过额度。
 */
export function decideAttentionCarryover(view: OwnerAttentionCarryoverView): 'blocked' | 'budget_blocked' | 'proceed' {
  if (view.state !== 'attention') return 'blocked'
  if (view.attentionCheck?.reason !== 'non_continueable_outcome') return 'blocked'
  const row = view.delegation
  if (!row) return 'blocked'
  const withinBudget = (row.autonomousExecution === true || view.usedRequests < row.maxRequests)
    && view.reservedCostMicros + row.perRequestCeilingMicros <= row.maxCostMicros
  return withinBudget ? 'proceed' : 'budget_blocked'
}
