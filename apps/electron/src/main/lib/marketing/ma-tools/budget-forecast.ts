/**
 * BudgetForecast - 市场投放预算预估引擎（Chat Tool）
 *
 * 为没有专业市场部的客户进行市场投放预算的科学计算。
 * 基于目标人群规模、曝光渠道、竞对稀释、曝光转化、销售占比五步法，
 * 输出可落地的预算预估报告和达人组合建议。
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@gravitas/core'
import type { ChatToolMeta } from '@gravitas/shared'
import { completePrompt, extractJSON } from './llm-service'

// =====================================================================
// 工具元数据
// =====================================================================

export const BUDGET_FORECAST_TOOL_META: ChatToolMeta = {
  id: 'ma-budget-forecast',
  name: 'MA预算预估',
  description: '为没有专业市场部的客户进行市场投放预算的科学计算。基于目标人群规模、曝光渠道、竞对稀释、曝光转化、销售占比五步法，输出预算预估报告和达人组合建议',
  params: [
    { name: 'brand', type: 'string', description: '品牌名称', required: true },
    { name: 'product', type: 'string', description: '产品名称/系列', required: true },
    { name: 'market_size', type: 'number', description: '目标市场总规模（人/户），如 1000000', required: true },
    { name: 'ta_description', type: 'string', description: '目标人群描述（如：25-35岁一二线城市精致妈妈）', required: true },
    { name: 'ta_penetration_rate', type: 'number', description: '目标人群渗透率（百分比，如 5 表示 5%）', required: true },
    { name: 'annual_sales_target', type: 'number', description: '年度销售目标（万元）', required: true },
    { name: 'competitor_spend_estimate', type: 'number', description: '主要竞品预估年度投放额（万元，可选）', required: false },
    { name: 'exposure_frequency', type: 'number', description: '单人有效曝光频次（默认6次）', required: false },
    { name: 'conversion_rate', type: 'number', description: '曝光到购买的预估转化率（百分比，如 2 表示 2%）', required: false },
    { name: 'budget_ratio', type: 'number', description: '投放占销售额比例（百分比，默认 15-20，如 18 表示 18%）', required: false },
    { name: 'preferred_platforms', type: 'string', description: '首选投放平台（小红书/抖音/B站/微博/快手，多个用逗号分隔）', required: false },
  ],
  icon: 'Calculator',
  category: 'builtin',
  executorType: 'builtin',
  systemPromptAppend: `
<ma_budget_forecast_instructions>
你拥有 **MA预算预估** 能力（BudgetForecast）。

**ma_forecast_budget — 市场投放预算预估：**
当用户需要计算市场投放预算、评估投放规模、规划预算分配时调用：
- 目标人群规模测算与市场规模预估
- 覆盖TA所需达人博主组合预估
- 竞品稀释系数计算（忠诚转化人群排除）
- 曝光转化预估（有效频次与转化率）
- 销售占比校验（投放占销售额 15-20%）
- 输出总预算预估和达人配比建议

工具会返回详细的预算预估报告，包含人群规模、曝光需求、转化预估、预算建议、达人组合方案。
</ma_budget_forecast_instructions>`,
}

export const BUDGET_FORECAST_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'ma_forecast_budget',
    description: 'Calculate market campaign budget forecast for clients without professional marketing teams. Based on 5-step methodology: target audience sizing, exposure channel estimation, competitor dilution coefficient, exposure-to-conversion forecast, and sales ratio validation (15-20% of sales). Returns detailed budget report and KOL mix recommendations. Use when the user wants to estimate campaign budget, plan marketing spend, or calculate required KOL investment.',
    parameters: {
      type: 'object',
      properties: {
        brand: { type: 'string', description: 'Brand name' },
        product: { type: 'string', description: 'Product name or series' },
        market_size: { type: 'number', description: 'Total target market size (people/households)' },
        ta_description: { type: 'string', description: 'Target audience description (e.g., 25-35yo urban moms)' },
        ta_penetration_rate: { type: 'number', description: 'Target audience penetration rate (percentage, e.g., 5 means 5%)' },
        annual_sales_target: { type: 'number', description: 'Annual sales target in 万元 (10K CNY)' },
        competitor_spend_estimate: { type: 'number', description: 'Estimated annual competitor spend in 万元 (optional)' },
        exposure_frequency: { type: 'number', description: 'Effective exposure frequency per person (default 6)' },
        conversion_rate: { type: 'number', description: 'Estimated exposure-to-purchase conversion rate (percentage, e.g., 2 means 2%)' },
        budget_ratio: { type: 'number', description: 'Marketing spend as percentage of sales (default 15-20, e.g., 18 means 18%)' },
        preferred_platforms: { type: 'string', description: 'Preferred platforms (xiaohongshu/douyin/bilibili/weibo/kuaishou, comma separated)' },
      },
      required: ['brand', 'product', 'market_size', 'ta_description', 'ta_penetration_rate', 'annual_sales_target'],
    },
  },
]

// =====================================================================
// 可用性检查
// =====================================================================

export function isBudgetForecastAvailable(): boolean {
  return true
}

// =====================================================================
// 工具执行
// =====================================================================

const TOOL_NAME = 'ma_forecast_budget'

export function isBudgetForecastToolCall(toolName: string): boolean {
  return toolName === TOOL_NAME
}

export async function executeBudgetForecastTool(toolCall: ToolCall): Promise<ToolResult> {
  try {
    const args = toolCall.arguments as Record<string, unknown>
    const brand = String(args.brand ?? '')
    const product = String(args.product ?? '')
    const marketSize = Number(args.market_size ?? 0)
    const taDescription = String(args.ta_description ?? '')
    const taPenetrationRate = Number(args.ta_penetration_rate ?? 0)
    const annualSalesTarget = Number(args.annual_sales_target ?? 0)

    if (!brand || !product || !marketSize || !taDescription || !taPenetrationRate || !annualSalesTarget) {
      return { toolCallId: toolCall.id, content: '参数缺失: brand、product、market_size、ta_description、ta_penetration_rate 和 annual_sales_target 为必填项', isError: true }
    }

    const competitorSpendEstimate = Number(args.competitor_spend_estimate ?? 0)
    const exposureFrequency = Number(args.exposure_frequency ?? 6)
    const conversionRate = Number(args.conversion_rate ?? 2)
    const budgetRatio = Number(args.budget_ratio ?? 18)
    const preferredPlatforms = String(args.preferred_platforms ?? '小红书,抖音')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const systemPrompt = buildSystemPrompt()
    const userPrompt = buildUserPrompt({
      brand, product, marketSize, taDescription, taPenetrationRate,
      annualSalesTarget, competitorSpendEstimate, exposureFrequency,
      conversionRate, budgetRatio, preferredPlatforms,
    })

    const result = await completePrompt(userPrompt, systemPrompt, {
      jsonMode: true,
      temperature: 0.4,
      maxTokens: 6000,
    })

    if (!result.success) {
      return { toolCallId: toolCall.id, content: `预算预估失败: ${result.error}`, isError: true }
    }

    let forecast: Record<string, unknown>
    try {
      forecast = extractJSON(result.text) as Record<string, unknown>
    } catch {
      return { toolCallId: toolCall.id, content: formatBudgetForecastText(result.text, brand, product) }
    }

    const formatted = formatBudgetForecastResult(forecast, brand, product, {
      marketSize, taPenetrationRate, annualSalesTarget, competitorSpendEstimate,
      exposureFrequency, conversionRate, budgetRatio, preferredPlatforms,
    })
    return { toolCallId: toolCall.id, content: formatted }

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[BudgetForecast] 执行失败:', error)
    return { toolCallId: toolCall.id, content: `预算预估错误: ${msg}`, isError: true }
  }
}

// =====================================================================
// Prompt 构建
// =====================================================================

function buildSystemPrompt(): string {
  return `你是一位资深的市场投放预算规划专家，擅长为没有专业市场部的品牌客户进行科学预算预估。

你必须输出**严格有效的 JSON**，不要包含任何 Markdown 代码块标记或额外说明文字。

预算预估五步法：
1. **目标人群规模**：TA目标人群在既定市场的规模测算 = 市场规模 × TA渗透率
2. **曝光渠道预估**：覆盖TA目标人群需要的达人博主组合 = 目标人群 × 单人曝光频次 / 达人平均曝光量
3. **竞对稀释系数**：竞对投放后忠诚转化人群稀释排除 = 考虑竞品投放对目标人群的覆盖重叠，计算净可触达人群
4. **曝光转化预估**：单人曝光六次可以成为品牌人群，计算有效转化人数 = 净可触达人群 × 曝光转化率
5. **销售占比校验**：投放预算 = 年度销售目标 × 投放占比（15-20%），校验预算是否支撑曝光需求

输出 JSON Schema：
{
  "step1_target_audience_sizing": {
    "total_market_size": 1000000,
    "ta_penetration_rate": 5,
    "ta_population": 50000,
    "ta_description": "目标人群描述",
    "calculation_note": "计算说明"
  },
  "step2_exposure_channel_estimate": {
    "exposure_frequency": 6,
    "total_exposures_needed": 300000,
    "avg_kol_exposure_per_post": 50000,
    "kol_posts_needed": 6,
    "kol_mix_recommendation": {
      "head_kols": {"count": 1, "exposure_per_post": 200000, "total_exposure": 200000},
      "waist_kols": {"count": 3, "exposure_per_post": 30000, "total_exposure": 90000},
      "koc": {"count": 10, "exposure_per_post": 1000, "total_exposure": 10000}
    },
    "platform_allocation": {"小红书": 60, "抖音": 40}
  },
  "step3_competitor_dilution": {
    "competitor_spend_estimate": 500,
    "market_overlap_rate": 30,
    "dilution_coefficient": 0.7,
    "net_reachable_audience": 35000,
    "calculation_note": "竞品投放稀释后净可触达人群"
  },
  "step4_exposure_conversion": {
    "exposure_frequency": 6,
    "conversion_rate": 2,
    "net_reachable_audience": 35000,
    "estimated_conversions": 700,
    "estimated_revenue": 700,
    "calculation_note": "有效曝光转化预估"
  },
  "step5_sales_ratio_validation": {
    "annual_sales_target": 5000,
    "budget_ratio": 18,
    "recommended_budget": 900,
    "cost_per_exposure": 3,
    "total_exposure_cost": 900,
    "budget_sufficiency": "充足/紧张/不足",
    "validation_note": "投放预算占销售目标比例校验"
  },
  "budget_summary": {
    "total_recommended_budget": 900,
    "budget_breakdown": {
      "head_kols": 400,
      "waist_kols": 350,
      "koc": 100,
      "content_production": 50
    },
    "roi_estimate": "预期ROI"
  },
  "risk_warnings": [
    {"risk": "风险描述", "mitigation": "应对措施"}
  ],
  "recommendations": [
    "建议1",
    "建议2"
  ]
}`
}

function buildUserPrompt(params: {
  brand: string
  product: string
  marketSize: number
  taDescription: string
  taPenetrationRate: number
  annualSalesTarget: number
  competitorSpendEstimate: number
  exposureFrequency: number
  conversionRate: number
  budgetRatio: number
  preferredPlatforms: string[]
}): string {
  const parts: string[] = [
    `请为以下品牌进行市场投放预算预估：`,
    ``,
    `品牌：${params.brand}`,
    `产品：${params.product}`,
    `目标市场总规模：${params.marketSize.toLocaleString()} 人/户`,
    `目标人群描述：${params.taDescription}`,
    `目标人群渗透率：${params.taPenetrationRate}%`,
    `年度销售目标：${params.annualSalesTarget} 万元`,
    `首选投放平台：${params.preferredPlatforms.join('、')}`,
  ]

  if (params.competitorSpendEstimate > 0) {
    parts.push(`主要竞品预估年度投放额：${params.competitorSpendEstimate} 万元`)
  }

  parts.push(`单人有效曝光频次：${params.exposureFrequency} 次`)
  parts.push(`预估曝光转化率：${params.conversionRate}%`)
  parts.push(`投放占销售额比例：${params.budgetRatio}%`)
  parts.push(``)
  parts.push(`请严格按照五步法进行预算预估，输出完整 JSON。`)
  parts.push(`注意：所有金额单位均为万元，人数单位为实际人数。`)
  parts.push(`达人平均曝光量估算：头部达人 20万/篇，腰部达人 3万/篇，KOC 1000/篇。`)

  return parts.join('\n')
}

// =====================================================================
// 结果格式化
// =====================================================================

function formatBudgetForecastResult(
  forecast: Record<string, unknown>,
  brand: string,
  product: string,
  params: {
    marketSize: number
    taPenetrationRate: number
    annualSalesTarget: number
    competitorSpendEstimate: number
    exposureFrequency: number
    conversionRate: number
    budgetRatio: number
    preferredPlatforms: string[]
  },
): string {
  const parts: string[] = []
  parts.push(`# ${brand} · ${product} — 市场投放预算预估报告`)
  parts.push('')
  parts.push(`**目标市场**：${params.marketSize.toLocaleString()} 人/户 | **TA 渗透率**：${params.taPenetrationRate}% | **销售目标**：${params.annualSalesTarget} 万元 | **投放占比**：${params.budgetRatio}%`)
  parts.push('')

  // Step 1: 目标人群规模
  const step1 = forecast.step1_target_audience_sizing as Record<string, unknown> | undefined
  if (step1) {
    parts.push('## 1️⃣ 目标人群规模测算')
    parts.push('')
    parts.push(`| 指标 | 数值 | 说明 |`)
    parts.push(`|------|------|------|`)
    parts.push(`| 目标市场总规模 | ${(step1.total_market_size as number)?.toLocaleString() ?? '-'} 人 | 既定市场的总人群规模 |`)
    parts.push(`| TA 渗透率 | ${step1.ta_penetration_rate ?? '-'}% | 目标人群占市场比例 |`)
    parts.push(`| **TA 目标人群** | **${(step1.ta_population as number)?.toLocaleString() ?? '-'} 人** | 市场规模 × 渗透率 |`)
    if (step1.ta_description) {
      parts.push(`| TA 画像 | ${step1.ta_description} | 目标人群特征 |`)
    }
    if (step1.calculation_note) {
      parts.push(`| 计算说明 | ${step1.calculation_note} | - |`)
    }
    parts.push('')
  }

  // Step 2: 曝光渠道预估
  const step2 = forecast.step2_exposure_channel_estimate as Record<string, unknown> | undefined
  if (step2) {
    parts.push('## 2️⃣ 曝光渠道与达人组合预估')
    parts.push('')
    parts.push(`- **总曝光需求**：${(step2.total_exposures_needed as number)?.toLocaleString() ?? '-'} 次（TA 人群 × ${params.exposureFrequency} 次有效曝光）`)
    parts.push(`- **达人笔记需求**：约 ${step2.kol_posts_needed ?? '-'} 篇`)
    parts.push(`- **达人平均曝光/篇**：${(step2.avg_kol_exposure_per_post as number)?.toLocaleString() ?? '-'} 次`)
    parts.push('')

    const kolMix = step2.kol_mix_recommendation as Record<string, Record<string, unknown>> | undefined
    if (kolMix) {
      parts.push('### 推荐达人组合')
      parts.push('')
      parts.push(`| 层级 | 数量 | 单篇曝光 | 总曝光 |`)
      parts.push(`|------|------|----------|--------|`)
      if (kolMix.head_kols) {
        parts.push(`| 头部达人 | ${kolMix.head_kols.count ?? '-'} 位 | ${(kolMix.head_kols.exposure_per_post as number)?.toLocaleString() ?? '-'} | ${(kolMix.head_kols.total_exposure as number)?.toLocaleString() ?? '-'} |`)
      }
      if (kolMix.waist_kols) {
        parts.push(`| 腰部达人 | ${kolMix.waist_kols.count ?? '-'} 位 | ${(kolMix.waist_kols.exposure_per_post as number)?.toLocaleString() ?? '-'} | ${(kolMix.waist_kols.total_exposure as number)?.toLocaleString() ?? '-'} |`)
      }
      if (kolMix.koc) {
        parts.push(`| KOC | ${kolMix.koc.count ?? '-'} 位 | ${(kolMix.koc.exposure_per_post as number)?.toLocaleString() ?? '-'} | ${(kolMix.koc.total_exposure as number)?.toLocaleString() ?? '-'} |`)
      }
      parts.push('')
    }

    const platformAlloc = step2.platform_allocation as Record<string, number> | undefined
    if (platformAlloc && Object.keys(platformAlloc).length > 0) {
      parts.push('### 平台曝光分配')
      parts.push('')
      for (const [platform, ratio] of Object.entries(platformAlloc)) {
        parts.push(`- ${platform}：${ratio}%`)
      }
      parts.push('')
    }
  }

  // Step 3: 竞对稀释系数
  const step3 = forecast.step3_competitor_dilution as Record<string, unknown> | undefined
  if (step3) {
    parts.push('## 3️⃣ 竞对稀释系数计算')
    parts.push('')
    if (params.competitorSpendEstimate > 0) {
      parts.push(`- **竞品预估投放额**：${params.competitorSpendEstimate} 万元`)
    }
    parts.push(`- **市场重叠率**：${step3.market_overlap_rate ?? '-'}%`)
    parts.push(`- **稀释系数**：${step3.dilution_coefficient ?? '-'}`)
    parts.push(`- **净可触达人群**：**${(step3.net_reachable_audience as number)?.toLocaleString() ?? '-'} 人**（稀释后）`)
    if (step3.calculation_note) {
      parts.push(`- *${step3.calculation_note}*`)
    }
    parts.push('')
  }

  // Step 4: 曝光转化预估
  const step4 = forecast.step4_exposure_conversion as Record<string, unknown> | undefined
  if (step4) {
    parts.push('## 4️⃣ 曝光转化预估')
    parts.push('')
    parts.push(`- **有效曝光频次**：${step4.exposure_frequency ?? '-'} 次/人`)
    parts.push(`- **曝光转化率**：${step4.conversion_rate ?? '-'}%`)
    parts.push(`- **净可触达人群**：${(step4.net_reachable_audience as number)?.toLocaleString() ?? '-'} 人`)
    parts.push(`- **预估转化人数**：**${(step4.estimated_conversions as number)?.toLocaleString() ?? '-'} 人**`)
    parts.push(`- **预估转化销售额**：${step4.estimated_revenue ?? '-'} 万元`)
    if (step4.calculation_note) {
      parts.push(`- *${step4.calculation_note}*`)
    }
    parts.push('')
  }

  // Step 5: 销售占比校验
  const step5 = forecast.step5_sales_ratio_validation as Record<string, unknown> | undefined
  if (step5) {
    parts.push('## 5️⃣ 销售占比校验')
    parts.push('')
    parts.push(`| 指标 | 数值 | 说明 |`)
    parts.push(`|------|------|------|`)
    parts.push(`| 年度销售目标 | ${step5.annual_sales_target ?? '-'} 万元 | 品牌年度销售目标 |`)
    parts.push(`| 投放占比 | ${step5.budget_ratio ?? '-'}% | 投放占销售额比例 |`)
    parts.push(`| **推荐投放预算** | **${step5.recommended_budget ?? '-'} 万元** | 销售目标 × 投放占比 |`)
    parts.push(`| 单次曝光成本 | ${step5.cost_per_exposure ?? '-'} 元 | 预算/总曝光需求 |`)
    parts.push(`| 总曝光成本 | ${step5.total_exposure_cost ?? '-'} 万元 | 覆盖TA所需成本 |`)
    parts.push(`| 预算充足度 | ${step5.budget_sufficiency ?? '-'} | 预算与需求对比 |`)
    if (step5.validation_note) {
      parts.push(`| 校验说明 | ${step5.validation_note} | - |`)
    }
    parts.push('')
  }

  // 预算汇总
  const summary = forecast.budget_summary as Record<string, unknown> | undefined
  if (summary) {
    parts.push('## 💰 预算汇总与分配建议')
    parts.push('')
    parts.push(`### 总推荐预算：${summary.total_recommended_budget ?? '-'} 万元`)
    parts.push('')

    const breakdown = summary.budget_breakdown as Record<string, number> | undefined
    if (breakdown) {
      parts.push('### 预算分配明细')
      parts.push('')
      parts.push(`| 项目 | 预算（万元） | 占比 |`)
      parts.push(`|------|-------------|------|`)
      const total = summary.total_recommended_budget as number ?? 1
      for (const [item, amount] of Object.entries(breakdown)) {
        const pct = total > 0 ? Math.round((amount / total) * 100) : 0
        const itemName = item === 'head_kols' ? '头部达人' : item === 'waist_kols' ? '腰部达人' : item === 'koc' ? 'KOC/素人' : item === 'content_production' ? '内容制作' : item
        parts.push(`| ${itemName} | ${amount} | ${pct}% |`)
      }
      parts.push('')
    }

    if (summary.roi_estimate) {
      parts.push(`### ROI 预估`)
      parts.push(`- ${summary.roi_estimate}`)
      parts.push('')
    }
  }

  // 风险提示
  const risks = forecast.risk_warnings as Array<Record<string, unknown>> | undefined
  if (risks && risks.length > 0) {
    parts.push('## ⚠️ 风险因素与应对')
    parts.push('')
    for (const r of risks) {
      parts.push(`- **${r.risk ?? '风险'}**：${r.mitigation ?? '待补充'}`)
    }
    parts.push('')
  }

  // 建议
  const recommendations = forecast.recommendations as string[] | undefined
  if (recommendations && recommendations.length > 0) {
    parts.push('## 💡 专家建议')
    parts.push('')
    for (let i = 0; i < recommendations.length; i++) {
      parts.push(`${i + 1}. ${recommendations[i]}`)
    }
    parts.push('')
  }

  return parts.join('\n')
}

function formatBudgetForecastText(text: string, brand: string, product: string): string {
  return `# ${brand} · ${product} — 市场投放预算预估\n\n${text}`
}
