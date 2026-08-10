/**
 * CampaignOptimizer - 投放优化助手（Chat Tool）
 *
 * 基于小规模投放测试结果，优化达人组合和投放策略，生成正式投放方案。
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@gravitas/core'
import type { ChatToolMeta } from '@gravitas/shared'
import { completePrompt, extractJSON } from './llm-service'

// =====================================================================
// 工具元数据
// =====================================================================

export const CAMPAIGN_OPTIMIZER_TOOL_META: ChatToolMeta = {
  id: 'ma-campaign-optimizer',
  name: 'MA投放优化',
  description: '基于小规模投放测试结果，优化达人组合和投放策略，生成正式投放方案与预算分配建议',
  params: [
    { name: 'brand', type: 'string', description: '品牌名称', required: true },
    { name: 'product', type: 'string', description: '产品名称', required: true },
    { name: 'test_results', type: 'string', description: '测试结果JSON或描述（包含各组合ROI、CTR、CPE等数据）', required: true },
    { name: 'total_budget', type: 'number', description: '正式投放总预算（单位：万元）', required: true },
    { name: 'platforms', type: 'string', description: '投放平台（小红书/抖音/B站/微博/快手等，多个用逗号分隔）', required: true },
    { name: 'optimization_goal', type: 'string', description: '优化目标（ROI最大化/曝光最大化/互动最大化/转化最大化）', required: false },
  ],
  icon: 'TrendingUp',
  category: 'builtin',
  executorType: 'builtin',
  systemPromptAppend: `
<ma_campaign_optimizer_instructions>
你拥有 **MA投放优化** 能力（CampaignOptimizer）。

**ma_optimize_campaign — 投放策略优化：**
当用户需要基于测试数据优化正式投放方案时调用：
- 分析小规模测试结果，识别表现最佳/最差的组合
- 重新分配预算到头部达人、腰部达人和KOC
- 优化平台组合和内容策略
- 提供投放时机和风险评估建议

工具会返回详细的测试分析、优化策略、预算重分配方案、内容优化建议和预期提升数据。
</ma_campaign_optimizer_instructions>`,
}

export const CAMPAIGN_OPTIMIZER_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'ma_optimize_campaign',
    description: 'Optimize formal campaign strategy based on small-scale test results. Analyzes test data, reallocates budget across KOL tiers, adjusts platform mix, and generates a comprehensive formal launch plan. Use when the user has test/pilot campaign data and wants to optimize the full-scale launch strategy.',
    parameters: {
      type: 'object',
      properties: {
        brand: { type: 'string', description: 'Brand name' },
        product: { type: 'string', description: 'Product name' },
        test_results: { type: 'string', description: 'Test results data (JSON or description with ROI, CTR, CPE, conversion data for each combination)' },
        total_budget: { type: 'number', description: 'Total formal campaign budget in 万元 (10K CNY)' },
        platforms: { type: 'string', description: 'Target platforms (xiaohongshu/douyin/bilibili/weibo/kuaishou, comma separated)' },
        optimization_goal: { type: 'string', description: 'Optimization goal: ROI最大化/曝光最大化/互动最大化/转化最大化' },
      },
      required: ['brand', 'product', 'test_results', 'total_budget', 'platforms'],
    },
  },
]

// =====================================================================
// 可用性检查
// =====================================================================

export function isCampaignOptimizerAvailable(): boolean {
  return true
}

// =====================================================================
// 工具执行
// =====================================================================

const TOOL_NAME = 'ma_optimize_campaign'

export function isCampaignOptimizerToolCall(toolName: string): boolean {
  return toolName === TOOL_NAME
}

export async function executeCampaignOptimizerTool(toolCall: ToolCall): Promise<ToolResult> {
  try {
    const args = toolCall.arguments as Record<string, unknown>
    const brand = String(args.brand ?? '')
    const product = String(args.product ?? '')
    const testResults = String(args.test_results ?? '')
    const totalBudget = Number(args.total_budget ?? 0)
    const platforms = String(args.platforms ?? '')

    if (!brand || !product || !testResults || !totalBudget || !platforms) {
      return { toolCallId: toolCall.id, content: '参数缺失: brand、product、test_results、total_budget 和 platforms 为必填项', isError: true }
    }

    const optimizationGoal = String(args.optimization_goal ?? 'ROI最大化')
    const platformList = platforms.split(',').map((s) => s.trim()).filter(Boolean)

    const systemPrompt = `你是一位资深的社交媒体投放优化专家，曾在顶级广告代理公司和品牌方负责过数亿级预算的达人投放项目。

请基于小规模测试数据，生成一份详细的正式投放优化方案。

**输出格式（严格 JSON）：**
{
  "test_analysis": {
    "key_findings": ["发现1", "发现2"],
    "winning_combinations": ["表现最好的组合"],
    "underperforming_elements": ["表现不佳的元素"]
  },
  "optimized_strategy": {
    "kol_mix": "调整后的达人配比",
    "platform_allocation": {"平台名": 50},
    "content_approach": "内容策略调整"
  },
  "budget_reallocation": {
    "total": 100,
    "head_kols": {"count": 2, "budget": 40, "rationale": "理由"},
    "waist_kols": {"count": 8, "budget": 45, "rationale": "理由"},
    "koc": {"count": 20, "budget": 15, "rationale": "理由"}
  },
  "content_optimization": ["内容优化建议1", "建议2"],
  "timing_adjustments": "投放时机调整建议",
  "expected_improvement": {
    "roi_lift": "预计ROI提升20%",
    "efficiency_gain": "效率提升描述"
  },
  "risk_factors": ["风险1", "风险2"]
}`

    const userPrompt = buildOptimizerPrompt({
      brand, product, testResults, totalBudget, platformList, optimizationGoal,
    })

    const result = await completePrompt(userPrompt, systemPrompt, {
      jsonMode: true,
      temperature: 0.5,
      maxTokens: 6000,
    })

    if (!result.success) {
      return { toolCallId: toolCall.id, content: `投放优化方案生成失败: ${result.error}`, isError: true }
    }

    let plan: Record<string, unknown>
    try {
      plan = extractJSON(result.text) as Record<string, unknown>
    } catch {
      return { toolCallId: toolCall.id, content: formatOptimizerText(result.text, brand, product) }
    }

    const formatted = formatOptimizerResult(plan, brand, product, platformList, totalBudget, optimizationGoal)
    return { toolCallId: toolCall.id, content: formatted }

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[CampaignOptimizer] 执行失败:', error)
    return { toolCallId: toolCall.id, content: `投放优化方案生成错误: ${msg}`, isError: true }
  }
}

// =====================================================================
// Prompt 构建
// =====================================================================

function buildOptimizerPrompt(params: {
  brand: string
  product: string
  testResults: string
  totalBudget: number
  platformList: string[]
  optimizationGoal: string
}): string {
  const parts: string[] = [
    `请基于以下小规模测试数据，生成正式投放优化方案：`,
    ``,
    `品牌：${params.brand}`,
    `产品：${params.product}`,
    `投放平台：${params.platformList.join('、')}`,
    `正式投放总预算：${params.totalBudget} 万元`,
    `优化目标：${params.optimizationGoal}`,
    ``,
    `--- 小规模测试结果数据 ---`,
    params.testResults,
    ``,
    `请分析测试数据，识别表现最佳和最差的组合，重新分配预算，优化达人组合和投放策略。`,
    `预算分配必须严格遵循总预算 ${params.totalBudget} 万元，各层级预算之和必须等于总预算。`,
  ]
  return parts.join('\n')
}

// =====================================================================
// 结果格式化
// =====================================================================

function formatOptimizerResult(
  plan: Record<string, unknown>,
  brand: string,
  product: string,
  platformList: string[],
  totalBudget: number,
  optimizationGoal: string,
): string {
  const parts: string[] = []
  parts.push(`# ${brand} · ${product} — 正式投放优化方案`)
  parts.push('')
  parts.push(`**投放平台**：${platformList.join('、')} | **总预算**：${totalBudget} 万元 | **优化目标**：${optimizationGoal}`)
  parts.push('')

  // 测试分析
  const testAnalysis = plan.test_analysis as Record<string, unknown> | undefined
  if (testAnalysis) {
    parts.push(`## 📊 测试数据分析`)
    const findings = testAnalysis.key_findings as string[] | undefined
    if (findings && findings.length > 0) {
      parts.push(`**核心发现**：`)
      for (const f of findings) parts.push(`- 🔍 ${f}`)
    }
    const winners = testAnalysis.winning_combinations as string[] | undefined
    if (winners && winners.length > 0) {
      parts.push(`**表现最佳组合**：`)
      for (const w of winners) parts.push(`- 🏆 ${w}`)
    }
    const underperformers = testAnalysis.underperforming_elements as string[] | undefined
    if (underperformers && underperformers.length > 0) {
      parts.push(`**表现不佳元素**：`)
      for (const u of underperformers) parts.push(`- ⚠️ ${u}`)
    }
    parts.push('')
  }

  // 优化策略
  const strategy = plan.optimized_strategy as Record<string, unknown> | undefined
  if (strategy) {
    parts.push(`## 🎯 优化策略`)
    if (strategy.kol_mix) parts.push(`- **达人配比**：${strategy.kol_mix}`)
    const allocation = strategy.platform_allocation as Record<string, number> | undefined
    if (allocation && Object.keys(allocation).length > 0) {
      parts.push(`- **平台预算分配**：`)
      for (const [plat, pct] of Object.entries(allocation)) {
        parts.push(`  - ${plat}：${pct}%（约 ${Math.round(totalBudget * (pct / 100))} 万元）`)
      }
    }
    if (strategy.content_approach) parts.push(`- **内容策略**：${strategy.content_approach}`)
    parts.push('')
  }

  // 预算重分配
  const budget = plan.budget_reallocation as Record<string, unknown> | undefined
  if (budget) {
    parts.push(`## 💰 预算重分配方案`)
    const total = budget.total as number | undefined
    if (total !== undefined) parts.push(`**总预算**：${total} 万元`)
    parts.push('')

    const head = budget.head_kols as Record<string, unknown> | undefined
    if (head) {
      parts.push(`### 🌟 头部达人`)
      parts.push(`- 数量：${head.count ?? '-'} 位`)
      parts.push(`- 预算：${head.budget ?? '-'} 万元`)
      parts.push(`- 理由：${head.rationale ?? '-'}`)
      parts.push('')
    }

    const waist = budget.waist_kols as Record<string, unknown> | undefined
    if (waist) {
      parts.push(`### ⭐ 腰部达人`)
      parts.push(`- 数量：${waist.count ?? '-'} 位`)
      parts.push(`- 预算：${waist.budget ?? '-'} 万元`)
      parts.push(`- 理由：${waist.rationale ?? '-'}`)
      parts.push('')
    }

    const koc = budget.koc as Record<string, unknown> | undefined
    if (koc) {
      parts.push(`### 💫 KOC/素人`)
      parts.push(`- 数量：${koc.count ?? '-'} 位`)
      parts.push(`- 预算：${koc.budget ?? '-'} 万元`)
      parts.push(`- 理由：${koc.rationale ?? '-'}`)
      parts.push('')
    }
  }

  // 内容优化
  const contentOpt = plan.content_optimization as string[] | undefined
  if (contentOpt && contentOpt.length > 0) {
    parts.push(`## ✨ 内容优化建议`)
    for (const c of contentOpt) parts.push(`- ${c}`)
    parts.push('')
  }

  // 投放时机
  if (plan.timing_adjustments) {
    parts.push(`## ⏰ 投放时机调整`)
    parts.push(String(plan.timing_adjustments))
    parts.push('')
  }

  // 预期提升
  const improvement = plan.expected_improvement as Record<string, unknown> | undefined
  if (improvement) {
    parts.push(`## 📈 预期提升`)
    if (improvement.roi_lift) parts.push(`- **ROI提升**：${improvement.roi_lift}`)
    if (improvement.efficiency_gain) parts.push(`- **效率增益**：${improvement.efficiency_gain}`)
    parts.push('')
  }

  // 风险因素
  const risks = plan.risk_factors as string[] | undefined
  if (risks && risks.length > 0) {
    parts.push(`## ⚠️ 风险因素与应对`)
    for (const r of risks) parts.push(`- ${r}`)
    parts.push('')
  }

  return parts.join('\n')
}

function formatOptimizerText(text: string, brand: string, product: string): string {
  return `# ${brand} · ${product} — 投放优化方案\n\n${text}`
}
