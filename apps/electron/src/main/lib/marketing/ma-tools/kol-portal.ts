/**
 * KOL 达人端门户工具（Chat Tool）
 *
 * 面向外部达人的自助服务工具。
 * 包括：入会信息查看/更新、内容创作指导、个人效果看板、平台分层查询。
 *
 * 数据库位置：~/.mapro/kol-database.sqlite
 * 相关表：kols, kol_crm, kol_performance
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@gravitas/core'
import type { ChatToolMeta } from '@gravitas/shared'
import { getConfigDir } from '../../config-paths'
import { join } from 'node:path'

// =====================================================================
// SQLite 运行时适配层（复用 kol-data-service.ts 模式）
// =====================================================================

let _nativeDb: { Database: new (path: string) => unknown } | null = null

function loadEngine(): { Database: new (path: string) => unknown } {
  if (typeof Bun !== 'undefined') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('bun:' + 'sqlite')
      return { Database: mod.Database }
    } catch {
      // fall through to better-sqlite3
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return { Database: require('better-sqlite3') }
}

function getEngine(): { Database: new (path: string) => unknown } {
  if (!_nativeDb) {
    _nativeDb = loadEngine()
  }
  return _nativeDb
}

/** 统一 Database API */
class Database {
  private db: unknown

  constructor(path: string) {
    const { Database: NativeDb } = getEngine()
    this.db = new NativeDb(path)
  }

  run(sql: string, ...params: unknown[]): { changes: number } {
    const flat = flattenParams(params)
    if (flat.length === 0) {
      ;(this.db as { exec: (sql: string) => void }).exec(sql)
      return { changes: 0 }
    }
    return (this.db as { prepare: (sql: string) => { run: (...p: unknown[]) => { changes: number } } }).prepare(sql).run(...flat)
  }

  query(sql: string) {
    const stmt = (this.db as { prepare: (sql: string) => unknown }).prepare(sql)
    return {
      get: (...params: unknown[]) => {
        const result = (stmt as { get: (...p: unknown[]) => unknown }).get(...flattenParams(params))
        return result ?? null
      },
      all: (...params: unknown[]) => {
        return (stmt as { all: (...p: unknown[]) => unknown[] }).all(...flattenParams(params))
      },
    }
  }

  close(): void {
    ;(this.db as { close: () => void }).close()
  }
}

function flattenParams(params: unknown[]): unknown[] {
  if (params.length === 1 && Array.isArray(params[0])) {
    return params[0]
  }
  return params
}

// =====================================================================
// 数据库连接
// =====================================================================

let dbInstance: Database | null = null

function getDb(): Database {
  if (dbInstance) return dbInstance

  const dbPath = join(getConfigDir(), 'kol-database.sqlite')
  dbInstance = new Database(dbPath)

  // 确保达人端资料表存在
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS kol_portal_profiles (
      kol_id TEXT PRIMARY KEY,
      bio TEXT,
      specialties TEXT,
      content_style TEXT,
      audience_demo TEXT,
      collaboration_preferences TEXT,
      availability TEXT DEFAULT 'open',
      onboarding_completed INTEGER DEFAULT 0,
      tier_level TEXT DEFAULT 'bronze',
      tier_points INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    )
  `)

  // 内容指导记录表
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS kol_content_guidance (
      guidance_id TEXT PRIMARY KEY,
      kol_id TEXT NOT NULL,
      campaign_id TEXT,
      brief_summary TEXT,
      content_tips TEXT,
      brand_dos TEXT,
      brand_donts TEXT,
      deadline TEXT,
      status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    )
  `)

  return dbInstance
}

// =====================================================================
// 工具元数据
// =====================================================================

