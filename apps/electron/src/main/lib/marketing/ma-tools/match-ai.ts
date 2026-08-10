/**
 * MatchAI - KOL/KOC 智能匹配系统（Chat Tool）
 *
 * 基于品牌需求和本地 KOL 数据库，智能筛选并推荐合适的 KOL 组合。
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@gravitas/core'
import type { ChatToolMeta } from '@gravitas/shared'
import { completePrompt, extractJSON } from './llm-service'
import { searchKOLs, getKOLStats, type KOLRecord } from './kol-data-service'
import industryTemplates from './knowledge/industry-templates.json'

// =====================================================================
// 工具元数据
// =====================================================================

export const MATCH_AI_TOOL_META: ChatToolMeta = {
  id: 'ma-match-ai',
  name: 'MAKOL匹配',
  description: '基于品牌需求和本地KOL数据库，智能筛选并推荐合适的KOL/KOC组合，含匹配度评分和风险预警',
  params: [
    { name: 'brand', type: 'string', description: '品牌名称', required: true },
    { name: 'product', type: 'string', description: '产品名称', required: true },
    { name: 'platform', type: 'string', description: '平台（小红书/抖音/B站/微博/快手/多平台）', required: false },
    { name: 'category', type: 'string', description: 'KOL内容领域（美妆/3C/母婴/时尚/生活方式等）', required: false },
    { name: 'follower_range', type: 'string', description: '粉丝量范围（如：10万-100万）', required: false },
    { name: 'budget_per_kol', type: 'string', description: '单个KOL预算范围', required: false },
    { name: 'target_audience', type: 'string', description: '目标受众', required: false },
    { name: 'key_messages', type: 'string', description: '关键传播信息', required: false },
    { name: 'limit', type: 'number', description: '推荐数量（默认10）', required: false },
  ],
  icon: 'Target',
  category: 'builtin',
  executorType: 'builtin',
  systemPromptAppend: `
<ma_match_ai_instructions>
你拥有 **MAKOL匹配** 能力（MatchAI）。

**ma_match_kols — KOL 智能匹配：**
当用户需要筛选推荐 KOL/KOC 时调用：
- 为品牌推荐合适的 KOL 组合
- 筛选特定平台/粉丝量/领域的 KOL
- 评估 KOL 与品牌的匹配度
- 获取 KOL 风险预警

工具会返回推荐的 KOL 列表（含匹配度评分、推荐理由、风险提示）。
</ma_match_ai_instructions>`,
}

export const MATCH_AI_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'ma_match_kols',
    description: 'Intelligently match and recommend KOL/KOC influencers based on brand requirements. Returns a ranked list with match scores, reasoning, and risk warnings. Use when the user needs KOL recommendations, influencer screening, or KOL cooperation planning.',
    parameters: {
      type: 'object',
      properties: {
        brand: { type: 'string', description: 'Brand name' },
        product: { type: 'string', description: 'Product name' },
        platform: { type: 'string', description: 'Platform (xiaohongshu/douyin/bilibili/weibo/kuaishou/multi)' },
        category: { type: 'string', description: 'KOL content category (beauty/3C/mother-baby/fashion/lifestyle etc.)' },
        follower_range: { type: 'string', description: 'Follower count range (e.g., 100k-1M)' },
        budget_per_kol: { type: 'string', description: 'Budget per KOL' },
        target_audience: { type: 'string', description: 'Target audience description' },
        key_messages: { type: 'string', description: 'Key marketing messages' },
        limit: { type: 'number', description: 'Number of recommendations (default 10)' },
      },
      required: ['brand', 'product'],
    },
  },
]

// =====================================================================
// 可用性检查
// =====================================================================

export function isMatchAIAvailable(): boolean {
  return true
}

// =====================================================================
// 工具执行
// =====================================================================

const TOOL_NAME = 'ma_match_kols'

export function isMatchAIToolCall(toolName: string): boolean {
  return toolName === TOOL_NAME
}

export async function executeMatchAITool(toolCall: ToolCall): Promise<ToolResult> {
  try {
    const args = toolCall.arguments as Record<string, unknown>
    const brand = String(args.brand ?? '')
    const product = String(args.product ?? '')

    if (!brand || !product) {
      return { toolCallId: toolCall.id, content: '参数缺失: brand 和 product 为必填项', isError: true }
    }

    const platform = String(args.platform ?? '')
    const category = String(args.category ?? '')
    const followerRange = String(args.follower_range ?? '')
    const budgetPerKol = String(args.budget_per_kol ?? '')
    const targetAudience = String(args.target_audience ?? '')
    const keyMessages = String(args.key_messages ?? '')
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 50) : 10

    // 1. 从本地数据库搜索候选 KOL
    const dbResults = searchKOLs({
      platform: platform === '多平台' || platform === 'multi' ? undefined : platform,
      category: category || undefined,
      limit: Math.min(limit * 3, 50), // 多取一些给 LLM 排序
    })

    const stats = getKOLStats()

    // 2. 如果没有数据，提示用户
    if (dbResults.kols.length === 0) {
      const noDataMsg = `# KOL 匹配结果\n\n本地 KOL 数据库暂无数据。\n\n**当前数据库状态：**\n- 总记录数：${stats.total}\n- 可用平台：${Object.keys(stats.byPlatform).join('、') || '无'}\n\n**建议：**\n1. 运行 \`ma_search_kols\` 工具从 API 数据源拉取 KOL 数据\n2. 或使用 Mock 数据初始化：数据库会自动填充示例数据`
      return { toolCallId: toolCall.id, content: noDataMsg }
    }

    // 3. 用 LLM 进行匹配度分析和排序
    const systemPrompt = `你是一位资深的 KOL 评估专家，拥有丰富的品牌合作经验。

请基于提供的 KOL 数据和品牌需求，进行全面的匹配度分析。

**输出格式（严格 JSON）：**
{
  "head_kols": [
    {"id": "KOL ID", "name": "KOL名称", "platform": "平台", "match_score": 95, "match_reasoning": "详细匹配理由", "risk_factors": ["风险1"], "estimated_roi": "1:5-1:8", "cooperation_suggestions": "合作建议"}
  ],
  "waist_kols": [...],
  "koc_recommendation": {"count": "建议数量", "selection_criteria": ["标准1"]},
  "overall_assessment": "整体评估",
  "risk_summary": "风险总结"
}

**评分标准：**
- 90-100：高度匹配，强烈建议合作
- 80-89：良好匹配，推荐合作
- 70-79：一般匹配，可考虑
- <70：匹配度较低，需谨慎`

    const userPrompt = buildMatchPrompt({
      brand, product, platform, category, followerRange, budgetPerKol,
      targetAudience, keyMessages, limit, kols: dbResults.kols,
    })

    const result = await completePrompt(userPrompt, systemPrompt, {
      jsonMode: true,
      temperature: 0.5,
      maxTokens: 6000,
    })

    if (!result.success) {
      // LLM 失败时返回数据库原始结果
      return {
        toolCallId: toolCall.id,
        content: formatFallbackResults(dbResults.kols.slice(0, limit), brand, product),
      }
    }

    let matchResult: Record<string, unknown>
    try {
      matchResult = extractJSON(result.text) as Record<string, unknown>
    } catch {
      return {
        toolCallId: toolCall.id,
        content: formatFallbackResults(dbResults.kols.slice(0, limit), brand, product),
      }
    }

    const formatted = formatMatchResult(matchResult, brand, product, dbResults.total)
    return { toolCallId: toolCall.id, content: formatted }

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[MatchAI] 执行失败:', error)
    return { toolCallId: toolCall.id, content: `KOL 匹配错误: ${msg}`, isError: true }
  }
}

// =====================================================================
// Prompt 构建
// =====================================================================

function buildMatchPrompt(params: {
  brand: string
  product: string
  platform: string
  category: string
  followerRange: string
  budgetPerKol: string
  targetAudience: string
  keyMessages: string
  limit: number
  kols: KOLRecord[]
}): string {
  const parts: string[] = [
    `请为以下品牌推荐合适的 KOL：`,
    ``,
    `品牌：${params.brand}`,
    `产品：${params.product}`,
  ]

  if (params.platform) parts.push(`平台：${params.platform}`)
  if (params.category) parts.push(`内容领域：${params.category}`)
  if (params.followerRange) parts.push(`粉丝量范围：${params.followerRange}`)
  if (params.budgetPerKol) parts.push(`单个 KOL 预算：${params.budgetPerKol}`)
  if (params.targetAudience) parts.push(`目标受众：${params.targetAudience}`)
  if (params.keyMessages) parts.push(`关键信息：${params.keyMessages}`)

  parts.push(`\n候选 KOL 数据（共 ${params.kols.length} 位）：`)
  parts.push('```json')
  parts.push(JSON.stringify(params.kols.map((k) => ({
    id: k.id,
    name: k.name,
    platform: k.platform,
    followers: k.followers,
    engagement: k.engagement,
    category: k.category,
    price: k.price,
    city: k.city,
  })), null, 2))
  parts.push('```')

  parts.push(`\n请从中筛选出最匹配的 KOL，按头部/腰部分类输出。`)
  return parts.join('\n')
}

// =====================================================================
// 结果格式化
// =====================================================================

function formatMatchResult(result: Record<string, unknown>, brand: string, product: string, totalCandidates: number): string {
  const parts: string[] = []
  parts.push(`# ${brand} · ${product} KOL 匹配推荐`)
  parts.push(`> 从 ${totalCandidates} 位候选 KOL 中筛选\n`)

  const overall = result.overall_assessment as string | undefined
  if (overall) {
    parts.push(`## 📊 整体评估`)
    parts.push(overall)
    parts.push('')
  }

  // 头部 KOL
  const headKols = result.head_kols as Array<Record<string, unknown>> | undefined
  if (headKols && headKols.length > 0) {
    parts.push(`## ⭐ 头部 KOL 推荐（${headKols.length} 位）`)
    for (const kol of headKols) {
      parts.push(formatKOLItem(kol))
    }
    parts.push('')
  }

  // 腰部 KOL
  const waistKols = result.waist_kols as Array<Record<string, unknown>> | undefined
  if (waistKols && waistKols.length > 0) {
    parts.push(`## 🌟 腰部 KOL 推荐（${waistKols.length} 位）`)
    for (const kol of waistKols) {
      parts.push(formatKOLItem(kol))
    }
    parts.push('')
  }

  // KOC 建议
  const koc = result.koc_recommendation as Record<string, unknown> | undefined
  if (koc) {
    parts.push(`## 💬 KOC 建议`)
    parts.push(`- **建议数量**：${koc.count ?? ''}`)
    const criteria = koc.selection_criteria as string[] | undefined
    if (criteria && criteria.length > 0) {
      parts.push(`- **筛选标准**：`)
      for (const c of criteria) parts.push(`  - ${c}`)
    }
    parts.push('')
  }

  // 风险总结
  const riskSummary = result.risk_summary as string | undefined
  if (riskSummary) {
    parts.push(`## ⚠️ 风险总结`)
    parts.push(riskSummary)
    parts.push('')
  }

  return parts.join('\n')
}

function formatKOLItem(kol: Record<string, unknown>): string {
  const parts: string[] = []
  const score = kol.match_score as number | undefined
  const scoreEmoji = score && score >= 90 ? '🟢' : score && score >= 80 ? '🟡' : '🔴'

  parts.push(`### ${scoreEmoji} ${kol.name ?? '未知'}（${kol.platform ?? ''}）`)
  if (score !== undefined) parts.push(`- **匹配度**：${score}/100`)
  parts.push(`- **匹配理由**：${kol.match_reasoning ?? ''}`)

  const risks = kol.risk_factors as string[] | undefined
  if (risks && risks.length > 0) {
    parts.push(`- **风险提示**：${risks.join('；')}`)
  }

  const roi = kol.estimated_roi as string | undefined
  if (roi) parts.push(`- **预估 ROI**：${roi}`)

  const suggestions = kol.cooperation_suggestions as string | undefined
  if (suggestions) parts.push(`- **合作建议**：${suggestions}`)

  return parts.join('\n')
}

function formatFallbackResults(kols: KOLRecord[], brand: string, product: string): string {
  const parts: string[] = []
  parts.push(`# ${brand} · ${product} KOL 推荐（数据库匹配）`)
  parts.push('')

  for (const kol of kols) {
    parts.push(`### ${kol.name}（${kol.platform}）`)
    parts.push(`- **粉丝量**：${kol.followers}`)
    parts.push(`- **互动率**：${kol.engagement}`)
    parts.push(`- **领域**：${kol.category}`)
    parts.push(`- **报价**：${kol.price}`)
    parts.push(`- **城市**：${kol.city}`)
    parts.push('')
  }

  return parts.join('\n')
}
