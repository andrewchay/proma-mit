/**
 * 评测成本预估工具
 *
 * 基于 benchmark 配置和模型定价，计算 Baseline / Improve 的预估成本。
 * 价格数据来自各主流 LLM API 的公开定价（2026-08）。
 */

import type { BenchmarkConfig } from './types'

/** 模型定价信息（USD / 1M tokens） */
interface ModelPricing {
  input: number
  output: number
  /** 是否支持缓存折扣 */
  cachedInput?: number
}

/** 内置模型定价表（2026-08 参考价） */
const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-opus-4-20250514': { input: 15.0, output: 75.0 },
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'claude-haiku-4-20250514': { input: 0.8, output: 4.0 },
  'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
  // OpenAI
  'gpt-5.6': { input: 2.5, output: 10.0 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  // DeepSeek
  'deepseek-v4-flash': { input: 0.1, output: 0.3 },
  'deepseek-v4': { input: 0.5, output: 2.0 },
  'deepseek-r1': { input: 0.5, output: 2.0 },
  // Google
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
  'gemini-2.5-flash': { input: 0.15, output: 0.6 },
  // 通义千问
  'qwen3-235b-a22b': { input: 0.8, output: 2.0 },
  'qwen3-30b-a3b': { input: 0.3, output: 0.6 },
  // 豆包
  'doubao-1.5-pro-32k': { input: 0.8, output: 2.0 },
  'doubao-1.5-lite-32k': { input: 0.3, output: 0.6 },
  // 智谱
  'glm-4-plus': { input: 0.5, output: 1.0 },
  // MiniMax
  'minimax-text-01': { input: 0.2, output: 1.0 },
}

/** 通过 modelId 查找定价（支持前缀匹配） */
function findPricing(modelId: string): ModelPricing | undefined {
  // 精确匹配
  if (MODEL_PRICING[modelId]) return MODEL_PRICING[modelId]
  // 前缀匹配（如 claude-sonnet-4-20250514 匹配 claude-sonnet）
  const prefix = Object.keys(MODEL_PRICING).find((k) => modelId.startsWith(k.replace(/-\d{8}$/, '')) || modelId.includes(k.split('-')[0]!))
  return prefix ? MODEL_PRICING[prefix] : undefined
}

/** 预估单次 Case Run 的 token 消耗 */
function estimateCaseTokens(statement: string, rubricItems: number): { input: number; output: number } {
  // Statement 长度估算 input tokens（1 token ≈ 4 chars for English, 2 chars for CJK）
  const inputChars = statement.length
  const inputTokens = Math.ceil(inputChars / 3)

  // Output：rubric 项数 × 每项平均输出（评估理由 + 分数）
  const outputPerItem = 150 // tokens per rubric item
  const outputTokens = rubricItems * outputPerItem

  return {
    input: Math.max(500, inputTokens), // 最低 500 tokens（system prompt + context）
    output: Math.max(200, outputTokens),
  }
}

/** 成本预估结果 */
export interface CostEstimate {
  /** 预估总成本（USD） */
  totalUsd: number
  /** 预估 input tokens */
  inputTokens: number
  /** 预估 output tokens */
  outputTokens: number
  /** 调用次数 */
  callCount: number
  /** 是否有定价数据 */
  hasPricing: boolean
  /** 使用的模型定价（如有） */
  pricing?: ModelPricing
  /** 未定价时的保守估算（USD） */
  fallbackUsd?: number
}

/** 估算 Baseline 成本 */
export function estimateBaselineCost(benchmark: BenchmarkConfig, caseRubricItems: Record<string, number> = {}): CostEstimate {
  const pricing = findPricing(benchmark.runtime.modelId)
  const runsPerCase = benchmark.runsPerCase ?? 1
  const caseCount = benchmark.cases.length
  const totalRuns = caseCount * runsPerCase

  let totalInputTokens = 0
  let totalOutputTokens = 0

  for (const caseId of benchmark.cases) {
    const items = caseRubricItems[caseId] ?? 5 // 默认 5 项 rubric
    const tokens = estimateCaseTokens('', items) // statement 长度未知，用保守估算
    totalInputTokens += tokens.input * runsPerCase
    totalOutputTokens += tokens.output * runsPerCase
  }

  if (pricing) {
    const inputCost = (totalInputTokens / 1_000_000) * pricing.input
    const outputCost = (totalOutputTokens / 1_000_000) * pricing.output
    return {
      totalUsd: Math.round((inputCost + outputCost) * 100) / 100,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      callCount: totalRuns,
      hasPricing: true,
      pricing,
    }
  }

  // 无定价数据时的保守估算：$0.01 / run
  return {
    totalUsd: Math.round(totalRuns * 0.01 * 100) / 100,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    callCount: totalRuns,
    hasPricing: false,
    fallbackUsd: totalRuns * 0.01,
  }
}

/** 估算 Improve 成本（Baseline + 候选迭代） */
export function estimateImproveCost(benchmark: BenchmarkConfig, maxRounds: number = 2, caseRubricItems: Record<string, number> = {}): CostEstimate {
  // Improve = Baseline + 每轮重新评估所有 Case
  const baseline = estimateBaselineCost(benchmark, caseRubricItems)
  // 每轮候选评估 ≈ 一次 Baseline（重新跑所有 Case）
  const roundCost = baseline.totalUsd * maxRounds
  // Builder 候选生成：每轮一次 LLM 调用（约 2K input + 1K output）
  const builderPricing = findPricing(benchmark.runtime.modelId) ?? { input: 3.0, output: 15.0 }
  const builderCostPerRound = (2000 / 1_000_000) * builderPricing.input + (1000 / 1_000_000) * builderPricing.output
  const builderTotal = builderCostPerRound * maxRounds

  return {
    totalUsd: Math.round((baseline.totalUsd + roundCost + builderTotal) * 100) / 100,
    inputTokens: baseline.inputTokens * (1 + maxRounds) + 2000 * maxRounds,
    outputTokens: baseline.outputTokens * (1 + maxRounds) + 1000 * maxRounds,
    callCount: baseline.callCount * (1 + maxRounds) + maxRounds,
    hasPricing: baseline.hasPricing,
    pricing: baseline.pricing,
    fallbackUsd: baseline.hasPricing ? undefined : (baseline.callCount * (1 + maxRounds) + maxRounds) * 0.01,
  }
}

/** 格式化成本显示（自动切换 $/¢） */
export function formatCost(usd: number): string {
  if (usd < 0.01) return `${Math.round(usd * 100)}¢`
  if (usd < 1) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(2)}`
}

/** 格式化 token 数量 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return `${n}`
}