export const KOL_PORTAL_TOOL_META: ChatToolMeta = {
  id: 'ma-kol-portal',
  name: 'MA达人端',
  description: '达人端自助服务：入会资料管理、内容创作指导、个人效果看板、平台分层查询',
  params: [
    { name: 'action', type: 'string', description: '操作类型：get_profile(查看资料)/update_profile(更新资料)/get_content_guidance(获取内容指导)/get_my_performance(个人效果看板)/get_platform_tier(平台分层信息)/list_my_campaigns(我的合作活动)', required: true },
    { name: 'kol_id', type: 'string', description: '达人ID（必填）', required: true },
    { name: 'data', type: 'string', description: '更新数据JSON字符串（update_profile时需要）', required: false },
    { name: 'campaign_id', type: 'string', description: '活动ID（获取内容指导时需要）', required: false },
    { name: 'limit', type: 'number', description: '返回数量限制（默认10）', required: false },
  ],
  icon: 'UserCircle',
  category: 'builtin',
  executorType: 'builtin',
  systemPromptAppend: `
<ma_kol_portal_instructions>
你拥有 **MA达人端** 能力（KOLPortal）。

**ma_kol_portal — 达人端自助服务：**
当达人需要查看自己的资料、获取内容创作指导、查看合作效果或了解平台分层时调用。

支持的操作：
- \`get_profile\` — 查看达人完整资料（基础信息 + CRM + 达人端资料）
- \`update_profile\` — 更新达人端资料（专长、内容风格、受众画像等）
- \`get_content_guidance\` — 获取指定活动的内容创作指导（brief解读、创作建议）
- \`get_my_performance\` — 查看个人效果数据看板（历史合作、数据汇总）
- \`get_platform_tier\` — 查看平台分层信息和当前等级权益
- \`list_my_campaigns\` — 列出达人参与的所有合作活动

注意：
- \`data\` 参数必须是有效的JSON字符串
- 达人端面向外部达人用户，语气应友好、专业
- 本工具直接操作本地数据库，无需调用外部API
</ma_kol_portal_instructions>`,
}

export const KOL_PORTAL_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'ma_kol_portal',
    description: 'KOL self-service portal for profile management, content guidance, performance dashboard, and platform tier info. Direct database operations without LLM calls. Use when the KOL needs to view/update their profile, get content brief guidance, check performance stats, or query platform tier benefits.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get_profile', 'update_profile', 'get_content_guidance', 'get_my_performance', 'get_platform_tier', 'list_my_campaigns'],
          description: 'Operation type: get_profile (view full profile), update_profile (update KOL profile), get_content_guidance (get content brief and tips), get_my_performance (performance dashboard), get_platform_tier (platform tier info), list_my_campaigns (list participated campaigns)',
        },
        kol_id: { type: 'string', description: 'KOL ID (required for all actions)' },
        data: { type: 'string', description: 'JSON string of fields to update (required for update_profile, e.g. {"bio":"专注美妆测评","specialties":"护肤,彩妆"})' },
        campaign_id: { type: 'string', description: 'Campaign ID (required for get_content_guidance)' },
        limit: { type: 'number', description: 'Result limit (default 10)' },
      },
      required: ['action', 'kol_id'],
    },
  },
]

// =====================================================================
// 可用性检查
// =====================================================================

export function isKOLPortalAvailable(): boolean {
  return true
}

// =====================================================================
// 工具执行
// =====================================================================

const TOOL_NAME = 'ma_kol_portal'

export function isKOLPortalToolCall(toolName: string): boolean {
  return toolName === TOOL_NAME
}

