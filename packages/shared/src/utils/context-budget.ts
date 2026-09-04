/** 上下文预算计算的输入。 */
export interface ContextBudgetInput {
  contextWindow: number
  inputTokens: number
  requestedOutputTokens: number
  safetyBufferTokens: number
}

/** 上下文预算计算结果。 */
export interface ContextBudget {
  inputBudgetTokens: number
  remainingInputTokens: number
  shouldCompact: boolean
}

/**
 * 计算请求可用的输入预算。
 *
 * 输出预留和安全余量从模型窗口中扣除，调用方据此在请求前决定是否压缩。
 */
export function calculateContextBudget(input: ContextBudgetInput): ContextBudget {
  const contextWindow = requireNonNegativeInteger(input.contextWindow, 'contextWindow')
  const inputTokens = requireNonNegativeInteger(input.inputTokens, 'inputTokens')
  const requestedOutputTokens = requireNonNegativeInteger(input.requestedOutputTokens, 'requestedOutputTokens')
  const safetyBufferTokens = requireNonNegativeInteger(input.safetyBufferTokens, 'safetyBufferTokens')
  const inputBudgetTokens = Math.max(0, contextWindow - requestedOutputTokens - safetyBufferTokens)

  return {
    inputBudgetTokens,
    remainingInputTokens: inputBudgetTokens - inputTokens,
    shouldCompact: inputTokens > inputBudgetTokens,
  }
}

function requireNonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} 必须是非负整数`)
  }
  return value
}
