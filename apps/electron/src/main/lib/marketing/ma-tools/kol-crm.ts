/**
 * KOL CRM 管理工具（Chat Tool）
 *
 * 直接操作 SQLite 数据库，管理达人 CRM 信息。
 * 包括：入会信息、标签管理、效果记录查询、平台分层分析。
 *
 * 数据库位置：~/.mapro/kol-database.sqlite
 * 相关表：kol_crm, kol_performance, kols
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@gravitas/core'
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

/** 统一 Database API（模拟 bun:sqlite 接口，适配 better-sqlite3 差异） */
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

/** 展开参数（兼容数组参数和展开参数） */
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

  // 确保表存在（与 kol-data-service.ts 保持一致）
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS kol_crm (
      kol_id TEXT PRIMARY KEY,
      onboarding_status TEXT DEFAULT 'pending',
      track TEXT,
      tags TEXT,
      response_rate REAL DEFAULT 0,
      loyalty_tier TEXT DEFAULT 'new',
      last_contact_date TEXT,
      total_cooperations INTEGER DEFAULT 0,
      total_revenue REAL DEFAULT 0,
      notes TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    )
  `)

  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS kol_performance (
      record_id TEXT PRIMARY KEY,
      kol_id TEXT NOT NULL,
      campaign_id TEXT,
      platform TEXT,
      category TEXT,
      exposure INTEGER DEFAULT 0,
      engagement INTEGER DEFAULT 0,
      conversion INTEGER DEFAULT 0,
      cpm REAL,
      cpe REAL,
      roi REAL,
      cooperation_score REAL,
      record_date TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    )
  `)

  return dbInstance
}

// =====================================================================
// 工具元数据
// =====================================================================


export const KOL_CRM_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'ma_kol_crm',
    description: 'Manage KOL CRM data including onboarding info, tags, loyalty tiers, performance records, and value analysis. Direct database operations without LLM calls. Use when the user needs to query KOL CRM info, update KOL tags/tiers, record cooperation performance, list KOLs by tier, or analyze KOL value.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get_kol_crm', 'update_kol_crm', 'list_kols_by_tier', 'record_performance', 'get_performance_history', 'analyze_kol_value'],
          description: 'Operation type: get_kol_crm (query CRM), update_kol_crm (update fields), list_kols_by_tier (list by loyalty tier), record_performance (log performance), get_performance_history (query history), analyze_kol_value (value analysis)',
        },
        kol_id: { type: 'string', description: 'KOL ID (required for get/update/record/analyze)' },
        data: { type: 'string', description: 'JSON string of fields to update (required for update_kol_crm, e.g. {"tags":"beauty,skincare","loyalty_tier":"loyal"})' },
        tier: { type: 'string', enum: ['loyal', 'returning', 'churned', 'new'], description: 'Loyalty tier filter (required for list_kols_by_tier)' },
        platform: { type: 'string', description: 'Platform filter (optional, e.g. xiaohongshu/douyin/bilibili/weibo)' },
        limit: { type: 'number', description: 'Result limit (default 20)' },
      },
      required: ['action'],
    },
  },
]

// =====================================================================
// 工具执行
// =====================================================================



