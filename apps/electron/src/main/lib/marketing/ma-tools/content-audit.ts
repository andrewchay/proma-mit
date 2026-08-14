/**
 * ContentAudit - 内容审核助手（Chat Tool）
 *
 * 审核达人提交的内容（视频/图文），从合规性、品牌契合度、内容质量三个维度评分。
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@gravitas/core'
import { completePrompt, extractJSON } from './llm-service'

// =====================================================================
// 工具元数据
// =====================================================================


export const CONTENT_AUDIT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'ma_audit_content',
    description: 'Audit KOL submitted content from compliance, brand alignment, and quality dimensions. Use when the user needs to review or audit influencer content before publication, check content compliance, or evaluate brand fit.',
    parameters: {
      type: 'object',
      properties: {
        brand: { type: 'string', description: 'Brand name' },
        product: { type: 'string', description: 'Product name' },
        platform: { type: 'string', description: 'Platform (xiaohongshu/douyin/bilibili/weibo/kuaishou)' },
        content_type: { type: 'string', description: 'Content type (video/image_text/live)' },
        content_description: { type: 'string', description: 'Content description or script text' },
        kol_id: { type: 'string', description: 'KOL ID (optional, for CRM linkage)' },
        content_url: { type: 'string', description: 'Content URL (optional)' },
      },
      required: ['brand', 'product', 'content_description'],
    },
  },
]

// =====================================================================
// 工具执行
// =====================================================================



export async function executeContentAuditTool(toolCall: ToolCall): Promise<ToolResult> {
  try {
    const args = toolCall.arguments as Record<string, unknown>
    const brand = String(args.brand ?? '')
    const product = String(args.product ?? '')
    const contentDescription = String(args.content_description ?? '')

    if (!brand || !product || !contentDescription) {
      return { toolCallId: toolCall.id, content: '参数缺失: brand、product 和 content_description 为必填项', isError: true }
    }

    const platform = String(args.platform ?? '小红书')
    const contentType = String(args.content_type ?? '图文')
    const kolId = String(args.kol_id ?? '')
    const contentUrl = String(args.content_url ?? '')

    const systemPrompt = `你是一位资深的内容审核专家，曾在大型 MCN 机构和品牌方担任内容风控总监。

请基于品牌需求和平台特性，对达人提交的内容进行多维度审核评估。

**审核维度：**
1. **合规性检查**：广告法合规、平台规范、虚假宣传风险、违禁词检测
2. **品牌契合度**：品牌信息准确性、产品卖点传达、品牌调性一致性
3. **内容质量**：创意水平、用户吸引力、内容结构、互动引导

**输出格式（严格 JSON）：**
{
  "audit_summary": "审核结论：通过/需修改/不通过",
  "compliance_check": {
    "score": 85,
    "issues": ["问题1", "问题2"],
    "suggestions": ["建议1"]
  },
  "brand_alignment": {
    "score": 90,
    "matches": ["符合点1"],
    "mismatches": ["不符合点1"]
  },
  "quality_assessment": {
    "score": 88,
    "strengths": ["优点1"],
    "weaknesses": ["不足1"]
  },
  "revision_suggestions": ["具体修改建议1", "修改建议2"],
  "overall_score": 88,
  "final_verdict": "通过，建议微调"
}

评分标准（0-100分）：
- 90-100：优秀，可直接发布
- 70-89：良好，需微调后发布
- 50-69：一般，需修改后重新审核
- 0-49：不合格，需大幅修改或拒绝`

    const userPrompt = buildAuditPrompt({
      brand, product, platform, contentType, contentDescription, kolId, contentUrl,
    })

    const result = await completePrompt(userPrompt, systemPrompt, {
      jsonMode: true,
      temperature: 0.5,
      maxTokens: 6000,
    })

    if (!result.success) {
      return { toolCallId: toolCall.id, content: `内容审核失败: ${result.error}`, isError: true }
    }

    let audit: Record<string, unknown>
    try {
      audit = extractJSON(result.text) as Record<string, unknown>
    } catch {
      return { toolCallId: toolCall.id, content: formatAuditText(result.text, brand, product, platform) }
    }

    const formatted = formatAuditResult(audit, brand, product, platform, contentType, kolId)
    return { toolCallId: toolCall.id, content: formatted }

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[ContentAudit] 执行失败:', error)
    return { toolCallId: toolCall.id, content: `内容审核错误: ${msg}`, isError: true }
  }
}

// =====================================================================
// Prompt 构建
// =====================================================================

function buildAuditPrompt(params: {
  brand: string
  product: string
  platform: string
  contentType: string
  contentDescription: string
  kolId: string
  contentUrl: string
}): string {
  const parts: string[] = [
    `请对以下内容进行审核评估：`,
    ``,
    `品牌：${params.brand}`,
    `产品：${params.product}`,
    `平台：${params.platform}`,
    `内容类型：${params.contentType}`,
  ]

  if (params.kolId) parts.push(`达人ID：${params.kolId}`)
  if (params.contentUrl) parts.push(`内容链接：${params.contentUrl}`)

  parts.push(``)
  parts.push(`内容描述/脚本：`)
  parts.push('```')
  parts.push(params.contentDescription)
  parts.push('```')

  parts.push(``)
  parts.push(`请从合规性、品牌契合度、内容质量三个维度进行详细审核，给出评分和具体修改建议。`)

  return parts.join('\n')
}

// =====================================================================
// 结果格式化
// =====================================================================

function formatAuditResult(
  audit: Record<string, unknown>,
  brand: string,
  product: string,
  platform: string,
  contentType: string,
  kolId: string,
): string {
  const parts: string[] = []

  // 标题
  parts.push(`# ${brand} · ${product} — ${platform} ${contentType} 内容审核报告`)
  if (kolId) parts.push(`*达人ID：${kolId}*`)
  parts.push('')

  // 审核结论
  const summary = audit.audit_summary as string | undefined
  const overallScore = audit.overall_score as number | undefined
  const finalVerdict = audit.final_verdict as string | undefined

  if (summary || overallScore !== undefined || finalVerdict) {
    parts.push(`## 📋 审核结论`)
    if (summary) parts.push(`**审核结果**：${summary}`)
    if (overallScore !== undefined) parts.push(`**综合评分**：${overallScore}/100`)
    if (finalVerdict) parts.push(`**最终判定**：${finalVerdict}`)
    parts.push('')
  }

  // 合规性检查
  const compliance = audit.compliance_check as Record<string, unknown> | undefined
  if (compliance) {
    parts.push(`## ⚖️ 合规性检查`)
    const score = compliance.score as number | undefined
    if (score !== undefined) parts.push(`**评分**：${score}/100`)

    const issues = compliance.issues as string[] | undefined
    if (issues && issues.length > 0) {
      parts.push(`**问题清单**：`)
      for (const issue of issues) parts.push(`  - ❌ ${issue}`)
    }

    const suggestions = compliance.suggestions as string[] | undefined
    if (suggestions && suggestions.length > 0) {
      parts.push(`**改进建议**：`)
      for (const s of suggestions) parts.push(`  - 💡 ${s}`)
    }
    parts.push('')
  }

  // 品牌契合度
  const brandAlignment = audit.brand_alignment as Record<string, unknown> | undefined
  if (brandAlignment) {
    parts.push(`## 🏷️ 品牌契合度`)
    const score = brandAlignment.score as number | undefined
    if (score !== undefined) parts.push(`**评分**：${score}/100`)

    const matches = brandAlignment.matches as string[] | undefined
    if (matches && matches.length > 0) {
      parts.push(`**契合点**：`)
      for (const m of matches) parts.push(`  - ✅ ${m}`)
    }

    const mismatches = brandAlignment.mismatches as string[] | undefined
    if (mismatches && mismatches.length > 0) {
      parts.push(`**不符合点**：`)
      for (const m of mismatches) parts.push(`  - ⚠️ ${m}`)
    }
    parts.push('')
  }

  // 内容质量
  const quality = audit.quality_assessment as Record<string, unknown> | undefined
  if (quality) {
    parts.push(`## ✨ 内容质量评估`)
    const score = quality.score as number | undefined
    if (score !== undefined) parts.push(`**评分**：${score}/100`)

    const strengths = quality.strengths as string[] | undefined
    if (strengths && strengths.length > 0) {
      parts.push(`**优点**：`)
      for (const s of strengths) parts.push(`  - ⭐ ${s}`)
    }

    const weaknesses = quality.weaknesses as string[] | undefined
    if (weaknesses && weaknesses.length > 0) {
      parts.push(`**不足**：`)
      for (const w of weaknesses) parts.push(`  - 🔧 ${w}`)
    }
    parts.push('')
  }

  // 修改建议
  const revisions = audit.revision_suggestions as string[] | undefined
  if (revisions && revisions.length > 0) {
    parts.push(`## 📝 具体修改建议`)
    for (let i = 0; i < revisions.length; i++) {
      parts.push(`${i + 1}. ${revisions[i]}`)
    }
    parts.push('')
  }

  // 评分参考
  parts.push(`---`)
  parts.push(`**评分参考**：`)
  parts.push(`- 90-100分：优秀，可直接发布`)
  parts.push(`- 70-89分：良好，需微调后发布`)
  parts.push(`- 50-69分：一般，需修改后重新审核`)
  parts.push(`- 0-49分：不合格，需大幅修改或拒绝`)
  parts.push('')

  return parts.join('\n')
}

function formatAuditText(text: string, brand: string, product: string, platform: string): string {
  return `# ${brand} · ${product} — ${platform} 内容审核\n\n${text}`
}

// =====================================================================
// 可复用审核函数（供 Campaign 管理流程调用）
// =====================================================================

export interface ContentAuditParams {
  brand: string
  product: string
  platform: string
  contentType: string
  contentDescription: string
  kolId: string
  contentUrl: string
}

export interface ContentAuditResult {
  success: boolean
  auditSummary?: string
  complianceScore?: number
  brandAlignmentScore?: number
  qualityScore?: number
  overallScore?: number
  finalVerdict?: string
  report?: string
  error?: string
}

/** 执行内容审核（不依赖 ToolCall，直接调用 LLM） */
export async function runContentAudit(params: ContentAuditParams): Promise<ContentAuditResult> {
  try {
    const systemPrompt = `你是一位资深的内容审核专家，曾在大型 MCN 机构和品牌方担任内容风控总监。

请基于品牌需求和平台特性，对达人提交的内容进行多维度审核评估。

**审核维度：**
1. **合规性检查**：广告法合规、平台规范、虚假宣传风险、违禁词检测
2. **品牌契合度**：品牌信息准确性、产品卖点传达、品牌调性一致性
3. **内容质量**：创意水平、用户吸引力、内容结构、互动引导

**输出格式（严格 JSON）：**
{
  "audit_summary": "审核结论：通过/需修改/不通过",
  "compliance_check": {
    "score": 85,
    "issues": ["问题1", "问题2"],
    "suggestions": ["建议1"]
  },
  "brand_alignment": {
    "score": 90,
    "matches": ["符合点1"],
    "mismatches": ["不符合点1"]
  },
  "quality_assessment": {
    "score": 88,
    "strengths": ["优点1"],
    "weaknesses": ["不足1"]
  },
  "revision_suggestions": ["具体修改建议1", "修改建议2"],
  "overall_score": 88,
  "final_verdict": "通过，建议微调"
}

评分标准（0-100分）：
- 90-100：优秀，可直接发布
- 70-89：良好，需微调后发布
- 50-69：一般，需修改后重新审核
- 0-49：不合格，需大幅修改或拒绝`

    const userPrompt = buildAuditPrompt(params)

    const result = await completePrompt(userPrompt, systemPrompt, {
      jsonMode: true,
      temperature: 0.5,
      maxTokens: 6000,
    })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    let audit: Record<string, unknown>
    try {
      audit = extractJSON(result.text) as Record<string, unknown>
    } catch {
      return { success: false, error: '无法解析 AI 审核结果' }
    }

    const overallScore = audit.overall_score as number | undefined
    const complianceScore = (audit.compliance_check as Record<string, unknown> | undefined)?.score as number | undefined
    const brandAlignmentScore = (audit.brand_alignment as Record<string, unknown> | undefined)?.score as number | undefined
    const qualityScore = (audit.quality_assessment as Record<string, unknown> | undefined)?.score as number | undefined
    const finalVerdict = audit.final_verdict as string | undefined
    const auditSummary = audit.audit_summary as string | undefined

    const report = formatAuditResult(
      audit,
      params.brand,
      params.product,
      params.platform,
      params.contentType,
      params.kolId,
    )

    return {
      success: true,
      auditSummary,
      complianceScore: complianceScore ?? 0,
      brandAlignmentScore: brandAlignmentScore ?? 0,
      qualityScore: qualityScore ?? 0,
      overallScore: overallScore ?? 0,
      finalVerdict,
      report,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { success: false, error: msg }
  }
}