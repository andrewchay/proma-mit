/**
 * CreativePilot - 创意内容指导助手（Chat Tool）
 *
 * 为 KOL 内容创作提供个性化 Brief、脚本建议和合规审核。
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@gravitas/core'
import { completePrompt, extractJSON } from './llm-service'
import platformGuidelines from './knowledge/platform-guidelines.json'
import industryTemplates from './knowledge/industry-templates.json'

// =====================================================================
// 工具元数据
// =====================================================================


export const CREATIVE_PILOT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'ma_generate_creative_brief',
    description: 'Generate personalized creative brief and content guidelines for KOL cooperation. Includes platform-specific content templates, script suggestions, visual direction, and compliance checklist. Use when the user needs content creation guidance, KOL brief generation, or content compliance review.',
    parameters: {
      type: 'object',
      properties: {
        brand: { type: 'string', description: 'Brand name' },
        product: { type: 'string', description: 'Product name' },
        platform: { type: 'string', description: 'Content platform (xiaohongshu/douyin/bilibili/weibo/kuaishou/tiktok/instagram/youtube)' },
        kol_style: { type: 'string', description: 'KOL style (professional/entertainment/lifestyle/review)' },
        campaign_goal: { type: 'string', description: 'Campaign goal' },
        key_messages: { type: 'string', description: 'Key messages, comma separated' },
        must_include: { type: 'string', description: 'Must-include elements, comma separated' },
        forbidden: { type: 'string', description: 'Forbidden content, comma separated' },
        target_audience: { type: 'string', description: 'Target audience' },
        industry: { type: 'string', description: 'Industry category' },
      },
      required: ['brand', 'product', 'platform'],
    },
  },
]

// =====================================================================
// 工具执行
// =====================================================================



export async function executeCreativePilotTool(toolCall: ToolCall): Promise<ToolResult> {
  try {
    const args = toolCall.arguments as Record<string, unknown>
    const brand = String(args.brand ?? '')
    const product = String(args.product ?? '')
    const platform = String(args.platform ?? '')

    if (!brand || !product || !platform) {
      return { toolCallId: toolCall.id, content: '参数缺失: brand、product 和 platform 为必填项', isError: true }
    }

    const kolStyle = String(args.kol_style ?? 'professional')
    const campaignGoal = String(args.campaign_goal ?? '品牌曝光')
    const keyMessages = String(args.key_messages ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const mustInclude = String(args.must_include ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const forbidden = String(args.forbidden ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const targetAudience = String(args.target_audience ?? '')
    const industry = String(args.industry ?? '通用')

    // 加载平台规范
    const guidelines = (platformGuidelines as Record<string, Record<string, unknown>>)[platform] ?? {}

    // 加载行业模板
    const template = getIndustryTemplate(industry, platform)
    const finalMustInclude = [...mustInclude, ...((template.creative_must_include as string[] | undefined) ?? [])]
    const finalForbidden = [...forbidden, ...((template.creative_forbidden as string[] | undefined) ?? [])]

    const systemPrompt = `你是一位资深的内容创意总监，曾在顶尖 MCN 和内容营销公司任职。

请基于品牌需求和平台特性，生成一份详细的 KOL 内容创作 Brief。

**输出格式（严格 JSON）：**
{
  "project_overview": "项目概述",
  "content_strategy": {
    "core_message": "核心传播信息",
    "content_angle": "内容切入角度",
    "emotional_appeal": "情感诉求点",
    "story_framework": "故事框架建议"
  },
  "creative_elements": {
    "visual_direction": "视觉指导",
    "tone_voice": "语气语调",
    "key_phrases": ["关键词1", "关键词2"],
    "hashtag_strategy": "标签策略"
  },
  "execution_guide": {
    "opening_hook": "开头抓人技巧",
    "content_flow": "内容流程建议",
    "cta": "行动号召设计",
    "engagement_tactics": "互动引导技巧"
  },
  "platform_specific": "平台特殊要求",
  "brand_integration": "品牌植入建议",
  "kol_adaptation": {
    "style_alignment": "如何贴合KOL调性",
    "dos": ["建议做法1"],
    "donts": ["避免事项1"]
  },
  "compliance_notes": "合规注意事项",
  "reference_script": "参考脚本/文案"
}`

    const userPrompt = buildCreativePrompt({
      brand, product, platform, kolStyle, campaignGoal,
      keyMessages, mustInclude: finalMustInclude, forbidden: finalForbidden,
      targetAudience, industry, guidelines,
    })

    const result = await completePrompt(userPrompt, systemPrompt, {
      jsonMode: true,
      temperature: 0.7,
      maxTokens: 6000,
    })

    if (!result.success) {
      return { toolCallId: toolCall.id, content: `创意 Brief 生成失败: ${result.error}`, isError: true }
    }

    let brief: Record<string, unknown>
    try {
      brief = extractJSON(result.text) as Record<string, unknown>
    } catch {
      return { toolCallId: toolCall.id, content: formatCreativeText(result.text, brand, platform) }
    }

    const formatted = formatCreativeResult(brief, brand, product, platform, guidelines)
    return { toolCallId: toolCall.id, content: formatted }

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[CreativePilot] 执行失败:', error)
    return { toolCallId: toolCall.id, content: `创意 Brief 生成错误: ${msg}`, isError: true }
  }
}

// =====================================================================
// Prompt 构建
// =====================================================================

function buildCreativePrompt(params: {
  brand: string
  product: string
  platform: string
  kolStyle: string
  campaignGoal: string
  keyMessages: string[]
  mustInclude: string[]
  forbidden: string[]
  targetAudience: string
  industry: string
  guidelines: Record<string, unknown>
}): string {
  const parts: string[] = [
    `请为以下品牌生成 KOL 内容创作 Brief：`,
    ``,
    `品牌：${params.brand}`,
    `产品：${params.product}`,
    `平台：${params.platform}`,
    `KOL风格：${params.kolStyle}`,
    `活动目标：${params.campaignGoal}`,
  ]

  if (params.keyMessages.length > 0) parts.push(`关键信息：${params.keyMessages.join('、')}`)
  if (params.mustInclude.length > 0) parts.push(`必须包含：${params.mustInclude.join('、')}`)
  if (params.forbidden.length > 0) parts.push(`禁止事项：${params.forbidden.join('、')}`)
  if (params.targetAudience) parts.push(`目标受众：${params.targetAudience}`)
  if (params.industry) parts.push(`行业：${params.industry}`)

  parts.push(`\n平台规范参考：`)
  parts.push('```json')
  parts.push(JSON.stringify(params.guidelines, null, 2))
  parts.push('```')

  parts.push(`\n请生成详细的创意 Brief，包含具体的脚本建议。`)
  return parts.join('\n')
}

// =====================================================================
// 行业模板辅助
// =====================================================================

function getIndustryTemplate(industry: string, platform: string): Record<string, unknown> {
  const templates = industryTemplates as Record<string, Record<string, unknown>>
  const specific = templates[industry] ?? templates['通用'] ?? {}
  return specific
}

// =====================================================================
// 结果格式化
// =====================================================================

function formatCreativeResult(
  brief: Record<string, unknown>,
  brand: string,
  product: string,
  platform: string,
  guidelines: Record<string, unknown>,
): string {
  const parts: string[] = []
  parts.push(`# ${brand} · ${product} — ${platform} 内容创作 Brief`)
  parts.push('')

  // 项目概述
  const overview = brief.project_overview as string | undefined
  if (overview) {
    parts.push(`## 📋 项目概述`)
    parts.push(overview)
    parts.push('')
  }

  // 内容策略
  const strategy = brief.content_strategy as Record<string, unknown> | undefined
  if (strategy) {
    parts.push(`## 🎯 内容策略`)
    if (strategy.core_message) parts.push(`- **核心信息**：${strategy.core_message}`)
    if (strategy.content_angle) parts.push(`- **切入角度**：${strategy.content_angle}`)
    if (strategy.emotional_appeal) parts.push(`- **情感诉求**：${strategy.emotional_appeal}`)
    if (strategy.story_framework) parts.push(`- **故事框架**：${strategy.story_framework}`)
    parts.push('')
  }

  // 创意元素
  const elements = brief.creative_elements as Record<string, unknown> | undefined
  if (elements) {
    parts.push(`## ✨ 创意元素`)
    if (elements.visual_direction) parts.push(`- **视觉方向**：${elements.visual_direction}`)
    if (elements.tone_voice) parts.push(`- **语气语调**：${elements.tone_voice}`)
    const phrases = elements.key_phrases as string[] | undefined
    if (phrases && phrases.length > 0) parts.push(`- **关键词**：${phrases.join('、')}`)
    if (elements.hashtag_strategy) parts.push(`- **标签策略**：${elements.hashtag_strategy}`)
    parts.push('')
  }

  // 执行指南
  const guide = brief.execution_guide as Record<string, unknown> | undefined
  if (guide) {
    parts.push(`## 📝 执行指南`)
    if (guide.opening_hook) parts.push(`- **开头钩子**：${guide.opening_hook}`)
    if (guide.content_flow) parts.push(`- **内容流程**：${guide.content_flow}`)
    if (guide.cta) parts.push(`- **CTA设计**：${guide.cta}`)
    if (guide.engagement_tactics) parts.push(`- **互动技巧**：${guide.engagement_tactics}`)
    parts.push('')
  }

  // 平台特殊要求
  if (brief.platform_specific) {
    parts.push(`## 📱 ${platform} 平台特殊要求`)
    parts.push(String(brief.platform_specific))
    parts.push('')
  }

  // 品牌植入
  if (brief.brand_integration) {
    parts.push(`## 🏷️ 品牌植入建议`)
    parts.push(String(brief.brand_integration))
    parts.push('')
  }

  // KOL 适配
  const adaptation = brief.kol_adaptation as Record<string, unknown> | undefined
  if (adaptation) {
    parts.push(`## 🎭 KOL 调性适配`)
    if (adaptation.style_alignment) parts.push(`- **调性对齐**：${adaptation.style_alignment}`)
    const dos = adaptation.dos as string[] | undefined
    if (dos && dos.length > 0) {
      parts.push(`- **建议做法**：`)
      for (const d of dos) parts.push(`  - ✅ ${d}`)
    }
    const donts = adaptation.donts as string[] | undefined
    if (donts && donts.length > 0) {
      parts.push(`- **避免事项**：`)
      for (const d of donts) parts.push(`  - ❌ ${d}`)
    }
    parts.push('')
  }

  // 合规
  if (brief.compliance_notes) {
    parts.push(`## ⚖️ 合规注意事项`)
    parts.push(String(brief.compliance_notes))
    parts.push('')
  }

  // 参考脚本
  if (brief.reference_script) {
    parts.push(`## 🎬 参考脚本/文案`)
    parts.push('```')
    parts.push(String(brief.reference_script))
    parts.push('```')
    parts.push('')
  }

  // 平台规范附录
  if (Object.keys(guidelines).length > 0) {
    parts.push(`---`)
    parts.push(`## 📎 ${platform} 平台规范速查`)

    const hooks = guidelines.hook_templates as string[] | undefined
    if (hooks && hooks.length > 0) {
      parts.push(`**钩子模板**：`)
      for (const h of hooks.slice(0, 5)) parts.push(`- ${h}`)
    }

    const structure = guidelines.video_structure as string[] | undefined
    if (structure && structure.length > 0) {
      parts.push(`**内容结构**：`)
      for (const s of structure) parts.push(`- ${s}`)
    }

    if (guidelines.optimal_length) {
      parts.push(`**建议时长/字数**：${guidelines.optimal_length}`)
    }

    if (guidelines.hashtag_strategy) {
      parts.push(`**标签策略**：${guidelines.hashtag_strategy}`)
    }

    const forbidden = guidelines.forbidden_words as string[] | undefined
    if (forbidden && forbidden.length > 0) {
      parts.push(`**禁用词**：${forbidden.join('、')}`)
    }

    parts.push('')
  }

  return parts.join('\n')
}

function formatCreativeText(text: string, brand: string, platform: string): string {
  return `# ${brand} — ${platform} 创意 Brief\n\n${text}`
}
