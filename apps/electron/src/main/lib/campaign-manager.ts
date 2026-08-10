/**
 * Campaign 项目管理数据服务
 *
 * 负责 Campaign 的本地存储（SQLite）。
 * 存储位置：~/.mapro/campaign-database.sqlite
 *
 * Slice 1: 仅实现 Campaign 核心表（创建 + 列表）
 * Slice 3: 添加 KOL 候选池表 + 导入功能
 * Slice 4: 添加 Brief 表 + 生成/保存功能
 */

import { existsSync, mkdirSync, cpSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { getConfigDir, getAgentWorkspacePath } from './config-paths'
import { createAgentWorkspace } from './agent-workspace-manager'
import { getKOLById, computeKOLScores, recalculateAllScores, type KOLRecord } from './marketing/ma-tools/kol-data-service'
export { recalculateAllScores }
import { runContentAudit } from './marketing/ma-tools/content-audit'
import type { Campaign, CampaignCreativePlan, CampaignPhasePlan, CreateCampaignInput, KOLListItem } from '@gravitas/shared'

// =====================================================================
// SQLite 运行时适配层（复用 kol-data-service 模式）
// =====================================================================

let _nativeDb: any = null

function loadEngine(): { Database: new (path: string) => any } {
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

function getEngine(): { Database: new (path: string) => any } {
  if (!_nativeDb) {
    _nativeDb = loadEngine()
  }
  return _nativeDb
}

class Database {
  private db: any

  constructor(path: string) {
    const { Database: NativeDb } = getEngine()
    this.db = new NativeDb(path)
    // WAL + busy_timeout：kol-database.sqlite 会被 campaign-manager 与 kol-data-service
    // 以两个独立连接同时读写，避免提交窗口内互踩 SQLITE_BUSY
    try {
      this.db.exec('PRAGMA journal_mode=WAL')
      this.db.exec('PRAGMA busy_timeout=3000')
    } catch (err) {
      console.warn('[Campaign 服务] 设置 WAL/busy_timeout 失败:', err)
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

function flattenParams(params: unknown[]): any[] {
  if (params.length === 1 && Array.isArray(params[0])) {
    return params[0] as any[]
  }
  return params as any[]
}

// =====================================================================
// 测试注入：支持通过环境变量覆盖配置目录
// =====================================================================

function getTestConfigDir(): string | undefined {
  return process.env._MAPRO_TEST_CONFIG_DIR
}

// =====================================================================
// 数据库初始化
// =====================================================================

let dbInstance: Database | null = null

const DEFAULT_PHASE_TEMPLATE: Array<Omit<CampaignPhasePlan, 'budget'>> = [
  { phase: 1, name: '第一阶段', months: '第 1 阶段', goal: '根据品牌与目标人群制定投放策略' },
  { phase: 2, name: '第二阶段', months: '第 2 阶段', goal: '深化内容与场景渗透' },
  { phase: 3, name: '第三阶段', months: '第 3 阶段', goal: '沉淀品牌资产与长尾运营' },
]

function buildDefaultPhasePlans(budget: number, durationMonths: number): CampaignPhasePlan[] {
  const safeDuration = Math.max(durationMonths, 1)
  const phaseBudget = Math.round(budget / safeDuration * 2)
  const monthsPerPhase = Math.max(1, Math.round(safeDuration / 3))
  return DEFAULT_PHASE_TEMPLATE.map((phase, index) => {
    const startMonth = index * monthsPerPhase + 1
    const endMonth = Math.min((index + 1) * monthsPerPhase, safeDuration)
    const monthsRange = startMonth === endMonth ? `第 ${startMonth} 月` : `第 ${startMonth}-${endMonth} 月`
    return {
      ...phase,
      months: monthsRange,
      budget: phaseBudget,
    }
  })
}

function normalizePhasePlans(value: unknown, budget: number, durationMonths: number): CampaignPhasePlan[] {
  if (!value) return buildDefaultPhasePlans(budget, durationMonths)

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (Array.isArray(parsed)) {
      const defaults = buildDefaultPhasePlans(budget, durationMonths)
      return parsed.map((item, index) => {
        const raw = item as Partial<CampaignPhasePlan>
        const fallback = defaults[index] ?? defaults[defaults.length - 1]!
        return {
          phase: Number(raw.phase ?? fallback.phase),
          name: String(raw.name ?? fallback.name),
          months: String(raw.months ?? fallback.months),
          goal: String(raw.goal ?? fallback.goal),
          budget: Number(raw.budget ?? fallback.budget),
        }
      })
    }
  } catch {
    // 兼容旧数据，回退到默认三阶段预算。
  }

  return buildDefaultPhasePlans(budget, durationMonths)
}

function buildDefaultCreativePlan(campaign: Pick<Campaign, 'brand' | 'targetAudience'>): CampaignCreativePlan {
  return {
    bigIdea: `${campaign.brand} 的品牌种草计划`,
    coreMessage: `面向${campaign.targetAudience || '目标人群'}传递品牌价值与使用场景。`,
    contentPillars: ['产品体验', '生活场景', '用户口碑'],
    tone: '真实、自然、有质感',
    mandatoryElements: [campaign.brand],
    forbiddenElements: [],
  }
}

function normalizeCreativePlan(
  value: unknown,
  campaign: Pick<Campaign, 'brand' | 'targetAudience'>,
): CampaignCreativePlan {
  const fallback = buildDefaultCreativePlan(campaign)
  if (!value) return fallback

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (parsed && typeof parsed === 'object') {
      const raw = parsed as Partial<CampaignCreativePlan>
      return {
        bigIdea: String(raw.bigIdea ?? fallback.bigIdea),
        coreMessage: String(raw.coreMessage ?? fallback.coreMessage),
        contentPillars: Array.isArray(raw.contentPillars) ? raw.contentPillars.map(String) : fallback.contentPillars,
        tone: String(raw.tone ?? fallback.tone),
        mandatoryElements: Array.isArray(raw.mandatoryElements) ? raw.mandatoryElements.map(String) : fallback.mandatoryElements,
        forbiddenElements: Array.isArray(raw.forbiddenElements) ? raw.forbiddenElements.map(String) : fallback.forbiddenElements,
      }
    }
  } catch {
    // 兼容旧数据，回退到默认创意策略。
  }

  return fallback
}

function getDbPath(): string {
  const testDir = getTestConfigDir()
  return join(testDir ?? getConfigDir(), 'campaign-database.sqlite')
}

export function getDb(): Database {
  if (dbInstance) return dbInstance

  const dbPath = getDbPath()
  const dir = join(getTestConfigDir() ?? getConfigDir())
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  dbInstance = new Database(dbPath)

  // Campaign 核心表（Slice 1）
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      brand TEXT NOT NULL,
      platform TEXT NOT NULL,
      budget INTEGER DEFAULT 0,
      duration_months INTEGER DEFAULT 1,
      target_city TEXT,
      target_audience TEXT,
      project_path TEXT,
      current_phase INTEGER DEFAULT 1,
      phase_plans TEXT,
      creative_plan TEXT,
      status TEXT DEFAULT 'draft',
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    )
  `)

  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_campaigns_brand ON campaigns(brand)`)

  const campaignColumns = dbInstance.query(`PRAGMA table_info(campaigns)`).all() as Array<{ name: string }>
  if (!campaignColumns.some((col) => col.name === 'phase_plans')) {
    dbInstance.run(`ALTER TABLE campaigns ADD COLUMN phase_plans TEXT`)
  }
  if (!campaignColumns.some((col) => col.name === 'creative_plan')) {
    dbInstance.run(`ALTER TABLE campaigns ADD COLUMN creative_plan TEXT`)
  }
  if (!campaignColumns.some((col) => col.name === 'project_path')) {
    dbInstance.run(`ALTER TABLE campaigns ADD COLUMN project_path TEXT`)
  }

  // Campaign KOL 候选池表（Slice 3）
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS campaign_kol_pool (
      campaign_id TEXT NOT NULL,
      kol_id TEXT NOT NULL,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      followers TEXT,
      engagement TEXT,
      category TEXT,
      price TEXT,
      city TEXT,
      status TEXT DEFAULT 'candidate',
      notes TEXT,
      added_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      PRIMARY KEY (campaign_id, kol_id),
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )
  `)

  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_pool_campaign ON campaign_kol_pool(campaign_id)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_pool_status ON campaign_kol_pool(status)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_pool_platform ON campaign_kol_pool(platform)`)

  // Campaign KOL Brief 表（Slice 4）
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS campaign_briefs (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      kol_id TEXT NOT NULL,
      kol_name TEXT NOT NULL,
      content TEXT NOT NULL,
      ai_generated INTEGER DEFAULT 0,
      status TEXT DEFAULT 'draft',
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      UNIQUE(campaign_id, kol_id)
    )
  `)

  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_briefs_campaign ON campaign_briefs(campaign_id)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_briefs_kol ON campaign_briefs(kol_id)`)

  // 内容数据追踪表（新增）
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS kol_content_tracking (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      kol_id TEXT NOT NULL,
      kol_name TEXT NOT NULL,
      platform TEXT NOT NULL,
      content_url TEXT,
      content_type TEXT DEFAULT 'organic',
      publish_date TEXT,
      exposure INTEGER DEFAULT 0,
      views INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      saves INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      shares INTEGER DEFAULT 0,
      completion_rate REAL,
      cpm REAL,
      cpe REAL,
      ctr REAL,
      engagement_rate REAL,
      data_source TEXT DEFAULT 'manual',
      collected_at INTEGER,
      performance_grade TEXT DEFAULT 'pending',
      benchmark_comparison TEXT,
      ai_analysis TEXT,
      recommendations TEXT,
      paid_data TEXT,
      paid_spend REAL DEFAULT 0,
      paid_exposure INTEGER DEFAULT 0,
      paid_views INTEGER DEFAULT 0,
      paid_likes INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    )
  `)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_content_tracking_campaign ON kol_content_tracking(campaign_id)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_content_tracking_kol ON kol_content_tracking(kol_id)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_content_tracking_platform ON kol_content_tracking(platform)`)

  // 扩展现有内容追踪表（阶段复盘相关字段）
  const hasTrackingCol = (col: string): boolean => {
    try {
      const rows = dbInstance!.query(`PRAGMA table_info(kol_content_tracking)`).all() as Array<{ name: string }>
      return rows.some((r) => r.name === col)
    } catch {
      return false
    }
  }
  if (!hasTrackingCol('phase')) {
    dbInstance.run(`ALTER TABLE kol_content_tracking ADD COLUMN phase INTEGER DEFAULT 1`)
  }
  if (!hasTrackingCol('test_group')) {
    dbInstance.run(`ALTER TABLE kol_content_tracking ADD COLUMN test_group TEXT DEFAULT ''`)
  }
  if (!hasTrackingCol('note_type')) {
    dbInstance.run(`ALTER TABLE kol_content_tracking ADD COLUMN note_type TEXT DEFAULT ''`)
  }
  if (!hasTrackingCol('cost')) {
    dbInstance.run(`ALTER TABLE kol_content_tracking ADD COLUMN cost REAL DEFAULT 0`)
  }
  if (!hasTrackingCol('is_organic')) {
    dbInstance.run(`ALTER TABLE kol_content_tracking ADD COLUMN is_organic INTEGER DEFAULT 1`)
  }

  // 阶段复盘报告表（新增）
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS campaign_phase_reports (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      phase INTEGER NOT NULL,
      report_type TEXT NOT NULL DEFAULT 'phase',
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      total_kols INTEGER DEFAULT 0,
      total_posts INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0,
      organic_cost REAL DEFAULT 0,
      paid_cost REAL DEFAULT 0,
      total_exposure INTEGER DEFAULT 0,
      total_views INTEGER DEFAULT 0,
      total_likes INTEGER DEFAULT 0,
      total_saves INTEGER DEFAULT 0,
      total_comments INTEGER DEFAULT 0,
      total_shares INTEGER DEFAULT 0,
      avg_cpm REAL DEFAULT 0,
      avg_cpe REAL DEFAULT 0,
      avg_ctr REAL DEFAULT 0,
      avg_engagement_rate REAL DEFAULT 0,
      roi_estimate REAL DEFAULT 0,
      cpm_target REAL DEFAULT 0,
      cpm_target_achieved INTEGER DEFAULT 0,
      engagement_target REAL DEFAULT 0,
      engagement_target_achieved INTEGER DEFAULT 0,
      ai_summary TEXT,
      ai_findings TEXT,
      ai_recommendations TEXT,
      ai_scale_advice TEXT,
      status TEXT DEFAULT 'draft',
      generated_by TEXT DEFAULT 'ai',
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    )
  `)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_phase_reports_campaign ON campaign_phase_reports(campaign_id)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_phase_reports_phase ON campaign_phase_reports(phase)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_phase_reports_type ON campaign_phase_reports(report_type)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_phase_reports_status ON campaign_phase_reports(status)`)

  // AB 测试表（新增 — Slice 3）
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS campaign_ab_tests (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      phase INTEGER DEFAULT 1,
      test_name TEXT NOT NULL,
      hypothesis TEXT NOT NULL,
      variable_type TEXT NOT NULL,
      variable_description TEXT,
      control_group_definition TEXT,
      test_group_definition TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      status TEXT DEFAULT 'running',
      winner_group TEXT DEFAULT '',
      winner_reason TEXT,
      scale_recommendation TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    )
  `)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_ab_tests_campaign ON campaign_ab_tests(campaign_id)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_ab_tests_phase ON campaign_ab_tests(phase)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_ab_tests_status ON campaign_ab_tests(status)`)

  // AB 测试分组结果表（新增 — Slice 3）
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS ab_test_results (
      id TEXT PRIMARY KEY,
      ab_test_id TEXT NOT NULL,
      group_name TEXT NOT NULL,
      kol_count INTEGER DEFAULT 0,
      post_count INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0,
      total_exposure INTEGER DEFAULT 0,
      total_views INTEGER DEFAULT 0,
      total_likes INTEGER DEFAULT 0,
      total_saves INTEGER DEFAULT 0,
      total_comments INTEGER DEFAULT 0,
      total_shares INTEGER DEFAULT 0,
      avg_cpm REAL DEFAULT 0,
      avg_cpe REAL DEFAULT 0,
      avg_ctr REAL DEFAULT 0,
      avg_engagement_rate REAL DEFAULT 0,
      conversion_count INTEGER DEFAULT 0,
      conversion_rate REAL DEFAULT 0,
      significance_score REAL DEFAULT 0,
      is_significant INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    )
  `)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_ab_results_test ON ab_test_results(ab_test_id)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_ab_results_group ON ab_test_results(group_name)`)

  // 数据标准基准表（新增）
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS content_benchmarks (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      price_tier TEXT NOT NULL,
      followers_range TEXT NOT NULL,
      metric_name TEXT NOT NULL,
      excellent_threshold REAL DEFAULT 0,
      good_threshold REAL DEFAULT 0,
      normal_threshold REAL DEFAULT 0,
      description TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      UNIQUE(platform, price_tier, followers_range, metric_name)
    )
  `)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_benchmarks_platform ON content_benchmarks(platform)`)
  dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_benchmarks_tier ON content_benchmarks(price_tier)`)

  console.log('[Campaign 服务] 数据库已初始化:', dbPath)

  // 初始化数据标准基准
  seedContentBenchmarks()

  return dbInstance
}

/** 关闭数据库连接（主要用于测试） */
export function closeCampaignDatabase(): void {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
  if (kolDbInstance) {
    kolDbInstance.close()
    kolDbInstance = null
  }
}

// =====================================================================
// KOL 数据库连接（用于查询可用 KOL）
// =====================================================================

let kolDbInstance: Database | null = null

function getKolDbPath(): string {
  const testDir = getTestConfigDir()
  return join(testDir ?? getConfigDir(), 'kol-database.sqlite')
}

function getKolDb(): Database {
  if (kolDbInstance) return kolDbInstance

  const dbPath = getKolDbPath()
  const defaultDbPath = join(homedir(), 'LLM', 'ma', 'data', 'kol_database.db')

  if (!getTestConfigDir()) {
    // 确保 .mapro 和 .mapro-dev 目录都存在
    const maproDir = join(homedir(), '.mapro')
    const maproDevDir = join(homedir(), '.mapro-dev')
    if (!existsSync(maproDir)) mkdirSync(maproDir, { recursive: true })
    if (!existsSync(maproDevDir)) mkdirSync(maproDevDir, { recursive: true })

    const maproPath = join(maproDir, 'kol-database.sqlite')
    const maproDevPath = join(maproDevDir, 'kol-database.sqlite')

    console.log(`[Campaign 服务] KOL 数据库路径: ${dbPath}`)
    console.log(`[Campaign 服务] 默认数据库路径: ${defaultDbPath}`)
    console.log(`[Campaign 服务] 默认数据库存在: ${existsSync(defaultDbPath)}`)
    console.log(`[Campaign 服务] .mapro 数据库存在: ${existsSync(maproPath)}`)
    console.log(`[Campaign 服务] .mapro-dev 数据库存在: ${existsSync(maproDevPath)}`)

    // 同时复制到 .mapro 和 .mapro-dev
    for (const targetPath of [maproPath, maproDevPath]) {
      if (!existsSync(targetPath) && existsSync(defaultDbPath)) {
        try {
          cpSync(defaultDbPath, targetPath)
          console.log(`[Campaign 服务] 已复制 KOL 数据库到 ${targetPath}`)
        } catch (err) {
          console.warn(`[Campaign 服务] 复制到 ${targetPath} 失败:`, err)
        }
      } else if (existsSync(targetPath)) {
        console.log(`[Campaign 服务] ${targetPath} 已存在，跳过复制`)
      }
    }
  }

  kolDbInstance = new Database(dbPath)

  kolDbInstance.run(`
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
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    )
  `)

  // 兼容原始数据库：如果原始数据库没有评分字段，添加它们
  // 使用显式列存在检查，避免 try/catch 吞掉真正的错误
  const hasColumn = (table: string, col: string): boolean => {
    try {
      const rows = kolDbInstance!.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      return rows.some((r) => r.name === col)
    } catch {
      return false
    }
  }

  if (!hasColumn('kols', 'fan_score')) {
    kolDbInstance.run(`ALTER TABLE kols ADD COLUMN fan_score REAL DEFAULT 0`)
  }
  if (!hasColumn('kols', 'engagement_score')) {
    kolDbInstance.run(`ALTER TABLE kols ADD COLUMN engagement_score REAL DEFAULT 0`)
  }
  if (!hasColumn('kols', 'content_score')) {
    kolDbInstance.run(`ALTER TABLE kols ADD COLUMN content_score REAL DEFAULT 0`)
  }
  if (!hasColumn('kols', 'overall_score')) {
    kolDbInstance.run(`ALTER TABLE kols ADD COLUMN overall_score REAL DEFAULT 0`)
  }
  // 扩展数据评分列
  if (!hasColumn('kols', 'value_score')) {
    kolDbInstance.run(`ALTER TABLE kols ADD COLUMN value_score REAL DEFAULT 0`)
  }
  if (!hasColumn('kols', 'ad_quality_score')) {
    kolDbInstance.run(`ALTER TABLE kols ADD COLUMN ad_quality_score REAL DEFAULT 0`)
  }
  if (!hasColumn('kols', 'risk_score')) {
    kolDbInstance.run(`ALTER TABLE kols ADD COLUMN risk_score REAL DEFAULT 0`)
  }
  if (!hasColumn('kols', 'extended_data')) {
    kolDbInstance.run(`ALTER TABLE kols ADD COLUMN extended_data TEXT`)
  }
  // 标签列
  if (!hasColumn('kols', 'value_tags')) {
    kolDbInstance.run(`ALTER TABLE kols ADD COLUMN value_tags TEXT`)
  }
  if (!hasColumn('kols', 'risk_flags')) {
    kolDbInstance.run(`ALTER TABLE kols ADD COLUMN risk_flags TEXT`)
  }

  // 确保索引存在
  kolDbInstance.run(`CREATE INDEX IF NOT EXISTS idx_kols_platform ON kols(platform)`)
  kolDbInstance.run(`CREATE INDEX IF NOT EXISTS idx_kols_category ON kols(category)`)
  kolDbInstance.run(`CREATE INDEX IF NOT EXISTS idx_kols_name ON kols(name)`)
  kolDbInstance.run(`CREATE INDEX IF NOT EXISTS idx_kols_source ON kols(source)`)
  kolDbInstance.run(`CREATE INDEX IF NOT EXISTS idx_kols_overall_score ON kols(overall_score DESC)`)

  // 统计 KOL 数量
  const countRow = kolDbInstance.query('SELECT COUNT(*) as total FROM kols').get() as { total: number } | null
  console.log(`[Campaign 服务] KOL 数据库已连接: ${dbPath}, KOL 数量: ${countRow?.total ?? 0}`)
  return kolDbInstance
}

/** 填充 Mock KOL 数据到 KOL 数据库 */
function seedMockKOLsIntoKolDb(db: Database): void {
  const now = Date.now()
  const mockKOLs: Array<Omit<KOLListItem, 'createdAt' | 'updatedAt'>> = [
    ...[
      { id: 'mock_xhs_美妆达人小美', name: '@美妆达人小美', platform: '小红书', followers: '50万', engagement: '8.5%', category: '美妆', price: '3万', city: '上海', avatar: '', source: 'mock', rawData: '{}' },
      { id: 'mock_xhs_护肤分享师', name: '@护肤分享师', platform: '小红书', followers: '30万', engagement: '9.2%', category: '美妆', price: '2万', city: '杭州', avatar: '', source: 'mock', rawData: '{}' },
      { id: 'mock_xhs_生活方式博主', name: '@生活方式博主', platform: '小红书', followers: '80万', engagement: '6.8%', category: '生活方式', price: '5万', city: '北京', avatar: '', source: 'mock', rawData: '{}' },
      { id: 'mock_xhs_母婴博主乐乐', name: '@母婴博主乐乐', platform: '小红书', followers: '40万', engagement: '10.1%', category: '母婴', price: '2.5万', city: '广州', avatar: '', source: 'mock', rawData: '{}' },
      { id: 'mock_xhs_数码测评君', name: '@数码测评君', platform: '小红书', followers: '60万', engagement: '7.5%', category: '3C', price: '4万', city: '深圳', avatar: '', source: 'mock', rawData: '{}' },
      { id: 'mock_dy_时尚小姐姐', name: '@时尚小姐姐', platform: '抖音', followers: '200万', engagement: '5.2%', category: '时尚', price: '15万', city: '上海', avatar: '', source: 'mock', rawData: '{}' },
      { id: 'mock_dy_搞笑日常', name: '@搞笑日常', platform: '抖音', followers: '500万', engagement: '4.8%', category: '娱乐', price: '30万', city: '成都', avatar: '', source: 'mock', rawData: '{}' },
      { id: 'mock_dy_美食探店', name: '@美食探店', platform: '抖音', followers: '150万', engagement: '6.5%', category: '美食', price: '10万', city: '重庆', avatar: '', source: 'mock', rawData: '{}' },
      { id: 'mock_dy_科技大人', name: '@科技大人', platform: '抖音', followers: '300万', engagement: '5.8%', category: '3C', price: '20万', city: '北京', avatar: '', source: 'mock', rawData: '{}' },
      { id: 'mock_wb_时尚icon', name: '@时尚icon', platform: '微博', followers: '800万', engagement: '3.5%', category: '时尚', price: '50万', city: '北京', avatar: '', source: 'mock', rawData: '{}' },
      { id: 'mock_wb_美妆教主', name: '@美妆教主', platform: '微博', followers: '600万', engagement: '4.2%', category: '美妆', price: '40万', city: '上海', avatar: '', source: 'mock', rawData: '{}' },
      { id: 'mock_bz_测评实验室', name: '@测评实验室', platform: 'B站', followers: '150万', engagement: '12.5%', category: '3C', price: '12万', city: '上海', avatar: '', source: 'mock', rawData: '{}' },
    ].map((kol) => ({ ...kol, baseScore: 0, contentScore: 0, commercialScore: 0, overallScore: 0 })),
  ]

  for (const kol of mockKOLs) {
    db.run(
      `INSERT INTO kols (id, name, platform, followers, engagement, category, price, city, avatar, source, raw_data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      now,
      now,
    )
  }

  console.log(`[Campaign 服务] KOL 数据库自动填充: ${mockKOLs.length} 条 mock 数据`)
}