export async function executeKOLCRMTool(toolCall: ToolCall): Promise<ToolResult> {
  try {
    const args = toolCall.arguments as Record<string, unknown>
    const action = String(args.action ?? '')

    if (!action) {
      return { toolCallId: toolCall.id, content: '参数缺失: action 为必填项', isError: true }
    }

    const kolId = args.kol_id ? String(args.kol_id) : undefined
    const dataStr = args.data ? String(args.data) : undefined
    const tier = args.tier ? String(args.tier) : undefined
    const platform = args.platform ? String(args.platform) : undefined
    const limit = typeof args.limit === 'number' ? args.limit : 20

    switch (action) {
      case 'get_kol_crm':
        if (!kolId) {
          return { toolCallId: toolCall.id, content: '参数缺失: kol_id 为 get_kol_crm 的必填项', isError: true }
        }
        return { toolCallId: toolCall.id, content: await handleGetKOLCRM(kolId) }

      case 'update_kol_crm':
        if (!kolId) {
          return { toolCallId: toolCall.id, content: '参数缺失: kol_id 为 update_kol_crm 的必填项', isError: true }
        }
        if (!dataStr) {
          return { toolCallId: toolCall.id, content: '参数缺失: data 为 update_kol_crm 的必填项', isError: true }
        }
        return { toolCallId: toolCall.id, content: await handleUpdateKOLCRM(kolId, dataStr) }

      case 'list_kols_by_tier':
        if (!tier) {
          return { toolCallId: toolCall.id, content: '参数缺失: tier 为 list_kols_by_tier 的必填项', isError: true }
        }
        return { toolCallId: toolCall.id, content: await handleListKOLsByTier(tier, platform, limit) }

      case 'record_performance':
        if (!kolId) {
          return { toolCallId: toolCall.id, content: '参数缺失: kol_id 为 record_performance 的必填项', isError: true }
        }
        return { toolCallId: toolCall.id, content: await handleRecordPerformance(kolId, args) }

      case 'get_performance_history':
        if (!kolId) {
          return { toolCallId: toolCall.id, content: '参数缺失: kol_id 为 get_performance_history 的必填项', isError: true }
        }
        return { toolCallId: toolCall.id, content: await handleGetPerformanceHistory(kolId, limit) }

      case 'analyze_kol_value':
        if (!kolId) {
          return { toolCallId: toolCall.id, content: '参数缺失: kol_id 为 analyze_kol_value 的必填项', isError: true }
        }
        return { toolCallId: toolCall.id, content: await handleAnalyzeKOLValue(kolId) }

      default:
        return { toolCallId: toolCall.id, content: `不支持的操作类型: ${action}`, isError: true }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[KOLCRM] 执行失败:', error)
    return { toolCallId: toolCall.id, content: `KOL CRM 操作错误: ${msg}`, isError: true }
  }
}

// =====================================================================
// 操作实现
// =====================================================================

/** 获取达人CRM信息 */
async function handleGetKOLCRM(kolId: string): Promise<string> {
  const db = getDb()

  const row = db.query(`
    SELECT c.*, k.name, k.platform, k.followers, k.engagement, k.category, k.price, k.city
    FROM kol_crm c
    LEFT JOIN kols k ON c.kol_id = k.id
    WHERE c.kol_id = ?
  `).get(kolId) as Record<string, unknown> | null

  if (!row) {
    const kolRow = db.query('SELECT id, name, platform, followers, category FROM kols WHERE id = ?').get(kolId) as Record<string, unknown> | null
    if (kolRow) {
      return `## 达人基础信息\n\n| 字段 | 值 |\n|------|------|\n| 达人ID | ${kolRow.id} |\n| 名称 | ${kolRow.name ?? '-'} |\n| 平台 | ${kolRow.platform ?? '-'} |\n| 粉丝量 | ${kolRow.followers ?? '-'} |\n| 类目 | ${kolRow.category ?? '-'} |\n\n> ⚠️ 该达人暂无CRM记录，可通过 \`update_kol_crm\` 创建。`
    }
    return `❌ 未找到达人: ${kolId}`
  }

  const parts: string[] = []
  parts.push(`## 📋 达人CRM信息 — ${row.name ?? kolId}`)
  parts.push('')

  parts.push(`### 基础信息`)
  parts.push(`| 字段 | 值 |`)
  parts.push(`|------|------|`)
  parts.push(`| 达人ID | ${row.kol_id} |`)
  parts.push(`| 名称 | ${row.name ?? '-'} |`)
  parts.push(`| 平台 | ${row.platform ?? '-'} |`)
  parts.push(`| 粉丝量 | ${row.followers ?? '-'} |`)
  parts.push(`| 互动率 | ${row.engagement ?? '-'} |`)
  parts.push(`| 类目 | ${row.category ?? '-'} |`)
  parts.push(`| 报价 | ${row.price ?? '-'} |`)
  parts.push(`| 城市 | ${row.city ?? '-'} |`)
  parts.push('')

  parts.push(`### CRM 信息`)
  parts.push(`| 字段 | 值 |`)
  parts.push(`|------|------|`)
  parts.push(`| 入会状态 | ${row.onboarding_status ?? 'pending'} |`)
  parts.push(`| 跟进轨道 | ${row.track ?? '-'} |`)
  parts.push(`| 标签 | ${row.tags ?? '-'} |`)
  parts.push(`| 回复率 | ${row.response_rate ?? 0}% |`)
  parts.push(`| 忠诚度分层 | ${translateTier(String(row.loyalty_tier ?? 'new'))} |`)
  parts.push(`| 最后联系 | ${row.last_contact_date ?? '-'} |`)
  parts.push(`| 合作次数 | ${row.total_cooperations ?? 0} |`)
  parts.push(`| 总营收 | ¥${Number(row.total_revenue ?? 0).toFixed(2)} |`)
  parts.push(`| 备注 | ${row.notes ?? '-'} |`)
  parts.push(`| 创建时间 | ${formatTimestamp(row.created_at)} |`)
  parts.push(`| 更新时间 | ${formatTimestamp(row.updated_at)} |`)
  parts.push('')

  return parts.join('\n')
}

/** 更新达人CRM信息 */
async function handleUpdateKOLCRM(kolId: string, dataStr: string): Promise<string> {
  const db = getDb()

  let data: Record<string, unknown>
  try {
    data = JSON.parse(dataStr)
  } catch {
    return '❌ data 参数不是有效的 JSON 字符串'
  }

  const kolExists = db.query('SELECT 1 FROM kols WHERE id = ?').get(kolId)
  if (!kolExists) {
    return `❌ 达人不存在: ${kolId}，无法更新CRM`
  }

  const allowedFields = ['onboarding_status', 'track', 'tags', 'response_rate', 'loyalty_tier', 'last_contact_date', 'total_cooperations', 'total_revenue', 'notes']
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
  const crmExists = db.query('SELECT 1 FROM kol_crm WHERE kol_id = ?').get(kolId)

  if (crmExists) {
    values.push(now, kolId)
    db.run(`UPDATE kol_crm SET ${updates.join(', ')}, updated_at = ? WHERE kol_id = ?`, values)
    const updatedFields = Object.keys(data).filter((k) => allowedFields.includes(k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())))
    return `✅ 已更新达人 ${kolId} 的CRM信息\n\n更新字段：${updatedFields.join(', ')}`
  }

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

  db.run(`INSERT INTO kol_crm (${insertFields.join(', ')}) VALUES (${insertPlaceholders.join(', ')})`, insertValues)
  const setFields = Object.keys(data).filter((k) => allowedFields.includes(k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())))
  return `✅ 已为达人 ${kolId} 创建CRM记录\n\n设置字段：${setFields.join(', ')}`
}

