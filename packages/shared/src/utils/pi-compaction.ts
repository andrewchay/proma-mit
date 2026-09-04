/**
 * Pi 上下文自动压缩的阈值计算。
 *
 * 借鉴上游 Proma（v0.16.x）：Pi 在上下文达到模型窗口约 80% 时触发自动压缩，
 * 以 reserveTokens 表示预留空间（剩余 20% 留给压缩摘要与后续轮次）。
 */

/** 自动压缩触发阈值：上下文占用模型窗口的比例 */
export const PI_AUTO_COMPACTION_THRESHOLD_RATIO = 0.8

/** Pi 会话的上下文窗口兜底值（模型未声明时使用） */
export const PI_DEFAULT_CONTEXT_WINDOW = 256_000

/**
 * 返回 Pi SDK 会开始自动压缩的上下文 token 阈值（占用窗口的阈值比例）。
 */
export function calculatePiAutoCompactionThresholdTokens(contextWindow: number): number {
  return contextWindow - calculatePiAutoCompactionReserveTokens(contextWindow)
}

/**
 * 返回应保留给压缩摘要与后续内容的 token 数（reserveTokens）。
 * Pi SDK 的 compaction.reserveTokens 即此值。
 */
export function calculatePiAutoCompactionReserveTokens(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new TypeError('Pi context window must be a positive finite number')
  }
  return Math.ceil(contextWindow * (1 - PI_AUTO_COMPACTION_THRESHOLD_RATIO))
}
