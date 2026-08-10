/**
 * CampaignAgent — Campaign 专属管理工具（Chat Tool）
 *
 * 让 AI Agent 可以通过对话读取和修改 Campaign 数据：
 * - 获取 Campaign 详情
 * - 修改 Campaign 基本信息
 * - 获取/修改 KOL Brief
 * - 获取/修改 KOL 候选池状态
 * - 导入 KOL 到候选池
 * - 触发内容审核
 *
 * 绑定到 Campaign 详情页的聊天面板中使用。
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@gravitas/core'
import type { ChatToolMeta } from '@gravitas/shared'
import {
  getCampaignById,
  getPoolKOLs,
  getBrief,
  saveBrief,
  createContentAudit,
  importKOLsToPool,
} from '../../campaign-manager'

// =====================================================================
// 工具元数据
// =====================================================================

export const CAMPAIGN_AGENT_TOOL_META: ChatToolMeta = {
  id: 'ma-campaign-agent',
  name: 'MA Campaign 管理',
  description: '通过对话读取和修改 Campaign 数据：获取详情、修改信息、管理KOL Brief、导入KOL、触发审核等。专为 Campaign 内嵌聊天面板设计。',
  params: [
    { name: 'action', type: 'string', description: '操作类型：get_campaign/update_campaign/get_brief/update_brief/get_kols/add_kols/update_kol_status/audit_content', required: true },
    { name: 'campaign_id', type: 'string', description: 'Campaign ID', required: true },
    { name: 'data', type: 'string', description: 'JSON 格式的操作数据', required: false },
  ],
  icon: 'Target',
  category: 'builtin',
  executorType: 'builtin',
  systemPromptAppend: `
<ma_campaign_agent_instructions>
你拥有 **MA Campaign 管理** 能力（CampaignAgent）。

你可以通过对话直接读取和修改 Campaign 数据：
- **ma_campaign_get** — 获取 Campaign 详情
- **ma_campaign_update** — 修改 Campaign 名称、品牌、品类、预算、周期、阶段、状态
- **ma_campaign_brief_get** — 获取 KOL 的 Brief
- **ma_campaign_brief_update** — 修改 KOL 的 Brief
- **ma_campaign_kol_list** — 获取 KOL 候选池列表
- **ma_campaign_kol_add** — 将 KOL 从数据库导入到 Campaign 候选池（插入新记录）
- **ma_campaign_kol_status** — 修改已有 KOL 在候选池中的状态
- **ma_campaign_audit** — 触发内容审核

当用户要求导入 KOL 到候选池时，使用 ma_campaign_kol_add 工具批量导入（提供 kol_id 数组）。
当用户要求修改 Campaign 数据时，先读取当前数据，然后执行修改，最后确认修改结果。

**信息补全规则**：
用户新建 Campaign 时可能只填写了项目名称和品牌名，其余字段（投放平台、预算、投放周期、目标城市、目标人群）可能尚未提供。在协助用户推进 Campaign 之前，请先通过 **ma_campaign_get** 检查这些关键信息是否完整。若发现以下情况，应主动、一次性地向用户提问补充，而不是直接假设或编造：
- 平台未指定或显示为默认值：询问计划投放小红书、抖音还是双平台。
- 预算为 0 或未填写：询问总预算金额（元）。
- 投放周期为 0 或未填写：询问计划投放几个月。
- 目标城市为空：询问重点投放哪些城市。
- 目标人群为空：询问目标受众画像（年龄、性别、兴趣、生活状态等）。

提问时语气友好简洁，一次可以问 1-3 个相关问题，并在用户回答后使用 **ma_campaign_update** 更新到 Campaign 中。
</ma_campaign_agent_instructions>`,
}

export const CAMPAIGN_AGENT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'ma_campaign_get',
    description: 'Get campaign details by ID. Returns full campaign info including name, brand, category, budget, dates, phase, status, and all KOL pool data.',
    parameters: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Campaign ID' },
      },
      required: ['campaign_id'],
    },
  },
  {
    name: 'ma_campaign_update',
    description: 'Update campaign basic information. Fields: name, brand, category, budget, start_date, end_date, status, current_phase.',
    parameters: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Campaign ID' },
        name: { type: 'string', description: 'New campaign name' },
        brand: { type: 'string', description: 'Brand name' },
        category: { type: 'string', description: 'Product category' },
        budget: { type: 'number', description: 'Budget in 万元' },
        start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        end_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
        status: { type: 'string', description: 'Status: draft/active/paused/completed/cancelled' },
        current_phase: { type: 'number', description: 'Current phase (1-3)' },
      },
      required: ['campaign_id'],
    },
  },
  {
    name: 'ma_campaign_brief_get',
    description: 'Get KOL brief by campaign ID and KOL ID.',
    parameters: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Campaign ID' },
        kol_id: { type: 'string', description: 'KOL ID' },
      },
      required: ['campaign_id', 'kol_id'],
    },
  },
  {
    name: 'ma_campaign_brief_update',
    description: 'Update KOL brief content.',
    parameters: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Campaign ID' },
        kol_id: { type: 'string', description: 'KOL ID' },
        content: { type: 'string', description: 'New brief content (markdown)' },
      },
      required: ['campaign_id', 'kol_id', 'content'],
    },
  },
  {
    name: 'ma_campaign_kol_list',
    description: 'Get all KOLs in the campaign pool.',
    parameters: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Campaign ID' },
      },
      required: ['campaign_id'],
    },
  },
  {
    name: 'ma_campaign_kol_add',
    description: 'Import KOLs from the database into the campaign pool. KOLs that already exist in the pool will be skipped. Returns how many were actually imported.',
    parameters: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Campaign ID' },
        kol_ids: { type: 'string', description: 'Comma-separated list of KOL IDs to import (e.g. "kol1,kol2,kol3")' },
      },
      required: ['campaign_id', 'kol_ids'],
    },
  },
  {
    name: 'ma_campaign_kol_status',
    description: 'Update KOL status in the campaign pool.',
    parameters: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Campaign ID' },
        kol_id: { type: 'string', description: 'KOL ID' },
        status: { type: 'string', description: 'New status: candidate/shortlisted/contacted/confirmed/completed/rejected' },
      },
      required: ['campaign_id', 'kol_id', 'status'],
    },
  },
  {
    name: 'ma_campaign_audit',
    description: 'Trigger content audit for a KOL.',
    parameters: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Campaign ID' },
        kol_id: { type: 'string', description: 'KOL ID' },
        kol_name: { type: 'string', description: 'KOL name' },
        brand: { type: 'string', description: 'Brand name' },
        platform: { type: 'string', description: 'Platform' },
        content_description: { type: 'string', description: 'Content description' },
      },
      required: ['campaign_id', 'kol_id', 'kol_name', 'brand', 'platform', 'content_description'],
    },
  },
]

// =====================================================================
// 可用性检查
// =====================================================================

export function isCampaignAgentAvailable(): boolean {
  return true
}

// =====================================================================
// 工具执行
// =====================================================================

const TOOL_NAMES = [
  'ma_campaign_get',
  'ma_campaign_update',
  'ma_campaign_brief_get',
  'ma_campaign_brief_update',
  'ma_campaign_kol_list',
  'ma_campaign_kol_add',
  'ma_campaign_kol_status',
  'ma_campaign_audit',
]

export function isCampaignAgentToolCall(toolName: string): boolean {
  return TOOL_NAMES.includes(toolName)
}

export async function executeCampaignAgentTool(tc: ToolCall): Promise<ToolResult> {
  try {
    const args = tc.arguments as Record<string, unknown>
    const campaignId = String(args.campaign_id ?? '')

    switch (tc.name) {
      case 'ma_campaign_get': {
        const campaign = getCampaignById(campaignId)
        if (!campaign) {
          return { toolCallId: tc.id, content: 'Campaign not found', isError: true }
        }
        const kols = getPoolKOLs(campaignId)
        return {
          toolCallId: tc.id,
          content: JSON.stringify({ campaign, kols: kols.length, kolList: kols }, null, 2),
        }
      }

      case 'ma_campaign_update': {
        // 更新 Campaign 信息
        const db = getDb()
        const updateFields: string[] = []
        const values: (string | number)[] = []

        const fieldMap: Record<string, string> = {
          name: 'name',
          brand: 'brand',
          category: 'category',
          budget: 'budget',
          start_date: 'start_date',
          end_date: 'end_date',
          status: 'status',
          current_phase: 'current_phase',
        }

        for (const [key, dbKey] of Object.entries(fieldMap)) {
          if (args[key] !== undefined) {
            updateFields.push(`${dbKey} = ?`)
            values.push(args[key] as string | number)
          }
        }

        if (updateFields.length === 0) {
          return { toolCallId: tc.id, content: 'No fields to update', isError: true }
        }

        updateFields.push('updated_at = ?')
        values.push(Date.now())
        values.push(campaignId)

        db.run(`UPDATE campaigns SET ${updateFields.join(', ')} WHERE id = ?`, values)
        const updated = getCampaignById(campaignId)
        return {
          toolCallId: tc.id,
          content: JSON.stringify({ updated: !!updated, campaign: updated }, null, 2),
        }
      }

      case 'ma_campaign_brief_get': {
        const kolId = String(args.kol_id ?? '')
        const brief = getBrief(campaignId, kolId)
        return {
          toolCallId: tc.id,
          content: brief
            ? JSON.stringify(brief, null, 2)
            : 'No brief found for this KOL',
        }
      }

      case 'ma_campaign_brief_update': {
        const kolId = String(args.kol_id ?? '')
        const content = String(args.content ?? '')
        if (!content) {
          return { toolCallId: tc.id, content: 'Content is required', isError: true }
        }
        const brief = saveBrief({
          campaignId,
          kolId,
          kolName: String(args.kol_name ?? kolId),
          content,
          aiGenerated: false,
        })
        return {
          toolCallId: tc.id,
          content: JSON.stringify({ saved: true, brief }, null, 2),
        }
      }

      case 'ma_campaign_kol_list': {
        const kols = getPoolKOLs(campaignId)
        return {
          toolCallId: tc.id,
          content: JSON.stringify(kols, null, 2),
        }
      }

      case 'ma_campaign_kol_add': {
        const kolIdsRaw = String(args.kol_ids ?? '')
        const kolIds = kolIdsRaw.split(',').map(s => s.trim()).filter(Boolean)
        if (kolIds.length === 0) {
          return { toolCallId: tc.id, content: 'kol_ids must be a non-empty comma-separated list', isError: true }
        }
        const result = importKOLsToPool({ campaignId, kolIds })
        return {
          toolCallId: tc.id,
          content: JSON.stringify({ imported: result.imported, totalRequested: kolIds.length }, null, 2),
        }
      }

      case 'ma_campaign_kol_status': {
        const kolId = String(args.kol_id ?? '')
        const status = String(args.status ?? '')
        const db = getDb()
        db.run(
          'UPDATE campaign_kol_pool SET status = ?, updated_at = ? WHERE campaign_id = ? AND kol_id = ?',
          status,
          Date.now(),
          campaignId,
          kolId,
        )
        return {
          toolCallId: tc.id,
          content: JSON.stringify({ campaignId, kolId, status }, null, 2),
        }
      }

      case 'ma_campaign_audit': {
        const kolId = String(args.kol_id ?? '')
        const kolName = String(args.kol_name ?? '')
        const brand = String(args.brand ?? '')
        const platform = String(args.platform ?? '')
        const contentDescription = String(args.content_description ?? '')
        const result = await createContentAudit({
          campaignId,
          kolId,
          kolName,
          brand,
          product: brand,
          platform,
          contentType: '图文',
          contentDescription,
        })
        return {
          toolCallId: tc.id,
          content: result
            ? JSON.stringify({ auditId: result.auditId, status: result.auditStatus, overallScore: result.overallScore }, null, 2)
            : 'Audit failed',
          isError: !result,
        }
      }

      default:
        return { toolCallId: tc.id, content: `Unknown action: ${tc.name}`, isError: true }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { toolCallId: tc.id, content: msg, isError: true }
  }
}

// 辅助函数：需要导入 getDb
import { getDb } from '../../campaign-manager'
