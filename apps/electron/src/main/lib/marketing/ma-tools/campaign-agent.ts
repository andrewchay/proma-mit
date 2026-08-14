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
// 工具执行
// =====================================================================



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
