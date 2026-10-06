/**
 * 审查发现的来源归属（M7.3，纯函数无 IO）
 *
 * 方案 §6.3 与 §13.3 的硬要求：**模型意见与规则检查必须分开呈现**。
 * 二者证据强度完全不同：
 *
 * - `rule-lint`：确定性检查。有明确规则与实测值，可复核、可复现。
 *   例如「摘要 132 字 < 150 字」「引用 [3] 的 DOI 未解析」。这类发现
 *   可以断言为「检测到」。
 * - `llm-suggestion`：模型建议。可能有价值，但不可复现、不可断言为
 *   事实。因此**不得**标为 error，也不得进入"已验证"状态。
 *
 * 本模块只做归属与呈现，不做质量评分。
 */

import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'

export type ReviewCheckKind = 'rule-lint' | 'llm-suggestion'

/** 规则检查的依据：必须有可复核的规则名与实测值 */
export interface RuleLintBasis {
  rule: string
  measured: string
  expected?: string
}

/** 模型建议的依据：必须记录模型与理由，便于追溯但不声称可复现 */
export interface LlmSuggestionBasis {
  model: string
  rationale: string
  promptRef?: string
}

export interface ReviewFinding {
  id: string
  kind: ReviewCheckKind
  /** 严重度：规则检查可到 error；模型建议最高 warning */
  severity: 'error' | 'warning' | 'info'
  message: string
  location?: string
  /** 按 kind 区分依据结构 */
  basis: RuleLintBasis | LlmSuggestionBasis
  /** 创建时间 */
  createdAt: string
}

/** 模型建议允许的最高严重度（防止把模型意见呈现为确定性错误） */
export const MAX_LLM_SEVERITY = 'warning' as const

const SEVERITY_ORDER: Record<ReviewFinding['severity'], number> = {
  error: 3,
  warning: 2,
  info: 1,
}

/** 构造规则检查发现（severity 可到 error） */
export function makeRuleFinding(input: {
  id: string
  message: string
  severity?: ReviewFinding['severity']
  rule: string
  measured: string
  expected?: string
  location?: string
  createdAt?: string
}): ReviewFinding {
  if (!input.rule?.trim() || !input.measured?.trim()) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      '规则检查发现必须提供规则名与实测值（否则无法复核）',
    )
  }
  return {
    id: input.id,
    kind: 'rule-lint',
    severity: input.severity ?? 'warning',
    message: input.message,
    location: input.location,
    basis: { rule: input.rule, measured: input.measured, expected: input.expected },
    createdAt: input.createdAt ?? new Date().toISOString(),
  }
}

/**
 * 构造模型建议发现。
 *
 * 强制降级：即使调用方传入 `error`，也会被降到 `warning`——
 * 模型意见不是确定性事实，不应在界面上与规则错误同等呈现。
 */
export function makeLlmFinding(input: {
  id: string
  message: string
  model: string
  rationale: string
  severity?: ReviewFinding['severity']
  location?: string
  promptRef?: string
  createdAt?: string
}): ReviewFinding {
  if (!input.model?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '模型建议必须记录模型标识')
  }
  if (!input.rationale?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '模型建议必须给出理由，便于人工判断')
  }
  const requested = input.severity ?? 'info'
  const severity =
    SEVERITY_ORDER[requested] > SEVERITY_ORDER[MAX_LLM_SEVERITY] ? MAX_LLM_SEVERITY : requested

  return {
    id: input.id,
    kind: 'llm-suggestion',
    severity,
    message: input.message,
    location: input.location,
    basis: { model: input.model, rationale: input.rationale, promptRef: input.promptRef },
    createdAt: input.createdAt ?? new Date().toISOString(),
  }
}

/** 按来源分组（UI 分栏展示用） */
export function groupFindingsByKind(findings: ReviewFinding[]): {
  ruleLint: ReviewFinding[]
  llmSuggestions: ReviewFinding[]
} {
  return {
    ruleLint: findings.filter((f) => f.kind === 'rule-lint'),
    llmSuggestions: findings.filter((f) => f.kind === 'llm-suggestion'),
  }
}

/** 断定某条发现是否为「可断言的事实」——只有规则检查算 */
export function isAssertiveFinding(finding: ReviewFinding): boolean {
  return finding.kind === 'rule-lint'
}

/** 来源标签（UI 必须显示，避免读者混淆两类信息） */
export function findingSourceLabel(finding: ReviewFinding): string {
  if (finding.kind === 'rule-lint') {
    const basis = finding.basis as RuleLintBasis
    return `规则检查（${basis.rule}）`
  }
  const basis = finding.basis as LlmSuggestionBasis
  return `模型建议（${basis.model}）· 未经复核`
}

/** 校验一批发现：模型建议不得被标为 error */
export function assertNoLlmErrors(findings: ReviewFinding[]): void {
  const offending = findings.filter((f) => f.kind === 'llm-suggestion' && f.severity === 'error')
  if (offending.length > 0) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      `模型建议不得标为 error：${offending.map((f) => f.id).join(', ')}`,
    )
  }
}

/** 汇总计数（分别统计，不合并） */
export function summarizeFindings(findings: ReviewFinding[]): {
  ruleLint: { error: number; warning: number; info: number }
  llmSuggestions: number
} {
  const { ruleLint, llmSuggestions } = groupFindingsByKind(findings)
  return {
    ruleLint: {
      error: ruleLint.filter((f) => f.severity === 'error').length,
      warning: ruleLint.filter((f) => f.severity === 'warning').length,
      info: ruleLint.filter((f) => f.severity === 'info').length,
    },
    llmSuggestions: llmSuggestions.length,
  }
}
