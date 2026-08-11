/**
 * StrategyIQ - 策略理解与生成引擎（Chat Tool）
 *
 * 自动解析客户需求，生成完整的社交营销策略提案。
 * 复用 MAPro 的 Provider 适配器进行 LLM 调用。
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@gravitas/core'
import type { ChatToolMeta } from '@gravitas/shared'
import { completePrompt, extractJSON } from './llm-service'
import industryTemplates from './knowledge/industry-templates.json'
import casePlaybooks from './knowledge/case-playbooks.json'

// =====================================================================
// 工具元数据
// =====================================================================

export const STRATEGY_IQ_TOOL_META: ChatToolMeta = {
  id: 'ma-strategy-iq',
  name: 'MA策略生成',
  description: '解析品牌Brief并生成完整的社交营销策略提案，包括平台矩阵、KOL策略、内容规划和KPI设定',
  params: [
    { name: 'brand', type: 'string', description: '品牌名称', required: true },
    { name: 'product', type: 'string', description: '产品名称/系列', required: true },
    { name: 'industry', type: 'string', description: '行业类别（美妆/3C/快消/母婴/时尚/食品/运动鞋服/宠物科技等）', required: false },
    { name: 'goal', type: 'string', description: '营销目标（品牌曝光/产品认知/种草/转化/销售）', required: false },
    { name: 'budget', type: 'string', description: '预算范围（如：100万、50-80万）', required: false },
    { name: 'timeline', type: 'string', description: '执行周期（如：2026年6月-8月）', required: false },
    { name: 'target_audience', type: 'string', description: '目标受众描述', required: false },
    { name: 'key_messages', type: 'string', description: '关键传播信息，逗号分隔', required: false },
    { name: 'preferred_platforms', type: 'string', description: '首选平台，逗号分隔（小红书/抖音/B站/微博/快手）', required: false },
    { name: 'is_overseas', type: 'boolean', description: '是否海外投放', required: false },
  ],
  icon: 'Brain',
  category: 'builtin',
  executorType: 'builtin',
  systemPromptAppend: `
<ma_strategy_iq_instructions>
你拥有 **MA策略生成** 能力（StrategyIQ）。

**ma_generate_strategy — 生成社交营销策略：**
当用户需要制定营销方案、解析Brief、规划传播策略时调用：
- 品牌新品上市推广方案
- 社交平台营销规划
- KOL合作策略
- 内容创意方向
- 预算分配建议

工具会返回结构化的策略提案，包含：平台矩阵、KOL配比、内容规划、KPI等。
</ma_strategy_iq_instructions>`,
}

export const STRATEGY_IQ_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'ma_generate_strategy',
    description: 'Generate a comprehensive social media marketing strategy proposal based on brand brief. Includes platform matrix, KOL strategy, content plan, and KPIs. Use when the user wants to create a marketing plan, campaign strategy, or KOL cooperation plan.',
    parameters: {
      type: 'object',
      properties: {
        brand: { type: 'string', description: 'Brand name' },
        product: { type: 'string', description: 'Product name or series' },
        industry: { type: 'string', description: 'Industry category (beauty/3C/FMCG/mother-baby/fashion/food/sportswear/pet-tech etc.)' },
        goal: { type: 'string', description: 'Marketing goal (brand awareness/product awareness/seedling/conversion/sales)' },
        budget: { type: 'string', description: 'Budget range (e.g., 1M, 500k-800k)' },
        timeline: { type: 'string', description: 'Campaign timeline (e.g., June-August 2026)' },
        target_audience: { type: 'string', description: 'Target audience description' },
        key_messages: { type: 'string', description: 'Key messages, comma separated' },
        preferred_platforms: { type: 'string', description: 'Preferred platforms, comma separated (xiaohongshu/douyin/bilibili/weibo/kuaishou)' },
        is_overseas: { type: 'boolean', description: 'Whether overseas campaign' },
      },
      required: ['brand', 'product'],
    },
  },
]

// =====================================================================
// 可用性检查
// =====================================================================

export function isStrategyIQAvailable(): boolean {
  // 只要有配置好的渠道即可使用
  return true
}

// =====================================================================
// 工具执行
// =====================================================================

const TOOL_NAME = 'ma_generate_strategy'

export function isStrategyIQToolCall(toolName: string): boolean {
  return toolName === TOOL_NAME
}

export async function executeStrategyIQTool(toolCall: ToolCall): Promise<ToolResult> {
  try {
    const args = toolCall.arguments as Record<string, unknown>
    const brand = String(args.brand ?? '')
    const product = String(args.product ?? '')

    if (!brand || !product) {
      return { toolCallId: toolCall.id, content: '参数缺失: brand 和 product 为必填项', isError: true }
    }

    const industry = String(args.industry ?? '通用')
    const goal = String(args.goal ?? '品牌曝光')
    const budget = String(args.budget ?? '待商议')
    const timeline = String(args.timeline ?? '待定')
    const targetAudience = String(args.target_audience ?? '')
    const keyMessages = String(args.key_messages ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const preferredPlatforms = String(args.preferred_platforms ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const isOverseas = Boolean(args.is_overseas ?? false)

    // 加载行业模板
    const template = getIndustryTemplate(industry, isOverseas)
    const playbook = getCasePlaybook({ industry, goal, isOverseas })

    const systemPrompt = buildSystemPrompt(template, playbook)
    const userPrompt = buildUserPrompt({
      brand, product, industry, goal, budget, timeline,
      targetAudience, keyMessages, preferredPlatforms, isOverseas,
    })

    const result = await completePrompt(userPrompt, systemPrompt, {
      jsonMode: true,
      temperature: 0.7,
      maxTokens: 8000,
    })

    if (!result.success) {
      return { toolCallId: toolCall.id, content: `策略生成失败: ${result.error}`, isError: true }
    }

    // 尝试解析 JSON，失败则返回原始文本
    let strategy: Record<string, unknown>
    try {
      strategy = extractJSON(result.text) as Record<string, unknown>
    } catch {
      // 不是 JSON，返回格式化后的文本
      return { toolCallId: toolCall.id, content: formatStrategyText(result.text) }
    }

    const formatted = formatStrategyResult(strategy, brand, product)
    return { toolCallId: toolCall.id, content: formatted }

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[StrategyIQ] 执行失败:', error)
    return { toolCallId: toolCall.id, content: `策略生成错误: ${msg}`, isError: true }
  }
}

// =====================================================================
// Prompt 构建
// =====================================================================

function buildSystemPrompt(template: Record<string, unknown>, playbook: Record<string, unknown>): string {
  return `你是一位拥有15年经验的社会化营销策略总监，曾在顶尖4A广告公司和大厂增长部门任职。

你必须输出**严格有效的 JSON**，不要包含任何 Markdown 代码块标记或额外说明文字。

输出必须按以下 JSON Schema：
{
  "brief_insight": {
    "brand_product": "品牌/产品核心定位一句话",
    "target_audience": "TA画像摘要",
    "marketing_goal": "营销目标与核心挑战",
    "key_challenge": "本次传播面临的最大挑战"
  },
  "big_idea": {
    "core_proposition": "一句话核心策略主张（Big Idea）",
    "theme": "传播主题",
    "creative_concept": "创意概念描述",
    "hero_message": "一句话可复述的 Hero Message"
  },
  "platform_matrix": [
    {"name": "平台名", "role": "角色定位", "content_format": "主打内容形式", "budget_ratio": 40, "reasoning": "选择理由"}
  ],
  "kol_strategy": {
    "head_kol": {"count": "建议数量", "purpose": "负责破圈/品牌背书", "budget_ratio": 0.4},
    "waist_kol": {"count": "建议数量", "purpose": "负责种草/垂类渗透", "budget_ratio": 0.45},
    "koc": {"count": "建议数量", "purpose": "负责口碑沉淀", "budget_ratio": 0.15}
  },
  "content_plan": {
    "preheat": {"period": "预热期", "theme": "阶段主题", "key_actions": ["动作1"]},
    "explosion": {"period": "爆发期", "theme": "阶段主题", "key_actions": ["动作1"]},
    "longtail": {"period": "长尾期", "theme": "阶段主题", "key_actions": ["动作1"]}
  },
  "kpis": {
    "primary": {"metric": "主要指标", "target": "目标值"},
    "secondary": [{"metric": "指标名", "target": "目标值"}]
  },
  "budget_allocation": {"平台名": 40},
  "risk_warnings": [{"risk": "风险描述", "mitigation": "应对措施"}],
  "next_steps": ["下一步动作1", "下一步动作2"]
}

【行业模板参考】
${JSON.stringify(template, null, 2)}

【案例参考】
${JSON.stringify(playbook, null, 2)}`
}

function buildUserPrompt(params: {
  brand: string
  product: string
  industry: string
  goal: string
  budget: string
  timeline: string
  targetAudience: string
  keyMessages: string[]
  preferredPlatforms: string[]
  isOverseas: boolean
}): string {
  const parts: string[] = [
    `请为以下品牌生成社交营销策略方案：`,
    ``,
    `品牌：${params.brand}`,
    `产品：${params.product}`,
    `行业：${params.industry}`,
    `营销目标：${params.goal}`,
    `预算：${params.budget}`,
    `时间周期：${params.timeline}`,
  ]

  if (params.targetAudience) {
    parts.push(`目标受众：${params.targetAudience}`)
  }
  if (params.keyMessages.length > 0) {
    parts.push(`关键信息：${params.keyMessages.join('、')}`)
  }
  if (params.preferredPlatforms.length > 0) {
    parts.push(`首选平台：${params.preferredPlatforms.join('、')}`)
  }
  if (params.isOverseas) {
    parts.push(`投放区域：海外`)
  }

  parts.push(`\n请输出完整的策略方案 JSON。`)
  return parts.join('\n')
}

// =====================================================================
// 行业模板与案例库
// =====================================================================

function getIndustryTemplate(industry: string, isOverseas: boolean): Record<string, unknown> {
  const base = (industryTemplates as Record<string, Record<string, unknown>>)._base
  const specific = (industryTemplates as Record<string, Record<string, unknown>>)[industry]
    ?? (industryTemplates as Record<string, Record<string, unknown>>)['通用']

  const merged: Record<string, unknown> = { ...base, ...specific, industry }
  const platformKey = isOverseas ? 'platforms_overseas' : 'platforms_cn'
  merged.platforms = (merged[platformKey] as string[] | undefined) ?? (base?.platforms_cn as string[] | undefined) ?? []
  return merged
}

function getCasePlaybook(context: { industry: string; goal: string; isOverseas: boolean }): Record<string, unknown> {
  const sportsKeywords = ['足球', '世界杯', '球衣', '运动', '球鞋', '赛事', '球场', '运动员', 'NBA', '跑步']
  const isSportsRelated = sportsKeywords.some((kw) => context.industry.includes(kw) || context.goal.includes(kw))

  const selected: string[] = []
  if (context.isOverseas && ['3C', '科技', '数码'].includes(context.industry)) {
    selected.push('Petphone1127')
  }
  if (!context.isOverseas || ['时尚', '美妆', '快消', '运动鞋服', '母婴'].includes(context.industry) || context.goal.includes('种草') || isSportsRelated) {
    selected.push('Mind social')
  }
  if (selected.length === 0) {
    selected.push('Mind social')
  }

  const playbooks = selected.map((name) => (casePlaybooks as Record<string, Record<string, unknown>>)[name])
  return {
    selected_cases: selected,
    insights: playbooks.flatMap((p) => (p?.core_patterns as string[] | undefined) ?? []),
    channel_roles: Object.assign({}, ...playbooks.map((p) => (p?.channel_roles as Record<string, unknown> | undefined) ?? {})),
    content_pillars: playbooks.flatMap((p) => (p?.content_pillars as string[] | undefined) ?? []),
  }
}

// =====================================================================
// 结果格式化
// =====================================================================

function formatStrategyResult(strategy: Record<string, unknown>, brand: string, product: string): string {
  const parts: string[] = []
  parts.push(`# ${brand} · ${product} 社交营销策略提案`)
  parts.push('')

  // Brief洞察
  const insight = strategy.brief_insight as Record<string, unknown> | undefined
  if (insight) {
    parts.push('## 📋 Brief 核心洞察')
    parts.push(`- **品牌/产品**：${insight.brand_product ?? ''}`)
    parts.push(`- **目标受众**：${insight.target_audience ?? ''}`)
    parts.push(`- **营销目标**：${insight.marketing_goal ?? ''}`)
    parts.push(`- **核心挑战**：${insight.key_challenge ?? ''}`)
    parts.push('')
  }

  // Big Idea
  const bigIdea = strategy.big_idea as Record<string, unknown> | undefined
  if (bigIdea) {
    parts.push('## 💡 Big Idea')
    parts.push(`- **核心主张**：${bigIdea.core_proposition ?? ''}`)
    parts.push(`- **传播主题**：${bigIdea.theme ?? ''}`)
    parts.push(`- **创意概念**：${bigIdea.creative_concept ?? ''}`)
    parts.push(`- **Hero Message**：${bigIdea.hero_message ?? ''}`)
    parts.push('')
  }

  // 平台矩阵
  const platforms = strategy.platform_matrix as Array<Record<string, unknown>> | undefined
  if (platforms && platforms.length > 0) {
    parts.push('## 📱 平台矩阵')
    parts.push('| 平台 | 角色 | 内容形式 | 预算占比 | 选择理由 |')
    parts.push('|------|------|----------|----------|----------|')
    for (const p of platforms) {
      parts.push(`| ${p.name ?? ''} | ${p.role ?? ''} | ${p.content_format ?? ''} | ${p.budget_ratio ?? ''}% | ${p.reasoning ?? ''} |`)
    }
    parts.push('')
  }

  // KOL策略
  const kolStrategy = strategy.kol_strategy as Record<string, unknown> | undefined
  if (kolStrategy) {
    parts.push('## 🎯 KOL 策略')
    const head = kolStrategy.head_kol as Record<string, unknown> | undefined
    const waist = kolStrategy.waist_kol as Record<string, unknown> | undefined
    const koc = kolStrategy.koc as Record<string, unknown> | undefined
    if (head) parts.push(`- **头部 KOL**：${head.count ?? ''} 人，占比 ${(head.budget_ratio as number ?? 0) * 100}%，负责 ${head.purpose ?? ''}`)
    if (waist) parts.push(`- **腰部 KOL**：${waist.count ?? ''} 人，占比 ${(waist.budget_ratio as number ?? 0) * 100}%，负责 ${waist.purpose ?? ''}`)
    if (koc) parts.push(`- **KOC**：${koc.count ?? ''} 人，占比 ${(koc.budget_ratio as number ?? 0) * 100}%，负责 ${koc.purpose ?? ''}`)
    parts.push('')
  }

  // 内容规划
  const contentPlan = strategy.content_plan as Record<string, Record<string, unknown>> | undefined
  if (contentPlan) {
    parts.push('## 📝 内容规划')
    for (const [phase, plan] of Object.entries(contentPlan)) {
      const phaseName = phase === 'preheat' ? '预热期' : phase === 'explosion' ? '爆发期' : phase === 'longtail' ? '长尾期' : phase
      parts.push(`### ${phaseName}（${plan.period ?? ''}）`)
      parts.push(`- **主题**：${plan.theme ?? ''}`)
      const actions = plan.key_actions as string[] | undefined
      if (actions && actions.length > 0) {
        parts.push(`- **关键动作**：`)
        for (const action of actions) {
          parts.push(`  - ${action}`)
        }
      }
      parts.push('')
    }
  }

  // KPI
  const kpis = strategy.kpis as Record<string, unknown> | undefined
  if (kpis) {
    parts.push('## 📊 KPI 设定')
    const primary = kpis.primary as Record<string, unknown> | undefined
    if (primary) parts.push(`- **核心指标**：${primary.metric ?? ''} → ${primary.target ?? ''}`)
    const secondary = kpis.secondary as Array<Record<string, unknown>> | undefined
    if (secondary && secondary.length > 0) {
      for (const s of secondary) {
        parts.push(`- **辅助指标**：${s.metric ?? ''} → ${s.target ?? ''}`)
      }
    }
    parts.push('')
  }

  // 预算分配
  const budgetAllocation = strategy.budget_allocation as Record<string, number> | undefined
  if (budgetAllocation) {
    parts.push('## 💰 预算分配')
    for (const [platform, ratio] of Object.entries(budgetAllocation)) {
      parts.push(`- ${platform}：${ratio}%`)
    }
    parts.push('')
  }

  // 风险提示
  const risks = strategy.risk_warnings as Array<Record<string, unknown>> | undefined
  if (risks && risks.length > 0) {
    parts.push('## ⚠️ 风险提示')
    for (const r of risks) {
      parts.push(`- **${r.risk ?? ''}**：${r.mitigation ?? ''}`)
    }
    parts.push('')
  }

  // 下一步
  const nextSteps = strategy.next_steps as string[] | undefined
  if (nextSteps && nextSteps.length > 0) {
    parts.push('## 🚀 下一步动作')
    for (let i = 0; i < nextSteps.length; i++) {
      parts.push(`${i + 1}. ${nextSteps[i]}`)
    }
    parts.push('')
  }

  return parts.join('\n')
}

function formatStrategyText(text: string): string {
  // 如果返回的是非 JSON 文本，直接包装
  return `# 社交营销策略提案\n\n${text}`
}