/** 按分层查询达人 */
async function handleListKOLsByTier(tier: string, platform: string | undefined, limit: number): Promise<string> {
  const db = getDb()

  const validTiers = ['loyal', 'returning', 'churned', 'new']
  if (!validTiers.includes(tier)) {
    return `❌ 无效的分层: ${tier}。有效值: ${validTiers.join(', ')}`
  }

  let sql = `
    SELECT c.*, k.name, k.platform, k.followers, k.category, k.price
    FROM kol_crm c
    LEFT JOIN kols k ON c.kol_id = k.id
    WHERE c.loyalty_tier = ?
  `
  const params: unknown[] = [tier]

  if (platform) {
    sql += ` AND k.platform = ?`
    params.push(platform)
  }

  sql += ` ORDER BY c.total_revenue DESC LIMIT ?`
  params.push(limit)

  const rows = db.query(sql).all(...params) as Record<string, unknown>[]

  if (rows.length === 0) {
    return `📭 未找到 ${translateTier(tier)} 分层的达人${platform ? `（平台: ${platform}）` : ''}`
  }

  const parts: string[] = []
  parts.push(`## ${translateTier(tier)} 分层达人列表 ${platform ? `— ${platform}` : ''}`)
  parts.push(`共 ${rows.length} 人`)
  parts.push('')

  parts.push(`| 达人ID | 名称 | 平台 | 粉丝量 | 类目 | 合作次数 | 总营收 | 回复率 | 标签 |`)
  parts.push(`|--------|------|------|--------|------|----------|--------|--------|------|`)

  for (const row of rows) {
    parts.push(`| ${row.kol_id} | ${row.name ?? '-'} | ${row.platform ?? '-'} | ${row.followers ?? '-'} | ${row.category ?? '-'} | ${row.total_cooperations ?? 0} | ¥${Number(row.total_revenue ?? 0).toFixed(0)} | ${row.response_rate ?? 0}% | ${row.tags ?? '-'} |`)
  }

  parts.push('')

  const totalRevenue = rows.reduce((sum, r) => sum + Number(r.total_revenue ?? 0), 0)
  const totalCoops = rows.reduce((sum, r) => sum + Number(r.total_cooperations ?? 0), 0)
  parts.push(`**汇总**: 总营收 ¥${totalRevenue.toFixed(2)}，总合作 ${totalCoops} 次`)

  return parts.join('\n')
}

