import type { AssistantMessage } from '@earendil-works/pi-ai'

/** Pi 本地费用软门禁：仅限制相邻请求与工具，不是 Provider 单次请求硬上限或原始账单。 */
export function createPiRequestBudgetGate(limitUsd: number) {
  if (!Number.isFinite(limitUsd) || limitUsd <= 0) throw new Error('Pi 调用级费用阈值无效')
  let reportedUsd = 0
  let blocked: string | undefined
  let inFlight = false
  let settledRequests = 0
  return {
    beforeRequest(): void {
      if (blocked || inFlight || reportedUsd >= limitUsd) {
        throw new Error(`Pi 请求前费用门禁阻断：${blocked ?? (inFlight ? '上一请求未结束' : '预算已达到阈值')}`)
      }
      inFlight = true
    },
    beforePayload(): void {
      // 作为 Provider 请求体生成处的第二道屏障；不能代替逐请求费用硬上限。
      if (!inFlight || blocked) {
        blocked ??= 'Provider 请求体没有有效的模型请求准入'
        throw new Error(`Pi Provider 请求体门禁阻断：${blocked}`)
      }
    },
    afterResponse(message: AssistantMessage): void {
      if (!inFlight) { blocked ??= '无法关联请求与 Runtime 回执'; return }
      inFlight = false
      settledRequests += 1
      const cost = message.usage?.cost?.total
      if (!Number.isFinite(cost) || cost === undefined || cost <= 0) {
        // 本地价格配置缺失时 Pi 可能报 0；无 Provider 原始账单不能据此认定免费。
        blocked ??= 'Runtime 费用缺失或无效，实际支出未知'
        return
      }
      reportedUsd += cost
      if (!Number.isFinite(reportedUsd)) { blocked ??= 'Runtime 累计费用无效'; return }
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        blocked ??= 'Runtime 结果不确定，已报告费用保留'
      } else if (reportedUsd >= limitUsd) {
        blocked ??= 'Runtime 报告费用已达到或超过阈值'
      }
    },
    stop(): void { blocked ??= '会话已中止' },
    get blocked(): string | undefined { return blocked ?? (inFlight ? undefined : reportedUsd >= limitUsd ? '预算已达到阈值' : undefined) },
    get reportedUsd(): number { return reportedUsd },
    get inFlight(): boolean { return inFlight },
    assertComplete(): void {
      if (inFlight || blocked || settledRequests === 0) {
        throw new Error(`Pi 有限费用执行待对账：${blocked ?? (inFlight ? '模型请求没有 Runtime 费用回执' : '没有可归属的 Runtime 费用回执')}`)
      }
    },
  }
}