export async function executeKOLPortalTool(toolCall: ToolCall): Promise<ToolResult> {
  try {
    const args = toolCall.arguments as Record<string, unknown>
    const action = String(args.action ?? '')
    const kolId = args.kol_id ? String(args.kol_id) : undefined

    if (!action) {
      return { toolCallId: toolCall.id, content: '参数缺失: action 为必填项', isError: true }
    }
    if (!kolId) {
      return { toolCallId: toolCall.id, content: '参数缺失: kol_id 为所有操作的必填项', isError: true }
    }

    const dataStr = args.data ? String(args.data) : undefined
    const campaignId = args.campaign_id ? String(args.campaign_id) : undefined
    const limit = typeof args.limit === 'number' ? args.limit : 10

    switch (action) {
      case 'get_profile':
        return { toolCallId: toolCall.id, content: await handleGetProfile(kolId) }

      case 'update_profile':
        if (!dataStr) {
          return { toolCallId: toolCall.id, content: '参数缺失: data 为 update_profile 的必填项', isError: true }
        }
        return { toolCallId: toolCall.id, content: await handleUpdateProfile(kolId, dataStr) }

      case 'get_content_guidance':
        if (!campaignId) {
          return { toolCallId: toolCall.id, content: '参数缺失: campaign_id 为 get_content_guidance 的必填项', isError: true }
        }
        return { toolCallId: toolCall.id, content: await handleGetContentGuidance(kolId, campaignId) }

      case 'get_my_performance':
        return { toolCallId: toolCall.id, content: await handleGetMyPerformance(kolId, limit) }

      case 'get_platform_tier':
        return { toolCallId: toolCall.id, content: await handleGetPlatformTier(kolId) }

      case 'list_my_campaigns':
        return { toolCallId: toolCall.id, content: await handleListMyCampaigns(kolId, limit) }

      default:
        return { toolCallId: toolCall.id, content: `不支持的操作类型: ${action}`, isError: true }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[KOLPortal] 执行失败:', error)
    return { toolCallId: toolCall.id, content: `达人端操作错误: ${msg}`, isError: true }
  }
}

// =====================================================================
// 操作实现
// =====================================================================

/** 获取达人完整资料 */
async function handleGetProfile(kolId: string): Promise<string> {
  const db = getDb()

  // 基础信息
  const kolRow = db.query(`
    SELECT * FROM kols WHERE id = ?
  `).get(kolId) as Record<string, unknown> | null

  if (!kolRow) {
    return `❌ 未找到达人: ${kolId}\n\n> 请先完成入驻登记。`
  }

  // CRM 信息
  const crmRow = db.query(`
    SELECT * FROM kol_crm WHERE kol_id = ?
  `).get(kolId) as Record<string, unknown> | null

  // 达人端资料
  const portalRow = db.query(`
    SELECT * FROM kol_portal_profiles WHERE kol_id = ?
  `).get(kolId) as Record<string, unknown> | null

  const parts: string[] = []
  parts.push(`## 👤 达人资料 — ${kolRow.name ?? kolId}`)
  parts.push('')

  // 基础信息
  parts.push(`### 📋 基础信息`)
  parts.push(`| 字段 | 值 |`)
  parts.push(`|------|------|`)
  parts.push(`| 达人ID | ${kolId} |`)
  parts.push(`| 名称 | ${kolRow.name ?? '-'} |`)
  parts.push(`| 平台 | ${kolRow.platform ?? '-'} |`)
  parts.push(`| 粉丝量 | ${kolRow.followers ?? '-'} |`)
  parts.push(`| 互动率 | ${kolRow.engagement ?? '-'} |`)
  parts.push(`| 类目 | ${kolRow.category ?? '-'} |`)
  parts.push(`| 报价 | ${kolRow.price ?? '-'} |`)
  parts.push(`| 城市 | ${kolRow.city ?? '-'} |`)
  parts.push('')

  // CRM 信息
  if (crmRow) {
    parts.push(`### 🏷️ 合作信息`)
    parts.push(`| 字段 | 值 |`)
    parts.push(`|------|------|`)
    parts.push(`| 入会状态 | ${crmRow.onboarding_status ?? 'pending'} |`)
    parts.push(`| 忠诚度分层 | ${translateTier(String(crmRow.loyalty_tier ?? 'new'))} |`)
    parts.push(`| 合作次数 | ${crmRow.total_cooperations ?? 0} |`)
    parts.push(`| 总营收 | ¥${Number(crmRow.total_revenue ?? 0).toFixed(2)} |`)
    parts.push(`| 标签 | ${crmRow.tags ?? '-'} |`)
    parts.push(`| 回复率 | ${crmRow.response_rate ?? 0}% |`)
    parts.push('')
  }

  // 达人端资料
  if (portalRow) {
    parts.push(`### ✨ 个人简介`)
    parts.push(`| 字段 | 值 |`)
    parts.push(`|------|------|`)
    parts.push(`| 个人介绍 | ${portalRow.bio ?? '-'} |`)
    parts.push(`| 专长领域 | ${portalRow.specialties ?? '-'} |`)
    parts.push(`| 内容风格 | ${portalRow.content_style ?? '-'} |`)
    parts.push(`| 受众画像 | ${portalRow.audience_demo ?? '-'} |`)
    parts.push(`| 合作偏好 | ${portalRow.collaboration_preferences ?? '-'} |`)
    parts.push(`| 可接单状态 | ${portalRow.availability === 'open' ? '✅ 开放接单' : '⏸️ 暂停接单'} |`)
    parts.push(`| 平台等级 | ${translateTierLevel(String(portalRow.tier_level ?? 'bronze'))} |`)
    parts.push(`| 等级积分 | ${portalRow.tier_points ?? 0} |`)
    parts.push('')
  } else {
    parts.push(`> 💡 尚未完善个人简介，可通过 \`update_profile\` 补充。`)
    parts.push('')
  }

  // 入驻状态
  const onboardingComplete = portalRow ? (portalRow.onboarding_completed as number) === 1 : false
  if (crmRow && crmRow.onboarding_status === 'approved' && onboardingComplete) {
    parts.push(`✅ **入驻状态**: 已完成全部入驻流程，可以正常接单。`)
  } else if (crmRow && crmRow.onboarding_status === 'approved') {
    parts.push(`⚠️ **入驻状态**: 已通过审核，但个人资料尚未完善。建议补充个人简介和专长领域。`)
  } else if (crmRow && crmRow.onboarding_status === 'pending') {
    parts.push(`⏳ **入驻状态**: 审核中，请耐心等待。`)
  } else {
    parts.push(`❓ **入驻状态**: 未入驻或审核未通过。`)
  }

  return parts.join('\n')
}

/** 更新达人端资料 */
async function handleUpdateProfile(kolId: string, dataStr: string): Promise<string> {
  const db = getDb()

  let data: Record<string, unknown>
  try {
    data = JSON.parse(dataStr)
  } catch {
    return '❌ data 参数不是有效的 JSON 字符串'
  }

  // 检查达人是否存在
  const kolExists = db.query('SELECT 1 FROM kols WHERE id = ?').get(kolId)
  if (!kolExists) {
    return `❌ 达人不存在: ${kolId}，无法更新资料`
  }

  const allowedFields = ['bio', 'specialties', 'content_style', 'audience_demo', 'collaboration_preferences', 'availability', 'onboarding_completed', 'tier_level', 'tier_points']
  const updates: string[] = []
  const values: unknown[] = []

  for (const [key, value] of Object.entries(data)) {
    const dbField = key.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())
    if (allowedFields.includes(dbField) && value !== undefined) {
      updates.push(`${dbField} = ?`)
      values.push(value)
    }
  }

  if (updates.length === 0) {
    return '⚠️ 没有提供有效的更新字段。允许更新的字段：' + allowedFields.join(', ')
  }

  const now = Date.now()
  const portalExists = db.query('SELECT 1 FROM kol_portal_profiles WHERE kol_id = ?').get(kolId)

  if (portalExists) {
    values.push(now, kolId)
    db.run(`UPDATE kol_portal_profiles SET ${updates.join(', ')}, updated_at = ? WHERE kol_id = ?`, values)
    const updatedFields = Object.keys(data).filter((k) => allowedFields.includes(k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())))
    return `✅ 已更新达人 ${kolId} 的个人资料\n\n更新字段：${updatedFields.join(', ')}`
  }

  // 创建新记录
  const insertFields: string[] = ['kol_id']
  const insertPlaceholders: string[] = ['?']
  const insertValues: unknown[] = [kolId]

  for (const [key, value] of Object.entries(data)) {
    const dbField = key.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())
    if (allowedFields.includes(dbField) && value !== undefined) {
      insertFields.push(dbField)
      insertPlaceholders.push('?')
      insertValues.push(value)
    }
  }
  insertFields.push('created_at', 'updated_at')
  insertPlaceholders.push('?', '?')
  insertValues.push(now, now)

  db.run(`INSERT INTO kol_portal_profiles (${insertFields.join(', ')}) VALUES (${insertPlaceholders.join(', ')})`, insertValues)
  const setFields = Object.keys(data).filter((k) => allowedFields.includes(k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())))
  return `✅ 已为达人 ${kolId} 创建个人资料\n\n设置字段：${setFields.join(', ')}`
}

