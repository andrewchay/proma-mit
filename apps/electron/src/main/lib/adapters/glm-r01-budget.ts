/** R01 试点专用预留器，不属于生产 Runtime 费用计量。
 * 价格来源：https://bigmodel.cn/pricing，2026-10-10 核验。
 * 按标准价、忽略缓存折扣，以请求 UTF-8 字节数两倍加 framing 余量保守预留输入。
 * 此为本地安全余量估计，不是 Provider 账单或 tokenizer 的形式化上界证明。
 * 网络失败、重试和缺usage保留预留；成功完整usage结算，避免未知费用被当成零。
 */
export class GlmR01Budget {
  reservedCny = 0
  requests = 0
  confirmedEstimateCny = 0
  private pending = new Map<number, number>()
  readonly maxOutputTokens = 2048
  constructor(readonly capCny = 10, priorReservedCny = 0) {
    if (!Number.isFinite(capCny) || capCny <= 0 || capCny > 10) throw new Error('预算必须在 (0,10] 元之间')
    if (!Number.isFinite(priorReservedCny) || priorReservedCny < 0 || priorReservedCny > capCny) throw new Error('无效历史预留')
    this.reservedCny = priorReservedCny
  }
  reserve(bodyBytes: number): number {
    if (!Number.isSafeInteger(bodyBytes) || bodyBytes <= 0) throw new Error('无效请求字节数')
    const inputAllowance = bodyBytes * 2 + 4096
    // 限制保守输入预留额度；不是价格档位声明。
    if (inputAllowance > 128_000) throw new Error('试点请求超过保守输入额度，拒绝发送')
    const amount = (inputAllowance * 0.8 + this.maxOutputTokens * 2.8) / 1_000_000
    if (this.reservedCny + amount > this.capCny) throw new Error('人民币预算预留已耗尽，拒绝发送')
    this.reservedCny += amount
    this.requests += 1
    this.pending.set(this.requests, amount)
    return this.requests
  }
  /** 只对成功响应中完整、有效的Provider usage释放多余预留；价格仍为本地估计。 */
  settle(receipt: number, promptTokens: number, completionTokens: number): void {
    const reserved = this.pending.get(receipt)
    if (reserved === undefined) throw new Error('预留不存在或已结算')
    if (!Number.isSafeInteger(promptTokens) || promptTokens <= 0 || !Number.isSafeInteger(completionTokens) || completionTokens < 0) throw new Error('无效usage，保留预留')
    const estimate = (promptTokens * 0.8 + completionTokens * 2.8) / 1_000_000
    if (estimate > reserved) throw new Error('usage超出保守预留，停止核验预算')
    this.pending.delete(receipt)
    this.confirmedEstimateCny += estimate
    this.reservedCny -= reserved - estimate
  }
}