/** 记录达人效果 */
async function handleRecordPerformance(kolId: string, args: Record<string, unknown>): Promise<string> {
  const db = getDb()

  const kolExists = db.query('SELECT 1 FROM kols WHERE id = ?').get(kolId)
  if (!kolExists) {
    return `❌ 达人不存在: ${kolId}`
  }

  const recordId = `perf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const campaignId = args.campaign_id ? String(args.campaign_id) : null
  const platform = args.platform ? String(args.platform) : null
  const category = args.category ? String(args.category) : null
  const exposure = typeof args.exposure === 'number' ? args.exposure : 0
  const engagement = typeof args.engagement === 'number' ? args.engagement : 0
  const conversion = typeof args.conversion === 'number' ? args.conversion : 0
  const cpm = typeof args.cpm === 'number' ? args.cpm : null
  const cpe = typeof args.cpe === 'number' ? args.cpe : null
  const roi = typeof args.roi === 'number' ? args.roi : null
  const cooperationScore = typeof args.cooperation_score === 'number' ? args.cooperation_score : null
  const recordDate = args.record_date ? String(args.record_date) : new Date().toISOString().split('T')[0]
  const revenue = typeof args.revenue === 'number' ? args.revenue : 0

  db.run(`
    INSERT INTO kol_performance (
      record_id, kol_id, campaign_id, platform, category,
      exposure, engagement, conversion, cpm, cpe, roi, cooperation_score, record_date, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    recordId, kolId, campaignId, platform, category,
    exposure, engagement, conversion, cpm, cpe, roi, cooperationScore, recordDate, Date.now(),
  ])

  // 同步更新CRM总合作次数和总营收
  const crmExists = db.query('SELECT 1 FROM kol_crm WHERE kol_id = ?').get(kolId)
  if (crmExists) {
    if (revenue > 0) {
      db.run(`
        UPDATE kol_crm SET
          total_cooperations = total_cooperations + 1,
          total_revenue = total_revenue + ?,
          updated_at = ?
        WHERE kol_id = ?
      `, [revenue, Date.now(), kolId])
    } else {
      db.run(`
        UPDATE kol_crm SET
          total_cooperations = total_cooperations + 1,
          updated_at = ?
        WHERE kol_id = ?
      `, [Date.now(), kolId])
    }
  }

  const parts: string[] = []
  parts.push(`✅ 已记录效果数据`)
  parts.push('')
  parts.push(`| 字段 | 值 |`)
  parts.push(`|------|------|`)
  parts.push(`| 记录ID | ${recordId} |`)
  parts.push(`| 达人ID | ${kolId} |`)
  parts.push(`| 活动ID | ${campaignId ?? '-'} |`)
  parts.push(`| 平台 | ${platform ?? '-'} |`)
  parts.push(`| 曝光 | ${exposure.toLocaleString()} |`)
  parts.push(`| 互动 | ${engagement.toLocaleString()} |`)
  parts.push(`| 转化 | ${conversion.toLocaleString()} |`)
  parts.push(`| CPM | ${cpm ?? '-'} |`)
  parts.push(`| CPE | ${cpe ?? '-'} |`)
  parts.push(`| ROI | ${roi ?? '-'} |`)
  parts.push(`| 合作评分 | ${cooperationScore ?? '-'} |`)
  parts.push(`| 记录日期 | ${recordDate} |`)
  if (revenue > 0) {
    parts.push(`| 同步营收 | ¥${revenue.toFixed(2)} |`)
  }
  parts.push('')

  return parts.join('\n')
}

