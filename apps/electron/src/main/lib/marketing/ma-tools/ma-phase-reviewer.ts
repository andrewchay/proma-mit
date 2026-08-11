/**
 * PhaseReviewer - 阶段复盘助手（Chat Tool）
 *
 * 基于 Campaign 阶段投放数据，自动生成复盘报告。
 * Slice 2: AI 分析由 generatePhaseReport 内部完成，本工具提供 Chat 入口。
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@gravitas/core'
import type { ChatToolMeta } from '@gravitas/shared'

// =====================================================================
// 工具元数据
// =====================================================================

export const PHASE_REVIEWER_TOOL_META: ChatToolMeta = {
  id: 'ma-phase-reviewer',
  name: 'MA阶段复盘',
  description: '基于 Campaign 阶段投放数据，自动生成复盘报告（汇总数据、AI 分析、优化建议、放量建议）',
  params: [
    { name: 'campaign_id', type: 'string', description: 'Campaign ID', required: true },
    { name: 'phase', type: 'string', description: '阶段序号 (1/2/3)', required: true },
    { name: 'start_date', type: 'string', description: '复盘开始日期 (YYYY-MM-DD)', required: true },
    { name: 'end_date', type: 'string', description: '复盘结束日期 (YYYY-MM-DD)', required: true },
    { name: 'cpm_target', type: 'number', description: 'CPM 目标值（可选）', required: false },
    { name: 'engagement_target', type: 'number', description: '互动率目标值（可选，百分比）', required: false },
  ],
  icon: 'TrendingUp',
  category: 'builtin',
  executorType: 'builtin',
  systemPromptAppend: `
<ma_phase_reviewer_instructions>
你拥有 **MA阶段复盘** 能力（PhaseReviewer）。

**ma_generate_phase_report — 生成阶段复盘报告：**
当用户需要复盘某阶段投放数据时调用：
- 自动汇总该阶段所有 KOL 内容数据
- 计算核心指标：CPM、CPE、CTR、互动率
- 与基准数据对比，判定性能等级
- 识别表现最佳/最差的内容和 KOL
- 输出结构化复盘报告（含 AI 分析、核心发现、优化建议、放量建议）

**参数说明：**
- campaign_id: Campaign 的唯一 ID
- phase: 阶段序号（1/2/3，对应 campaign.phasePlans 中的阶段定义）
- start_date / end_date: 复盘的时间范围
- cpm_target: 可选，CPM 目标值（如 100）
- engagement_target: 可选，互动率目标值（如 5 表示 5%）

工具会返回完整的复盘报告，包含数据汇总、AI 分析、优化建议和放量建议。
</ma_phase_reviewer_instructions>`,
}

export const PHASE_REVIEWER_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'ma_generate_phase_report',
    description: 'Generate a phase review report based on campaign phase data. Summarizes KOL content performance, calculates metrics (CPM, CPE, CTR, engagement rate), and provides AI analysis with optimization suggestions and scaling recommendations. Use when the user needs to review campaign phase performance, analyze influencer content data, or get recommendations for the next phase.',
    parameters: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Campaign ID' },
        phase: { type: 'string', description: 'Phase number (1/2/3)' },
        start_date: { type: 'string', description: 'Review start date (YYYY-MM-DD)' },
        end_date: { type: 'string', description: 'Review end date (YYYY-MM-DD)' },
        cpm_target: { type: 'number', description: 'Target CPM value (optional)' },
        engagement_target: { type: 'number', description: 'Target engagement rate in percentage (optional)' },
      },
      required: ['campaign_id', 'phase', 'start_date', 'end_date'],
    },
  },
]

// =====================================================================
// 可用性检查
// =====================================================================

export function isPhaseReviewerAvailable(): boolean {
  return true
}

// =====================================================================
// 工具执行
// =====================================================================

const TOOL_NAME = 'ma_generate_phase_report'

export function isPhaseReviewerToolCall(toolName: string): boolean {
  return toolName === TOOL_NAME
}

export async function executePhaseReviewerTool(toolCall: ToolCall): Promise<ToolResult> {
  try {
    const args = toolCall.arguments as Record<string, unknown>
    const campaignId = String(args.campaign_id ?? '')
    const phase = Number(args.phase ?? 1)
    const startDate = String(args.start_date ?? '')
    const endDate = String(args.end_date ?? '')

    if (!campaignId || !startDate || !endDate) {
      return { toolCallId: toolCall.id, content: '参数缺失: campaign_id、start_date 和 end_date 为必填项', isError: true }
    }

    const cpmTarget = args.cpm_target !== undefined ? Number(args.cpm_target) : undefined
    const engagementTarget = args.engagement_target !== undefined ? Number(args.engagement_target) : undefined

    // 调用主进程服务生成报告
    const { generatePhaseReport } = await import('../../campaign-manager')
    const report = await generatePhaseReport({
      campaignId,
      phase,
      reportType: 'phase',
      startDate,
      endDate,
      cpmTarget,
      engagementTarget,
    })

    const parts: string[] = []
    parts.push(`# 第 ${report.phase} 阶段复盘报告`)
    parts.push('')
    parts.push(`**时间范围**：${report.startDate} ~ ${report.endDate}`)
    parts.push(`**KOL 数量**：${report.totalKols} 位 · **内容数**：${report.totalPosts} 篇`)
    parts.push('')

    // 数据汇总
    parts.push('## 📊 数据汇总')
    parts.push(`- 总曝光：${report.totalExposure.toLocaleString()}`)
    parts.push(`- 总浏览：${report.totalViews.toLocaleString()}`)
    parts.push(`- 总点赞：${report.totalLikes.toLocaleString()}`)
    parts.push(`- 总收藏：${report.totalSaves.toLocaleString()}`)
    parts.push(`- 总评论：${report.totalComments.toLocaleString()}`)
    parts.push(`- 总转发：${report.totalShares.toLocaleString()}`)
    parts.push(`- 平均 CPM：¥${report.avgCpm.toFixed(2)}`)
    parts.push(`- 平均 CPE：¥${report.avgCpe.toFixed(2)}`)
    parts.push(`- 平均 CTR：${report.avgCtr.toFixed(2)}%`)
    parts.push(`- 平均互动率：${report.avgEngagementRate.toFixed(2)}%`)
    parts.push('')

    // AI 分析
    if (report.aiSummary) {
      parts.push('## 🤖 AI 复盘分析')
      parts.push(report.aiSummary)
      parts.push('')
    }

    if (report.aiFindings.length > 0) {
      parts.push('### 🔍 核心发现')
      for (const finding of report.aiFindings) {
        parts.push(`- ${finding}`)
      }
      parts.push('')
    }

    if (report.aiRecommendations.length > 0) {
      parts.push('### 💡 优化建议')
      for (const rec of report.aiRecommendations) {
        parts.push(`- ${rec}`)
      }
      parts.push('')
    }

    if (report.aiScaleAdvice) {
      parts.push('### 🚀 放量建议')
      parts.push(report.aiScaleAdvice)
      parts.push('')
    }

    // 目标达成
    if (report.cpmTarget > 0) {
      parts.push(`**CPM 目标**：${report.cpmTargetAchieved ? '✅ 已达成' : '❌ 未达成'}`)
    }
    if (report.engagementTarget > 0) {
      parts.push(`**互动率目标**：${report.engagementTargetAchieved ? '✅ 已达成' : '❌ 未达成'}`)
    }

    return { toolCallId: toolCall.id, content: parts.join('\n') }

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[PhaseReviewer] 执行失败:', error)
    return { toolCallId: toolCall.id, content: `阶段复盘报告生成错误: ${msg}`, isError: true }
  }
}
