/**
 * ConnectBot - 智能建联与协作代理（Chat Tool）
 *
 * 为品牌生成个性化的 KOL 合作邀约话术和谈判策略。
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@gravitas/core'
import type { ChatToolMeta } from '@gravitas/shared'
import { completePrompt, extractJSON } from './llm-service'
import { getKOLById } from './kol-data-service'

// =====================================================================
// 工具元数据
// =====================================================================

export const CONNECT_BOT_TOOL_META: ChatToolMeta = {
  id: 'ma-connect-bot',
  name: 'MA智能建联',
  description: '生成个性化的KOL合作邀约话术、谈判策略和合同条款建议',
  params: [
    { name: 'kol_name', type: 'string', description: 'KOL名称', required: true },
    { name: 'kol_id', type: 'string', description: 'KOL ID（可选，用于从数据库读取详情）', required: false },
    { name: 'brand', type: 'string', description: '品牌名称', required: true },
    { name: 'product', type: 'string', description: '产品名称', required: true },
    { name: 'platform', type: 'string', description: '合作平台', required: false },
    { name: 'cooperation_type', type: 'string', description: '合作形式（内容合作/直播带货/品牌代言）', required: false },
    { name: 'budget_range', type: 'string', description: '预算范围', required: false },
    { name: 'style', type: 'string', description: '话术风格（formal/casual/professional）', required: false },
    { name: 'strategy_context', type: 'string', description: '传播策略背景（如Big Idea、传播主题）', required: false },
  ],
  icon: 'MessageSquare',
  category: 'builtin',
  executorType: 'builtin',
  systemPromptAppend: `
<ma_connect_bot_instructions>
你拥有 **MA智能建联** 能力（ConnectBot）。

**ma_generate_outreach — 生成建联话术：**
当用户需要联系 KOL、生成邀约话术时调用：
- 生成个性化的 KOL 合作邀约
- 提供谈判策略建议
- 生成合同条款模板
- 提供跟进计划

工具会返回完整的邀约话术（主题/开场/正文/谈判/收尾）和谈判建议。
</ma_connect_bot_instructions>`,
}

export const CONNECT_BOT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'ma_generate_outreach',
    description: 'Generate personalized KOL outreach messages and negotiation strategies. Returns a complete outreach template including subject, opening, body, negotiation points, and closing. Use when the user needs to contact KOLs, craft cooperation invitations, or needs negotiation advice.',
    parameters: {
      type: 'object',
      properties: {
        kol_name: { type: 'string', description: 'KOL name' },
        kol_id: { type: 'string', description: 'KOL ID (optional, for fetching details from database)' },
        brand: { type: 'string', description: 'Brand name' },
        product: { type: 'string', description: 'Product name' },
        platform: { type: 'string', description: 'Cooperation platform' },
        cooperation_type: { type: 'string', description: 'Cooperation type (content/直播/代言)' },
        budget_range: { type: 'string', description: 'Budget range' },
        style: { type: 'string', description: 'Message style (formal/casual/professional)', enum: ['formal', 'casual', 'professional'] },
        strategy_context: { type: 'string', description: 'Campaign strategy context (Big Idea, theme, etc.)' },
      },
      required: ['kol_name', 'brand', 'product'],
    },
  },
]

// =====================================================================
// 可用性检查
// =====================================================================

export function isConnectBotAvailable(): boolean {
  return true
}

// =====================================================================
// 工具执行
// =====================================================================

const TOOL_NAME = 'ma_generate_outreach'

export function isConnectBotToolCall(toolName: string): boolean {
  return toolName === TOOL_NAME
}

export async function executeConnectBotTool(toolCall: ToolCall): Promise<ToolResult> {
  try {
    const args = toolCall.arguments as Record<string, unknown>
    const kolName = String(args.kol_name ?? '')
    const brand = String(args.brand ?? '')
    const product = String(args.product ?? '')

    if (!kolName || !brand || !product) {
      return { toolCallId: toolCall.id, content: '参数缺失: kol_name、brand 和 product 为必填项', isError: true }
    }

    const kolId = String(args.kol_id ?? '')
    const platform = String(args.platform ?? '小红书')
    const cooperationType = String(args.cooperation_type ?? '内容合作')
    const budgetRange = String(args.budget_range ?? '面议')
    const style = String(args.style ?? 'professional') as 'formal' | 'casual' | 'professional'
    const strategyContext = String(args.strategy_context ?? '')

    // 尝试从数据库读取 KOL 详情
    let kolProfile: Record<string, unknown> = { name: kolName, platform }
    if (kolId) {
      const dbKol = getKOLById(kolId)
      if (dbKol) {
        kolProfile = {
          name: dbKol.name,
          platform: dbKol.platform,
          followers: dbKol.followers,
          engagement: dbKol.engagement,
          category: dbKol.category,
          city: dbKol.city,
        }
      }
    }

    const systemPrompt = `你是一位资深的 KOL 商务合作专家，拥有丰富的达人合作谈判经验。

请根据提供的 KOL 信息和品牌信息，撰写一封个性化的合作邀约。

**输出格式（严格 JSON）：**
{
  "subject": "邮件/私信主题（简短有力）",
  "opening": "开场白：称呼+破冰+表达对其内容的认可（1-2句话）",
  "body": "合作内容：品牌介绍+产品卖点+合作形式+契合点说明（2-3句话）",
  "negotiation": "价格与条款：预算范围+可协商空间+额外权益（1-2句话）",
  "closing": "收尾：期待回复+下一步建议+礼貌结束（1句话）",
  "strategy_alignment": "该KOL与传播策略的契合点（1-2句话）",
  "content_direction": "建议的内容创作方向（1-2句话）",
  "tips": ["谈判建议1", "谈判建议2", "谈判建议3"],
  "contact_discovery_checklist": ["邮箱", "微信", "站内私信"],
  "required_confirmation_fields": ["传播期匹配", "合作权益", "报价区间"]
}

**风格要求：**
- formal: 正式商务风格，专业严谨
- casual: 轻松友好风格，像朋友聊天
- professional: 专业但不失亲切，平衡商务与友好（默认）`

    const userPrompt = buildOutreachPrompt({
      kolName, kolProfile, brand, product, platform,
      cooperationType, budgetRange, style, strategyContext,
    })

    const result = await completePrompt(userPrompt, systemPrompt, {
      jsonMode: true,
      temperature: 0.7,
      maxTokens: 4000,
    })

    if (!result.success) {
      return { toolCallId: toolCall.id, content: `建联话术生成失败: ${result.error}`, isError: true }
    }

    let outreach: Record<string, unknown>
    try {
      outreach = extractJSON(result.text) as Record<string, unknown>
    } catch {
      return { toolCallId: toolCall.id, content: formatOutreachText(result.text, kolName, brand) }
    }

    const formatted = formatOutreachResult(outreach, kolName, brand)
    return { toolCallId: toolCall.id, content: formatted }

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[ConnectBot] 执行失败:', error)
    return { toolCallId: toolCall.id, content: `建联话术生成错误: ${msg}`, isError: true }
  }
}

// =====================================================================
// Prompt 构建
// =====================================================================

function buildOutreachPrompt(params: {
  kolName: string
  kolProfile: Record<string, unknown>
  brand: string
  product: string
  platform: string
  cooperationType: string
  budgetRange: string
  style: string
  strategyContext: string
}): string {
  const parts: string[] = [
    `请为以下品牌撰写给 KOL 的合作邀约：`,
    ``,
    `KOL信息：`,
    `- 名称：${params.kolName}`,
    `- 平台：${params.platform}`,
  ]

  if (params.kolProfile.followers) parts.push(`- 粉丝量：${params.kolProfile.followers}`)
  if (params.kolProfile.engagement) parts.push(`- 互动率：${params.kolProfile.engagement}`)
  if (params.kolProfile.category) parts.push(`- 内容领域：${params.kolProfile.category}`)
  if (params.kolProfile.city) parts.push(`- 城市：${params.kolProfile.city}`)

  parts.push(`\n品牌信息：`)
  parts.push(`- 品牌：${params.brand}`)
  parts.push(`- 产品：${params.product}`)
  parts.push(`- 合作形式：${params.cooperationType}`)
  parts.push(`- 预算范围：${params.budgetRange}`)
  parts.push(`- 话术风格：${params.style}`)

  if (params.strategyContext) {
    parts.push(`\n传播策略背景：${params.strategyContext}`)
  }

  parts.push(`\n请撰写个性化的合作邀约，要体现对 KOL 内容的了解和尊重。`)
  return parts.join('\n')
}

// =====================================================================
// 结果格式化
// =====================================================================

function formatOutreachResult(outreach: Record<string, unknown>, kolName: string, brand: string): string {
  const parts: string[] = []
  parts.push(`# ${brand} → ${kolName} 合作邀约话术`)
  parts.push('')

  if (outreach.subject) {
    parts.push(`## 📧 主题`)
    parts.push(String(outreach.subject))
    parts.push('')
  }

  if (outreach.opening) {
    parts.push(`## 👋 开场白`)
    parts.push(String(outreach.opening))
    parts.push('')
  }

  if (outreach.body) {
    parts.push(`## 📝 合作内容`)
    parts.push(String(outreach.body))
    parts.push('')
  }

  if (outreach.negotiation) {
    parts.push(`## 💰 价格与条款`)
    parts.push(String(outreach.negotiation))
    parts.push('')
  }

  if (outreach.closing) {
    parts.push(`## 🙏 收尾`)
    parts.push(String(outreach.closing))
    parts.push('')
  }

  if (outreach.strategy_alignment) {
    parts.push(`## 🎯 策略契合点`)
    parts.push(String(outreach.strategy_alignment))
    parts.push('')
  }

  if (outreach.content_direction) {
    parts.push(`## ✨ 内容方向建议`)
    parts.push(String(outreach.content_direction))
    parts.push('')
  }

  const tips = outreach.tips as string[] | undefined
  if (tips && tips.length > 0) {
    parts.push(`## 💡 谈判建议`)
    for (const tip of tips) parts.push(`- ${tip}`)
    parts.push('')
  }

  const checklist = outreach.contact_discovery_checklist as string[] | undefined
  if (checklist && checklist.length > 0) {
    parts.push(`## 📋 联系方式获取清单`)
    for (const item of checklist) parts.push(`- [ ] ${item}`)
    parts.push('')
  }

  const required = outreach.required_confirmation_fields as string[] | undefined
  if (required && required.length > 0) {
    parts.push(`## ✅ 确认事项`)
    for (const item of required) parts.push(`- [ ] ${item}`)
    parts.push('')
  }

  return parts.join('\n')
}

function formatOutreachText(text: string, kolName: string, brand: string): string {
  return `# ${brand} → ${kolName} 合作邀约话术\n\n${text}`
}
