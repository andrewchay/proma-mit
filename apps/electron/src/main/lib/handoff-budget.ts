/**
 * HandoffBudget —— 交接预算工具（P2）
 *
 * 借鉴 LoopX 的 handoff budget：限制 SubAgent / Task 交接文本的长度，
 * 强制 Agent 压缩上下文，避免上下文膨胀导致 token 浪费。
 *
 * LoopX 默认：16 行 / 1800 字符。Proma MIT 保留相近阈值。
 */

/** 交接预算（与 LoopX 对齐） */
export const HANDOFF_BUDGET = {
  maxLines: 16,
  maxChars: 1_800,
} as const

/** 预算检查结果 */
export interface HandoffBudgetResult {
  withinBudget: boolean
  lineCount: number
  charCount: number
  maxLines: number
  maxChars: number
  overLineBudget: boolean
  overCharBudget: boolean
}

/** 检查一段交接文本是否在预算内 */
export function checkHandoffBudget(text: string): HandoffBudgetResult {
  const lineCount = text.split('\n').length
  const charCount = text.length
  const overLineBudget = lineCount > HANDOFF_BUDGET.maxLines
  const overCharBudget = charCount > HANDOFF_BUDGET.maxChars
  return {
    withinBudget: !overLineBudget && !overCharBudget,
    lineCount,
    charCount,
    maxLines: HANDOFF_BUDGET.maxLines,
    maxChars: HANDOFF_BUDGET.maxChars,
    overLineBudget,
    overCharBudget,
  }
}

/**
 * 若交接文本超出预算，生成压缩提示（不实际截断，交由上层决定）。
 *
 * @returns 裁剪后的文本（保留开头 + 结尾摘要提示）
 */
export function enforceHandoffBudget(
  text: string,
  budget: typeof HANDOFF_BUDGET = HANDOFF_BUDGET,
): { text: string; truncated: boolean; result: HandoffBudgetResult } {
  const result = checkHandoffBudget(text)
  if (result.withinBudget) return { text, truncated: false, result }

  const head = text.slice(0, budget.maxChars * 0.7)
  return {
    text: `${head}\n\n[交接内容已随 budget 压缩：原始 ${result.lineCount} 行 / ${result.charCount} 字符超过上限，请用最精简的一句话总结已交付结果与下一步]`,
    truncated: true,
    result,
  }
}

/** 全局单例入口 */
export const handoffBudget = {
  check: checkHandoffBudget,
  enforce: enforceHandoffBudget,
}
