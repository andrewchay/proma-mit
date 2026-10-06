import type { AssistantMessage } from '@earendil-works/pi-ai'

/** Pi 0.82.1 离线实验：只控制相邻模型请求，不是单次请求美元硬上限。 */
export function createPiTurnBudgetExperiment(limitUsd: number) {
  if (!Number.isFinite(limitUsd) || limitUsd <= 0) throw new Error('实验预算无效')
  let totalUsd = 0
  let blocked: string | undefined
  let requestInFlight = false
  return {
    beforeRequest(): boolean {
      if (blocked || requestInFlight || totalUsd >= limitUsd) return false
      requestInFlight = true
      return true
    },
    afterResponse(message: AssistantMessage): void {
      if (blocked) return
      if (!requestInFlight) { blocked = '未对应已准入请求的回执'; return }
      requestInFlight = false
      const cost = message.usage?.cost?.total
      if (!Number.isFinite(cost) || cost < 0) {
        blocked = '费用缺失或无效，实际支出未知'
        return
      }
      totalUsd += cost
      if (!Number.isFinite(totalUsd)) { blocked = '费用累计无效'; return }
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        blocked = '结果不确定，已报告费用仍保留'
        return
      }
      if (totalUsd >= limitUsd) blocked = '预算已达到或超出上限'
    },
    stop(): void { blocked = '主动中止' },
    get snapshot() { return { totalUsd, blocked, requestInFlight } },
  }
}
