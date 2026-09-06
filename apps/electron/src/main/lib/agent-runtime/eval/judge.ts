/**
 * LLM Judge：内置的独立评判打分器。
 *
 * 综述基准（arXiv:2607.13104 §8.1.2）：驱动更新的 judge 与报告终值的 judge 必须独立，
 * 否则系统会过优化到评判的潜在偏差（自我确认循环）。本模块提供生产可用的 LLM judge
 * 工厂：用 benchmark.judgeRuntime 指定的渠道/模型，按 Case 私有 rubric 逐项评分，
 * 输出 0..100 总分。
 *
 * 设计要点：
 * - 复用 builder.ts 的 `runPlainPrompt`（纯文本调用，不进评测沙箱）。
 * - 输出协议：要求 judge 在最后一行输出 `{"score": N}`，解析失败返回 null（调用方回退规则打分）。
 * - 本模块只被 eval-service 引用；eval-runner 不反向依赖，避免运行时循环。
 */

import type { EvalChannelInfo } from './eval-runner'
import { runPlainPrompt } from './builder'
import type { ScoreDelegate } from './evaluator'
import type { JudgeBudget, Rubric } from './types'

/** judge 系统提示：逐项对照 rubric 评分，最后一行输出 JSON。 */
function judgeSystemPrompt(): string {
  return [
    '你是一个严格、公正的评审者。你的任务是根据评分标准（rubric）评估一个 Agent 对任务的回答质量。',
    '规则：',
    '1. 逐项对照 rubric 的每个评分项，判断回答是否满足其判定标准，给出该项得分（0 或满分）。',
    '2. 评分只依据回答的实际内容与证据，不因回答提及了某个关键词就施舍分数。',
    '3. 全部项目评分完毕后，在回答的最后一行、且仅在最后一行，输出总分 JSON：{"score": N}',
    '   其中 N 是各项得分之和（0 到 100 的整数）。不要在 JSON 之后输出任何内容。',
  ].join('\n')
}

/** judge 用户提示：任务描述 + rubric + 被测输出。 */
function buildJudgeUserPrompt(input: { rubric: Rubric; statement: string; agentOutput: string }): string {
  const items = input.rubric.items
    .map((it) => `- ${it.name}（${it.points} 分）：${it.check}`)
    .join('\n')
  return [
    '## 任务描述（statement）',
    input.statement,
    '',
    '## 评分标准（rubric，总分 100）',
    items,
    '',
    '## 被测 Agent 的回答',
    input.agentOutput,
    '',
    '请逐项评分，并在最后一行输出 {"score": N}。',
  ].join('\n')
}

/**
 * 解析 judge 输出文本中的总分（纯函数，可单测）。
 *
 * 优先解析最后一行的 `{"score": N}` JSON；找不到时接受最后一行裸数字。
 * 结果 clamp 到 0..100；完全无法解析返回 null（调用方回退规则打分）。
 */
export function parseJudgeScore(text: string): number | null {
  if (!text) return null
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  // 从末尾向前找：先 JSON {"score": N}
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    const match = line.match(/\{\s*"score"\s*:\s*(-?\d+(?:\.\d+)?)\s*\}/)
    if (match) {
      return clampScore(Number(match[1]))
    }
  }
  // 退化为最后一行裸数字
  const last = lines[lines.length - 1]
  if (last && /^-?\d+(?:\.\d+)?$/.test(last)) {
    return clampScore(Number(last))
  }
  return null
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

/**
 * 给任意 ScoreDelegate 套上预算隔离（纯包装，可单测）：
 * - maxCalls：单次评测闭环内 judge 最大调用次数（独立计费桶的最小形态）；
 *   超限后短路返回 null（computeScores 回退规则打分），并 warn 一次。
 * - maxPromptChars：被测输出截断上限（max tokens 的代理），防超长输出烧 judge 额度。
 *
 * 计数器在闭包内：每次 runBaseline/runImprove 新建 delegate 即重置。
 */
export function withJudgeBudget(delegate: ScoreDelegate, budget?: JudgeBudget): ScoreDelegate {
  if (!budget || (budget.maxCalls == null && budget.maxPromptChars == null)) return delegate
  let calls = 0
  let warned = false
  return async (input) => {
    if (budget.maxCalls != null && calls >= budget.maxCalls) {
      if (!warned) {
        warned = true
        console.warn(`[Eval] judge 预算耗尽（maxCalls=${budget.maxCalls}），后续 Case 回退规则打分`)
      }
      return null
    }
    calls++
    const capped = budget.maxPromptChars != null && input.agentOutput.length > budget.maxPromptChars
      ? { ...input, agentOutput: input.agentOutput.slice(0, budget.maxPromptChars) + '\n（输出过长，已截断）' }
      : input
    return delegate(capped)
  }
}

/**
 * 生成 LLM judge 的 ScoreDelegate：用指定渠道按 rubric 打分。
 * judge 调用失败或输出无法解析时返回 null（computeScores 会回退规则打分）。
 * 传入 budget 时自动套预算隔离。
 */
export function buildLlmJudgeScoreDelegate(channel: EvalChannelInfo, budget?: JudgeBudget): ScoreDelegate {
  const base: ScoreDelegate = async (input) => {
    try {
      const out = await runPlainPrompt(channel, judgeSystemPrompt(), buildJudgeUserPrompt(input))
      return parseJudgeScore(out)
    } catch {
      return null
    }
  }
  return withJudgeBudget(base, budget)
}