/** 查询效果历史 */
async function handleGetPerformanceHistory(kolId: string, limit: number): Promise<string> {
  const db = getDb()

  const rows = db.query(`
    SELECT * FROM kol_performance
    WHERE kol_id = ?
    ORDER BY record_date DESC, created_at DESC
    LIMIT ?
  `).all(kolId, limit) as Record<string, unknown>[]

  if (rows.length === 0) {
    return `📭 达人 ${kolId} 暂无效果记录`
  }

  const parts: string[] = []
  parts.push(`## 📊 达人效果历史 — ${kolId}`)
  parts.push(`共 ${rows.length} 条记录`)
  parts.push('')

  parts.push(`| 日期 | 活动 | 平台 | 曝光 | 互动 | 转化 | CPM | CPE | ROI | 评分 |`)
  parts.push(`|------|------|------|------|------|------|-----|-----|-----|------|`)

  for (const row of rows) {
    parts.push(`| ${row.record_date ?? '-'} | ${row.campaign_id ?? '-'} | ${row.platform ?? '-'} | ${Number(row.exposure ?? 0).toLocaleString()} | ${Number(row.engagement ?? 0).toLocaleString()} | ${Number(row.conversion ?? 0).toLocaleString()} | ${row.cpm ?? '-'} | ${row.cpe ?? '-'} | ${row.roi ?? '-'} | ${row.cooperation_score ?? '-'} |`)
  }

  parts.push('')

  const totalExposure = rows.reduce((sum, r) => sum + Number(r.exposure ?? 0), 0)
  const totalEngagement = rows.reduce((sum, r) => sum + Number(r.engagement ?? 0), 0)
  const totalConversion = rows.reduce((sum, r) => sum + Number(r.conversion ?? 0), 0)
  const perfWithRoi = rows.filter((r) => r.roi !== null && r.roi !== undefined)
  const avgRoi = perfWithRoi.length > 0 ? perfWithRoi.reduce((sum, r) => sum + Number(r.roi), 0) / perfWithRoi.length : 0
  const perfWithScore = rows.filter((r) => r.cooperation_score !== null && r.cooperation_score !== undefined)
  const avgScore = perfWithScore.length > 0 ? perfWithScore.reduce((sum, r) => sum + Number(r.cooperation_score), 0) / perfWithScore.length : 0

  parts.push(`**汇总统计**`)
  parts.push(`- 总曝光: ${totalExposure.toLocaleString()}`)
  parts.push(`- 总互动: ${totalEngagement.toLocaleString()}`)
  parts.push(`- 总转化: ${totalConversion.toLocaleString()}`)
  parts.push(`- 平均ROI: ${avgRoi.toFixed(2)}`)
  parts.push(`- 平均合作评分: ${avgScore.toFixed(1)}`)

  return parts.join('\n')
}

