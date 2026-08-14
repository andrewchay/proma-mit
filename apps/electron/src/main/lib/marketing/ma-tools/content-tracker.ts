/**
 * ContentTracker - 内容数据追踪助手（Chat Tool）
 *
 * 分析 KOL 投放内容的自然流数据、判断性能等级、给出投流建议和优化策略。
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@gravitas/core'
import {
  analyzeContentPerformanceAI,
  createContentTracking,
  getContentTracking,
  listContentTracking,
} from '../../campaign-manager'
import { completePrompt, extractJSON } from './llm-service'

// =====================================================================
// 工具元数据
// =====================================================================


export const CONTENT_TRACKER_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'ma_analyze_content_performance',
    description: 'Analyze KOL content performance data (organic traffic). Compare with benchmarks and give grade + traffic boost recommendations. Use when user asks to evaluate content performance, analyze data, check metrics, or optimize content strategy.',
    parameters: {
      type: 'object',
      properties: {
        content_id: { type: 'string', description: 'Content tracking record ID' },
        campaign_id: { type: 'string', description: 'Campaign ID (alternative to content_id)' },
        kol_id: { type: 'string', description: 'KOL ID (required if using campaign_id)' },
        platform: { type: 'string', description: 'Platform (xiaohongshu/douyin/weibo)' },
        price_tier: { type: 'string', description: 'Price tier: budget, mid, premium, luxury' },
        followers_range: { type: 'string', description: 'Followers range: 1k-10k, 10k-100k, 100k-1m, 1m+' },
      },
      required: ['content_id'],
    },
  },
  {
    name: 'ma_suggest_traffic_strategy',
    description: 'Suggest paid traffic boost strategy based on content performance data. Recommend薯条, 评论区维护, or DOU+ depending on metrics and budget.',
    parameters: {
      type: 'object',
      properties: {
        content_id: { type: 'string', description: 'Content tracking record ID' },
        performance_grade: { type: 'string', description: 'Performance grade: excellent, good, normal, poor' },
        current_cpm: { type: 'number', description: 'Current CPM value' },
        current_cpe: { type: 'number', description: 'Current CPE value' },
        platform: { type: 'string', description: 'Platform name' },
        budget: { type: 'number', description: 'Available budget for boosting' },
      },
      required: ['content_id'],
    },
  },
  {
    name: 'ma_add_content_tracking',
    description: 'Add a new content tracking record for KOL collaboration. Auto-calculates CPM, CPE, CTR, engagement rate.',
    parameters: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Campaign ID' },
        kol_id: { type: 'string', description: 'KOL ID' },
        kol_name: { type: 'string', description: 'KOL name' },
        platform: { type: 'string', description: 'Platform' },
        content_url: { type: 'string', description: 'Content URL' },
        content_type: { type: 'string', description: 'Content type: organic, paid, mixed' },
        publish_date: { type: 'string', description: 'Publish date (YYYY-MM-DD)' },
        exposure: { type: 'number', description: 'Exposure count' },
        views: { type: 'number', description: 'Views count' },
        likes: { type: 'number', description: 'Likes count' },
        saves: { type: 'number', description: 'Saves count' },
        comments: { type: 'number', description: 'Comments count' },
        shares: { type: 'number', description: 'Shares count' },
        completion_rate: { type: 'number', description: 'Completion rate (optional)' },
        data_source: { type: 'string', description: 'Data source: api, manual, screenshot, estimated' },
        paid_spend: { type: 'number', description: 'Paid spend amount (optional)' },
      },
      required: ['campaign_id', 'kol_id', 'kol_name', 'platform', 'content_url', 'content_type', 'publish_date', 'exposure', 'views', 'likes', 'saves', 'comments', 'shares', 'data_source'],
    },
  },
  {
    name: 'ma_get_content_benchmarks',
    description: 'Get content performance benchmarks for a specific platform, price tier, and followers range.',
    parameters: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'Platform name' },
        price_tier: { type: 'string', description: 'Price tier: budget, mid, premium, luxury' },
        followers_range: { type: 'string', description: 'Followers range' },
      },
      required: ['platform'],
    },
  },
]

// =====================================================================
// 工具执行
// =====================================================================

const ANALYZE_TOOL = 'ma_analyze_content_performance'
const STRATEGY_TOOL = 'ma_suggest_traffic_strategy'
const ADD_TRACKING_TOOL = 'ma_add_content_tracking'
const GET_BENCHMARKS_TOOL = 'ma_get_content_benchmarks'


export async function executeContentTrackerTool(toolCall: ToolCall): Promise<ToolResult> {
  try {
    const args = toolCall.arguments as Record<string, unknown>

    switch (toolCall.name) {
      case ANALYZE_TOOL:
        return await executeAnalyzeTool(toolCall, args)
      case STRATEGY_TOOL:
        return await executeStrategyTool(toolCall, args)
      case ADD_TRACKING_TOOL:
        return await executeAddTrackingTool(toolCall, args)
      case GET_BENCHMARKS_TOOL:
        return await executeGetBenchmarksTool(toolCall, args)
      default:
        return { toolCallId: toolCall.id, content: `未知工具: ${toolCall.name}`, isError: true }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[ContentTracker] 执行失败:', error)
    return { toolCallId: toolCall.id, content: `内容数据追踪错误: ${msg}`, isError: true }
  }
}

async function executeAnalyzeTool(toolCall: ToolCall, args: Record<string, unknown>): Promise<ToolResult> {
  const contentId = String(args.content_id ?? '')
  const campaignId = String(args.campaign_id ?? '')
  const kolId = String(args.kol_id ?? '')
  const platform = String(args.platform ?? '小红书')
  const priceTier = String(args.price_tier ?? 'mid')
  const followersRange = String(args.followers_range ?? '100k-1m')

  // 如果只有 campaign_id + kol_id，尝试查找对应记录
  let targetId = contentId
  if (!targetId && campaignId && kolId) {
    const records = listContentTracking(campaignId)
    const match = records.find((r) => r.kolId === kolId)
    if (match) targetId = match.id
  }

  if (!targetId) {
    return { toolCallId: toolCall.id, content: '错误: 未提供 content_id，且未找到对应 campaign + kol 的追踪记录', isError: true }
  }

  const result = await analyzeContentPerformanceAI(targetId, platform, priceTier, followersRange)

  if (!result.success || !result.result) {
    return { toolCallId: toolCall.id, content: `分析失败: ${result.error ?? '未知错误'}`, isError: true }
  }

  const tracking = result.result
  const formatted = formatAnalysisReport(tracking)
  return { toolCallId: toolCall.id, content: formatted }
}

async function executeStrategyTool(toolCall: ToolCall, args: Record<string, unknown>): Promise<ToolResult> {
  const contentId = String(args.content_id ?? '')
  const budget = Number(args.budget ?? 0)
  const platform = String(args.platform ?? '小红书')

  if (!contentId) {
    return { toolCallId: toolCall.id, content: '错误: content_id 为必填项', isError: true }
  }

  const tracking = getContentTracking(contentId)
  if (!tracking) {
    return { toolCallId: toolCall.id, content: `未找到内容追踪记录: ${contentId}`, isError: true }
  }

  const systemPrompt = `你是一位资深社交媒体投放优化师，擅长根据内容数据给出精准的投流加热策略。`

  const userPrompt = `基于以下数据给出投流策略建议：

平台：${platform}
KOL：${tracking.kolName}
当前等级：${tracking.performanceGrade}

核心指标：
- CTR：${tracking.ctr.toFixed(2)}%
- 互动率：${tracking.engagementRate.toFixed(2)}%
- CPM：${tracking.cpm.toFixed(2)} 元
- CPE：${tracking.cpe.toFixed(2)} 元

可用预算：${budget > 0 ? `${budget} 元` : '未指定'}

请给出：
1. 是否值得投流加热（是/否/观望）
2. 推荐加热方式（薯条/DOU+/评论区维护/信息流投放）及预算分配
3. 预期效果与风险提示
4. 加热时机建议（发布后多久）`

  const llmResult = await completePrompt(userPrompt, systemPrompt, {
    temperature: 0.7,
    maxTokens: 3000,
  })

  if (!llmResult.success) {
    return { toolCallId: toolCall.id, content: `策略生成失败: ${llmResult.error}`, isError: true }
  }

  return { toolCallId: toolCall.id, content: llmResult.text }
}

async function executeAddTrackingTool(toolCall: ToolCall, args: Record<string, unknown>): Promise<ToolResult> {
  const campaignId = String(args.campaign_id ?? '')
  const kolId = String(args.kol_id ?? '')
  const kolName = String(args.kol_name ?? '')
  const platform = String(args.platform ?? '')
  const contentUrl = String(args.content_url ?? '')
  const contentType = String(args.content_type ?? 'organic') as 'organic' | 'paid' | 'mixed'
  const publishDate = String(args.publish_date ?? '')
  const exposure = Number(args.exposure ?? 0)
  const views = Number(args.views ?? 0)
  const likes = Number(args.likes ?? 0)
  const saves = Number(args.saves ?? 0)
  const comments = Number(args.comments ?? 0)
  const shares = Number(args.shares ?? 0)
  const completionRate = args.completion_rate != null ? Number(args.completion_rate) : undefined
  const dataSource = String(args.data_source ?? 'manual') as 'api' | 'manual' | 'screenshot' | 'estimated'
  const paidSpend = args.paid_spend != null ? Number(args.paid_spend) : undefined

  if (!campaignId || !kolId || !kolName || !platform || !contentUrl || !publishDate) {
    return { toolCallId: toolCall.id, content: '错误: campaign_id, kol_id, kol_name, platform, content_url, publish_date 为必填项', isError: true }
  }

  const record = createContentTracking({
    campaignId,
    kolId,
    kolName,
    platform,
    contentUrl,
    contentType,
    publishDate,
    exposure,
    views,
    likes,
    saves,
    comments,
    shares,
    completionRate,
    dataSource,
    paidSpend,
  })

  if (!record) {
    return { toolCallId: toolCall.id, content: '创建内容追踪记录失败', isError: true }
  }

  const formatted = formatNewRecordSummary(record)
  return { toolCallId: toolCall.id, content: formatted }
}

async function executeGetBenchmarksTool(toolCall: ToolCall, args: Record<string, unknown>): Promise<ToolResult> {
  const platform = String(args.platform ?? '小红书')
  const priceTier = String(args.price_tier ?? '')
  const followersRange = String(args.followers_range ?? '')

  const systemPrompt = `你是一位社交媒体投放数据专家，熟悉各平台各价格带的数据基准。`
  const userPrompt = `请整理以下平台的数据基准标准：

平台：${platform}
${priceTier ? `价格带：${priceTier}` : ''}
${followersRange ? `粉丝范围：${followersRange}` : ''}

请按指标（CTR / 互动率 / CPM / CPE）列出各等级的阈值，并给出投放建议。`

  const llmResult = await completePrompt(userPrompt, systemPrompt, {
    temperature: 0.5,
    maxTokens: 3000,
  })

  if (!llmResult.success) {
    return { toolCallId: toolCall.id, content: `获取基准失败: ${llmResult.error}`, isError: true }
  }

  return { toolCallId: toolCall.id, content: llmResult.text }
}

// =====================================================================
// 结果格式化
// =====================================================================

function formatAnalysisReport(tracking: import('@gravitas/shared').KOLContentTracking): string {
  const parts: string[] = []

  parts.push(`# 📊 ${tracking.kolName} — 内容数据追踪报告`)
  parts.push('')
  parts.push(`- **平台**：${tracking.platform}`)
  parts.push(`- **内容类型**：${tracking.contentType}`)
  parts.push(`- **发布日期**：${tracking.publishDate}`)
  parts.push(`- **内容链接**：[查看](${tracking.contentUrl})`)
  parts.push('')

  parts.push(`## 📈 核心数据`)
  parts.push(`| 指标 | 数值 |`)
  parts.push(`|------|------|`)
  parts.push(`| 曝光量 | ${tracking.exposure.toLocaleString()} |`)
  parts.push(`| 浏览量 | ${tracking.views.toLocaleString()} |`)
  parts.push(`| 点赞 | ${tracking.likes.toLocaleString()} |`)
  parts.push(`| 收藏 | ${tracking.saves.toLocaleString()} |`)
  parts.push(`| 评论 | ${tracking.comments.toLocaleString()} |`)
  parts.push(`| 转发 | ${tracking.shares.toLocaleString()} |`)
  if (tracking.completionRate != null) {
    parts.push(`| 完播率 | ${tracking.completionRate.toFixed(1)}% |`)
  }
  parts.push('')

  parts.push(`## 🔢 计算指标`)
  parts.push(`| 指标 | 数值 | 含义 |`)
  parts.push(`|------|------|------|`)
  parts.push(`| CTR | ${tracking.ctr.toFixed(2)}% | 浏览/曝光 |`)
  parts.push(`| 互动率 | ${tracking.engagementRate.toFixed(2)}% | 总互动/曝光 |`)
  parts.push(`| CPM | ${tracking.cpm.toFixed(2)} 元 | 千次曝光成本 |`)
  parts.push(`| CPE | ${tracking.cpe.toFixed(2)} 元 | 单次互动成本 |`)
  parts.push('')

  parts.push(`## 🏆 性能判定：${getGradeLabel(tracking.performanceGrade)}`)
  parts.push('')

  if (tracking.benchmarkComparison) {
    parts.push(`### 基准对比`)
    parts.push('```json')
    parts.push(tracking.benchmarkComparison)
    parts.push('```')
    parts.push('')
  }

  if (tracking.aiAnalysis) {
    parts.push(`## 🤖 AI 分析`)
    parts.push(tracking.aiAnalysis)
    parts.push('')
  }

  if (tracking.recommendations) {
    parts.push(`## 💡 优化建议`)
    parts.push(tracking.recommendations)
    parts.push('')
  }

  if (tracking.paidSpend > 0) {
    parts.push(`## 💰 投流数据`)
    parts.push(`- 投流花费：${tracking.paidSpend.toLocaleString()} 元`)
    parts.push(`- 投流曝光：${tracking.paidExposure.toLocaleString()}`)
    parts.push(`- 投流浏览：${tracking.paidViews.toLocaleString()}`)
    parts.push(`- 投流点赞：${tracking.paidLikes.toLocaleString()}`)
    parts.push('')
  }

  parts.push(`---`)
  parts.push(`*数据回收时间：${new Date(tracking.collectedAt).toLocaleString()} · 来源：${tracking.dataSource}*`)
  parts.push('')

  return parts.join('\n')
}

function formatNewRecordSummary(record: import('@gravitas/shared').KOLContentTracking): string {
  return `# ✅ 内容追踪记录已创建

- **记录 ID**：${record.id}
- **KOL**：${record.kolName}
- **平台**：${record.platform}
- **内容链接**：[查看](${record.contentUrl})

**核心指标**：
- CTR：${record.ctr.toFixed(2)}%
- 互动率：${record.engagementRate.toFixed(2)}%
- CPM：${record.cpm.toFixed(2)} 元
- CPE：${record.cpe.toFixed(2)} 元

*已自动计算 CPM/CPE/CTR/Engagement Rate，可通过分析工具进一步评估性能等级。*
`
}

function getGradeLabel(grade: string): string {
  const labels: Record<string, string> = {
    excellent: '优秀 🟢',
    good: '良好 🟡',
    normal: '一般 🔵',
    poor: '较差 🔴',
    pending: '待分析 ⏳',
  }
  return labels[grade] ?? grade
}
