/**
 * 奥格威五维评分引擎（本地规则兜底）
 *
 * 从 ma-proma server 版 content-audit-service 移植的纯函数部分：
 * 当 LLM 审核不可用或只产出三维分数时，用确定性规则补算
 * 品牌形象一致性与数据可验证性两个维度，并按奥格威权重加权总分：
 *   合规 20% + 品牌契合 25% + 内容质量 25% + 品牌形象 20% + 数据可验证 10%
 *
 * 这些规则只证明"引用/特征存在"，不证明成果内容质量。
 */

import type { ContentAudit, CreateContentAuditInput } from '@gravitas/shared'

export interface RuleBasedScores {
  complianceScore: number
  brandAlignmentScore: number
  qualityScore: number
  brandImageScore: number
  dataVerifiabilityScore: number
  overallScore: number
}

export function normalizeScore(value: unknown): number {
  if (value == null) return 0
  const n = Number(value)
  if (Number.isNaN(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

export function determineStatus(overallScore: number): ContentAudit['auditStatus'] {
  if (overallScore >= 70) return 'passed'
  if (overallScore >= 50) return 'reviewing'
  return 'failed'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 计算本地规则下的五维分数（奥格威加权） */
export function evaluateWithRules(input: CreateContentAuditInput): RuleBasedScores {
  const desc = input.contentDescription
  const brand = input.brand
  const length = desc.length

  // === 1. 合规性：检测常见风险词与长度 (20%) ===
  const riskWords = ['最', '第一', '国家级', '纯天然', '无副作用', '绝对', '保证治愈', '限时']
  const riskCount = riskWords.reduce((sum, word) => sum + (desc.includes(word) ? 1 : 0), 0)
  const complianceScore = Math.max(0, 100 - riskCount * 15)

  // === 2. 品牌契合：品牌名出现次数与产品关联 (25%) ===
  const brandCount = brand ? (desc.match(new RegExp(escapeRegExp(brand), 'g')) ?? []).length : 0
  const hasKeyMessage = input.keyMessage ? desc.includes(input.keyMessage.slice(0, 10)) : false
  const brandAlignmentScore = Math.min(100, 30 + brandCount * 15 + (desc.includes(input.product) ? 20 : 0) + (hasKeyMessage ? 25 : 0))

  // === 3. 内容质量：基于长度与结构 (25%) ===
  const hasStructure = /[\n\r]/.test(desc) || /[一二三四五六七八九十]/.test(desc)
  const hasDataEvidence = /\d+%?|\d+\.?\d*|第[一二三四五六七八九十\d]+|研究发现|数据显示|实验证明/.test(desc)
  const qualityScore = Math.min(100, Math.max(30, Math.round(length / 5) + (hasStructure ? 15 : 0) + (hasDataEvidence ? 20 : 0)))

  // === 4. 品牌形象一致性：调性/视觉/人格匹配 (20%) ===
  let brandImageScore = 60 // 基础分
  if (input.brandPersona) {
    const personaLower = input.brandPersona.toLowerCase()
    const descLower = desc.toLowerCase()
    if (personaLower.includes('专业') && /专家|医生|研发|科学|成分|功效/.test(descLower)) brandImageScore += 15
    if (personaLower.includes('潮流') && /时尚|种草|必入|神仙|yyds/.test(descLower)) brandImageScore += 15
    if (personaLower.includes('温暖') && /贴心|安心|守护|陪伴|温柔/.test(descLower)) brandImageScore += 15
    if (personaLower.includes('高端') && /奢华|精致|匠心|限量|尊贵/.test(descLower)) brandImageScore += 15
  }
  if (input.visualGuidelines) brandImageScore += 5
  brandImageScore = Math.min(100, brandImageScore)

  // === 5. 数据可验证性：前置洞察支撑 (10%) ===
  let dataVerifiabilityScore = 50
  if (input.dataSupport && input.dataSupport.length > 10) dataVerifiabilityScore += 25
  if (input.benchmarkData && input.benchmarkData.length > 10) dataVerifiabilityScore += 15
  if (hasDataEvidence) dataVerifiabilityScore += 10
  dataVerifiabilityScore = Math.min(100, dataVerifiabilityScore)

  // === 总分：奥格威加权 ===
  const overallScore = Math.round(
    complianceScore * 0.20 +
    brandAlignmentScore * 0.25 +
    qualityScore * 0.25 +
    brandImageScore * 0.20 +
    dataVerifiabilityScore * 0.10
  )

  return { complianceScore, brandAlignmentScore, qualityScore, brandImageScore, dataVerifiabilityScore, overallScore }
}