/** 分析达人价值 */
async function handleAnalyzeKOLValue(kolId: string): Promise<string> {
  const db = getDb()

  const crmRow = db.query(`
    SELECT c.*, k.name, k.platform, k.followers, k.engagement, k.category, k.price
    FROM kol_crm c
    LEFT JOIN kols k ON c.kol_id = k.id
    WHERE c.kol_id = ?
  `).get(kolId) as Record<string, unknown> | null

  const perfRows = db.query(`
    SELECT * FROM kol_performance
    WHERE kol_id = ?
    ORDER BY record_date DESC
  `).all(kolId) as Record<string, unknown>[]

  const parts: string[] = []
  parts.push(`## 🔍 达人价值分析 — ${crmRow?.name ?? kolId}`)
  parts.push('')

  parts.push(`### 基础画像`)
  parts.push(`| 字段 | 值 |`)
  parts.push(`|------|------|`)
  parts.push(`| 达人ID | ${kolId} |`)
  parts.push(`| 名称 | ${crmRow?.name ?? '-'} |`)
  parts.push(`| 平台 | ${crmRow?.platform ?? '-'} |`)
  parts.push(`| 粉丝量 | ${crmRow?.followers ?? '-'} |`)
  parts.push(`| 类目 | ${crmRow?.category ?? '-'} |`)
  parts.push(`| 报价 | ${crmRow?.price ?? '-'} |`)
  parts.push(`| 忠诚度分层 | ${translateTier(String(crmRow?.loyalty_tier ?? 'new'))} |`)
  parts.push(`| 合作次数 | ${crmRow?.total_cooperations ?? 0} |`)
  parts.push(`| 总营收 | ¥${Number(crmRow?.total_revenue ?? 0).toFixed(2)} |`)
  parts.push('')

  if (perfRows.length === 0) {
    parts.push(`> ⚠️ 该达人暂无效果记录，无法计算效果指标。`)
    return parts.join('\n')
  }

  const totalExposure = perfRows.reduce((sum, r) => sum + Number(r.exposure ?? 0), 0)
  const totalEngagement = perfRows.reduce((sum, r) => sum + Number(r.engagement ?? 0), 0)
  const totalConversion = perfRows.reduce((sum, r) => sum + Number(r.conversion ?? 0), 0)
  const perfWithRoi = perfRows.filter((r) => r.roi !== null && r.roi !== undefined)
  const avgRoi = perfWithRoi.length > 0 ? perfWithRoi.reduce((sum, r) => sum + Number(r.roi), 0) / perfWithRoi.length : 0
  const perfWithScore = perfRows.filter((r) => r.cooperation_score !== null && r.cooperation_score !== undefined)
  const avgScore = perfWithScore.length > 0 ? perfWithScore.reduce((sum, r) => sum + Number(r.cooperation_score), 0) / perfWithScore.length : 0
  const effectEngagementRate = totalExposure > 0 ? (totalEngagement / totalExposure * 100) : 0
  const perfWithCpm = perfRows.filter((r) => r.cpm !== null && r.cpm !== undefined)
  const avgCpm = perfWithCpm.length > 0 ? perfWithCpm.reduce((sum, r) => sum + Number(r.cpm), 0) / perfWithCpm.length : 0
  const perfWithCpe = perfRows.filter((r) => r.cpe !== null && r.cpe !== undefined)
  const avgCpe = perfWithCpe.length > 0 ? perfWithCpe.reduce((sum, r) => sum + Number(r.cpe), 0) / perfWithCpe.length : 0

  parts.push(`### 效果指标（${perfRows.length} 次合作）`)
  parts.push(`| 指标 | 数值 |`)
  parts.push(`|------|------|`)
  parts.push(`| 总曝光 | ${totalExposure.toLocaleString()} |`)
  parts.push(`| 总互动 | ${totalEngagement.toLocaleString()} |`)
  parts.push(`| 总转化 | ${totalConversion.toLocaleString()} |`)
  parts.push(`| 效果互动率 | ${effectEngagementRate.toFixed(2)}% |`)
  parts.push(`| 平均ROI | ${avgRoi.toFixed(2)} |`)
  parts.push(`| 平均CPM | ${avgCpm > 0 ? '¥' + avgCpm.toFixed(2) : '-'} |`)
  parts.push(`| 平均CPE | ${avgCpe > 0 ? '¥' + avgCpe.toFixed(2) : '-'} |`)
  parts.push(`| 平均合作评分 | ${avgScore.toFixed(1)} |`)
  parts.push('')

  const valueScore = calculateValueScore({
    totalCooperations: Number(crmRow?.total_cooperations ?? 0),
    avgRoi,
    avgScore,
    effectEngagementRate,
    loyaltyTier: String(crmRow?.loyalty_tier ?? 'new'),
  })

  parts.push(`### 价值评估`)
  parts.push(`**综合价值评分: ${valueScore.score}/100**`)
  parts.push('')
  parts.push(`| 维度 | 评分 | 说明 |`)
  parts.push(`|------|------|------|`)
  for (const dim of valueScore.dimensions) {
    parts.push(`| ${dim.name} | ${dim.score}/100 | ${dim.comment} |`)
  }
  parts.push('')

  parts.push(`### 💡 合作建议`)
  parts.push(valueScore.recommendation)

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

function formatTimestamp(ts: unknown): string {
  if (!ts) return '-'
  const num = Number(ts)
  if (Number.isNaN(num)) return String(ts)
  return new Date(num).toLocaleString('zh-CN')
}

interface ValueDimension {
  name: string
  score: number
  comment: string
}

interface ValueScore {
  score: number
  dimensions: ValueDimension[]
  recommendation: string
}

function calculateValueScore(params: {
  totalCooperations: number
  avgRoi: number
  avgScore: number
  effectEngagementRate: number
  loyaltyTier: string
}): ValueScore {
  const { totalCooperations, avgRoi, avgScore, effectEngagementRate, loyaltyTier } = params

  const stabilityScore = Math.min(totalCooperations * 10, 100)
  const stabilityComment = totalCooperations >= 5 ? '合作经验丰富' : totalCooperations >= 2 ? '有一定合作基础' : '合作经验较少'

  const roiScore = avgRoi > 3 ? 100 : avgRoi > 2 ? 80 : avgRoi > 1 ? 60 : avgRoi > 0 ? 40 : 20
  const roiComment = avgRoi > 2 ? 'ROI表现优秀' : avgRoi > 1 ? 'ROI表现良好' : avgRoi > 0 ? 'ROI一般' : 'ROI较差或数据不足'

  const qualityScore = avgScore > 4 ? 100 : avgScore > 3 ? 80 : avgScore > 2 ? 60 : avgScore > 0 ? 40 : 20
  const qualityComment = avgScore > 4 ? '合作质量极高' : avgScore > 3 ? '合作质量良好' : avgScore > 0 ? '合作质量一般' : '质量数据不足'

  const engagementScore = effectEngagementRate > 5 ? 100 : effectEngagementRate > 3 ? 80 : effectEngagementRate > 1 ? 60 : effectEngagementRate > 0 ? 40 : 20
  const engagementComment = effectEngagementRate > 5 ? '互动率极高' : effectEngagementRate > 3 ? '互动率良好' : effectEngagementRate > 0 ? '互动率一般' : '互动数据不足'

  const loyaltyBonus: Record<string, number> = { loyal: 20, returning: 10, new: 0, churned: -10 }
  const loyaltyScore = Math.max(0, Math.min(100, 50 + (loyaltyBonus[loyaltyTier] ?? 0)))
  const loyaltyComment = loyaltyTier === 'loyal' ? '忠诚达人，优先合作' : loyaltyTier === 'returning' ? '回流达人，积极维护' : loyaltyTier === 'churned' ? '流失达人，需挽回' : '新达人，需培养'

  const score = Math.round(
    stabilityScore * 0.15 +
    roiScore * 0.30 +
    qualityScore * 0.25 +
    engagementScore * 0.15 +
    loyaltyScore * 0.15,
  )

  const dimensions: ValueDimension[] = [
    { name: '稳定性', score: stabilityScore, comment: stabilityComment },
    { name: 'ROI表现', score: roiScore, comment: roiComment },
    { name: '合作质量', score: qualityScore, comment: qualityComment },
    { name: '互动效果', score: engagementScore, comment: engagementComment },
    { name: '忠诚度', score: loyaltyScore, comment: loyaltyComment },
  ]

  let recommendation: string
  if (score >= 80) {
    recommendation = '⭐ **核心达人** — 建议列为重点合作对象，保持长期合作关系，可给予更优合作条件。'
  } else if (score >= 60) {
    recommendation = '✅ **优质达人** — 合作表现良好，建议持续合作并尝试提升合作深度。'
  } else if (score >= 40) {
    recommendation = '⚠️ **潜力达人** — 有一定价值但存在短板，建议针对性优化合作策略。'
  } else {
    recommendation = '❓ **观察达人** — 数据不足或表现较弱，建议谨慎评估后再决定是否继续合作。'
  }

  return { score, dimensions, recommendation }
}