// =====================================================================
// Campaign Agent Workspace 工具脚本
// =====================================================================

const CAMPAIGN_TOOLS_SCRIPT = `#!/usr/bin/env python3
\"\"\"Campaign 数据管理工具

用法:
  python campaign.py get <campaign_id>
  python campaign.py update <campaign_id> --field value ...
  python campaign.py update-phase <campaign_id> <phase> --budget <amount>
  python campaign.py update-creative <campaign_id> --big_idea <text> --core_message <text>
  python campaign.py list-kols <campaign_id>
  python campaign.py update-kol <campaign_id> <kol_id> --status <status>
  python campaign.py get-brief <campaign_id> <kol_id>
  python campaign.py update-brief <campaign_id> <kol_id> <content>
"""

import sqlite3
import json
import os
import sys
import time
from pathlib import Path

DB_PATH = os.path.expanduser("~/.mapro/campaign-database.sqlite")

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def normalize_update_value(key, value):
    if key == "target_city":
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return json.dumps(parsed, ensure_ascii=False)
        except Exception:
            pass
        cities = [item.strip() for item in value.replace("，", ",").replace("、", ",").split(",") if item.strip()]
        return json.dumps(cities, ensure_ascii=False)
    if key in ("budget", "duration_months", "current_phase"):
        try:
            return int(float(value))
        except Exception:
            return value
    if key == "phase_plans":
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return json.dumps(parsed, ensure_ascii=False)
        except Exception:
            pass
    return value

def default_phase_plans(budget, duration_months):
    safe_duration = max(int(duration_months or 1), 1)
    phase_budget = round(float(budget or 0) / safe_duration * 2)
    months_per_phase = max(1, round(safe_duration / 3))
    phases = []
    for index, phase in enumerate([
        {"phase": 1, "name": "第一阶段", "goal": "根据品牌与目标人群制定投放策略"},
        {"phase": 2, "name": "第二阶段", "goal": "深化内容与场景渗透"},
        {"phase": 3, "name": "第三阶段", "goal": "沉淀品牌资产与长尾运营"},
    ]):
        start_month = index * months_per_phase + 1
        end_month = min((index + 1) * months_per_phase, safe_duration)
        months_range = f"第 {start_month} 月" if start_month == end_month else f"第 {start_month}-{end_month} 月"
        phases.append({
            "phase": phase["phase"],
            "name": phase["name"],
            "months": months_range,
            "goal": phase["goal"],
            "budget": phase_budget,
        })
    return phases

def split_list(value):
    try:
        parsed = json.loads(value)
        if isinstance(parsed, list):
            return [str(item) for item in parsed]
    except Exception:
        pass
    return [item.strip() for item in value.replace("，", ",").replace("、", ",").split(",") if item.strip()]

def default_creative_plan(brand, target_audience):
    return {
        "bigIdea": f"{brand} 的品牌种草计划",
        "coreMessage": f"面向{target_audience or '目标人群'}传递品牌价值与使用场景。",
        "contentPillars": ["产品体验", "生活场景", "用户口碑"],
        "tone": "真实、自然、有质感",
        "mandatoryElements": [brand],
        "forbiddenElements": [],
    }

def cmd_get(campaign_id):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM campaigns WHERE id = ?", (campaign_id,)
        ).fetchone()
        if not row:
            print(json.dumps({"error": "Campaign not found"}))
            return
        print(json.dumps(dict(row), default=str))

def cmd_update(campaign_id, kwargs):
    if not kwargs:
        print(json.dumps({"error": "No fields to update"}))
        return
    fields = []
    values = []
    field_map = {
        "name": "name",
        "brand": "brand",
        "platform": "platform",
        "budget": "budget",
        "duration_months": "duration_months",
        "target_city": "target_city",
        "target_audience": "target_audience",
        "current_phase": "current_phase",
        "phase_plans": "phase_plans",
        "status": "status",
    }
    for k, v in kwargs.items():
        col = field_map.get(k)
        if col:
            fields.append(f"{col} = ?")
            values.append(normalize_update_value(k, v))
    if not fields:
        print(json.dumps({"error": "No valid fields"}))
        return
    values.append(campaign_id)
    sql = f"UPDATE campaigns SET {', '.join(fields)}, updated_at = ? WHERE id = ?"
    with get_db() as conn:
        conn.execute(sql, (*values[:-1], int(time.time() * 1000), campaign_id))
        conn.commit()
    print(json.dumps({"success": True, "updated": len(fields)}))

def cmd_update_phase(campaign_id, phase, kwargs):
    with get_db() as conn:
        row = conn.execute(
            "SELECT budget, duration_months, phase_plans FROM campaigns WHERE id = ?",
            (campaign_id,),
        ).fetchone()
        if not row:
            print(json.dumps({"error": "Campaign not found"}))
            return
        try:
            plans = json.loads(row["phase_plans"]) if row["phase_plans"] else default_phase_plans(row["budget"], row["duration_months"])
        except Exception:
            plans = default_phase_plans(row["budget"], row["duration_months"])

        phase_num = int(phase)
        target = next((p for p in plans if int(p.get("phase", 0)) == phase_num), None)
        if not target:
            print(json.dumps({"error": f"Phase {phase_num} not found"}))
            return
        if "name" in kwargs:
            target["name"] = kwargs["name"]
        if "months" in kwargs:
            target["months"] = kwargs["months"]
        if "goal" in kwargs:
            target["goal"] = kwargs["goal"]
        if "budget" in kwargs:
            target["budget"] = int(float(kwargs["budget"]))

        conn.execute(
            "UPDATE campaigns SET phase_plans = ?, updated_at = ? WHERE id = ?",
            (json.dumps(plans, ensure_ascii=False), int(time.time() * 1000), campaign_id),
        )
        conn.commit()
        print(json.dumps({"success": True, "phasePlans": plans}, ensure_ascii=False))

def cmd_update_creative(campaign_id, kwargs):
    with get_db() as conn:
        row = conn.execute(
            "SELECT brand, target_audience, creative_plan FROM campaigns WHERE id = ?",
            (campaign_id,),
        ).fetchone()
        if not row:
            print(json.dumps({"error": "Campaign not found"}))
            return
        try:
            plan = json.loads(row["creative_plan"]) if row["creative_plan"] else default_creative_plan(row["brand"], row["target_audience"])
        except Exception:
            plan = default_creative_plan(row["brand"], row["target_audience"])

        field_map = {
            "big_idea": "bigIdea",
            "core_message": "coreMessage",
            "content_pillars": "contentPillars",
            "tone": "tone",
            "mandatory_elements": "mandatoryElements",
            "forbidden_elements": "forbiddenElements",
        }
        list_fields = {"contentPillars", "mandatoryElements", "forbiddenElements"}
        for key, value in kwargs.items():
            target = field_map.get(key)
            if not target:
                continue
            plan[target] = split_list(value) if target in list_fields else value

        conn.execute(
            "UPDATE campaigns SET creative_plan = ?, updated_at = ? WHERE id = ?",
            (json.dumps(plan, ensure_ascii=False), int(time.time() * 1000), campaign_id),
        )
        conn.commit()
        print(json.dumps({"success": True, "creativePlan": plan}, ensure_ascii=False))

def cmd_list_kols(campaign_id):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM campaign_kol_pool WHERE campaign_id = ? ORDER BY added_at DESC",
            (campaign_id,),
        ).fetchall()
        print(json.dumps([dict(r) for r in rows], default=str))

def cmd_update_kol(campaign_id, kol_id, status):
    with get_db() as conn:
        conn.execute(
            "UPDATE campaign_kol_pool SET status = ? WHERE campaign_id = ? AND kol_id = ?",
            (status, campaign_id, kol_id),
        )
        conn.commit()
    print(json.dumps({"success": True}))

def cmd_get_brief(campaign_id, kol_id):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM campaign_briefs WHERE campaign_id = ? AND kol_id = ?",
            (campaign_id, kol_id),
        ).fetchone()
        if not row:
            print(json.dumps({"error": "Brief not found"}))
            return
        print(json.dumps(dict(row), default=str))

def cmd_update_brief(campaign_id, kol_id, content, kol_name=""):
    with get_db() as conn:
        existing = conn.execute(
            "SELECT id FROM campaign_briefs WHERE campaign_id = ? AND kol_id = ?",
            (campaign_id, kol_id),
        ).fetchone()
        now = int(time.time() * 1000)
        if existing:
            conn.execute(
                "UPDATE campaign_briefs SET content = ?, updated_at = ? WHERE id = ?",
                (content, now, existing["id"]),
            )
        else:
            brief_id = f"brief_{now}_{os.urandom(4).hex()}"
            conn.execute(
                """INSERT INTO campaign_briefs (id, campaign_id, kol_id, kol_name, content, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (brief_id, campaign_id, kol_id, kol_name or kol_id, content, now, now),
            )
        conn.commit()
    print(json.dumps({"success": True}))

def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]
    campaign_id = sys.argv[2]

    if cmd == "get":
        cmd_get(campaign_id)
    elif cmd == "update":
        kwargs = {}
        i = 3
        while i < len(sys.argv):
            if sys.argv[i].startswith("--"):
                key = sys.argv[i][2:]
                val = sys.argv[i + 1] if i + 1 < len(sys.argv) else ""
                kwargs[key] = val
                i += 2
            else:
                i += 1
        cmd_update(campaign_id, kwargs)
    elif cmd == "update-phase":
        if len(sys.argv) < 4:
            print(json.dumps({"error": "Missing phase"}))
            sys.exit(1)
        kwargs = {}
        i = 4
        while i < len(sys.argv):
            if sys.argv[i].startswith("--"):
                key = sys.argv[i][2:]
                val = sys.argv[i + 1] if i + 1 < len(sys.argv) else ""
                kwargs[key] = val
                i += 2
            else:
                i += 1
        cmd_update_phase(campaign_id, sys.argv[3], kwargs)
    elif cmd == "update-creative":
        kwargs = {}
        i = 3
        while i < len(sys.argv):
            if sys.argv[i].startswith("--"):
                key = sys.argv[i][2:]
                val = sys.argv[i + 1] if i + 1 < len(sys.argv) else ""
                kwargs[key] = val
                i += 2
            else:
                i += 1
        cmd_update_creative(campaign_id, kwargs)
    elif cmd == "list-kols":
        cmd_list_kols(campaign_id)
    elif cmd == "update-kol":
        if len(sys.argv) < 5:
            print(json.dumps({"error": "Missing kol_id or status"}))
            sys.exit(1)
        kol_id = sys.argv[3]
        status = sys.argv[5] if len(sys.argv) > 5 else "candidate"
        cmd_update_kol(campaign_id, kol_id, status)
    elif cmd == "get-brief":
        if len(sys.argv) < 4:
            print(json.dumps({"error": "Missing kol_id"}))
            sys.exit(1)
        cmd_get_brief(campaign_id, sys.argv[3])
    elif cmd == "update-brief":
        if len(sys.argv) < 5:
            print(json.dumps({"error": "Missing kol_id or content"}))
            sys.exit(1)
        cmd_update_brief(campaign_id, sys.argv[3], sys.argv[4])
    else:
        print(json.dumps({"error": f"Unknown command: {cmd}"}))
        sys.exit(1)

if __name__ == "__main__":
    main()
`

