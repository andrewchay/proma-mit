/**
 * KOL 数据服务
 *
 * 负责 KOL 数据的本地存储（SQLite）和外部 API 拉取。
 * 存储位置：~/.mapro/kol-database.sqlite
 *
 * 支持的数据源：
 * - newrank（新榜）
 * - xinqiu（星图）
 * - justone（JustOneAPI）
 * - mock（内置样本数据，用于快速体验）
 */

import { existsSync, mkdirSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { getConfigDir } from '../../config-paths'
import type { KOLExtendedData } from '@gravitas/shared'

// =====================================================================
// SQLite 运行时适配层
//
// 开发模式（Bun）：使用 bun:sqlite（通过 Function 动态 require 避开 esbuild）
// 生产模式（Electron Node.js）：使用 better-sqlite3（esbuild external + electron-builder 打包）
// =====================================================================

/** 底层 SQLite 驱动实例（bun:sqlite Database 或 better-sqlite3 Database） */
let _nativeDb: any = null

/** 加载底层引擎 */
function loadEngine(): { Database: new (path: string) => any } {
  // Bun 运行时（开发模式）— 字符串拼接避开 esbuild 静态解析
  if (typeof Bun !== 'undefined') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('bun:' + 'sqlite')
      return { Database: mod.Database }
    } catch {
      // fall through to better-sqlite3
    }
  }
  // Node.js / Electron 运行时（生产模式）
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return { Database: require('better-sqlite3') }
}

/** 获取底层驱动实例 */
function getEngine(): { Database: new (path: string) => any } {
  if (!_nativeDb) {
    _nativeDb = loadEngine()
  }
  return _nativeDb
}

/**
 * 统一 Database API（模拟 bun:sqlite 接口）
 *
 * 适配 better-sqlite3 的 API 差异：
 * - DDL 用 exec()，DML 用 prepare().run()
 * - 查询用 prepare().get() / prepare().all()
 * - 空结果返回 null（兼容 bun:sqlite）
 */
class Database {
  private db: any

  constructor(path: string) {
    const { Database: NativeDb } = getEngine()
    this.db = new NativeDb(path)
    // WAL + busy_timeout：与 campaign-manager 共用 kol-database.sqlite 双连接读写，避免 SQLITE_BUSY
    try {
      this.db.exec('PRAGMA journal_mode=WAL')
      this.db.exec('PRAGMA busy_timeout=3000')
    } catch (err) {
      console.warn('[KOL 数据库] 设置 WAL/busy_timeout 失败:', err)
    }
  }

  run(sql: string, ...params: unknown[]): { changes: number } {
    const flat = flattenParams(params)
    if (flat.length === 0) {
      this.db.exec(sql)
      return { changes: 0 }
    }
    return this.db.prepare(sql).run(...flat)
  }

  query(sql: string) {
    const stmt = this.db.prepare(sql)
    return {
      get: (...params: unknown[]) => stmt.get(...flattenParams(params)) ?? null,
      all: (...params: unknown[]) => stmt.all(...flattenParams(params)),
    }
  }

  close(): void {
    this.db.close()
  }
}

/** 展开参数（兼容数组参数和展开参数） */
function flattenParams(params: unknown[]): any[] {
  if (params.length === 1 && Array.isArray(params[0])) {
    return params[0] as any[]
  }
  return params as any[]
}

// =====================================================================
// 类型定义
// =====================================================================

export interface KOLRecord {
  id: string
  name: string
  platform: string
  followers: string
  engagement: string
  category: string
  price: string
  city: string
  avatar: string
  source: string
  rawData: string
  fanScore: number
  engagementScore: number
  contentScore: number
  overallScore: number
  createdAt: number
  updatedAt: number
  // 扩展数据字段
  extendedData?: KOLExtendedData
  valueScore?: number
  adQualityScore?: number
  riskScore?: number
  valueTags?: string[]
  riskFlags?: string[]
}

export interface KOLSearchFilters {
  platform?: string
  category?: string
  minFollowers?: number
  maxFollowers?: number
  minEngagement?: number
  city?: string
  keywords?: string[]
  limit?: number
}

export interface KOLSearchResult {
  kols: KOLRecord[]
  total: number
}

export interface KOLCollectorReport {
  success: boolean
  source: string
  platform: string
  collected: number
  new: number
  updated: number
  errors: string[]
  message?: string
}

type KOLScoreFields = Pick<KOLRecord, 'fanScore' | 'engagementScore' | 'contentScore' | 'overallScore' | 'valueScore' | 'adQualityScore' | 'riskScore'>
type KOLUpsertInput = Omit<KOLRecord, 'createdAt' | 'updatedAt' | keyof KOLScoreFields> &
  Partial<KOLScoreFields> & {
    createdAt?: number
    updatedAt?: number
  }

// =====================================================================
// 数据库初始化
// =====================================================================

let dbInstance: Database | null = null

function getDbPath(): string {
  return join(getConfigDir(), 'kol-database.sqlite')
}

function getDefaultKolDbPath(): string {
  return join(homedir(), 'LLM', 'ma', 'data', 'kol_database.db')
}

