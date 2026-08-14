/**
 * CampaignTester - 投放测试助手（Chat Tool）
 *
 * 设计小规模投放测试方案（A/B测试），帮助媒介总监在正式投放前验证达人组合效果。
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@gravitas/core'
import { completePrompt, extractJSON } from './llm-service'

// =====================================================================
// 工具元数据
// =====================================================================


export const CAMPAIGN_TESTER_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'ma_design_campaign_test',
    description: 'Design a small-scale campaign test plan (A/B test) to validate KOL combination and content strategy before full deployment. Use when the user needs to test influencer marketing effectiveness, validate budget allocation, or run pre-launch experiments.',
    parameters: {
      type: 'object',
      properties: {
        brand: { type: 'string', description: 'Brand name' },
        product: { type: 'string', description: 'Product name' },
        budget: { type: 'string', description: 'Test budget in ten-thousands CNY (万元)' },
        platforms: { type: 'string', description: 'Test platforms, comma separated (e.g. xiaohongshu,douyin)' },
        kol_count: { type: 'string', description: 'Number of KOLs for testing (default 3-5)' },
        test_duration: { type: 'string', description: 'Test duration in days (default 7)' },
        target_metrics: { type: 'string', description: 'Target metrics (exposure/engagement/conversion, default engagement)' },
        content_type: { type: 'string', description: 'Content type (default image_text+video)' },
      },
      required: ['brand', 'product', 'budget', 'platforms'],
    },
  },
]

// =====================================================================
// 工具执行
// =====================================================================



export async function executeCampaignTesterTool(toolCall: ToolCall): Promise<ToolResult> {
  try {
    const args = toolCall.arguments as Record<string, unknown>
    const brand = String(args.brand ?? '')
    const product = String(args.product ?? '')
    const budget = String(args.budget ?? '')
    const platforms = String(args.platforms ?? '')

    if (!brand || !product || !budget || !platforms) {
      return { toolCallId: toolCall.id, content: '参数缺失: brand、product、budget 和 platforms 为必填项', isError: true }
    }

    const kolCount = String(args.kol_count ?? '3-5')
    const testDuration = String(args.test_duration ?? '7')
    const targetMetrics = String(args.target_metrics ?? '互动')
    const contentType = String(args.content_type ?? '图文+视频')

    const systemPrompt = `你是一位资深的媒介投放策略专家，曾在大型广告代理公司和品牌方担任媒介总监。

请基于品牌需求、预算和平台特性，设计一份科学的小规模投放测试方案（A/B测试）。

**设计原则：**
1. **控制变量**：每次测试只改变一个关键变量（达人层级/内容形式/平台策略）
2. **预算合理**：测试预算应控制在总预算的 5-10%，但足以获得统计学意义的数据
3. **时间充分**：测试周期需覆盖内容发布、数据积累、效果稳定三个阶段
4. **指标明确**：设定清晰的 KPI 和判定标准，避免"感觉不错"的模糊结论
5. **风险可控**：预留止损机制和应急预案

**输出格式（严格 JSON）：**
{
  "test_design": {
    "test_name": "测试方案名称",
    "objective": "测试目标",
    "hypothesis": "假设"
  },
  "budget_allocation": {
    "total": 10,
    "per_kol": 2,
    "platform_split": {"小红书": 60, "抖音": 40}
  },
  "kol_selection_criteria": {
    "tier_mix": "1头部+2腰部",
    "content_style": "真实体验型",
    "requirements": ["要求1"]
  },
  "content_strategy": {
    "variations": ["变体A描述", "变体B描述"],
    "test_variables": ["测试变量1"]
  },
  "timeline": {
    "phase_1": "第1-2天：内容发布",
    "phase_2": "第3-5天：数据观察",
    "phase_3": "第6-7天：结果分析"
  },
  "success_criteria": {
    "primary_metric": "CPE < 5元",
    "secondary_metrics": ["互动率 > 5%"]
  },
  "risk_mitigation": ["风险1及应对措施"]
}`

    const userPrompt = buildTestPrompt({
      brand, product, budget, platforms, kolCount, testDuration, targetMetrics, contentType,
    })

    const result = await completePrompt(userPrompt, systemPrompt, {
      jsonMode: true,
      temperature: 0.6,
      maxTokens: 6000,
    })

    if (!result.success) {
      return { toolCallId: toolCall.id, content: `投放测试方案生成失败: ${result.error}`, isError: true }
    }

    let testPlan: Record<string, unknown>
    try {
      testPlan = extractJSON(result.text) as Record<string, unknown>
    } catch {
      return { toolCallId: toolCall.id, content: formatTestText(result.text, brand, product) }
    }

    const formatted = formatTestResult(testPlan, brand, product, budget, platforms, testDuration)
    return { toolCallId: toolCall.id, content: formatted }

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[CampaignTester] 执行失败:', error)
    return { toolCallId: toolCall.id, content: `投放测试方案生成错误: ${msg}`, isError: true }
  }
}

// =====================================================================
// Prompt 构建
// =====================================================================

function buildTestPrompt(params: {
  brand: string
  product: string
  budget: string
  platforms: string
  kolCount: string
  testDuration: string
  targetMetrics: string
  contentType: string
}): string {
  const platformList = params.platforms.split(',').map((s) => s.trim()).filter(Boolean)

  const parts: string[] = [
    `请为以下品牌设计小规模投放测试方案：`,
    ``,
    `品牌：${params.brand}`,
    `产品：${params.product}`,
    `测试预算：${params.budget} 万元`,
    `测试平台：${platformList.join('、')}`,
    `测试达人数量：${params.kolCount} 人`,
    `测试周期：${params.testDuration} 天`,
    `目标指标：${params.targetMetrics}`,
    `内容类型：${params.contentType}`,
    ``,
    `请设计一份科学的 A/B 测试方案，包含预算分配、达人选择策略、内容变体设计、时间线和成功判定标准。`,
  ]

  return parts.join('\n')
}

// =====================================================================
// 结果格式化
// =====================================================================

function formatTestResult(
  testPlan: Record<string, unknown>,
  brand: string,
  product: string,
  budget: string,
  platforms: string,
  testDuration: string,
): string {
  const parts: string[] = []
  const platformList = platforms.split(',').map((s) => s.trim()).filter(Boolean)

  // 标题
  parts.push(`# ${brand} · ${product} — 投放测试方案`)
  parts.push(`*预算：${budget} 万元 | 平台：${platformList.join('、')} | 周期：${testDuration} 天*`)
  parts.push('')

  // 测试设计
  const testDesign = testPlan.test_design as Record<string, unknown> | undefined
  if (testDesign) {
    parts.push(`## 🎯 测试设计`)
    if (testDesign.test_name) parts.push(`**方案名称**：${testDesign.test_name}`)
    if (testDesign.objective) parts.push(`**测试目标**：${testDesign.objective}`)
    if (testDesign.hypothesis) parts.push(`**核心假设**：${testDesign.hypothesis}`)
    parts.push('')
  }

  // 预算分配
  const budgetAllocation = testPlan.budget_allocation as Record<string, unknown> | undefined
  if (budgetAllocation) {
    parts.push(`## 💰 预算分配`)
    const total = budgetAllocation.total as number | undefined
    if (total !== undefined) parts.push(`**总预算**：${total} 万元`)
    const perKol = budgetAllocation.per_kol as number | undefined
    if (perKol !== undefined) parts.push(`**单达人预算**：${perKol} 万元`)

    const platformSplit = budgetAllocation.platform_split as Record<string, number> | undefined
    if (platformSplit && Object.keys(platformSplit).length > 0) {
      parts.push(`**平台分配**：`)
      for (const [platform, pct] of Object.entries(platformSplit)) {
        parts.push(`  - ${platform}：${pct}%`)
      }
    }
    parts.push('')
  }

  // 达人选择标准
  const kolCriteria = testPlan.kol_selection_criteria as Record<string, unknown> | undefined
  if (kolCriteria) {
    parts.push(`## 👥 达人选择标准`)
    if (kolCriteria.tier_mix) parts.push(`**层级配比**：${kolCriteria.tier_mix}`)
    if (kolCriteria.content_style) parts.push(`**内容风格**：${kolCriteria.content_style}`)

    const requirements = kolCriteria.requirements as string[] | undefined
    if (requirements && requirements.length > 0) {
      parts.push(`**筛选要求**：`)
      for (const req of requirements) parts.push(`  - ${req}`)
    }
    parts.push('')
  }

  // 内容策略
  const contentStrategy = testPlan.content_strategy as Record<string, unknown> | undefined
  if (contentStrategy) {
    parts.push(`## 📝 内容策略`)

    const variations = contentStrategy.variations as string[] | undefined
    if (variations && variations.length > 0) {
      parts.push(`**内容变体**：`)
      for (let i = 0; i < variations.length; i++) {
        parts.push(`  - 变体 ${String.fromCharCode(65 + i)}：${variations[i]}`)
      }
    }

    const testVariables = contentStrategy.test_variables as string[] | undefined
    if (testVariables && testVariables.length > 0) {
      parts.push(`**测试变量**：`)
      for (const v of testVariables) parts.push(`  - ${v}`)
    }
    parts.push('')
  }

  // 时间线
  const timeline = testPlan.timeline as Record<string, unknown> | undefined
  if (timeline) {
    parts.push(`## 📅 执行时间线`)
    const phases = ['phase_1', 'phase_2', 'phase_3', 'phase_4', 'phase_5']
    for (const phase of phases) {
      const desc = timeline[phase] as string | undefined
      if (desc) parts.push(`- ${desc}`)
    }
    parts.push('')
  }

  // 成功标准
  const successCriteria = testPlan.success_criteria as Record<string, unknown> | undefined
  if (successCriteria) {
    parts.push(`## ✅ 成功判定标准`)
    if (successCriteria.primary_metric) parts.push(`**核心指标**：${successCriteria.primary_metric}`)

    const secondaryMetrics = successCriteria.secondary_metrics as string[] | undefined
    if (secondaryMetrics && secondaryMetrics.length > 0) {
      parts.push(`**辅助指标**：`)
      for (const m of secondaryMetrics) parts.push(`  - ${m}`)
    }
    parts.push('')
  }

  // 风险应对
  const riskMitigation = testPlan.risk_mitigation as string[] | undefined
  if (riskMitigation && riskMitigation.length > 0) {
    parts.push(`## ⚠️ 风险识别与应对`)
    for (let i = 0; i < riskMitigation.length; i++) {
      parts.push(`${i + 1}. ${riskMitigation[i]}`)
    }
    parts.push('')
  }

  // 决策建议
  parts.push(`---`)
  parts.push(`**测试后决策建议**：`)
  parts.push(`- 若核心指标达成：扩大预算，复制成功模式到全量投放`)
  parts.push(`- 若核心指标接近：优化内容/达人组合后追加测试`)
  parts.push(`- 若核心指标未达成：复盘假设，调整策略后重新测试`)
  parts.push('')

  return parts.join('\n')
}

function formatTestText(text: string, brand: string, product: string): string {
  return `# ${brand} · ${product} — 投放测试方案\n\n${text}`
}