/** 确保 Campaign 的 Workspace 工具文件存在（用于旧 Campaign 兼容性） */
export function ensureCampaignWorkspace(campaign: Campaign): string {
  const workspaceSlug = `campaign-${campaign.id}`
  
  try {
    const workspacePath = getAgentWorkspacePath(workspaceSlug)
    
    // 如果 Workspace 目录不存在，创建它
    if (!existsSync(workspacePath)) {
      createAgentWorkspace(campaign.name, undefined, workspaceSlug)
    }
    
    const toolsDir = join(workspacePath, '.campaign-tools')
    if (!existsSync(toolsDir)) {
      mkdirSync(toolsDir, { recursive: true })
    }
    
    // 动态替换 DB_PATH
    const dbPath = join(getConfigDir(), 'campaign-database.sqlite')
    const scriptWithCorrectPath = CAMPAIGN_TOOLS_SCRIPT.replace(
      'DB_PATH = os.path.expanduser("~/.mapro/campaign-database.sqlite")',
      `DB_PATH = os.path.expanduser("${dbPath}")`
    )
    
    const scriptPath = join(toolsDir, 'campaign.py')
    writeFileSync(scriptPath, scriptWithCorrectPath)
    
    const jsonPath = join(workspacePath, 'campaign.json')
    if (!existsSync(jsonPath)) {
      writeFileSync(
        jsonPath,
        JSON.stringify({
          id: campaign.id,
          name: campaign.name,
          brand: campaign.brand,
          platform: campaign.platform,
          budget: campaign.budget,
          durationMonths: campaign.durationMonths,
          targetCity: campaign.targetCity,
          targetAudience: campaign.targetAudience,
          currentPhase: campaign.currentPhase,
          phasePlans: campaign.phasePlans,
          creativePlan: campaign.creativePlan,
          status: campaign.status,
        }, null, 2)
      )
    }
    
    return workspacePath
  } catch (err) {
    console.error(`[Campaign] 确保 Workspace 失败 (${campaign.id}):`, err)
    throw err
  }
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** 行数据 → Campaign 对象 */
function rowToCampaign(row: any): Campaign {
  const parseTargetCity = (value: unknown): string[] => {
    if (!value) return []
    if (Array.isArray(value)) return value.map(String)
    const text = String(value)
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed.map(String)
    } catch {
      // 兼容旧工具脚本直接写入的「上海、杭州」或「上海,杭州」字符串。
    }
    return text
      .split(/[、,，]/)
      .map((item) => item.trim())
      .filter(Boolean)
  }

  const budget = row.budget ?? 0
  const durationMonths = row.duration_months ?? 1
  const brand = row.brand
  const targetAudience = row.target_audience ?? ''
  return {
    id: row.id,
    name: row.name,
    brand,
    projectPath: row.project_path || undefined,
    platform: row.platform as Campaign['platform'],
    budget,
    durationMonths,
    targetCity: parseTargetCity(row.target_city),
    targetAudience,
    currentPhase: row.current_phase ?? 1,
    phasePlans: normalizePhasePlans(row.phase_plans, budget, durationMonths),
    creativePlan: normalizeCreativePlan(row.creative_plan, { brand, targetAudience }),
    status: row.status as Campaign['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 行数据 → CampaignKOLPoolItem */
function rowToPoolItem(row: any): import('@gravitas/shared').CampaignKOLPoolItem {
  return {
    campaignId: row.campaign_id,
    kolId: row.kol_id,
    name: row.name,
    platform: row.platform,
    followers: row.followers ?? '',
    engagement: row.engagement ?? '',
    category: row.category ?? '',
    price: row.price ?? '',
    city: row.city ?? '',
    status: row.status as import('@gravitas/shared').PoolKOLStatus,
    notes: row.notes ?? '',
    addedAt: row.added_at,
  }
}

/** 获取 Campaign 列表（按创建时间倒序） */
export function listCampaigns(): Campaign[] {
  const db = getDb()
  const rows = db.query(
    `SELECT * FROM campaigns ORDER BY created_at DESC`
  ).all()
  return rows.map(rowToCampaign)
}

/** 创建 Campaign */
export function createCampaign(input: CreateCampaignInput): Campaign {
  const db = getDb()
  const now = Date.now()
  const id = generateId()
  const platform = input.platform ?? 'xiaohongshu'
  const budget = input.budget ?? 0
  const durationMonths = input.durationMonths ?? 3
  const targetCity = input.targetCity ?? []
  const targetAudience = input.targetAudience ?? ''

  const phasePlans = normalizePhasePlans(input.phasePlans, budget, durationMonths)
  const creativePlan = normalizeCreativePlan(input.creativePlan, {
    brand: input.brand,
    targetAudience,
  })

  db.run(
    `INSERT INTO campaigns (id, name, brand, platform, budget, duration_months, target_city, target_audience, project_path, current_phase, phase_plans, creative_plan, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name,
    input.brand,
    platform,
    budget,
    durationMonths,
    JSON.stringify(targetCity),
    targetAudience,
    input.projectPath ?? null,
    1,
    JSON.stringify(phasePlans),
    JSON.stringify(creativePlan),
    'draft',
    now,
    now,
  )

  const campaign: Campaign = {
    id,
    name: input.name,
    brand: input.brand,
    projectPath: input.projectPath,
    platform,
    budget,
    durationMonths,
    targetCity,
    targetAudience,
    currentPhase: 1,
    phasePlans,
    creativePlan,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  }

  // 创建 Campaign 专属的 Agent Workspace
  const workspaceSlug = `campaign-${id}`
  try {
    // 若用户指定了本地项目文件夹，将其绑定为 Campaign Workspace 的 rootPath
    createAgentWorkspace(campaign.name, campaign.projectPath, workspaceSlug)

    // 在 Workspace 中创建 Campaign 工具脚本
    const workspacePath = getAgentWorkspacePath(workspaceSlug)
    const toolsDir = join(workspacePath, '.campaign-tools')
    mkdirSync(toolsDir, { recursive: true })

    // 动态替换 DB_PATH 为正确的配置目录
    const dbPath = join(getConfigDir(), 'campaign-database.sqlite')
    const scriptWithCorrectPath = CAMPAIGN_TOOLS_SCRIPT.replace(
      'DB_PATH = os.path.expanduser("~/.mapro/campaign-database.sqlite")',
      `DB_PATH = os.path.expanduser("${dbPath}")`
    )

    // 创建工具脚本
    writeFileSync(join(toolsDir, 'campaign.py'), scriptWithCorrectPath)

    // 创建初始 Campaign 数据文件
    writeFileSync(
      join(workspacePath, 'campaign.json'),
      JSON.stringify({
        id: campaign.id,
        name: campaign.name,
        brand: campaign.brand,
        platform: campaign.platform,
        budget: campaign.budget,
        durationMonths: campaign.durationMonths,
        targetCity: campaign.targetCity,
        targetAudience: campaign.targetAudience,
        projectPath: campaign.projectPath ?? null,
        currentPhase: campaign.currentPhase,
        phasePlans: campaign.phasePlans,
        creativePlan: campaign.creativePlan,
        status: campaign.status,
      }, null, 2)
    )
  } catch (err) {
    // 用户指定了本地项目文件夹时，workspace 绑定失败应让创建失败并清理 DB 记录，避免数据不一致；
    // 未指定 projectPath 时保持原有行为（仅记录、不阻断创建）。
    console.error('[Campaign] 创建 Agent Workspace 失败:', err)
    if (campaign.projectPath) {
      try {
        db.run(`DELETE FROM campaigns WHERE id = ?`, id)
      } catch {
        // 忽略回滚失败
      }
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  return campaign
}

/** 获取单个 Campaign */
export function getCampaignById(id: string): Campaign | null {
  const db = getDb()
  const row = db.query(
    `SELECT * FROM campaigns WHERE id = ?`
  ).get(id)
  return row ? rowToCampaign(row) : null
}

/** 更新 Campaign */
export function updateCampaign(
  id: string,
  updates: Partial<Pick<Campaign, 'name' | 'brand' | 'platform' | 'budget' | 'durationMonths' | 'targetCity' | 'targetAudience' | 'currentPhase' | 'phasePlans' | 'creativePlan' | 'status'>>
): Campaign | null {
  const db = getDb()
  const campaign = getCampaignById(id)
  if (!campaign) return null

  const fields: string[] = []
  const values: unknown[] = []

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
  if (updates.brand !== undefined) { fields.push('brand = ?'); values.push(updates.brand) }
  if (updates.platform !== undefined) { fields.push('platform = ?'); values.push(updates.platform) }
  if (updates.budget !== undefined) { fields.push('budget = ?'); values.push(updates.budget) }
  if (updates.durationMonths !== undefined) { fields.push('duration_months = ?'); values.push(updates.durationMonths) }
  if (updates.targetCity !== undefined) { fields.push('target_city = ?'); values.push(JSON.stringify(updates.targetCity)) }
  if (updates.targetAudience !== undefined) { fields.push('target_audience = ?'); values.push(updates.targetAudience) }
  if (updates.currentPhase !== undefined) { fields.push('current_phase = ?'); values.push(updates.currentPhase) }
  if (updates.phasePlans !== undefined) { fields.push('phase_plans = ?'); values.push(JSON.stringify(updates.phasePlans)) }
  if (updates.creativePlan !== undefined) { fields.push('creative_plan = ?'); values.push(JSON.stringify(updates.creativePlan)) }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status) }

  if (fields.length === 0) return campaign

  fields.push('updated_at = ?')
  values.push(Date.now())
  values.push(id)

  db.run(
    `UPDATE campaigns SET ${fields.join(', ')} WHERE id = ?`,
    ...values
  )

  const updatedCampaign = getCampaignById(id)!

  // 同步更新 workspace 中的 campaign.json
  try {
    const workspacePath = getAgentWorkspacePath(`campaign-${id}`)
    const campaignJsonPath = join(workspacePath, 'campaign.json')
    if (existsSync(campaignJsonPath)) {
      writeFileSync(campaignJsonPath, JSON.stringify(updatedCampaign, null, 2))
    }
  } catch (err) {
    console.error('[Campaign] 同步 campaign.json 失败:', err)
  }

  return updatedCampaign
}

// =====================================================================
// KOL 候选池操作（Slice 3）
// =====================================================================

/** 获取 Campaign 候选池 KOL */
export function getPoolKOLs(campaignId: string): import('@gravitas/shared').CampaignKOLPoolItem[] {
  const db = getDb()
  const rows = db.query(
    `SELECT * FROM campaign_kol_pool WHERE campaign_id = ? ORDER BY added_at DESC`
  ).all(campaignId)
  return rows.map(rowToPoolItem)
}

/** 导入 KOL 到候选池 */
export function importKOLsToPool(input: import('@gravitas/shared').ImportKOLsToPoolInput): { imported: number } {
  const campaignDb = getDb()
  const kolDb = getKolDb()
  let imported = 0

  for (const kolId of input.kolIds) {
    // 从 KOL 数据库获取信息
    const kolRow = kolDb.query('SELECT * FROM kols WHERE id = ?').get(kolId) as Record<string, unknown> | null
    if (!kolRow) continue

    // 检查是否已存在
    const existing = campaignDb.query(
      'SELECT 1 FROM campaign_kol_pool WHERE campaign_id = ? AND kol_id = ?'
    ).get(input.campaignId, kolId)
    if (existing) continue

    // 插入到候选池
    campaignDb.run(
      `INSERT INTO campaign_kol_pool (campaign_id, kol_id, name, platform, followers, engagement, category, price, city, status, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.campaignId,
      kolId,
      String(kolRow.name ?? ''),
      String(kolRow.platform ?? ''),
      String(kolRow.followers ?? ''),
      String(kolRow.engagement ?? ''),
      String(kolRow.category ?? ''),
      String(kolRow.price ?? ''),
      String(kolRow.city ?? ''),
      'candidate',
      Date.now(),
    )
    imported++
  }

  return { imported }
}

/** 获取 KOL 数据库中可用 KOL（用于导入弹窗） */
export function listAvailableKOLs(
  filters?: { platform?: string; category?: string; keywords?: string[]; limit?: number }
): import('@gravitas/shared').KOLSearchResult {
  const kolDb = getKolDb()
  const conditions: string[] = []
  const params: (string | number)[] = []

  if (filters?.platform) {
    conditions.push('platform = ?')
    params.push(filters.platform)
  }
  if (filters?.category) {
    conditions.push('category = ?')
    params.push(filters.category)
  }
  if (filters?.keywords && filters.keywords.length > 0) {
    const keywordConditions = filters.keywords.map(() => 'name LIKE ?').join(' OR ')
    conditions.push(`(${keywordConditions})`)
    for (const kw of filters.keywords) {
      params.push(`%${kw}%`)
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = filters?.limit ?? 50

  const rows = kolDb.query(`SELECT * FROM kols ${whereClause} ORDER BY updated_at DESC LIMIT ?`).all(
    ...params,
    limit,
  ) as Record<string, unknown>[]

  const countRow = kolDb.query(`SELECT COUNT(*) as total FROM kols ${whereClause}`).get(...params) as { total: number } | null

  const kols = rows.map((row) => ({
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
    baseScore: Number(row.fan_score ?? 0),
    contentScore: Number(row.engagement_score ?? 0),
    commercialScore: Number(row.content_score ?? 0),
    overallScore: Number(row.overall_score ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }))

  return {
    kols,
    total: countRow?.total ?? kols.length,
  }
}

// =====================================================================
// Brief 操作（Slice 4）
// =====================================================================

/** 获取 KOL 的 Brief */
export function getBrief(campaignId: string, kolId: string): import('@gravitas/shared').CampaignBrief | null {
  const db = getDb()
  const row = db.query(
    `SELECT * FROM campaign_briefs WHERE campaign_id = ? AND kol_id = ?`
  ).get(campaignId, kolId) as Record<string, unknown> | null

  if (!row) return null

  return {
    id: String(row.id),
    campaignId: String(row.campaign_id),
    kolId: String(row.kol_id),
    kolName: String(row.kol_name),
    content: String(row.content),
    aiGenerated: Boolean(row.ai_generated),
    status: row.status as 'draft' | 'final',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** 保存/更新 KOL Brief */
export function saveBrief(input: import('@gravitas/shared').SaveCampaignBriefInput): import('@gravitas/shared').CampaignBrief {
  const db = getDb()
  const now = Date.now()
  const id = generateId()

  // 检查是否已存在
  const existing = db.query(
    `SELECT id FROM campaign_briefs WHERE campaign_id = ? AND kol_id = ?`
  ).get(input.campaignId, input.kolId) as { id: string } | null

  if (existing) {
    // 更新
    db.run(
      `UPDATE campaign_briefs
       SET content = ?, kol_name = ?, ai_generated = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      input.content,
      input.kolName,
      input.aiGenerated ? 1 : 0,
      'draft',
      now,
      existing.id,
    )

    return {
      id: existing.id,
      campaignId: input.campaignId,
      kolId: input.kolId,
      kolName: input.kolName,
      content: input.content,
      aiGenerated: input.aiGenerated ?? false,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    }
  }

  // 新建
  db.run(
    `INSERT INTO campaign_briefs (id, campaign_id, kol_id, kol_name, content, ai_generated, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.campaignId,
    input.kolId,
    input.kolName,
    input.content,
    input.aiGenerated ? 1 : 0,
    'draft',
    now,
    now,
  )

  return {
    id,
    campaignId: input.campaignId,
    kolId: input.kolId,
    kolName: input.kolName,
    content: input.content,
    aiGenerated: input.aiGenerated ?? false,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  }
}

// =====================================================================
// Brief 模板生成
// =====================================================================

/**
 * 根据 Campaign 和 KOL 信息生成基础 Brief
 */
export function generateBriefTemplate(
  campaign: Campaign,
  kol: import('@gravitas/shared').CampaignKOLPoolItem
): string {
  const platformLabel: Record<string, string> = {
    xiaohongshu: '小红书',
    douyin: '抖音',
  }

  return `# ${campaign.brand} × ${kol.name} 合作 Brief

## 合作背景
- **品牌**：${campaign.brand}
- **项目**：${campaign.name}
- **投放平台**：${platformLabel[campaign.platform] ?? campaign.platform}
- **目标人群**：${campaign.targetAudience || '待补充'}
- **投放周期**：${campaign.durationMonths} 个月

## KOL 画像
- **账号**：${kol.name}
- **平台**：${kol.platform}
- **粉丝量**：${kol.followers}
- **互动率**：${kol.engagement}
- **内容类目**：${kol.category}
${kol.city ? `- **所在城市**：${kol.city}` : ''}
${kol.price ? `- **合作报价**：${kol.price}` : ''}

## 内容方向（按 Campaign 阶段规划）

${campaign.phasePlans.map((phase) => `### 第 ${phase.phase} 阶段：${phase.name}（${phase.goal}）
- 结合 ${campaign.brand} 品牌调性创作内容
- 围绕 ${campaign.creativePlan.contentPillars.join('、') || '产品卖点'} 展开
- 适配 ${kol.platform} 平台内容形态与受众习惯`).join('\n\n')}

## 内容要求
- [ ] 必须露出品牌名「${campaign.brand}」
- [ ] 强调核心信息：${campaign.creativePlan.coreMessage}
- [ ] 内容风格：${campaign.creativePlan.tone}
- [ ] 重点内容支柱：${campaign.creativePlan.contentPillars.join('、')}
- [ ] 内容风格适配 ${kol.platform} 平台调性
- [ ] 避免过度营销感，保持真实分享感

## 交付要求
- 笔记/视频数量：____ 条
- 发布时间：配合 Campaign 整体排期
- 需提前 3 天提交内容审核
- 发布后 7 天内提供数据截图

## 审核标准
- 内容真实、有情感共鸣
- 产品露出自然不生硬
- 评论区互动积极回应
- 无负面舆情风险

---
*此 Brief 由 MAPro 自动生成，可根据实际合作需求调整。*
`
}

/** 获取所有 KOL（用于 KOL 数据管理页面） */
export function listAllKOLs(): KOLListItem[] {
  const kolDb = getKolDb()
  const rows = kolDb.query(
    `SELECT * FROM kols ORDER BY overall_score DESC, updated_at DESC`
  ).all() as Record<string, unknown>[]

  return rows.map((row) => {
    const extRaw = row.extended_data ? String(row.extended_data) : null
    let extendedData: KOLListItem['extendedData'] = undefined
    if (extRaw) {
      try {
        extendedData = JSON.parse(extRaw) as KOLListItem['extendedData']
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
      baseScore: Number(row.fan_score ?? 0),
      contentScore: Number(row.engagement_score ?? 0),
      commercialScore: Number(row.content_score ?? 0),
      overallScore: Number(row.overall_score ?? 0),
      extendedData,
      fanScore: row.fan_score != null ? Number(row.fan_score) : undefined,
      engagementScore: row.engagement_score != null ? Number(row.engagement_score) : undefined,
      valueScore: row.value_score != null ? Number(row.value_score) : undefined,
      adQualityScore: row.ad_quality_score != null ? Number(row.ad_quality_score) : undefined,
      riskScore: row.risk_score != null ? Number(row.risk_score) : undefined,
      valueTags: row.value_tags ? String(row.value_tags).split(',').filter(Boolean) : undefined,
      riskFlags: row.risk_flags ? String(row.risk_flags).split(',').filter(Boolean) : undefined,
      createdAt: Number(row.created_at) || Date.now(),
      updatedAt: Number(row.updated_at) || Date.now(),
    }
  })
}

/** 更新 KOL 信息 */
export function updateKOL(input: import('@gravitas/shared').UpdateKOLInput): boolean {
  const kolDb = getKolDb()

  // 重新计算评分
  const kol = getKOLById(input.id)
  if (!kol) return false

  const updatedKol: KOLRecord = {
    ...kol,
    name: input.name,
    platform: input.platform,
    followers: input.followers,
    engagement: input.engagement,
    category: input.category,
    price: input.price,
    city: input.city,
    extendedData: input.extendedData,
    fanScore: input.fanScore ?? kol.fanScore,
    engagementScore: input.engagementScore ?? kol.engagementScore,
    valueScore: input.valueScore ?? kol.valueScore,
    adQualityScore: input.adQualityScore ?? kol.adQualityScore,
    riskScore: input.riskScore ?? kol.riskScore,
    valueTags: input.extendedData?.valueTags ?? kol.valueTags,
    riskFlags: input.extendedData?.riskFlags ?? kol.riskFlags,
  }
  const scores = computeKOLScores(updatedKol)

  const result = kolDb.run(
    `UPDATE kols SET name = ?, platform = ?, followers = ?, engagement = ?, category = ?, price = ?, city = ?, fan_score = ?, engagement_score = ?, content_score = ?, overall_score = ?, value_score = ?, ad_quality_score = ?, risk_score = ?, extended_data = ?, value_tags = ?, risk_flags = ?, updated_at = ? WHERE id = ?`,
    input.name,
    input.platform,
    input.followers,
    input.engagement,
    input.category,
    input.price,
    input.city,
    scores.baseScore,
    scores.contentScore,
    scores.commercialScore,
    scores.overallScore,
    updatedKol.valueScore ?? 0,
    updatedKol.adQualityScore ?? 0,
    updatedKol.riskScore ?? 0,
    updatedKol.extendedData ? JSON.stringify(updatedKol.extendedData) : null,
    updatedKol.valueTags ? updatedKol.valueTags.join(',') : null,
    updatedKol.riskFlags ? updatedKol.riskFlags.join(',') : null,
    Date.now(),
    input.id,
  )
  return result.changes > 0
}

/** 删除 KOL */
export function deleteKOL(id: string): boolean {
  const kolDb = getKolDb()
  const result = kolDb.run('DELETE FROM kols WHERE id = ?', id)
  return result.changes > 0
}

// =====================================================================
// 阶段推进（Slice 5）
// =====================================================================

const PHASE_STATUS_MAP: Record<number, Campaign['status']> = {
  1: 'strategy',
  2: 'kol_selection',
  3: 'content_production',
}

/** 推进 Campaign 到下一阶段 */
export function advanceCampaignPhase(id: string): Campaign | null {
  const db = getDb()
  const campaign = getCampaignById(id)
  if (!campaign) return null

  const nextPhase = campaign.currentPhase + 1
  if (nextPhase > 3) return null // 已到最后阶段

  const nextStatus = PHASE_STATUS_MAP[nextPhase] ?? campaign.status
  const now = Date.now()

  db.run(
    `UPDATE campaigns SET current_phase = ?, status = ?, updated_at = ? WHERE id = ?`,
    nextPhase,
    nextStatus,
    now,
    id,
  )

  return getCampaignById(id)
}

// =====================================================================
// 内容审核流水线（内容审核流水线）
// =====================================================================

/** 生成唯一 ID */
function generateAuditId(): string {
  return `audit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

/** 查询 Campaign 的审核记录 */
export function listContentAudits(campaignId: string): import('@gravitas/shared').ContentAudit[] {
  const db = getDb()
  const rows = db.query(
    `SELECT * FROM content_audits WHERE campaign_id = ? ORDER BY created_at DESC`
  ).all(campaignId) as Record<string, unknown>[]

  return rows.map((row) => ({
    auditId: String(row.audit_id),
    campaignId: String(row.campaign_id),
    kolId: String(row.kol_id),
    kolName: '', // 从 KOL 数据库补充
    contentUrl: String(row.content_url ?? ''),
    platform: String(row.platform ?? ''),
    auditStatus: String(row.audit_status ?? 'pending') as import('@gravitas/shared').ContentAudit['auditStatus'],
    complianceScore: Number(row.compliance_score ?? 0),
    brandAlignmentScore: Number(row.brand_alignment_score ?? 0),
    qualityScore: Number(row.quality_score ?? 0),
    overallScore: Number(row.overall_score ?? 0),
    auditReport: String(row.audit_report ?? ''),
    auditor: String(row.auditor ?? 'ai'),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }))
}

/** 获取单个审核记录 */
export function getContentAudit(auditId: string): import('@gravitas/shared').ContentAudit | null {
  const db = getDb()
  const row = db.query('SELECT * FROM content_audits WHERE audit_id = ?').get(auditId) as Record<string, unknown> | null
  if (!row) return null

  return {
    auditId: String(row.audit_id),
    campaignId: String(row.campaign_id),
    kolId: String(row.kol_id),
    kolName: '',
    contentUrl: String(row.content_url ?? ''),
    platform: String(row.platform ?? ''),
    auditStatus: String(row.audit_status ?? 'pending') as import('@gravitas/shared').ContentAudit['auditStatus'],
    complianceScore: Number(row.compliance_score ?? 0),
    brandAlignmentScore: Number(row.brand_alignment_score ?? 0),
    qualityScore: Number(row.quality_score ?? 0),
    overallScore: Number(row.overall_score ?? 0),
    auditReport: String(row.audit_report ?? ''),
    auditor: String(row.auditor ?? 'ai'),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** 创建并执行内容审核 */
export async function createContentAudit(
  input: import('@gravitas/shared').CreateContentAuditInput
): Promise<import('@gravitas/shared').ContentAudit | null> {
  const db = getDb()
  const auditId = generateAuditId()
  const now = Date.now()

  // 先插入 pending 记录
  db.run(
    `INSERT INTO content_audits (audit_id, campaign_id, kol_id, content_url, platform, audit_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    auditId,
    input.campaignId,
    input.kolId,
    input.contentUrl ?? '',
    input.platform,
    'reviewing',
    now,
    now,
  )

  // 执行 AI 审核
  const auditResult = await runContentAudit({
    brand: input.brand,
    product: input.brand, // 简化：品牌名作为产品名
    platform: input.platform,
    contentType: input.contentType,
    contentDescription: input.contentDescription,
    kolId: input.kolId,
    contentUrl: input.contentUrl ?? '',
  })

  if (!auditResult.success) {
    // 更新为失败状态
    db.run(
      `UPDATE content_audits SET audit_status = ?, audit_report = ?, updated_at = ? WHERE audit_id = ?`,
      'failed',
      `审核失败: ${auditResult.error ?? '未知错误'}`,
      Date.now(),
      auditId,
    )
    return getContentAudit(auditId)
  }

  // 判定最终状态
  const finalStatus: 'passed' | 'failed' = (auditResult.overallScore ?? 0) >= 60 ? 'passed' : 'failed'

  // 更新审核结果
  db.run(
    `UPDATE content_audits SET
      audit_status = ?, compliance_score = ?, brand_alignment_score = ?, quality_score = ?, overall_score = ?, audit_report = ?, updated_at = ?
     WHERE audit_id = ?`,
    finalStatus,
    auditResult.complianceScore ?? 0,
    auditResult.brandAlignmentScore ?? 0,
    auditResult.qualityScore ?? 0,
    auditResult.overallScore ?? 0,
    auditResult.report ?? '',
    Date.now(),
    auditId,
  )

  return getContentAudit(auditId)
}

/** 更新审核状态（人工复核） */
export function updateContentAuditStatus(
  auditId: string,
  status: 'pending' | 'reviewing' | 'passed' | 'failed'
): boolean {
  const db = getDb()
  const result = db.run(
    `UPDATE content_audits SET audit_status = ?, updated_at = ? WHERE audit_id = ?`,
    status,
    Date.now(),
    auditId,
  )
  return result.changes > 0
}

// =====================================================================
// 内容数据追踪（新增）
// =====================================================================

/** 生成内容追踪 ID */
function generateTrackingId(): string {
  return `ct_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

/** 生成基准 ID */
function generateBenchmarkId(): string {
  return `bm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

/** 初始化数据标准基准（内置默认值） */
export function seedContentBenchmarks(): void {
  const db = getDb()

  // 检查是否已有数据
  const countRow = db.query('SELECT COUNT(*) as total FROM content_benchmarks').get() as { total: number } | null
  if ((countRow?.total ?? 0) > 0) return

  const now = Date.now()
  const benchmarks: Array<Omit<import('@gravitas/shared').ContentBenchmark, 'id' | 'createdAt' | 'updatedAt'>> = [
    // 小红书 - budget - 10k-100k
    { platform: '小红书', priceTier: 'budget', followersRange: '10k-100k', metricName: 'ctr', excellentThreshold: 10, goodThreshold: 8, normalThreshold: 5, description: '点击率（浏览/曝光）' },
    { platform: '小红书', priceTier: 'budget', followersRange: '10k-100k', metricName: 'engagement_rate', excellentThreshold: 8, goodThreshold: 5, normalThreshold: 3, description: '互动率（总互动/曝光）' },
    { platform: '小红书', priceTier: 'budget', followersRange: '10k-100k', metricName: 'cpm', excellentThreshold: 50, goodThreshold: 100, normalThreshold: 200, description: '千次曝光成本（元），越低越好' },
    { platform: '小红书', priceTier: 'budget', followersRange: '10k-100k', metricName: 'cpe', excellentThreshold: 5, goodThreshold: 10, normalThreshold: 20, description: '单次互动成本（元），越低越好' },
    // 小红书 - mid - 100k-1m
    { platform: '小红书', priceTier: 'mid', followersRange: '100k-1m', metricName: 'ctr', excellentThreshold: 12, goodThreshold: 9, normalThreshold: 6, description: '点击率（浏览/曝光）' },
    { platform: '小红书', priceTier: 'mid', followersRange: '100k-1m', metricName: 'engagement_rate', excellentThreshold: 10, goodThreshold: 7, normalThreshold: 4, description: '互动率（总互动/曝光）' },
    { platform: '小红书', priceTier: 'mid', followersRange: '100k-1m', metricName: 'cpm', excellentThreshold: 80, goodThreshold: 150, normalThreshold: 300, description: '千次曝光成本（元），越低越好' },
    { platform: '小红书', priceTier: 'mid', followersRange: '100k-1m', metricName: 'cpe', excellentThreshold: 8, goodThreshold: 15, normalThreshold: 30, description: '单次互动成本（元），越低越好' },
    // 小红书 - premium - 1m+
    { platform: '小红书', priceTier: 'premium', followersRange: '1m+', metricName: 'ctr', excellentThreshold: 15, goodThreshold: 11, normalThreshold: 7, description: '点击率（浏览/曝光）' },
    { platform: '小红书', priceTier: 'premium', followersRange: '1m+', metricName: 'engagement_rate', excellentThreshold: 12, goodThreshold: 8, normalThreshold: 5, description: '互动率（总互动/曝光）' },
    { platform: '小红书', priceTier: 'premium', followersRange: '1m+', metricName: 'cpm', excellentThreshold: 120, goodThreshold: 200, normalThreshold: 400, description: '千次曝光成本（元），越低越好' },
    { platform: '小红书', priceTier: 'premium', followersRange: '1m+', metricName: 'cpe', excellentThreshold: 12, goodThreshold: 20, normalThreshold: 40, description: '单次互动成本（元），越低越好' },
    // 抖音 - budget - 10k-100k
    { platform: '抖音', priceTier: 'budget', followersRange: '10k-100k', metricName: 'ctr', excellentThreshold: 8, goodThreshold: 6, normalThreshold: 4, description: '点击率（浏览/曝光）' },
    { platform: '抖音', priceTier: 'budget', followersRange: '10k-100k', metricName: 'engagement_rate', excellentThreshold: 6, goodThreshold: 4, normalThreshold: 2, description: '互动率（总互动/曝光）' },
    { platform: '抖音', priceTier: 'budget', followersRange: '10k-100k', metricName: 'cpm', excellentThreshold: 40, goodThreshold: 80, normalThreshold: 150, description: '千次曝光成本（元），越低越好' },
    { platform: '抖音', priceTier: 'budget', followersRange: '10k-100k', metricName: 'cpe', excellentThreshold: 4, goodThreshold: 8, normalThreshold: 15, description: '单次互动成本（元），越低越好' },
    // 抖音 - mid - 100k-1m
    { platform: '抖音', priceTier: 'mid', followersRange: '100k-1m', metricName: 'ctr', excellentThreshold: 10, goodThreshold: 7, normalThreshold: 4, description: '点击率（浏览/曝光）' },
    { platform: '抖音', priceTier: 'mid', followersRange: '100k-1m', metricName: 'engagement_rate', excellentThreshold: 8, goodThreshold: 5, normalThreshold: 3, description: '互动率（总互动/曝光）' },
    { platform: '抖音', priceTier: 'mid', followersRange: '100k-1m', metricName: 'cpm', excellentThreshold: 60, goodThreshold: 120, normalThreshold: 250, description: '千次曝光成本（元），越低越好' },
    { platform: '抖音', priceTier: 'mid', followersRange: '100k-1m', metricName: 'cpe', excellentThreshold: 6, goodThreshold: 12, normalThreshold: 25, description: '单次互动成本（元），越低越好' },
    // 抖音 - premium - 1m+
    { platform: '抖音', priceTier: 'premium', followersRange: '1m+', metricName: 'ctr', excellentThreshold: 12, goodThreshold: 9, normalThreshold: 6, description: '点击率（浏览/曝光）' },
    { platform: '抖音', priceTier: 'premium', followersRange: '1m+', metricName: 'engagement_rate', excellentThreshold: 10, goodThreshold: 7, normalThreshold: 4, description: '互动率（总互动/曝光）' },
    { platform: '抖音', priceTier: 'premium', followersRange: '1m+', metricName: 'cpm', excellentThreshold: 100, goodThreshold: 180, normalThreshold: 350, description: '千次曝光成本（元），越低越好' },
    { platform: '抖音', priceTier: 'premium', followersRange: '1m+', metricName: 'cpe', excellentThreshold: 10, goodThreshold: 18, normalThreshold: 35, description: '单次互动成本（元），越低越好' },
    // 微博 - budget - 10k-100k
    { platform: '微博', priceTier: 'budget', followersRange: '10k-100k', metricName: 'ctr', excellentThreshold: 5, goodThreshold: 3, normalThreshold: 2, description: '点击率（浏览/曝光）' },
    { platform: '微博', priceTier: 'budget', followersRange: '10k-100k', metricName: 'engagement_rate', excellentThreshold: 4, goodThreshold: 2.5, normalThreshold: 1.5, description: '互动率（总互动/曝光）' },
    { platform: '微博', priceTier: 'budget', followersRange: '10k-100k', metricName: 'cpm', excellentThreshold: 30, goodThreshold: 60, normalThreshold: 120, description: '千次曝光成本（元），越低越好' },
    { platform: '微博', priceTier: 'budget', followersRange: '10k-100k', metricName: 'cpe', excellentThreshold: 3, goodThreshold: 6, normalThreshold: 12, description: '单次互动成本（元），越低越好' },
    // 微博 - mid - 100k-1m
    { platform: '微博', priceTier: 'mid', followersRange: '100k-1m', metricName: 'ctr', excellentThreshold: 7, goodThreshold: 5, normalThreshold: 3, description: '点击率（浏览/曝光）' },
    { platform: '微博', priceTier: 'mid', followersRange: '100k-1m', metricName: 'engagement_rate', excellentThreshold: 6, goodThreshold: 4, normalThreshold: 2, description: '互动率（总互动/曝光）' },
    { platform: '微博', priceTier: 'mid', followersRange: '100k-1m', metricName: 'cpm', excellentThreshold: 50, goodThreshold: 100, normalThreshold: 200, description: '千次曝光成本（元），越低越好' },
    { platform: '微博', priceTier: 'mid', followersRange: '100k-1m', metricName: 'cpe', excellentThreshold: 5, goodThreshold: 10, normalThreshold: 20, description: '单次互动成本（元），越低越好' },
  ]

  for (const bm of benchmarks) {
    db.run(
      `INSERT INTO content_benchmarks (id, platform, price_tier, followers_range, metric_name, excellent_threshold, good_threshold, normal_threshold, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      generateBenchmarkId(),
      bm.platform,
      bm.priceTier,
      bm.followersRange,
      bm.metricName,
      bm.excellentThreshold,
      bm.goodThreshold,
      bm.normalThreshold,
      bm.description,
      now,
      now,
    )
  }

  console.log(`[Campaign 服务] 已初始化 ${benchmarks.length} 条数据标准基准`)
}

/** 行数据 → KOLContentTracking */
function rowToContentTracking(row: Record<string, unknown>): import('@gravitas/shared').KOLContentTracking {
  return {
    id: String(row.id),
    campaignId: String(row.campaign_id),
    kolId: String(row.kol_id),
    kolName: String(row.kol_name),
    platform: String(row.platform),
    contentUrl: String(row.content_url ?? ''),
    contentType: String(row.content_type ?? 'organic') as 'organic' | 'paid' | 'mixed',
    publishDate: String(row.publish_date ?? ''),
    exposure: Number(row.exposure ?? 0),
    views: Number(row.views ?? 0),
    likes: Number(row.likes ?? 0),
    saves: Number(row.saves ?? 0),
    comments: Number(row.comments ?? 0),
    shares: Number(row.shares ?? 0),
    completionRate: row.completion_rate != null ? Number(row.completion_rate) : undefined,
    cpm: Number(row.cpm ?? 0),
    cpe: Number(row.cpe ?? 0),
    ctr: Number(row.ctr ?? 0),
    engagementRate: Number(row.engagement_rate ?? 0),
    dataSource: String(row.data_source ?? 'manual') as 'api' | 'manual' | 'screenshot' | 'estimated',
    collectedAt: Number(row.collected_at ?? 0),
    performanceGrade: String(row.performance_grade ?? 'pending') as 'excellent' | 'good' | 'normal' | 'poor' | 'pending',
    benchmarkComparison: String(row.benchmark_comparison ?? ''),
    aiAnalysis: String(row.ai_analysis ?? ''),
    recommendations: String(row.recommendations ?? ''),
    paidData: String(row.paid_data ?? ''),
    paidSpend: Number(row.paid_spend ?? 0),
    paidExposure: Number(row.paid_exposure ?? 0),
    paidViews: Number(row.paid_views ?? 0),
    paidLikes: Number(row.paid_likes ?? 0),
    phase: Number(row.phase ?? 1),
    testGroup: String(row.test_group ?? ''),
    noteType: String(row.note_type ?? ''),
    cost: Number(row.cost ?? 0),
    isOrganic: Boolean(row.is_organic ?? 1),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** 计算内容数据指标 */
function calculateMetrics(
  exposure: number,
  views: number,
  likes: number,
  saves: number,
  comments: number,
  shares: number,
  estimatedPrice: number
): { cpm: number; cpe: number; ctr: number; engagementRate: number } {
  const safeExposure = Math.max(exposure, 1)
  const safeEngagement = Math.max(likes + saves + comments + shares, 1)

  const cpm = estimatedPrice > 0 ? (estimatedPrice / safeExposure) * 1000 : 0
  const cpe = estimatedPrice > 0 ? estimatedPrice / safeEngagement : 0
  const ctr = (views / safeExposure) * 100
  const engagementRate = (safeEngagement / safeExposure) * 100

  return { cpm, cpe, ctr, engagementRate }
}

/** 分析内容性能等级 */
function analyzeContentPerformance(
  platform: string,
  priceTier: string,
  followersRange: string,
  ctr: number,
  engagementRate: number,
  cpm: number,
  cpe: number
): { grade: 'excellent' | 'good' | 'normal' | 'poor'; comparison: Record<string, unknown> } {
  const db = getDb()

  // 查询对应基准
  const rows = db.query(
    `SELECT metric_name, excellent_threshold, good_threshold, normal_threshold
     FROM content_benchmarks
     WHERE platform = ? AND price_tier = ? AND followers_range = ?`
  ).all(platform, priceTier, followersRange) as Array<{
    metric_name: string
    excellent_threshold: number
    good_threshold: number
    normal_threshold: number
  }>

  if (rows.length === 0) {
    return { grade: 'pending' as 'excellent' | 'good' | 'normal' | 'poor', comparison: { reason: '未找到对应基准数据' } }
  }

  const comparison: Record<string, unknown> = {}
  let excellentCount = 0
  let goodCount = 0
  let poorCount = 0

  for (const row of rows) {
    const metricName = row.metric_name
    const excellent = row.excellent_threshold
    const good = row.good_threshold
    const normal = row.normal_threshold

    let value = 0
    switch (metricName) {
      case 'ctr': value = ctr; break
      case 'engagement_rate': value = engagementRate; break
      case 'cpm': value = cpm; break
      case 'cpe': value = cpe; break
      default: continue
    }

    // CPM 和 CPE 是越低越好，其他是越高越好
    const isLowerBetter = metricName === 'cpm' || metricName === 'cpe'

    let grade: string
    if (isLowerBetter) {
      if (value <= excellent) grade = 'excellent'
      else if (value <= good) grade = 'good'
      else if (value <= normal) grade = 'normal'
      else grade = 'poor'
    } else {
      if (value >= excellent) grade = 'excellent'
      else if (value >= good) grade = 'good'
      else if (value >= normal) grade = 'normal'
      else grade = 'poor'
    }

    comparison[metricName] = {
      value: Number(value.toFixed(2)),
      excellent: isLowerBetter ? `<= ${excellent}` : `>= ${excellent}`,
      good: isLowerBetter ? `<= ${good}` : `>= ${good}`,
      normal: isLowerBetter ? `<= ${normal}` : `>= ${normal}`,
      grade,
    }

    if (grade === 'excellent') excellentCount++
    if (grade === 'good') goodCount++
    if (grade === 'poor') poorCount++
  }

  // 综合判定：excellent (>=2个优秀) / good (>=1个优秀或2个良好) / normal (全部合格) / poor (有不合格)
  let finalGrade: 'excellent' | 'good' | 'normal' | 'poor'
  if (excellentCount >= 2) {
    finalGrade = 'excellent'
  } else if (excellentCount >= 1 || goodCount >= 2) {
    finalGrade = 'good'
  } else if (poorCount > 0) {
    finalGrade = 'poor'
  } else {
    finalGrade = 'normal'
  }

  return { grade: finalGrade, comparison }
}

/** 按 Campaign 列出内容追踪记录 */
export function listContentTracking(campaignId: string): import('@gravitas/shared').KOLContentTracking[] {
  const db = getDb()
  const rows = db.query(
    `SELECT * FROM kol_content_tracking WHERE campaign_id = ? ORDER BY created_at DESC`
  ).all(campaignId) as Record<string, unknown>[]
  return rows.map(rowToContentTracking)
}

/** 获取单条内容追踪记录 */
export function getContentTracking(id: string): import('@gravitas/shared').KOLContentTracking | null {
  const db = getDb()
  const row = db.query('SELECT * FROM kol_content_tracking WHERE id = ?').get(id) as Record<string, unknown> | null
  return row ? rowToContentTracking(row) : null
}

/** 创建内容追踪记录 */
export function createContentTracking(
  input: import('@gravitas/shared').CreateContentTrackingInput
): import('@gravitas/shared').KOLContentTracking | null {
  const db = getDb()
  const now = Date.now()
  const id = generateTrackingId()

  // 获取 KOL 报价用于计算 CPM/CPE（如果可用）
  let estimatedPrice = input.paidSpend ?? 0
  if (estimatedPrice === 0) {
    try {
      const kolDb = getKolDb()
      const kolRow = kolDb.query('SELECT price FROM kols WHERE id = ?').get(input.kolId) as { price: string } | null
      if (kolRow?.price) {
        // 解析报价字符串（如 "3万" → 30000）
        const priceStr = kolRow.price.replace(/[万亿]/g, '')
        const priceNum = parseFloat(priceStr)
        if (!Number.isNaN(priceNum)) {
          if (kolRow.price.includes('万')) estimatedPrice = priceNum * 10000
          else if (kolRow.price.includes('亿')) estimatedPrice = priceNum * 100000000
          else estimatedPrice = priceNum
        }
      }
    } catch {
      // KOL 数据库可能不存在，忽略错误
    }
  }

  const metrics = calculateMetrics(
    input.exposure,
    input.views,
    input.likes,
    input.saves,
    input.comments,
    input.shares,
    estimatedPrice
  )

  db.run(
    `INSERT INTO kol_content_tracking (
      id, campaign_id, kol_id, kol_name, platform, content_url, content_type, publish_date,
      exposure, views, likes, saves, comments, shares, completion_rate,
      cpm, cpe, ctr, engagement_rate, data_source, collected_at,
      performance_grade, benchmark_comparison, paid_spend, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.campaignId,
    input.kolId,
    input.kolName,
    input.platform,
    input.contentUrl,
    input.contentType,
    input.publishDate,
    input.exposure,
    input.views,
    input.likes,
    input.saves,
    input.comments,
    input.shares,
    input.completionRate ?? null,
    metrics.cpm,
    metrics.cpe,
    metrics.ctr,
    metrics.engagementRate,
    input.dataSource,
    now,
    'pending',
    '',
    estimatedPrice,
    now,
    now,
  )

  return getContentTracking(id)
}

/** 更新内容数据（自动计算指标） */
export function updateContentTrackingData(
  input: import('@gravitas/shared').UpdateContentTrackingDataInput
): import('@gravitas/shared').KOLContentTracking | null {
  const db = getDb()
  const existing = getContentTracking(input.id)
  if (!existing) return null

  // 重新计算指标（保留原有报价估算）
  const estimatedPrice = existing.paidSpend > 0 ? existing.paidSpend : 0
  const metrics = calculateMetrics(
    input.exposure,
    input.views,
    input.likes,
    input.saves,
    input.comments,
    input.shares,
    estimatedPrice
  )

  const now = Date.now()

  db.run(
    `UPDATE kol_content_tracking SET
      exposure = ?, views = ?, likes = ?, saves = ?, comments = ?, shares = ?,
      completion_rate = ?, cpm = ?, cpe = ?, ctr = ?, engagement_rate = ?,
      data_source = ?, collected_at = ?, updated_at = ?
     WHERE id = ?`,
    input.exposure,
    input.views,
    input.likes,
    input.saves,
    input.comments,
    input.shares,
    input.completionRate ?? null,
    metrics.cpm,
    metrics.cpe,
    metrics.ctr,
    metrics.engagementRate,
    input.dataSource,
    now,
    now,
    input.id,
  )

  return getContentTracking(input.id)
}

/** 添加投流数据 */
export function addPaidData(
  input: import('@gravitas/shared').AddPaidDataInput
): import('@gravitas/shared').KOLContentTracking | null {
  const db = getDb()
  const now = Date.now()

  db.run(
    `UPDATE kol_content_tracking SET
      paid_spend = ?, paid_exposure = ?, paid_views = ?, paid_likes = ?,
      paid_data = ?, updated_at = ?
     WHERE id = ?`,
    input.paidSpend,
    input.paidExposure,
    input.paidViews,
    input.paidLikes,
    input.paidData,
    now,
    input.id,
  )

  return getContentTracking(input.id)
}

/** 更新分析结果 */
export function updateContentTrackingAnalysis(
  input: import('@gravitas/shared').UpdateAnalysisInput
): import('@gravitas/shared').KOLContentTracking | null {
  const db = getDb()
  const now = Date.now()

  db.run(
    `UPDATE kol_content_tracking SET
      performance_grade = ?, benchmark_comparison = ?, ai_analysis = ?,
      recommendations = ?, updated_at = ?
     WHERE id = ?`,
    input.performanceGrade,
    input.benchmarkComparison,
    input.aiAnalysis,
    input.recommendations,
    now,
    input.id,
  )

  return getContentTracking(input.id)
}

/** 删除内容追踪记录 */
export function deleteContentTracking(id: string): boolean {
  const db = getDb()
  const result = db.run('DELETE FROM kol_content_tracking WHERE id = ?', id)
  return result.changes > 0
}

/** 执行 AI 内容性能分析（供 Chat Tool 调用） */
export async function analyzeContentPerformanceAI(
  contentId: string,
  platform: string,
  priceTier: string,
  followersRange: string
): Promise<{ success: boolean; result?: import('@gravitas/shared').KOLContentTracking; error?: string }> {
  try {
    const tracking = getContentTracking(contentId)
    if (!tracking) return { success: false, error: '内容追踪记录不存在' }

    const { grade, comparison } = analyzeContentPerformance(
      platform,
      priceTier,
      followersRange,
      tracking.ctr,
      tracking.engagementRate,
      tracking.cpm,
      tracking.cpe
    )

    const benchmarkComparison = JSON.stringify(comparison, null, 2)

    // AI 分析提示词
    const systemPrompt = `你是一位资深社交媒体投放分析师，擅长根据数据判断内容表现并给出优化建议。`

    const userPrompt = `请分析以下内容的投放表现并给出建议：

平台：${platform}
KOL：${tracking.kolName}
曝光量：${tracking.exposure.toLocaleString()}
浏览量：${tracking.views.toLocaleString()}
点赞：${tracking.likes.toLocaleString()}
收藏：${tracking.saves.toLocaleString()}
评论：${tracking.comments.toLocaleString()}
转发：${tracking.shares.toLocaleString()}

核心指标：
- CTR：${tracking.ctr.toFixed(2)}%
- 互动率：${tracking.engagementRate.toFixed(2)}%
- CPM：${tracking.cpm.toFixed(2)} 元
- CPE：${tracking.cpe.toFixed(2)} 元

基准对比：${benchmarkComparison}

请给出：
1. 数据表现总结（100字以内）
2. 是否建议投流加热及具体策略（薯条/评论区维护/DOU+）
3. 下一步优化建议`

    const { completePrompt } = await import('./marketing/ma-tools/llm-service')
    const llmResult = await completePrompt(userPrompt, systemPrompt, {
      temperature: 0.7,
      maxTokens: 3000,
    })

    if (!llmResult.success) {
      return { success: false, error: llmResult.error }
    }

    // 更新分析结果
    const updated = updateContentTrackingAnalysis({
      id: contentId,
      performanceGrade: grade,
      benchmarkComparison,
      aiAnalysis: llmResult.text,
      recommendations: grade === 'excellent' || grade === 'good'
        ? '表现良好，建议继续自然传播观察；如需扩大声量可考虑适度加热。'
        : '表现未达预期，建议优化内容形式或调整投放策略。',
    })

    return { success: true, result: updated ?? undefined }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { success: false, error: msg }
  }
}

// =====================================================================
// 阶段复盘报告（Slice 1）
// =====================================================================

/** 行数据 → CampaignPhaseReport */
function rowToPhaseReport(row: Record<string, unknown>): import('@gravitas/shared').CampaignPhaseReport {
  return {
    id: String(row.id),
    campaignId: String(row.campaign_id),
    phase: Number(row.phase ?? 1),
    reportType: String(row.report_type ?? 'phase') as 'phase' | 'weekly' | 'ab_test',
    startDate: String(row.start_date ?? ''),
    endDate: String(row.end_date ?? ''),
    totalKols: Number(row.total_kols ?? 0),
    totalPosts: Number(row.total_posts ?? 0),
    totalCost: Number(row.total_cost ?? 0),
    organicCost: Number(row.organic_cost ?? 0),
    paidCost: Number(row.paid_cost ?? 0),
    totalExposure: Number(row.total_exposure ?? 0),
    totalViews: Number(row.total_views ?? 0),
    totalLikes: Number(row.total_likes ?? 0),
    totalSaves: Number(row.total_saves ?? 0),
    totalComments: Number(row.total_comments ?? 0),
    totalShares: Number(row.total_shares ?? 0),
    avgCpm: Number(row.avg_cpm ?? 0),
    avgCpe: Number(row.avg_cpe ?? 0),
    avgCtr: Number(row.avg_ctr ?? 0),
    avgEngagementRate: Number(row.avg_engagement_rate ?? 0),
    roiEstimate: Number(row.roi_estimate ?? 0),
    cpmTarget: Number(row.cpm_target ?? 0),
    cpmTargetAchieved: Boolean(row.cpm_target_achieved),
    engagementTarget: Number(row.engagement_target ?? 0),
    engagementTargetAchieved: Boolean(row.engagement_target_achieved),
    aiSummary: String(row.ai_summary ?? ''),
    aiFindings: row.ai_findings ? JSON.parse(String(row.ai_findings)) : [],
    aiRecommendations: row.ai_recommendations ? JSON.parse(String(row.ai_recommendations)) : [],
    aiScaleAdvice: String(row.ai_scale_advice ?? ''),
    status: String(row.status ?? 'draft') as 'draft' | 'generated' | 'finalized',
    generatedBy: String(row.generated_by ?? 'ai') as 'ai' | 'manual',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** 生成阶段复盘报告（自动汇总数据 + AI 分析） */
export async function generatePhaseReport(
  input: import('@gravitas/shared').GeneratePhaseReportInput
): Promise<import('@gravitas/shared').CampaignPhaseReport> {
  const db = getDb()
  const now = Date.now()
  const id = `report_${now}_${Math.random().toString(36).slice(2, 9)}`

  // 1. 拉取该阶段所有内容数据
  const rows = db.query(
    `SELECT * FROM kol_content_tracking
     WHERE campaign_id = ? AND (phase = ? OR phase = 0)
     ORDER BY publish_date ASC`
  ).all(input.campaignId, input.phase) as Record<string, unknown>[]

  // 2. 计算汇总指标
  let totalExposure = 0, totalViews = 0, totalLikes = 0, totalSaves = 0
  let totalComments = 0, totalShares = 0, totalCost = 0, paidCost = 0
  const kolSet = new Set<string>()
  const postCount = rows.length

  for (const row of rows) {
    totalExposure += Number(row.exposure ?? 0)
    totalViews += Number(row.views ?? 0)
    totalLikes += Number(row.likes ?? 0)
    totalSaves += Number(row.saves ?? 0)
    totalComments += Number(row.comments ?? 0)
    totalShares += Number(row.shares ?? 0)
    totalCost += Number(row.cost ?? 0) + Number(row.paid_spend ?? 0)
    paidCost += Number(row.paid_spend ?? 0)
    kolSet.add(String(row.kol_id ?? ''))
  }

  const safeExposure = Math.max(totalExposure, 1)
  const safeEngagement = Math.max(totalLikes + totalSaves + totalComments + totalShares, 1)
  const avgCpm = totalCost > 0 ? (totalCost / safeExposure) * 1000 : 0
  const avgCpe = totalCost > 0 ? totalCost / safeEngagement : 0
  const avgCtr = totalViews > 0 ? (totalViews / safeExposure) * 100 : 0
  const avgEngagementRate = (safeEngagement / safeExposure) * 100

  const cpmTarget = input.cpmTarget ?? 0
  const engagementTarget = input.engagementTarget ?? 0

  // 3. AI 分析（Slice 2）
  let aiSummary = ''
  let aiFindings: string[] = []
  let aiRecommendations: string[] = []
  let aiScaleAdvice = ''

  if (postCount > 0) {
    try {
      const { completePrompt, extractJSON } = await import('./marketing/ma-tools/llm-service')

      const systemPrompt = `你是一位资深社交媒体投放复盘专家，曾为多个品牌管理过百万级预算的 KOL 投放项目。

请基于投放数据生成结构化复盘分析，输出严格 JSON 格式：
{
  "summary": "整体表现总结（100字以内）",
  "findings": ["发现1", "发现2", "发现3"],
  "recommendations": ["建议1", "建议2", "建议3"],
  "scaleAdvice": "放量建议（200字以内，包含具体预算分配和达人组合建议）"
}

分析维度：
1. 数据表现与行业基准对比（CPM/CPE/互动率是否达标）
2. 自然流 vs 投流效果对比
3. 内容形式和内容类型的表现差异
4. 达人层级/平台的表现差异
5. 下阶段优化方向和具体策略
6. 放量建议（预算分配、达人组合、内容策略）`

      const userPrompt = `请分析以下第 ${input.phase} 阶段投放数据：

时间范围：${input.startDate} ~ ${input.endDate}
参与 KOL：${kolSet.size} 位
发布内容：${postCount} 篇

核心指标：
- 总曝光：${totalExposure.toLocaleString()}
- 总浏览：${totalViews.toLocaleString()}
- 总点赞：${totalLikes.toLocaleString()}
- 总收藏：${totalSaves.toLocaleString()}
- 总评论：${totalComments.toLocaleString()}
- 总转发：${totalShares.toLocaleString()}
- 平均 CPM：¥${avgCpm.toFixed(2)}
- 平均 CPE：¥${avgCpe.toFixed(2)}
- 平均 CTR：${avgCtr.toFixed(2)}%
- 平均互动率：${avgEngagementRate.toFixed(2)}%
- 总花费：¥${totalCost.toLocaleString()}
- 投流花费：¥${paidCost.toLocaleString()}
${cpmTarget > 0 ? `- CPM 目标：¥${cpmTarget}（${avgCpm <= cpmTarget ? '已达成' : '未达成'}）` : ''}
${engagementTarget > 0 ? `- 互动率目标：${engagementTarget}%（${avgEngagementRate >= engagementTarget ? '已达成' : '未达成'}）` : ''}

${rows.length > 0 ? `内容明细（前10条）：
${rows.slice(0, 10).map((row) => {
  const name = String(row.kol_name ?? '')
  const platform = String(row.platform ?? '')
  const exp = Number(row.exposure ?? 0)
  const likes = Number(row.likes ?? 0)
  const er = Number(row.engagement_rate ?? 0)
  const grade = String(row.performance_grade ?? 'pending')
  return `- ${name} (${platform}): 曝光 ${exp.toLocaleString()}, 点赞 ${likes.toLocaleString()}, 互动率 ${er.toFixed(2)}%, 等级 ${grade}`
}).join('\n')}` : ''}

请生成结构化复盘分析。`

      const llmResult = await completePrompt(userPrompt, systemPrompt, {
        jsonMode: true,
        temperature: 0.5,
        maxTokens: 6000,
      })

      if (llmResult.success) {
        try {
          const parsed = extractJSON(llmResult.text) as Record<string, unknown>
          aiSummary = String(parsed.summary ?? '')
          aiFindings = Array.isArray(parsed.findings) ? parsed.findings.map(String) : []
          aiRecommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations.map(String) : []
          aiScaleAdvice = String(parsed.scaleAdvice ?? '')
        } catch {
          aiSummary = llmResult.text.slice(0, 500)
        }
      }
    } catch (error) {
      console.error('[阶段复盘] AI 分析失败:', error)
      aiSummary = 'AI 分析服务暂时不可用，请稍后重试。'
    }
  } else {
    aiSummary = '暂无内容数据，请先添加内容数据后再生成复盘报告。'
  }

  // 4. 插入报告
  db.run(
    `INSERT INTO campaign_phase_reports (
      id, campaign_id, phase, report_type, start_date, end_date,
      total_kols, total_posts, total_cost, organic_cost, paid_cost,
      total_exposure, total_views, total_likes, total_saves, total_comments, total_shares,
      avg_cpm, avg_cpe, avg_ctr, avg_engagement_rate, roi_estimate,
      cpm_target, cpm_target_achieved, engagement_target, engagement_target_achieved,
      ai_summary, ai_findings, ai_recommendations, ai_scale_advice,
      status, generated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.campaignId,
    input.phase,
    input.reportType,
    input.startDate,
    input.endDate,
    kolSet.size,
    postCount,
    totalCost,
    totalCost - paidCost,
    paidCost,
    totalExposure,
    totalViews,
    totalLikes,
    totalSaves,
    totalComments,
    totalShares,
    avgCpm,
    avgCpe,
    avgCtr,
    avgEngagementRate,
    0, // roiEstimate
    cpmTarget,
    cpmTarget > 0 && avgCpm <= cpmTarget ? 1 : 0,
    engagementTarget,
    engagementTarget > 0 && avgEngagementRate >= engagementTarget ? 1 : 0,
    aiSummary,
    JSON.stringify(aiFindings),
    JSON.stringify(aiRecommendations),
    aiScaleAdvice,
    'generated',
    'ai',
    now,
    now,
  )

  return getPhaseReport(id)!
}

/** 按 Campaign 列出复盘报告 */
export function listPhaseReports(campaignId: string): import('@gravitas/shared').CampaignPhaseReport[] {
  const db = getDb()
  const rows = db.query(
    `SELECT * FROM campaign_phase_reports WHERE campaign_id = ? ORDER BY created_at DESC`
  ).all(campaignId) as Record<string, unknown>[]
  return rows.map(rowToPhaseReport)
}

/** 获取单份复盘报告 */
export function getPhaseReport(id: string): import('@gravitas/shared').CampaignPhaseReport | null {
  const db = getDb()
  const row = db.query('SELECT * FROM campaign_phase_reports WHERE id = ?').get(id) as Record<string, unknown> | null
  return row ? rowToPhaseReport(row) : null
}

/** 更新复盘报告（人工编辑） */
export function updatePhaseReport(
  id: string,
  updates: Partial<Pick<import('@gravitas/shared').CampaignPhaseReport, 'aiSummary' | 'aiFindings' | 'aiRecommendations' | 'aiScaleAdvice' | 'status'>>
): import('@gravitas/shared').CampaignPhaseReport | null {
  const db = getDb()
  const report = getPhaseReport(id)
  if (!report) return null

  const fields: string[] = []
  const values: unknown[] = []

  if (updates.aiSummary !== undefined) { fields.push('ai_summary = ?'); values.push(updates.aiSummary) }
  if (updates.aiFindings !== undefined) { fields.push('ai_findings = ?'); values.push(JSON.stringify(updates.aiFindings)) }
  if (updates.aiRecommendations !== undefined) { fields.push('ai_recommendations = ?'); values.push(JSON.stringify(updates.aiRecommendations)) }
  if (updates.aiScaleAdvice !== undefined) { fields.push('ai_scale_advice = ?'); values.push(updates.aiScaleAdvice) }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status) }

  if (fields.length === 0) return report

  fields.push('updated_at = ?')
  values.push(Date.now())
  values.push(id)

  db.run(`UPDATE campaign_phase_reports SET ${fields.join(', ')} WHERE id = ?`, ...values)
  return getPhaseReport(id)
}

/** 定稿复盘报告 */
export function finalizePhaseReport(id: string): import('@gravitas/shared').CampaignPhaseReport | null {
  return updatePhaseReport(id, { status: 'finalized' })
}

/** 删除复盘报告 */
export function deletePhaseReport(id: string): boolean {
  const db = getDb()
  const result = db.run('DELETE FROM campaign_phase_reports WHERE id = ?', id)
  return result.changes > 0
}

// =====================================================================
// AB 测试服务（Slice 3）
// =====================================================================

/** 生成 AB 测试 ID */
function generateABTestId(): string {
  return `ab_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

/** 行数据 → CampaignABTest */
function rowToABTest(row: Record<string, unknown>): import('@gravitas/shared').CampaignABTest {
  return {
    id: String(row.id),
    campaignId: String(row.campaign_id),
    phase: Number(row.phase ?? 1),
    testName: String(row.test_name ?? ''),
    hypothesis: String(row.hypothesis ?? ''),
    variableType: String(row.variable_type ?? 'content') as import('@gravitas/shared').ABTestVariableType,
    variableDescription: String(row.variable_description ?? ''),
    controlGroupDefinition: String(row.control_group_definition ?? ''),
    testGroupDefinition: String(row.test_group_definition ?? ''),
    startDate: String(row.start_date ?? ''),
    endDate: String(row.end_date ?? ''),
    status: String(row.status ?? 'running') as 'running' | 'completed' | 'cancelled',
    winnerGroup: String(row.winner_group ?? ''),
    winnerReason: String(row.winner_reason ?? ''),
    scaleRecommendation: String(row.scale_recommendation ?? ''),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** 行数据 → ABTestResult */
function rowToABTestResult(row: Record<string, unknown>): import('@gravitas/shared').ABTestResult {
  return {
    id: String(row.id),
    abTestId: String(row.ab_test_id),
    groupName: String(row.group_name ?? ''),
    kolCount: Number(row.kol_count ?? 0),
    postCount: Number(row.post_count ?? 0),
    totalCost: Number(row.total_cost ?? 0),
    totalExposure: Number(row.total_exposure ?? 0),
    totalViews: Number(row.total_views ?? 0),
    totalLikes: Number(row.total_likes ?? 0),
    totalSaves: Number(row.total_saves ?? 0),
    totalComments: Number(row.total_comments ?? 0),
    totalShares: Number(row.total_shares ?? 0),
    avgCpm: Number(row.avg_cpm ?? 0),
    avgCpe: Number(row.avg_cpe ?? 0),
    avgCtr: Number(row.avg_ctr ?? 0),
    avgEngagementRate: Number(row.avg_engagement_rate ?? 0),
    conversionCount: Number(row.conversion_count ?? 0),
    conversionRate: Number(row.conversion_rate ?? 0),
    significanceScore: Number(row.significance_score ?? 0),
    isSignificant: Boolean(row.is_significant ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** 创建 AB 测试 */
export function createABTest(
  input: import('@gravitas/shared').CreateABTestInput
): import('@gravitas/shared').CampaignABTest {
  const db = getDb()
  const now = Date.now()
  const id = generateABTestId()

  db.run(
    `INSERT INTO campaign_ab_tests (
      id, campaign_id, phase, test_name, hypothesis, variable_type, variable_description,
      control_group_definition, test_group_definition, start_date, end_date,
      status, winner_group, winner_reason, scale_recommendation, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.campaignId,
    input.phase,
    input.testName,
    input.hypothesis,
    input.variableType,
    input.variableDescription,
    input.controlGroupDefinition,
    input.testGroupDefinition,
    input.startDate,
    input.endDate,
    'running',
    '',
    '',
    '',
    now,
    now,
  )

  return getABTest(id)!
}

/** 按 Campaign 列出 AB 测试 */
export function listABTests(campaignId: string): import('@gravitas/shared').CampaignABTest[] {
  const db = getDb()
  const rows = db.query(
    `SELECT * FROM campaign_ab_tests WHERE campaign_id = ? ORDER BY created_at DESC`
  ).all(campaignId) as Record<string, unknown>[]
  return rows.map(rowToABTest)
}

/** 获取单个 AB 测试 */
export function getABTest(id: string): import('@gravitas/shared').CampaignABTest | null {
  const db = getDb()
  const row = db.query('SELECT * FROM campaign_ab_tests WHERE id = ?').get(id) as Record<string, unknown> | null
  return row ? rowToABTest(row) : null
}

/** 更新 AB 测试 */
export function updateABTest(
  id: string,
  updates: Partial<Pick<import('@gravitas/shared').CampaignABTest, 'testName' | 'hypothesis' | 'variableType' | 'variableDescription' | 'controlGroupDefinition' | 'testGroupDefinition' | 'startDate' | 'endDate' | 'status' | 'winnerGroup' | 'winnerReason' | 'scaleRecommendation'>>
): import('@gravitas/shared').CampaignABTest | null {
  const db = getDb()
  const test = getABTest(id)
  if (!test) return null

  const fields: string[] = []
  const values: unknown[] = []

  if (updates.testName !== undefined) { fields.push('test_name = ?'); values.push(updates.testName) }
  if (updates.hypothesis !== undefined) { fields.push('hypothesis = ?'); values.push(updates.hypothesis) }
  if (updates.variableType !== undefined) { fields.push('variable_type = ?'); values.push(updates.variableType) }
  if (updates.variableDescription !== undefined) { fields.push('variable_description = ?'); values.push(updates.variableDescription) }
  if (updates.controlGroupDefinition !== undefined) { fields.push('control_group_definition = ?'); values.push(updates.controlGroupDefinition) }
  if (updates.testGroupDefinition !== undefined) { fields.push('test_group_definition = ?'); values.push(updates.testGroupDefinition) }
  if (updates.startDate !== undefined) { fields.push('start_date = ?'); values.push(updates.startDate) }
  if (updates.endDate !== undefined) { fields.push('end_date = ?'); values.push(updates.endDate) }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status) }
  if (updates.winnerGroup !== undefined) { fields.push('winner_group = ?'); values.push(updates.winnerGroup) }
  if (updates.winnerReason !== undefined) { fields.push('winner_reason = ?'); values.push(updates.winnerReason) }
  if (updates.scaleRecommendation !== undefined) { fields.push('scale_recommendation = ?'); values.push(updates.scaleRecommendation) }

  if (fields.length === 0) return test

  fields.push('updated_at = ?')
  values.push(Date.now())
  values.push(id)

  db.run(`UPDATE campaign_ab_tests SET ${fields.join(', ')} WHERE id = ?`, ...values)
  return getABTest(id)
}

/** 完成 AB 测试 */
export function completeABTest(
  id: string,
  winnerGroup: string,
  winnerReason: string,
  scaleRecommendation: string
): import('@gravitas/shared').CampaignABTest | null {
  return updateABTest(id, { status: 'completed', winnerGroup, winnerReason, scaleRecommendation })
}

/** 删除 AB 测试 */
export function deleteABTest(id: string): boolean {
  const db = getDb()
  // 先删除关联结果
  db.run('DELETE FROM ab_test_results WHERE ab_test_id = ?', id)
  const result = db.run('DELETE FROM campaign_ab_tests WHERE id = ?', id)
  return result.changes > 0
}

/** 获取 AB 测试结果 */
export function getABTestResults(abTestId: string): import('@gravitas/shared').ABTestResult[] {
  const db = getDb()
  const rows = db.query(
    `SELECT * FROM ab_test_results WHERE ab_test_id = ? ORDER BY group_name ASC`
  ).all(abTestId) as Record<string, unknown>[]
  return rows.map(rowToABTestResult)
}

/** 更新 AB 测试分组结果（存在则更新，不存在则插入） */
export function updateABTestResult(
  input: import('@gravitas/shared').UpdateABTestResultInput
): import('@gravitas/shared').ABTestResult {
  const db = getDb()
  const now = Date.now()

  // 检查是否已存在
  const existing = db.query(
    'SELECT id FROM ab_test_results WHERE ab_test_id = ? AND group_name = ?'
  ).get(input.abTestId, input.groupName) as { id: string } | null

  const safeExposure = Math.max(input.totalExposure, 1)
  const safeEngagement = Math.max(input.totalLikes + input.totalSaves + input.totalComments + input.totalShares, 1)
  const avgCpm = input.totalCost > 0 ? (input.totalCost / safeExposure) * 1000 : 0
  const avgCpe = input.totalCost > 0 ? input.totalCost / safeEngagement : 0
  const avgCtr = input.totalViews > 0 ? (input.totalViews / safeExposure) * 100 : 0
  const avgEngagementRate = (safeEngagement / safeExposure) * 100

  if (existing) {
    db.run(
      `UPDATE ab_test_results SET
        kol_count = ?, post_count = ?, total_cost = ?,
        total_exposure = ?, total_views = ?, total_likes = ?, total_saves = ?, total_comments = ?, total_shares = ?,
        avg_cpm = ?, avg_cpe = ?, avg_ctr = ?, avg_engagement_rate = ?,
        conversion_count = ?, conversion_rate = ?, updated_at = ?
       WHERE id = ?`,
      input.kolCount, input.postCount, input.totalCost,
      input.totalExposure, input.totalViews, input.totalLikes, input.totalSaves, input.totalComments, input.totalShares,
      avgCpm, avgCpe, avgCtr, avgEngagementRate,
      input.conversionCount, input.conversionRate,
      now, existing.id,
    )
    return getABTestResultById(existing.id)!
  }

  const id = `abr_${now}_${Math.random().toString(36).slice(2, 9)}`
  db.run(
    `INSERT INTO ab_test_results (
      id, ab_test_id, group_name, kol_count, post_count, total_cost,
      total_exposure, total_views, total_likes, total_saves, total_comments, total_shares,
      avg_cpm, avg_cpe, avg_ctr, avg_engagement_rate, conversion_count, conversion_rate,
      significance_score, is_significant, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, input.abTestId, input.groupName, input.kolCount, input.postCount, input.totalCost,
    input.totalExposure, input.totalViews, input.totalLikes, input.totalSaves, input.totalComments, input.totalShares,
    avgCpm, avgCpe, avgCtr, avgEngagementRate, input.conversionCount, input.conversionRate,
    0, 0, now, now,
  )
  return getABTestResultById(id)!
}

/** 通过 ID 获取单条结果 */
function getABTestResultById(id: string): import('@gravitas/shared').ABTestResult | null {
  const db = getDb()
  const row = db.query('SELECT * FROM ab_test_results WHERE id = ?').get(id) as Record<string, unknown> | null
  return row ? rowToABTestResult(row) : null
}

/** 计算并更新统计显著性（简化版：组间差异 / 标准差） */
export function calculateABTestSignificance(abTestId: string): void {
  const db = getDb()
  const results = getABTestResults(abTestId)
  if (results.length < 2) return

  const engagementRates = results.map((r) => r.avgEngagementRate)
  const mean = engagementRates.reduce((a, b) => a + b, 0) / engagementRates.length
  const variance = engagementRates.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / engagementRates.length
  const stdDev = Math.sqrt(variance) || 1

  const maxRate = Math.max(...engagementRates)
  const minRate = Math.min(...engagementRates)
  const diff = maxRate - minRate
  const significanceScore = Math.min(diff / stdDev, 1) // 0-1
  const isSignificant = significanceScore > 0.5 ? 1 : 0

  for (const result of results) {
    db.run(
      'UPDATE ab_test_results SET significance_score = ?, is_significant = ? WHERE id = ?',
      significanceScore,
      isSignificant,
      result.id,
    )
  }
}

/** AI 分析 AB 测试 */
export async function analyzeABTest(
  abTestId: string
): Promise<{ success: boolean; result?: import('@gravitas/shared').CampaignABTest; error?: string }> {
  try {
    const test = getABTest(abTestId)
    if (!test) return { success: false, error: 'AB 测试不存在' }

    const results = getABTestResults(abTestId)
    if (results.length < 2) return { success: false, error: '需要至少 2 组数据才能分析' }

    // 计算统计显著性
    calculateABTestSignificance(abTestId)
    const updatedResults = getABTestResults(abTestId)

    // 找出胜出组
    const winner = updatedResults.reduce((best, current) =>
      current.avgEngagementRate > best.avgEngagementRate ? current : best
    )

    const { completePrompt, extractJSON } = await import('./marketing/ma-tools/llm-service')

    const systemPrompt = `你是一位资深社交媒体投放测试分析师，擅长 A/B 测试数据分析和放量决策。

请基于 AB 测试数据生成结构化分析，输出严格 JSON 格式：
{
  "winner_reason": "胜出原因（200字以内）",
  "scale_recommendation": "放量建议（300字以内，包含具体预算分配和达人组合建议）"
}

分析维度：
1. 各组数据表现对比（曝光、互动率、CPM、CPE）
2. 统计显著性评估
3. 胜出组优势分析
4. 下阶段放量建议（预算分配、达人组合、内容策略）`

    const userPrompt = `请分析以下 AB 测试数据：

测试名称：${test.testName}
假设：${test.hypothesis}
变量类型：${test.variableType}

分组数据：
${updatedResults.map((r) => `
组名：${r.groupName}
- KOL 数量：${r.kolCount}
- 内容数：${r.postCount}
- 总成本：¥${r.totalCost.toLocaleString()}
- 总曝光：${r.totalExposure.toLocaleString()}
- 总浏览：${r.totalViews.toLocaleString()}
- 总点赞：${r.totalLikes.toLocaleString()}
- 总收藏：${r.totalSaves.toLocaleString()}
- 总评论：${r.totalComments.toLocaleString()}
- 总转发：${r.totalShares.toLocaleString()}
- 平均 CPM：¥${r.avgCpm.toFixed(2)}
- 平均 CPE：¥${r.avgCpe.toFixed(2)}
- 平均 CTR：${r.avgCtr.toFixed(2)}%
- 平均互动率：${r.avgEngagementRate.toFixed(2)}%
- 转化率：${r.conversionRate.toFixed(2)}%
`).join('\n')}

统计显著性：${(updatedResults[0]?.significanceScore ?? 0 * 100).toFixed(0)}%
胜出组：${winner.groupName}

请生成结构化分析。`

    const llmResult = await completePrompt(userPrompt, systemPrompt, {
      jsonMode: true,
      temperature: 0.5,
      maxTokens: 6000,
    })

    let winnerReason = `${winner.groupName} 组互动率最高（${winner.avgEngagementRate.toFixed(2)}%），建议作为胜出组。`
    let scaleRecommendation = '建议扩大 ${winner.groupName} 组的投放规模，逐步减少其他组预算。'

    if (llmResult.success) {
      try {
        const parsed = extractJSON(llmResult.text) as Record<string, unknown>
        winnerReason = String(parsed.winner_reason ?? winnerReason)
        scaleRecommendation = String(parsed.scale_recommendation ?? scaleRecommendation)
      } catch {
        // 使用默认值
      }
    }

    const updated = updateABTest(abTestId, {
      status: 'completed',
      winnerGroup: winner.groupName,
      winnerReason,
      scaleRecommendation,
    })

    return { success: true, result: updated ?? undefined }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { success: false, error: msg }
  }
}
