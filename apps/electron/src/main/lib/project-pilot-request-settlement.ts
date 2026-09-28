import { getPilotReviewedPriceEvidence } from './project-pilot-request-evidence'
import { getProjectDb } from './project-sqlite-store'

/**
 * 逐请求结算：响应给出可信用量后按已审核证据价计算实际成本。
 * 实际 ≤ 预留 → settled 并释放差额（可用额度按实际成本继续占用）；
 * 实际 > 预留或证据/用量不可信 → needs_reconcile 保持全额占额，等待人工对账。
 */

export interface PilotRequestUsage {
  promptTokens: number
  completionTokens: number
}

export type PilotRequestSettlement =
  | { outcome: 'settled'; settledCostMicros: number }
  | { outcome: 'needs_reconcile'; reason: string }

const MILLION = 1_000_000n

/** 结算单次请求。幂等：已 settled 返回原值；已 needs_reconcile 不自动改判。 */
export function settlePilotRequestUsage(requestId: string, usage: PilotRequestUsage): PilotRequestSettlement {
  if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('Pilot 请求身份无效')
  if (!Number.isSafeInteger(usage?.promptTokens) || usage.promptTokens < 0
    || !Number.isSafeInteger(usage?.completionTokens) || usage.completionTokens < 0) throw new Error('Pilot 请求用量无效')
  const db = getProjectDb()
  let result: PilotRequestSettlement | undefined
  db.transaction(() => {
    const row = db.prepare(`SELECT reserved_cost_micros, settled_cost_micros, state, price_evidence_id
      FROM pilot_request_reservations WHERE request_id = ?`).get(requestId) as {
      reserved_cost_micros: number; settled_cost_micros: number | null; state: string; price_evidence_id: string
    } | undefined
    if (!row) throw new Error('Pilot 请求预留不存在，无法结算')
    if (row.state === 'settled') {
      result = { outcome: 'settled', settledCostMicros: row.settled_cost_micros ?? 0 }
      return
    }
    if (row.state === 'needs_reconcile') {
      result = { outcome: 'needs_reconcile', reason: '预留此前已进入待对账，保持占额' }
      return
    }
    const evidence = getPilotReviewedPriceEvidence(row.price_evidence_id)
    if (!evidence) {
      db.prepare("UPDATE pilot_request_reservations SET state = 'needs_reconcile' WHERE request_id = ?").run(requestId)
      result = { outcome: 'needs_reconcile', reason: '价格证据不可用' }
      return
    }
    // 与预留同一套 BigInt 向上取整算术：tokens 不超上界则实际必不超预留，超出即说明
    // Provider 未执行输出上限等合同被破坏，转待对账并保留全额占额。
    const cost = (BigInt(usage.promptTokens) * BigInt(evidence.inputMicrosPerMillion)
      + BigInt(usage.completionTokens) * BigInt(evidence.outputMicrosPerMillion)
      + MILLION - 1n) / MILLION + BigInt(evidence.extraCostCeilingMicros)
    if (cost > BigInt(row.reserved_cost_micros)) {
      db.prepare("UPDATE pilot_request_reservations SET state = 'needs_reconcile' WHERE request_id = ?").run(requestId)
      result = { outcome: 'needs_reconcile', reason: '实际用量费用超过预留上界' }
      return
    }
    db.prepare('UPDATE pilot_request_reservations SET state = ?, settled_cost_micros = ? WHERE request_id = ?')
      .run('settled', Number(cost), requestId)
    result = { outcome: 'settled', settledCostMicros: Number(cost) }
  })()
  if (!result) throw new Error('Pilot 请求结算未产生结果')
  return result
}

/** 响应中断、状态异常或用量不可解析时调用：占额不释放，等待人工对账。已结算行不受影响。 */
export function markPilotRequestNeedsReconcile(requestId: string): void {
  if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('Pilot 请求身份无效')
  getProjectDb().prepare("UPDATE pilot_request_reservations SET state = 'needs_reconcile' WHERE request_id = ? AND state = 'reserved'")
    .run(requestId)
}
