/**
 * Builder 候选生成的纯模板（不依赖 Electron/渠道，便于单测）。
 */

import type { BenchmarkConfig } from './types'

const BUILDER_SYSTEM_PROMPT = `你是 Agent 系统提示词优化器。基于被测 Agent 在基准评测中的表现，产出一版改进后的系统提示词（system prompt）。
要求：
- 直接输出改进后的提示词正文，不要解释、不要 markdown 围栏。
- 保留原有角色的核心职责，针对失分 Case 补强指令（明确要求、更好的输出格式指导、避免已知弱行为）。
- 保持简洁、可执行，不要堆无关规则。`

const BUILDER_USER_TEMPLATE = `当前被测子代理的系统提示词：
"""
{{prompt}}
"""

该子代理在以下基准 Case 上的评测情况（score 0-100，较低表示薄弱）：
{{casesTable}}

请产出一版改进后的系统提示词，针对低分区 Case 的失分点做强化。直接输出新提示词正文。`

/** 采样子代理定义的 Case 表现（供 Builder 参考）。 */
export interface CandidateBuilderContext {
  benchmark: BenchmarkConfig
  /** 当前被测系统提示词 */
  currentPrompt: string
  /** 各 Case 表现：caseId + score（可 null） */
  caseScores: Array<{ caseId: string; score: number | null }>
}

/** 构造 Builder 的一次调用用户消息（纯函数，便于单测）。 */
export function buildBuilderUserPrompt(ctx: CandidateBuilderContext): string {
  const rows = ctx.caseScores
    .map((c) => `- ${c.caseId}: ${c.score == null ? '评测失败' : `${c.score.toFixed(1)} / 100`}`)
    .join('\n')
  return BUILDER_USER_TEMPLATE
    .replace('{{prompt}}', ctx.currentPrompt)
    .replace('{{casesTable}}', rows || '（无 Case 数据）')
}

/** Builder 系统提示词（generateCandidatePrompt 使用）。 */
export function builderSystemPrompt(): string {
  return BUILDER_SYSTEM_PROMPT
}
