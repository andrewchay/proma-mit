/** 两条 Runtime 共用的逐请求上界算术；调用方必须在最终 HTTP 出口核验输入、输出及价格证据。 */
export interface PilotRequestEnvelope {
  /** 已由受控请求出口证明的输入 token 上界，不是字符数估算。 */
  inputTokenCeiling: number
  /** Provider 执行的输出总 token 上限（含推理）；不能只限可见文本。 */
  outputTokenCeiling: number
  /** 已审核的价格包络，单位 micro-USD / 百万 token；须覆盖缓存、推理及可能的额外费用。 */
  inputRateMicrosPerMillion: number
  outputRateMicrosPerMillion: number
  /** 无法按 token 归类的最高附加费用，单位 micro-USD。 */
  extraCostCeilingMicros: number
  /** 上游凭证：定价快照与最终请求参数的身份，由出口负责验证而非此函数生成。 */
  priceEvidenceId: string
  requestEvidenceId: string
}

const MILLION = 1_000_000n
/** 未经证明的参数一律拒绝；返回向上取整后的最低必要预留。 */
export function calculatePilotRequestCeiling(input: PilotRequestEnvelope, availableMicros: number): number {
  if (!input || typeof input.priceEvidenceId !== 'string' || typeof input.requestEvidenceId !== 'string') {
    throw new Error('Pilot 单请求上界缺少可核验参数')
  }
  const fields = [input.inputTokenCeiling, input.outputTokenCeiling, input.inputRateMicrosPerMillion,
    input.outputRateMicrosPerMillion, input.extraCostCeilingMicros, availableMicros]
  if (fields.some((n) => !Number.isSafeInteger(n) || n < 0)
    || input.inputTokenCeiling === 0 || input.outputTokenCeiling === 0
    || input.inputRateMicrosPerMillion === 0 || input.outputRateMicrosPerMillion === 0
    || availableMicros === 0 || !input.priceEvidenceId.trim() || !input.requestEvidenceId.trim()) {
    throw new Error('Pilot 单请求上界缺少可核验参数')
  }
  const tokens = BigInt(input.inputTokenCeiling) * BigInt(input.inputRateMicrosPerMillion)
    + BigInt(input.outputTokenCeiling) * BigInt(input.outputRateMicrosPerMillion)
  const ceiling = (tokens + MILLION - 1n) / MILLION + BigInt(input.extraCostCeilingMicros)
  if (ceiling > BigInt(availableMicros)) throw new Error('Pilot 单请求最坏费用超过可用额度')
  return Number(ceiling)
}