function getDb(): Database {
  if (dbInstance) return dbInstance

  const dbPath = getDbPath()
  const defaultDbPath = getDefaultKolDbPath()

  // 如果目标数据库不存在，且默认数据库存在，则复制
  if (!existsSync(dbPath) && existsSync(defaultDbPath)) {
    try {
      cpSync(defaultDbPath, dbPath)
      console.log(`[KOL 数据库] 已从 ${defaultDbPath} 复制到 ${dbPath}`)
    } catch (err) {
      console.warn(`[KOL 数据库] 复制默认数据库失败:`, err)
    }
  }

  dbInstance = new Database(dbPath)

  // 创建表（如果表不存在则创建，包含评分字段和扩展数据列）
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS kols (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      followers TEXT,
      engagement TEXT,
      category TEXT,
      price TEXT,
      city TEXT,
      avatar TEXT,
      source TEXT NOT NULL,
      raw_data TEXT,
      fan_score REAL DEFAULT 0,
      engagement_score REAL DEFAULT 0,
      content_score REAL DEFAULT 0,
      overall_score REAL DEFAULT 0,
      value_score REAL DEFAULT 0,
      ad_quality_score REAL DEFAULT 0,
      risk_score REAL DEFAULT 0,
      extended_data TEXT,
      value_tags TEXT,
      risk_flags TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    )
  `)

  // 兼容原始数据库：如果原始数据库没有评分字段，添加它们
  const hasColumn = (table: string, col: string): boolean => {
    try {
      const rows = dbInstance!.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      return rows.some((r) => r.name === col)
    } catch {
      return false
    }
  }
  if (!hasColumn('kols', 'fan_score')) {
    dbInstance.run(`ALTER TABLE kols ADD COLUMN fan_score REAL DEFAULT 0`)
  }
  if (!hasColumn('kols', 'engagement_score')) {
    dbInstance.run(`ALTER TABLE kols ADD COLUMN engagement_score REAL DEFAULT 0`)
  }
  if (!hasColumn('kols', 'content_score')) {
    dbInstance.run(`ALTER TABLE kols ADD COLUMN content_score REAL DEFAULT 0`)
  }
  if (!hasColumn('kols', 'overall_score')) {
    dbInstance.run(`ALTER TABLE kols ADD COLUMN overall_score REAL DEFAULT 0`)
  }
  // 扩展数据评分列
  if (!hasColumn('kols', 'value_score')) {
    dbInstance.run(`ALTER TABLE kols ADD COLUMN value_score REAL DEFAULT 0`)
  }
  if (!hasColumn('kols', 'ad_quality_score')) {
    dbInstance.run(`ALTER TABLE kols ADD COLUMN ad_quality_score REAL DEFAULT 0`)
  }
  if (!hasColumn('kols', 'risk_score')) {
    dbInstance.run(`ALTER TABLE kols ADD COLUMN risk_score REAL DEFAULT 0`)
  }
  if (!hasColumn('kols', 'extended_data')) {
    dbInstance.run(`ALTER TABLE kols ADD COLUMN extended_data TEXT`)
  }
  if (!hasColumn('kols', 'value_tags')) {
    dbInstance.run(`ALTER TABLE kols ADD COLUMN value_tags TEXT`)
  }
  if (!hasColumn('kols', 'risk_flags')) {
    dbInstance.run(`ALTER TABLE kols ADD COLUMN risk_flags TEXT`)
  }

  // 达人CRM表
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
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      FOREIGN KEY (kol_id) REFERENCES kols(id) ON DELETE CASCADE
    )
  `)

  // 投放测试表
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS campaign_tests (
      test_id TEXT PRIMARY KEY,
      campaign_id TEXT,
      test_name TEXT NOT NULL,
      budget REAL DEFAULT 0,
      kol_combo TEXT,
      start_date TEXT,
      end_date TEXT,
      status TEXT DEFAULT 'planned',
      results TEXT,
      optimization_notes TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    )
  `)

  // 内容审核记录表（新增 campaign_id 字段）
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS content_audits (
      audit_id TEXT PRIMARY KEY,
      campaign_id TEXT,
      kol_id TEXT NOT NULL,
      content_url TEXT,
      platform TEXT,
      audit_status TEXT DEFAULT 'pending',
      compliance_score REAL,
      brand_alignment_score REAL,
      quality_score REAL,
      audit_report TEXT,
      auditor TEXT DEFAULT 'ai',
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    )
  `)

  // 达人效果记录表
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

  // 创建索引
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_kols_platform ON kols(platform)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_kols_category ON kols(category)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_kols_name ON kols(name)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_kols_source ON kols(source)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_kols_overall_score ON kols(overall_score DESC)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_kols_value_score ON kols(value_score DESC)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_kols_ad_quality_score ON kols(ad_quality_score DESC)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_kol_crm_status ON kol_crm(onboarding_status)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_kol_crm_loyalty ON kol_crm(loyalty_tier)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_campaign_tests_status ON campaign_tests(status)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_content_audits_kol ON content_audits(kol_id)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_content_audits_status ON content_audits(audit_status)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_kol_performance_kol ON kol_performance(kol_id)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_kol_performance_campaign ON kol_performance(campaign_id)`)

  console.log('[KOL数据服务] 数据库已初始化:', dbPath)
  return dbInstance
}

/** 关闭数据库连接（主要用于测试） */
export function closeKolDatabase(): void {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
}

// =====================================================================
// CRUD 操作
// =====================================================================

/**
 * 插入或更新 KOL 记录
 */
export function upsertKOL(kol: KOLUpsertInput): void {
  const db = getDb()
  const now = Date.now()

  // 自动计算评分
  const scores = computeKOLScores(kol as KOLRecord)

  db.run(
    `
    INSERT INTO kols (id, name, platform, followers, engagement, category, price, city, avatar, source, raw_data, fan_score, engagement_score, content_score, overall_score, value_score, ad_quality_score, risk_score, extended_data, value_tags, risk_flags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      platform = excluded.platform,
      followers = excluded.followers,
      engagement = excluded.engagement,
      category = excluded.category,
      price = excluded.price,
      city = excluded.city,
      avatar = excluded.avatar,
      source = excluded.source,
      raw_data = excluded.raw_data,
      fan_score = excluded.fan_score,
      engagement_score = excluded.engagement_score,
      content_score = excluded.content_score,
      overall_score = excluded.overall_score,
      value_score = excluded.value_score,
      ad_quality_score = excluded.ad_quality_score,
      risk_score = excluded.risk_score,
      extended_data = excluded.extended_data,
      value_tags = excluded.value_tags,
      risk_flags = excluded.risk_flags,
      updated_at = excluded.updated_at
    `,
    [
      kol.id,
      kol.name,
      kol.platform,
      kol.followers,
      kol.engagement,
      kol.category,
      kol.price,
      kol.city,
      kol.avatar,
      kol.source,
      kol.rawData,
      scores.baseScore,
      scores.contentScore,
      scores.commercialScore,
      scores.overallScore,
      scores.valueScore,
      scores.adQualityScore,
      scores.riskScore,
      kol.extendedData ? JSON.stringify(kol.extendedData) : null,
      kol.valueTags ? kol.valueTags.join(',') : null,
      kol.riskFlags ? kol.riskFlags.join(',') : null,
      kol.createdAt ?? now,
      kol.updatedAt ?? now,
    ],
  )
}

/**
 * 根据 ID 获取 KOL
 */
export function getKOLById(id: string): KOLRecord | undefined {
  const db = getDb()
  const row = db.query('SELECT * FROM kols WHERE id = ?').get(id) as Record<string, unknown> | null
  if (!row) return undefined
  return rowToKOL(row)
}

/**
 * 搜索 KOL
 */
export function searchKOLs(filters: KOLSearchFilters): KOLSearchResult {
  const db = getDb()
  const conditions: string[] = []
  const params: (string | number)[] = []

  if (filters.platform) {
    conditions.push('platform = ?')
    params.push(filters.platform)
  }
  if (filters.category) {
    conditions.push('category = ?')
    params.push(filters.category)
  }
  if (filters.city) {
    conditions.push('city LIKE ?')
    params.push(`%${filters.city}%`)
  }
  if (filters.keywords && filters.keywords.length > 0) {
    const keywordConditions = filters.keywords.map(() => 'name LIKE ?').join(' OR ')
    conditions.push(`(${keywordConditions})`)
    for (const kw of filters.keywords) {
      params.push(`%${kw}%`)
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = filters.limit ?? 50

  const rows = db.query(`SELECT * FROM kols ${whereClause} ORDER BY updated_at DESC LIMIT ?`).all(
    ...params,
    limit,
  ) as Record<string, unknown>[]

  const countRow = db.query(`SELECT COUNT(*) as total FROM kols ${whereClause}`).get(...params) as { total: number } | null

  return {
    kols: rows.map(rowToKOL),
    total: countRow?.total ?? rows.length,
  }
}

/**
 * 获取所有平台列表
 */
export function getPlatforms(): string[] {
  const db = getDb()
  const rows = db.query('SELECT DISTINCT platform FROM kols ORDER BY platform').all() as { platform: string }[]
  return rows.map((r) => r.platform)
}

/**
 * 获取所有类目列表
 */
export function getCategories(): string[] {
  const db = getDb()
  const rows = db.query('SELECT DISTINCT category FROM kols WHERE category IS NOT NULL AND category != "" ORDER BY category').all() as { category: string }[]
  return rows.map((r) => r.category)
}

/**
 * 删除 KOL
 */
export function deleteKOL(id: string): boolean {
  const db = getDb()
  const result = db.run('DELETE FROM kols WHERE id = ?', [id])
  return result.changes > 0
}

/**
 * 清空数据库
 */
export function clearAllKOLs(): void {
  const db = getDb()
  db.run('DELETE FROM kols')
}

/**
 * 获取统计信息
 */
export function getKOLStats(): { total: number; byPlatform: Record<string, number>; bySource: Record<string, number> } {
  const db = getDb()

  const totalRow = db.query('SELECT COUNT(*) as total FROM kols').get() as { total: number }

  const platformRows = db.query('SELECT platform, COUNT(*) as count FROM kols GROUP BY platform').all() as { platform: string; count: number }[]
  const byPlatform: Record<string, number> = {}
  for (const r of platformRows) {
    byPlatform[r.platform] = r.count
  }

  const sourceRows = db.query('SELECT source, COUNT(*) as count FROM kols GROUP BY source').all() as { source: string; count: number }[]
  const bySource: Record<string, number> = {}
  for (const r of sourceRows) {
    bySource[r.source] = r.count
  }

  return {
    total: totalRow.total,
    byPlatform,
    bySource,
  }
}

// =====================================================================
// 行转换
// =====================================================================

function rowToKOL(row: Record<string, unknown>): KOLRecord {
  const extRaw = row.extended_data ? String(row.extended_data) : null
  let extendedData: KOLRecord['extendedData'] = undefined
  if (extRaw) {
    try {
      extendedData = JSON.parse(extRaw) as KOLRecord['extendedData']
    } catch {
      extendedData = undefined
    }
  }
  return {
    id: String(row.id),
    name: String(row.name),
    platform: String(row.platform),
    followers: String(row.followers ?? ''),
    engagement: String(row.engagement ?? ''),
    category: String(row.category ?? ''),
    price: String(row.price ?? ''),
    city: String(row.city ?? ''),
    avatar: String(row.avatar ?? ''),
    source: String(row.source),
    rawData: String(row.raw_data ?? ''),
    fanScore: Number(row.fan_score ?? 0),
    engagementScore: Number(row.engagement_score ?? 0),
    contentScore: Number(row.content_score ?? 0),
    overallScore: Number(row.overall_score ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    extendedData,
    valueScore: row.value_score != null ? Number(row.value_score) : undefined,
    adQualityScore: row.ad_quality_score != null ? Number(row.ad_quality_score) : undefined,
    riskScore: row.risk_score != null ? Number(row.risk_score) : undefined,
    valueTags: row.value_tags ? String(row.value_tags).split(',').filter(Boolean) : undefined,
    riskFlags: row.risk_flags ? String(row.risk_flags).split(',').filter(Boolean) : undefined,
  }
}

// =====================================================================
// 样本数据（Mock）
// =====================================================================

const SAMPLE_KOLS: Omit<KOLRecord, 'createdAt' | 'updatedAt'>[] = [
  ...[
    { id: 'mock_小红书_美妆达人小美', name: '@美妆达人小美', platform: '小红书', followers: '50万', engagement: '8.5%', category: '美妆', price: '3万', city: '上海', avatar: '', source: 'mock', rawData: '{}' },
    { id: 'mock_小红书_护肤分享师', name: '@护肤分享师', platform: '小红书', followers: '30万', engagement: '9.2%', category: '美妆', price: '2万', city: '杭州', avatar: '', source: 'mock', rawData: '{}' },
    { id: 'mock_小红书_生活方式博主', name: '@生活方式博主', platform: '小红书', followers: '80万', engagement: '6.8%', category: '生活方式', price: '5万', city: '北京', avatar: '', source: 'mock', rawData: '{}' },
    { id: 'mock_小红书_母婴博主乐乐', name: '@母婴博主乐乐', platform: '小红书', followers: '40万', engagement: '10.1%', category: '母婴', price: '2.5万', city: '广州', avatar: '', source: 'mock', rawData: '{}' },
    { id: 'mock_小红书_数码测评君', name: '@数码测评君', platform: '小红书', followers: '60万', engagement: '7.5%', category: '3C', price: '4万', city: '深圳', avatar: '', source: 'mock', rawData: '{}' },
    { id: 'mock_抖音_时尚小姐姐', name: '@时尚小姐姐', platform: '抖音', followers: '200万', engagement: '5.2%', category: '时尚', price: '15万', city: '上海', avatar: '', source: 'mock', rawData: '{}' },
    { id: 'mock_抖音_搞笑日常', name: '@搞笑日常', platform: '抖音', followers: '500万', engagement: '4.8%', category: '娱乐', price: '30万', city: '成都', avatar: '', source: 'mock', rawData: '{}' },
    { id: 'mock_抖音_美食探店', name: '@美食探店', platform: '抖音', followers: '150万', engagement: '6.5%', category: '美食', price: '10万', city: '重庆', avatar: '', source: 'mock', rawData: '{}' },
    { id: 'mock_抖音_科技大人', name: '@科技大人', platform: '抖音', followers: '300万', engagement: '5.8%', category: '3C', price: '20万', city: '北京', avatar: '', source: 'mock', rawData: '{}' },
    { id: 'mock_微博_时尚icon', name: '@时尚icon', platform: '微博', followers: '800万', engagement: '3.5%', category: '时尚', price: '50万', city: '北京', avatar: '', source: 'mock', rawData: '{}' },
    { id: 'mock_微博_美妆教主', name: '@美妆教主', platform: '微博', followers: '600万', engagement: '4.2%', category: '美妆', price: '40万', city: '上海', avatar: '', source: 'mock', rawData: '{}' },
    { id: 'mock_B站_测评实验室', name: '@测评实验室', platform: 'B站', followers: '150万', engagement: '12.5%', category: '3C', price: '12万', city: '上海', avatar: '', source: 'mock', rawData: '{}' },
  ].map((kol) => ({
    ...kol,
    fanScore: 0,
    engagementScore: 0,
    contentScore: 0,
    overallScore: 0,
    valueScore: 0,
    adQualityScore: 0,
    riskScore: 0,
  })),
  // 带扩展数据的示例 KOL（用于展示扩展评分维度）
  {
    id: 'mock_xhs_扩展数据示例_美妆达人',
    name: '@扩展数据示例-美妆达人',
    platform: '小红书',
    followers: '100万',
    engagement: '12%',
    category: '美妆',
    price: '5万',
    city: '上海',
    avatar: '',
    source: 'mock',
    rawData: '{}',
    fanScore: 0,
    engagementScore: 0,
    contentScore: 0,
    overallScore: 0,
    valueScore: 0,
    adQualityScore: 0,
    riskScore: 0,
    extendedData: {
      likes: 5000,
      saves: 3000,
      likesToSavesRatio: 1.67,
      femaleRatio: 82,
      maleRatio: 18,
      age18to35Ratio: 55,
      minLikes3m: 2000,
      maxLikes3m: 15000,
      avgLikes3m: 6000,
      monthlyPostCount: 8,
      postsLast30d: 7,
      viralRate30d: 12,
      viralNotesCount: 3,
      negativeCommentRatio: 3,
      cpe: 8,
      cpm: 60,
      estimatedPrice: 100000,
      priceReasonableness: 'normal',
      adNoteRatio: 15,
      organicNoteRatio: 75,
      adNotesLast30d: 3,
      totalNotesLast30d: 20,
      recentNotesTrend: [
        { date: '2024-01-15', title: '新年妆容分享', exposure: 50000, views: 30000, likes: 5000, comments: 200, saves: 1500, isAd: false },
        { date: '2024-01-10', title: 'XX口红试色', exposure: 80000, views: 50000, likes: 8000, comments: 300, saves: 2500, isAd: true },
      ],
      recentAdNotes: [
        { date: '2024-01-10', title: 'XX口红试色', exposure: 80000, views: 50000, completionRate: 0.6, likes: 8000, comments: 300, saves: 2500, shares: 150, commentProductRatio: 45, vsOrganic: { exposureDiff: 30000, engagementDiff: 2000 } },
      ],
      valueTags: ['女粉精准', '性价比高', '爆文率高'],
      riskFlags: [],
    },
  },
  {
    id: 'mock_xhs_扩展数据示例_生活方式',
    name: '@扩展数据示例-生活方式',
    platform: '小红书',
    followers: '60万',
    engagement: '7%',
    category: '生活方式',
    price: '3.5万',
    city: '杭州',
    avatar: '',
    source: 'mock',
    rawData: '{}',
    fanScore: 0,
    engagementScore: 0,
    contentScore: 0,
    overallScore: 0,
    valueScore: 0,
    adQualityScore: 0,
    riskScore: 0,
    extendedData: {
      likes: 3000,
      saves: 2000,
      likesToSavesRatio: 1.5,
      femaleRatio: 75,
      maleRatio: 25,
      age18to35Ratio: 48,
      minLikes3m: 1500,
      maxLikes3m: 8000,
      avgLikes3m: 3500,
      monthlyPostCount: 6,
      postsLast30d: 5,
      viralRate30d: 8,
      viralNotesCount: 2,
      negativeCommentRatio: 5,
      cpe: 12,
      cpm: 80,
      estimatedPrice: 60000,
      priceReasonableness: 'normal',
      adNoteRatio: 25,
      organicNoteRatio: 65,
      adNotesLast30d: 4,
      totalNotesLast30d: 16,
      valueTags: ['更新稳定'],
      riskFlags: ['CPE偏高', '广告占比上升'],
    },
  },
]

/**
 * 用 Mock 数据填充本地数据库
 */
export function seedMockKOLs(): { inserted: number } {
  const db = getDb()
  let inserted = 0

  for (const kol of SAMPLE_KOLS) {
    const existing = db.query('SELECT 1 FROM kols WHERE id = ?').get(kol.id)
    if (!existing) {
      upsertKOL(kol)
      inserted++
    }
  }

  console.log(`[KOL数据服务] Mock 数据已填充: ${inserted} 条`)
  return { inserted }
}

// =====================================================================
// API 数据源拉取
// =====================================================================

/** JustOneAPI 搜索 */
export async function searchJustOne(
  apiToken: string,
  platform: string,
  keywords?: string[],
  limit: number = 10,
): Promise<KOLRecord[]> {
  const baseUrl = process.env.JUSTONE_API_BASE_URL ?? 'https://api.justoneapi.com'

  const platformEndpoints: Record<string, string> = {
    '小红书': '/api/xiaohongshu/search-user/v2',
    '抖音': '/api/douyin/search-user/v2',
    '快手': '/api/kuaishou/search-user/v2',
    'TikTok': '/api/tiktok/search-user/v1',
    '微博': '/api/search/v1',
    'B站': '/api/search/v1',
    'Instagram': '/api/instagram/search-reels/v1',
    'YouTube': '/api/search/v1',
  }

  const endpoint = platformEndpoints[platform]
  if (!endpoint) {
    console.warn(`[JustOne] 不支持的平�: ${platform}`)
    return []
  }

  const params = new URLSearchParams({ token: apiToken })
  if (keywords && keywords.length > 0) {
    params.set('keyword', keywords[0] ?? '')
  }

  // 微博/B站/YouTube 需要 source 参数
  if (platform === '微博') params.set('source', 'WEIBO')
  if (platform === 'B站') params.set('source', 'BILIBILI')
  if (platform === 'YouTube') params.set('source', 'ALL')

  try {
    const url = `${baseUrl}${endpoint}?${params.toString()}`
    const response = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } })

    if (!response.ok) {
      console.error(`[JustOne] API 请求失败: ${response.status}`)
      return []
    }

    const data = await response.json() as { data?: unknown[]; code?: string; message?: string }
    if (data.code && data.code !== '200') {
      console.error(`[JustOne] API 错误: ${data.message}`)
      return []
    }

    const rawList = Array.isArray(data.data) ? data.data : []
    return rawList.slice(0, limit).map((item: unknown) => normalizeJustOneItem(item, platform))
  } catch (error) {
    console.error('[JustOne] 请求异常:', error)
    return []
  }
}

function normalizeJustOneItem(item: unknown, platform: string): KOLRecord {
  const raw = item as Record<string, unknown>
  const userId = String(raw.userId ?? raw.user_id ?? raw.secUid ?? raw.uid ?? raw.channelId ?? raw.username ?? '')
  const name = String(raw.nickname ?? raw.accountName ?? raw.account_name ?? raw.name ?? '未知')
  const safeId = userId || `justone_${platform}_${name.replace(/\s+/g, '_')}`

  const followers = raw.fansCount ?? raw.followerCount ?? raw.followers ?? 0
  const engagement = raw.interactRate ?? raw.engagementRate ?? 0

  return {
    id: safeId,
    name,
    platform,
    followers: formatFollowers(followers),
    engagement: formatEngagement(engagement),
    category: String(raw.category ?? raw.tag ?? '未知'),
    price: String(raw.price ?? '待询'),
    city: String(raw.city ?? ''),
    avatar: String(raw.headImg ?? raw.avatar ?? raw.avatarUrl ?? ''),
    source: 'justone',
    rawData: JSON.stringify(raw),
    fanScore: 0,
    engagementScore: 0,
    contentScore: 0,
    overallScore: 0,
    valueScore: 0,
    adQualityScore: 0,
    riskScore: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/** 新榜搜索 */
export async function searchNewrank(
  apiKey: string,
  platform: string,
  keywords?: string[],
  limit: number = 10,
): Promise<KOLRecord[]> {
  const platformMap: Record<string, string> = {
    '小红书': 'xiaohongshu',
    '抖音': 'douyin',
    '微博': 'weibo',
    'B站': 'bilibili',
    '快手': 'kuaishou',
  }

  const apiPlatform = platformMap[platform] ?? platform
  const params = new URLSearchParams({ platform: apiPlatform, pageSize: String(limit) })
  if (keywords && keywords.length > 0) {
    params.set('keywords', keywords.join(','))
  }

  try {
    const response = await fetch(`https://api.newrank.cn/api/kol/search?${params.toString()}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      console.error(`[Newrank] API 请求失败: ${response.status}`)
      return []
    }

    const data = await response.json() as { data?: unknown[] }
    const rawList = Array.isArray(data.data) ? data.data : []

    return rawList.slice(0, limit).map((item: unknown) => {
      const raw = item as Record<string, unknown>
      const id = String(raw.accountId ?? raw.account_id ?? `newrank_${platform}_${hashCode(String(raw.accountName ?? ''))}`)
      return {
        id,
        name: String(raw.accountName ?? raw.account_name ?? '未知'),
        platform,
        followers: formatFollowers(raw.fansCount ?? 0),
        engagement: formatEngagement(raw.interactRate ?? 0),
        category: String(raw.category ?? '未知'),
        price: '待询',
        city: String(raw.city ?? ''),
        avatar: String(raw.headImg ?? raw.avatar ?? ''),
        source: 'newrank',
        rawData: JSON.stringify(raw),
        fanScore: 0,
        engagementScore: 0,
        contentScore: 0,
        overallScore: 0,
        valueScore: 0,
        adQualityScore: 0,
        riskScore: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
    })
  } catch (error) {
    console.error('[Newrank] 请求异常:', error)
    return []
  }
}