/** 获取内容创作指导 */
async function handleGetContentGuidance(kolId: string, campaignId: string): Promise<string> {
  const db = getDb()

  // 检查达人是否存在
  const kolRow = db.query('SELECT name, platform, category FROM kols WHERE id = ?').get(kolId) as Record<string, unknown> | null
  if (!kolRow) {
    return `❌ 未找到达人: ${kolId}`
  }

  // 查询内容指导记录
  const guidanceRow = db.query(`
    SELECT * FROM kol_content_guidance
    WHERE kol_id = ? AND campaign_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(kolId, campaignId) as Record<string, unknown> | null

  // 查询活动信息（从 campaign_tests 表）
  const campaignRow = db.query(`
    SELECT * FROM campaign_tests WHERE test_id = ? OR campaign_id = ?
    LIMIT 1
  `).get(campaignId, campaignId) as Record<string, unknown> | null

  const parts: string[] = []
  parts.push(`## 📝 内容创作指导`)
  parts.push(`**达人**: ${kolRow.name ?? kolId} | **平台**: ${kolRow.platform ?? '-'} | **类目**: ${kolRow.category ?? '-'}`)
  parts.push('')

  if (campaignRow) {
    parts.push(`### 📢 活动信息`)
    parts.push(`| 字段 | 值 |`)
    parts.push(`|------|------|`)
    parts.push(`| 活动名称 | ${campaignRow.test_name ?? campaignId} |`)
    parts.push(`| 活动ID | ${campaignId} |`)
    parts.push(`| 预算 | ${campaignRow.budget ? '¥' + Number(campaignRow.budget).toFixed(0) : '-'} |`)
    parts.push(`| 时间 | ${campaignRow.start_date ?? '-'} ~ ${campaignRow.end_date ?? '-'} |`)
    parts.push('')
  }

  if (guidanceRow) {
    parts.push(`### 🎯 创作要点`)
    if (guidanceRow.brief_summary) {
      parts.push(`**Brief 摘要**: ${guidanceRow.brief_summary}`)
      parts.push('')
    }
    if (guidanceRow.content_tips) {
      parts.push(`**创作建议**:`)
      parts.push(`${guidanceRow.content_tips}`)
      parts.push('')
    }
    if (guidanceRow.brand_dos) {
      parts.push(`**✅ 品牌要求**:`)
      parts.push(`${guidanceRow.brand_dos}`)
      parts.push('')
    }
    if (guidanceRow.brand_donts) {
      parts.push(`**❌ 注意事项**:`)
      parts.push(`${guidanceRow.brand_donts}`)
      parts.push('')
    }
    if (guidanceRow.deadline) {
      parts.push(`⏰ **交稿截止**: ${guidanceRow.deadline}`)
      parts.push('')
    }
    parts.push(`**状态**: ${translateGuidanceStatus(String(guidanceRow.status ?? 'pending'))}`)
  } else {
    parts.push(`> 📭 暂无该活动的内容指导记录。`)
    parts.push(`> `)
    parts.push(`> 请联系商务助理获取详细 Brief，或通过 \`update_profile\` 完善个人资料以获得更精准的内容建议。`)
  }

  // 通用创作建议
  parts.push('')
  parts.push(`### 💡 通用创作建议`)
  parts.push(`基于你的平台 **${kolRow.platform ?? '-'}** 和类目 **${kolRow.category ?? '-'}**：`)
  parts.push('')

  const platformTips: Record<string, string[]> = {
    '小红书': [
      '封面图要精美，标题要有吸引力',
      '内容真实、有干货，避免硬广感',
      '善用标签（#话题），增加曝光',
      '图文笔记建议 6-9 张图，视频 1-3 分钟',
    ],
    '抖音': [
      '前 3 秒抓住注意力',
      '音乐选择要贴合内容调性',
      '适当使用特效和转场增加趣味性',
      '视频时长建议 15-60 秒',
    ],
    'B站': [
      '标题要有梗或悬念',
      '视频质量要求高，注意画质和音质',
      '弹幕互动是特色，可在视频中埋梗',
      '简介区详细说明合作信息',
    ],
    '微博': [
      '话题标签要精准',
      '图文结合，图片要高清',
      '互动抽奖可增加转发',
      '注意发文时间（午休/晚间）',
    ],
    '快手': [
      '内容接地气，真实感强',
      '直播互动效果好',
      '老铁文化，语气亲切',
      '短视频 + 直播结合',
    ],
  }

  const tips = platformTips[String(kolRow.platform) ?? ''] ?? [
    '保持内容真实性和原创性',
    '与粉丝积极互动，回复评论',
    '注意品牌露出自然，避免过度硬广',
    '按时交稿，维护良好合作关系',
  ]

  for (const tip of tips) {
    parts.push(`- ${tip}`)
  }

  return parts.join('\n')
}

/** 个人效果看板 */
async function handleGetMyPerformance(kolId: string, limit: number): Promise<string> {
  const db = getDb()

  // 检查达人是否存在
  const kolRow = db.query('SELECT name, platform, category FROM kols WHERE id = ?').get(kolId) as Record<string, unknown> | null
  if (!kolRow) {
    return `❌ 未找到达人: ${kolId}`
  }

  // CRM 汇总
  const crmRow = db.query(`
    SELECT total_cooperations, total_revenue, loyalty_tier, response_rate
    FROM kol_crm WHERE kol_id = ?
  `).get(kolId) as Record<string, unknown> | null

  // 效果记录
  const perfRows = db.query(`
    SELECT * FROM kol_performance
    WHERE kol_id = ?
    ORDER BY record_date DESC, created_at DESC
    LIMIT ?
  `).all(kolId, limit) as Record<string, unknown>[]

  const parts: string[] = []
  parts.push(`## 📊 个人效果看板 — ${kolRow.name ?? kolId}`)
  parts.push('')

  // 汇总卡片
  parts.push(`### 📈 数据汇总`)
  parts.push(`| 指标 | 数值 |`)
  parts.push(`|------|------|`)
  parts.push(`| 总合作次数 | ${crmRow?.total_cooperations ?? 0} |`)
  parts.push(`| 总营收 | ¥${Number(crmRow?.total_revenue ?? 0).toFixed(2)} |`)
  parts.push(`| 忠诚度分层 | ${translateTier(String(crmRow?.loyalty_tier ?? 'new'))} |`)
  parts.push(`| 回复率 | ${crmRow?.response_rate ?? 0}% |`)
  parts.push('')

  if (perfRows.length === 0) {
    parts.push(`> 📭 暂无效果记录。完成合作后，品牌方会录入效果数据。`)
    return parts.join('\n')
  }

  // 计算汇总
  const totalExposure = perfRows.reduce((sum, r) => sum + Number(r.exposure ?? 0), 0)
  const totalEngagement = perfRows.reduce((sum, r) => sum + Number(r.engagement ?? 0), 0)
  const totalConversion = perfRows.reduce((sum, r) => sum + Number(r.conversion ?? 0), 0)
  const perfWithRoi = perfRows.filter((r) => r.roi !== null && r.roi !== undefined)
  const avgRoi = perfWithRoi.length > 0 ? perfWithRoi.reduce((sum, r) => sum + Number(r.roi), 0) / perfWithRoi.length : 0
  const perfWithScore = perfRows.filter((r) => r.cooperation_score !== null && r.cooperation_score !== undefined)
  const avgScore = perfWithScore.length > 0 ? perfWithScore.reduce((sum, r) => sum + Number(r.cooperation_score), 0) / perfWithScore.length : 0
  const effectEngagementRate = totalExposure > 0 ? (totalEngagement / totalExposure * 100) : 0

  parts.push(`| 总曝光 | ${totalExposure.toLocaleString()} |`)
  parts.push(`| 总互动 | ${totalEngagement.toLocaleString()} |`)
  parts.push(`| 总转化 | ${totalConversion.toLocaleString()} |`)
  parts.push(`| 效果互动率 | ${effectEngagementRate.toFixed(2)}% |`)
  parts.push(`| 平均ROI | ${avgRoi.toFixed(2)} |`)
  parts.push(`| 平均合作评分 | ${avgScore.toFixed(1)} |`)
  parts.push('')

  // 详细记录
  parts.push(`### 📋 最近 ${perfRows.length} 次合作记录`)
  parts.push(`| 日期 | 活动 | 平台 | 曝光 | 互动 | 转化 | ROI | 评分 |`)
  parts.push(`|------|------|------|------|------|------|-----|------|`)

  for (const row of perfRows) {
    parts.push(`| ${row.record_date ?? '-'} | ${row.campaign_id ?? '-'} | ${row.platform ?? '-'} | ${Number(row.exposure ?? 0).toLocaleString()} | ${Number(row.engagement ?? 0).toLocaleString()} | ${Number(row.conversion ?? 0).toLocaleString()} | ${row.roi ?? '-'} | ${row.cooperation_score ?? '-'} |`)
  }

  // 表现评价
  parts.push('')
  if (avgScore >= 4.5) {
    parts.push(`⭐ **表现评价**: 优秀达人！合作质量极高，建议保持并争取更多合作机会。`)
  } else if (avgScore >= 3.5) {
    parts.push(`✅ **表现评价**: 良好表现，合作质量稳定，有提升空间。`)
  } else if (avgScore > 0) {
    parts.push(`⚠️ **表现评价**: 表现一般，建议关注内容质量和交付时效。`)
  } else {
    parts.push(`💡 **表现评价**: 数据积累中，继续加油！`)
  }

  return parts.join('\n')
}

/** 平台分层信息 */
async function handleGetPlatformTier(kolId: string): Promise<string> {
  const db = getDb()

  // 检查达人是否存在
  const kolRow = db.query('SELECT name, platform, followers, category FROM kols WHERE id = ?').get(kolId) as Record<string, unknown> | null
  if (!kolRow) {
    return `❌ 未找到达人: ${kolId}`
  }

  // 查询达人端资料
  const portalRow = db.query(`
    SELECT tier_level, tier_points FROM kol_portal_profiles WHERE kol_id = ?
  `).get(kolId) as Record<string, unknown> | null

  const currentTier = String(portalRow?.tier_level ?? 'bronze')
  const currentPoints = Number(portalRow?.tier_points ?? 0)

  const parts: string[] = []
  parts.push(`## 🏆 平台分层 — ${kolRow.name ?? kolId}`)
  parts.push(`**当前等级**: ${translateTierLevel(currentTier)} | **当前积分**: ${currentPoints}`)
  parts.push('')

  // 等级体系
  const tiers = [
    {
      level: 'bronze',
      name: '青铜达人',
      minPoints: 0,
      benefits: ['基础接单权限', '标准结算周期', '基础数据看板'],
    },
    {
      level: 'silver',
      name: '白银达人',
      minPoints: 100,
      benefits: ['优先推荐机会', '快速结算（7天）', '专属运营对接', '月度数据报告'],
    },
    {
      level: 'gold',
      name: '黄金达人',
      minPoints: 500,
      benefits: ['头部活动优先权', '即时结算', '1对1运营支持', '品牌定制合作', '季度奖金池'],
    },
    {
      level: 'platinum',
      name: '铂金达人',
      minPoints: 2000,
      benefits: ['独家合作机会', '预付合作金', '专属商务团队', '年度盛典邀请', '股权激励计划'],
    },
  ]

  parts.push(`### 📊 等级体系`)
  parts.push(`| 等级 | 名称 | 最低积分 | 核心权益 |`)
  parts.push(`|------|------|----------|----------|`)

  for (const tier of tiers) {
    const isCurrent = tier.level === currentTier
    const marker = isCurrent ? '👉 ' : ''
    parts.push(`| ${marker}${tier.name} | ${tier.minPoints} | ${tier.benefits.join('、')} |`)
  }

  parts.push('')

  // 当前等级详情
  const currentTierInfo = tiers.find((t) => t.level === currentTier) ?? tiers[0]!
  const nextTier = tiers.find((t) => t.minPoints > currentPoints)

  parts.push(`### 🎯 当前等级权益`)
  parts.push(`**${currentTierInfo.name}** 专属权益：`)
  for (const benefit of currentTierInfo.benefits) {
    parts.push(`- ✅ ${benefit}`)
  }

  if (nextTier) {
    const needPoints = nextTier.minPoints - currentPoints
    parts.push('')
    parts.push(`### 🚀 升级进度`)
    parts.push(`距离 **${nextTier.name}** 还需 **${needPoints}** 积分`)
    parts.push('')
    parts.push(`**积分获取方式**:`)
    parts.push(`- 完成一次合作: +10~50 积分（根据合作质量）`)
    parts.push(`- 获得好评（4.5星以上）: +20 积分`)
    parts.push(`- 按时交稿: +10 积分`)
    parts.push(`- 内容被品牌方二次传播: +30 积分`)
    parts.push(`- 推荐新达人入驻: +50 积分`)
  } else {
    parts.push('')
    parts.push(`🎉 恭喜！你已达到最高等级 **${currentTierInfo.name}**，享受全部权益！`)
  }

  return parts.join('\n')
}

/** 列出我的合作活动 */
async function handleListMyCampaigns(kolId: string, limit: number): Promise<string> {
  const db = getDb()

  // 检查达人是否存在
  const kolRow = db.query('SELECT name, platform FROM kols WHERE id = ?').get(kolId) as Record<string, unknown> | null
  if (!kolRow) {
    return `❌ 未找到达人: ${kolId}`
  }

  // 从效果记录反推参与的活动
  const perfRows = db.query(`
    SELECT DISTINCT campaign_id, platform, record_date
    FROM kol_performance
    WHERE kol_id = ? AND campaign_id IS NOT NULL
    ORDER BY record_date DESC
    LIMIT ?
  `).all(kolId, limit) as Record<string, unknown>[]

  // 查询内容指导记录中的活动
  const guidanceRows = db.query(`
    SELECT DISTINCT campaign_id, status, deadline
    FROM kol_content_guidance
    WHERE kol_id = ? AND campaign_id IS NOT NULL
    ORDER BY created_at DESC
    LIMIT ?
  `).all(kolId, limit) as Record<string, unknown>[]

  const parts: string[] = []
  parts.push(`## 📋 我的合作活动 — ${kolRow.name ?? kolId}`)
  parts.push('')

  if (perfRows.length === 0 && guidanceRows.length === 0) {
    parts.push(`> 📭 暂无合作活动记录。`)
    parts.push(`> `)
    parts.push(`> 💡 完善个人资料并保持"开放接单"状态，商务助理会主动推送合作机会。`)
    return parts.join('\n')
  }

  // 合并活动列表
  const campaignMap = new Map<string, { id: string; hasPerf: boolean; hasGuidance: boolean; status?: string; deadline?: string; lastDate?: string }>()

  for (const row of perfRows) {
    const id = String(row.campaign_id ?? '')
    if (!id) continue
    const existing = campaignMap.get(id) ?? { id, hasPerf: false, hasGuidance: false }
    existing.hasPerf = true
    existing.lastDate = String(row.record_date ?? '')
    campaignMap.set(id, existing)
  }

  for (const row of guidanceRows) {
    const id = String(row.campaign_id ?? '')
    if (!id) continue
    const existing = campaignMap.get(id) ?? { id, hasPerf: false, hasGuidance: false }
    existing.hasGuidance = true
    existing.status = String(row.status ?? '')
    existing.deadline = String(row.deadline ?? '')
    campaignMap.set(id, existing)
  }

  const campaigns = Array.from(campaignMap.values()).slice(0, limit)

  parts.push(`| 活动ID | 内容指导 | 效果录入 | 状态 | 截止日 |`)
  parts.push(`|--------|----------|----------|------|--------|`)

  for (const c of campaigns) {
    const guidanceStatus = c.hasGuidance ? '✅' : '⏳'
    const perfStatus = c.hasPerf ? '✅' : '⏳'
    const status = c.status ? translateGuidanceStatus(c.status) : '-'
    const deadline = c.deadline ?? '-'
    parts.push(`| ${c.id} | ${guidanceStatus} | ${perfStatus} | ${status} | ${deadline} |`)
  }

  parts.push('')
  parts.push(`**图例**: ✅ 已完成 | ⏳ 待进行`)

  return parts.join('\n')
}

// =====================================================================
// 辅助函数
// =====================================================================

function translateTier(tier: string): string {
  const map: Record<string, string> = {
    loyal: '忠诚',
    returning: '回流',
    churned: '流失',
    new: '新客',
  }
  return map[tier] ?? tier
}

function translateTierLevel(level: string): string {
  const map: Record<string, string> = {
    bronze: '🥉 青铜达人',
    silver: '🥈 白银达人',
    gold: '🥇 黄金达人',
    platinum: '💎 铂金达人',
  }
  return map[level] ?? level
}

function translateGuidanceStatus(status: string): string {
  const map: Record<string, string> = {
    pending: '⏳ 待开始',
    in_progress: '📝 创作中',
    submitted: '📤 已交稿',
    approved: '✅ 已通过',
    rejected: '❌ 需修改',
    published: '🚀 已发布',
    completed: '🏁 已完成',
  }
  return map[status] ?? status
}