// =====================================================================
// 采集器主入口
// =====================================================================

export interface KOLCollectorConfig {
  justoneToken?: string
  newrankKey?: string
}

/**
 * 从指定数据源采集 KOL 并存入本地数据库
 */
export async function collectFromSource(
  sourceName: string,
  config: KOLCollectorConfig,
  platform: string,
  keywords?: string[],
  limit: number = 30,
): Promise<KOLCollectorReport> {
  let kols: KOLRecord[] = []

  if (sourceName === 'justone') {
    if (!config.justoneToken) {
      return { success: false, source: sourceName, platform, collected: 0, new: 0, updated: 0, errors: ['JUSTONE_API_TOKEN 未配置'] }
    }
    kols = await searchJustOne(config.justoneToken, platform, keywords, limit)
  } else if (sourceName === 'newrank') {
    if (!config.newrankKey) {
      return { success: false, source: sourceName, platform, collected: 0, new: 0, updated: 0, errors: ['NEWRANK_API_KEY 未配置'] }
    }
    kols = await searchNewrank(config.newrankKey, platform, keywords, limit)
  } else if (sourceName === 'mock') {
    // Mock 数据已经在 seedMockKOLs 中处理
    return { success: true, source: sourceName, platform, collected: 0, new: 0, updated: 0, errors: [], message: 'Mock 数据通过 seedMockKOLs() 初始化' }
  } else {
    return { success: false, source: sourceName, platform, collected: 0, new: 0, updated: 0, errors: [`未知数据源: ${sourceName}`] }
  }

  if (kols.length === 0) {
    return { success: true, source: sourceName, platform, collected: 0, new: 0, updated: 0, errors: [], message: '数据源返回空结果' }
  }

  let newCount = 0
  let updatedCount = 0
  const errors: string[] = []

  for (const kol of kols) {
    try {
      const existing = getKOLById(kol.id)
      upsertKOL(kol)
      if (existing) {
        updatedCount++
      } else {
        newCount++
      }
    } catch (e) {
      errors.push(`${kol.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    success: true,
    source: sourceName,
    platform,
    collected: newCount + updatedCount,
    new: newCount,
    updated: updatedCount,
    errors,
  }
}

/**
 * 遍历所有已配置的数据源采集
 */
export async function collectAllSources(
  config: KOLCollectorConfig,
  platforms: string[],
  limitPerSource: number = 20,
): Promise<KOLCollectorReport[]> {
  const reports: KOLCollectorReport[] = []
  const sources: string[] = []

  if (config.justoneToken) sources.push('justone')
  if (config.newrankKey) sources.push('newrank')

  for (const source of sources) {
    for (const platform of platforms) {
      const report = await collectFromSource(source, config, platform, undefined, limitPerSource)
      reports.push(report)
    }
  }

  return reports
}

// =====================================================================
// 工具函数
// =====================================================================

function formatFollowers(count: unknown): string {
  const num = typeof count === 'string' ? parseFloat(count) : Number(count)
  if (Number.isNaN(num)) return String(count)
  if (num >= 10000) return `${(num / 10000).toFixed(1)}万`
  return String(Math.round(num))
}

function formatEngagement(rate: unknown): string {
  const num = typeof rate === 'string' ? parseFloat(rate) : Number(rate)
  if (Number.isNaN(num)) return String(rate)
  if (num > 1) return `${num.toFixed(1)}%`
  return `${(num * 100).toFixed(1)}%`
}

function hashCode(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }
  return Math.abs(hash)
}

// =====================================================================
// KOL 评分算法 — 基于 VONBON 文档 §4.1
// 5 维度：基础数据 25-30% | 内容质量 25-30% | 商业适配 25% | 粉丝画像 15% | 风险评估 5%
// 粉丝层级 §2.2：超头部500w+/头部100-500w/肩部50-100w/腰部10-50w/尾部1-10w/KOC 1k-1w
// 平台差异：小红书重内容质量(30%)，抖音重基础数据(30%)
// =====================================================================

const PLATFORM_WEIGHTS: Record<string, { base: number; content: number; commercial: number; audience: number; risk: number }> = {
  '小红书': { base: 0.25, content: 0.30, commercial: 0.25, audience: 0.15, risk: 0.05 },
  '抖音':   { base: 0.30, content: 0.25, commercial: 0.25, audience: 0.15, risk: 0.05 },
  '微博':   { base: 0.30, content: 0.25, commercial: 0.25, audience: 0.15, risk: 0.05 },
  'B站':    { base: 0.25, content: 0.30, commercial: 0.25, audience: 0.15, risk: 0.05 },
  '快手':   { base: 0.30, content: 0.25, commercial: 0.25, audience: 0.15, risk: 0.05 },
}

function parseFollowersNum(followers: string): number {
  if (!followers) return 0
  const match = followers.match(/^(\d+(?:\.\d+)?)\s*(万|亿|千|k|w)?$/i)
  if (!match) return 0
  const num = parseFloat(match[1]!)
  const unit = match[2] ?? ''
  switch (unit.toLowerCase()) {
    case '万': case 'w': return num * 10000
    case '亿': return num * 100000000
    case '千': case 'k': return num * 1000
    default: return num
  }
}

function parseEngagementNum(engagement: string): number {
  if (!engagement) return 0
  const match = engagement.match(/^(\d+(?:\.\d+)?)%?$/)
  return match ? parseFloat(match[1]!) : 0
}

function computeBaseScore(platform: string, followersStr: string, engagementStr: string): number {
  const followers = parseFollowersNum(followersStr)
  const engagement = parseEngagementNum(engagementStr)

  const fanScore = followers >= 5000000 ? 100
    : followers >= 1000000 ? 80
    : followers >= 500000 ? 60
    : followers >= 100000 ? 40
    : followers >= 10000 ? 20
    : followers >= 1000 ? 10
    : 5

  const engagementTiers: Record<string, [number, number, number, number, number]> = {
    '小红书': [3, 5, 8, 10, 15],
    '抖音':   [2, 3, 5, 7, 10],
    '微博':   [1, 2, 3, 4, 6],
    'B站':    [4, 6, 10, 15, 20],
    '快手':   [2, 3, 5, 7, 10],
  }
  const t = engagementTiers[platform] ?? engagementTiers['小红书']!
  const engagementScore = engagement >= t[4] ? 100
    : engagement >= t[3] ? 80
    : engagement >= t[2] ? 60
    : engagement >= t[1] ? 40
    : engagement >= t[0] ? 20
    : 10

  return Math.round(fanScore * 0.5 + engagementScore * 0.5)
}

function computeContentScore(platform: string, engagementStr: string): number {
  const engagement = parseEngagementNum(engagementStr)
  const platformBaseline: Record<string, number> = {
    '小红书': 5, '抖音': 3, '微博': 2, 'B站': 6, '快手': 3,
  }
  const baseline = platformBaseline[platform] ?? 5
  if (engagement >= baseline * 2) return 100
  if (engagement >= baseline * 1.5) return 80
  if (engagement >= baseline) return 60
  if (engagement >= baseline * 0.5) return 40
  return 20
}

function computeCommercialScore(kolCategory: string, brandCategory?: string): number {
  if (!brandCategory || !kolCategory) return 50
  if (kolCategory === brandCategory) return 100
  const relatedMap: Record<string, string[]> = {
    '美妆': ['护肤', '彩妆', '穿搭', '时尚', '生活方式'],
    '护肤': ['美妆', '生活方式', '健康'],
    '食品': ['美食', '生活方式', '健康', '母婴'],
    '3C': ['科技', '数码', '生活方式'],
    '时尚': ['美妆', '穿搭', '生活方式'],
    '母婴': ['育儿', '生活方式', '食品', '健康'],
    '家居': ['生活方式', '设计', '装修'],
    '健康': ['运动', '健身', '食品', '生活方式'],
  }
  const related = relatedMap[brandCategory] ?? []
  if (related.includes(kolCategory)) return 75
  return 30
}

function computeAudienceScore(kolCity: string, targetCities?: string[]): number {
  if (!targetCities || targetCities.length === 0 || !kolCity) return 50
  if (targetCities.includes(kolCity)) return 100
  const tier1 = ['北京', '上海', '广州', '深圳', '杭州', '成都']
  const kolTier1 = tier1.includes(kolCity)
  const targetTier1 = targetCities.some((c) => tier1.includes(c))
  if (kolTier1 && targetTier1) return 80
  if (!kolTier1 && !targetTier1) return 70
  return 40
}

function computeRiskScore(platform: string, followersStr: string, engagementStr: string, extendedData?: KOLExtendedData): number {
  const followers = parseFollowersNum(followersStr)
  const engagement = parseEngagementNum(engagementStr)
  const interactionRatio = followers > 0 ? (engagement / followers * 100) : 0
  let score = 90

  // 基础风险评估（互动率异常）
  if (interactionRatio > 10) score -= 30
  if (interactionRatio < 0.05) score -= 20
  if (platform === '抖音' && engagement > 50) score -= 20

  // 基于扩展数据的风险评估
  if (extendedData) {
    // 负面评论占比（<10%合格，0%优秀）
    if (extendedData.negativeCommentRatio != null) {
      if (extendedData.negativeCommentRatio > 20) score -= 30
      else if (extendedData.negativeCommentRatio > 10) score -= 15
      else if (extendedData.negativeCommentRatio === 0) score += 5
    }

    // 更新频率（月更4条合格，8-10条优秀）
    if (extendedData.monthlyPostCount != null) {
      if (extendedData.monthlyPostCount < 2) score -= 20  // 更新不稳定
      else if (extendedData.monthlyPostCount > 15) score -= 10  // 更新过于频繁可能质量下降
    }

    // 爆文率异常（5%合格，10%优秀）
    if (extendedData.viralRate30d != null) {
      if (extendedData.viralRate30d > 30) score -= 15  // 爆文率过高可能刷量
    }
  }

  return Math.max(0, Math.min(100, score))
}

/**
 * 计算性价比评分（基于 CPE、CPM、报价合理性）
 * 5-10元性价比高，10-20元常态，>20元需谨慎
 */
function computeValueScore(priceStr: string, followersStr: string, extendedData?: KOLExtendedData): number {
  let score = 50

  // 解析报价
  const priceMatch = priceStr.match(/(\d+(?:\.\d+)?)\s*万?/)
  const price = priceMatch ? parseFloat(priceMatch[1]!) * (priceStr.includes('万') ? 10000 : 1) : 0
  const followers = parseFollowersNum(followersStr)

  if (extendedData) {
    // CPE 评估（单次互动成本）
    if (extendedData.cpe != null) {
      if (extendedData.cpe <= 5) score += 25
      else if (extendedData.cpe <= 10) score += 15
      else if (extendedData.cpe <= 20) score += 0
      else score -= 20
    }

    // CPM 评估（千次曝光成本）
    if (extendedData.cpm != null) {
      if (extendedData.cpm <= 50) score += 15
      else if (extendedData.cpm <= 100) score += 5
      else if (extendedData.cpm <= 200) score += 0
      else score -= 10
    }

    // 报价合理性（预估报价 vs 实际报价）
    if (extendedData.estimatedPrice != null && price > 0) {
      const ratio = price / extendedData.estimatedPrice
      if (ratio >= 0.8 && ratio <= 1.2) score += 10
      else if (ratio >= 0.5 && ratio <= 1.5) score += 5
      else if (ratio > 2) score -= 15
    }
  } else if (followers > 0 && price > 0) {
    // 无扩展数据时，基于粉丝量估算
    const estimatedPrice = followers * 0.1
    const ratio = price / estimatedPrice
    if (ratio >= 0.8 && ratio <= 1.2) score += 10
    else if (ratio >= 0.5 && ratio <= 1.5) score += 5
    else if (ratio > 2) score -= 15
  }

  return Math.max(0, Math.min(100, score))
}

/**
 * 计算广告质量评分（基于广告笔记占比、广告数据表现）
 * 广告笔记占比30%合格，10%优秀
 */
function computeAdQualityScore(extendedData?: KOLExtendedData): number {
  if (!extendedData) return 50

  let score = 50

  // 广告笔记占比评估
  if (extendedData.adNoteRatio != null) {
    if (extendedData.adNoteRatio <= 10) score += 20
    else if (extendedData.adNoteRatio <= 20) score += 10
    else if (extendedData.adNoteRatio <= 30) score += 0
    else if (extendedData.adNoteRatio <= 50) score -= 10
    else score -= 25
  }

  // 日常笔记占比评估（60%合格，70%优秀）
  if (extendedData.organicNoteRatio != null) {
    if (extendedData.organicNoteRatio >= 70) score += 10
    else if (extendedData.organicNoteRatio >= 60) score += 5
    else if (extendedData.organicNoteRatio < 40) score -= 10
  }

  // 近10条广告内容数据表现
  if (extendedData.recentAdNotes && extendedData.recentAdNotes.length > 0) {
    const avgEngagement = extendedData.recentAdNotes.reduce((sum, note) => sum + (note.likes + note.comments + note.saves), 0) / extendedData.recentAdNotes.length
    const avgOrganic = extendedData.recentNotesTrend
      ? extendedData.recentNotesTrend.filter(n => !n.isAd).reduce((sum, note) => sum + (note.likes + note.comments + note.saves), 0) / Math.max(1, extendedData.recentNotesTrend.filter(n => !n.isAd).length)
      : 0

    if (avgOrganic > 0) {
      const ratio = avgEngagement / avgOrganic
      if (ratio >= 0.8) score += 15
      else if (ratio >= 0.5) score += 5
      else if (ratio >= 0.3) score -= 5
      else score -= 15
    }

    // 完播率评估
    const avgCompletion = extendedData.recentAdNotes.reduce((sum, note) => sum + (note.completionRate ?? 0), 0) / extendedData.recentAdNotes.length
    if (avgCompletion >= 0.5) score += 10
    else if (avgCompletion >= 0.3) score += 5
    else if (avgCompletion < 0.1) score -= 10
  }

  return Math.max(0, Math.min(100, score))
}

export function computeKOLScores(
  kol: KOLRecord,
  brandCategory?: string,
  targetCities?: string[],
): {
  baseScore: number
  contentScore: number
  commercialScore: number
  audienceScore: number
  riskScore: number
  valueScore: number
  adQualityScore: number
  overallScore: number
} {
  const weights = PLATFORM_WEIGHTS[kol.platform] ?? PLATFORM_WEIGHTS['小红书']!
  const baseScore = computeBaseScore(kol.platform, kol.followers, kol.engagement)
  const contentScore = computeContentScore(kol.platform, kol.engagement)
  const commercialScore = computeCommercialScore(kol.category, brandCategory)
  const audienceScore = computeAudienceScore(kol.city, targetCities)
  const riskScore = computeRiskScore(kol.platform, kol.followers, kol.engagement, kol.extendedData)
  const valueScore = computeValueScore(kol.price, kol.followers, kol.extendedData)
  const adQualityScore = computeAdQualityScore(kol.extendedData)

  // 综合评分权重调整（纳入 valueScore 和 adQualityScore）
  const overallScore = Math.round(
    baseScore * weights.base * 0.7 +
    contentScore * weights.content * 0.7 +
    commercialScore * weights.commercial * 0.7 +
    audienceScore * weights.audience * 0.7 +
    riskScore * weights.risk * 0.7 +
    valueScore * 0.15 +
    adQualityScore * 0.15,
  )
  return { baseScore, contentScore, commercialScore, audienceScore, riskScore, valueScore, adQualityScore, overallScore }
}

export function recalculateAllScores(): { updated: number } {
  const db = getDb()
  const rows = db.query('SELECT * FROM kols').all() as Record<string, unknown>[]
  let updated = 0
  for (const row of rows) {
    const kol = rowToKOL(row)
    const scores = computeKOLScores(kol)
    db.run(
      `UPDATE kols SET fan_score = ?, engagement_score = ?, content_score = ?, overall_score = ?, value_score = ?, ad_quality_score = ?, risk_score = ?, updated_at = ? WHERE id = ?`,
      scores.baseScore, scores.contentScore, scores.commercialScore, scores.overallScore,
      scores.valueScore, scores.adQualityScore, scores.riskScore,
      Date.now(), kol.id,
    )
    updated++
  }
  console.log(`[KOL评分] 已重新计算 ${updated} 个 KOL（VONBON 5维度 + 扩展评分）`)
  return { updated }
}

export function getTopKOLs(limit: number = 20): KOLRecord[] {
  const db = getDb()
  const rows = db.query(
    `SELECT * FROM kols ORDER BY overall_score DESC, updated_at DESC LIMIT ?`
  ).all(limit) as Record<string, unknown>[]
  return rows.map(rowToKOL)
}
