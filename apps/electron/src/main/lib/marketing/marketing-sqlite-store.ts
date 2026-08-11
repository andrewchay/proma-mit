/**
 * 营销领域包 SQLite 数据层 — Marketing SQLite Store
 *
 * 方案 v4：共享素材(creative) + 达人(influencer) + 广告投放(paid-media) 三个子域。
 * 本地 SQLite（sql.js）承载，复用现有 project-sqlite-store 模式。
 * 表结构预留 tenant_id/user_id 列，未来切 Postgres 多租户可直接复用。
 *
 * M0 骨架：建表 + 基础 CRUD，支撑后续 M1/M2 扩展。
 */

import { randomUUID } from 'node:crypto'
import initSqlJs from 'sql.js'
import { getMarketingDir } from '../config-paths'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type {
  InfluencerTalent,
  InfluencerBrief,
  InfluencerDraft,
  PaidCampaign,
  PaidControlAction,
  PaidRule,
  CreativeProject,
  CreativeAsset,
} from '@gravitas/shared'

// ===== 轻量 sql.js 封装（prepare().get/all/run + persist） =====

type Row = Record<string, unknown>

interface Stmt {
  get(...params: unknown[]): Row | undefined
  all(...params: unknown[]): Row[]
  run(...params: unknown[]): unknown
}

interface Compat {
  prepare(sql: string): Stmt
  run(sql: string, ...params: unknown[]): unknown
  get(sql: string, ...params: unknown[]): Row | undefined
  all(sql: string, ...params: unknown[]): Row[]
  persist(): void
  close(): void
  exec(sql: string): void
}

let db: Compat | null = null
let sqlJsPromise: Promise<unknown> | null = null
let dbReady = false
let dbInitPromise: Promise<void> | null = null

function loadSqlJs(): Promise<unknown> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`),
    })
  }
  return sqlJsPromise
}

function throwIfNotReady(): void {
  if (!dbReady) throw new Error('营销数据库未初始化，请先调用 initMarketingDb()')
}

/** 获取（或初始化）营销数据库 */
export function getMarketingDb(): Compat {
  if (db) return db
  throwIfNotReady()
  return db!
}

/** 异步初始化营销数据库（订阅 influencer/paid-media 时惰性调用） */
export async function initMarketingDb(): Promise<void> {
  if (dbReady) return
  if (dbInitPromise) return dbInitPromise
  dbInitPromise = (async () => {
    const SQL = (await loadSqlJs()) as {
      Database: new (data?: Uint8Array) => {
        exec(sql: string): void
        prepare(sql: string): Stmt
        close(): void
        export(): Uint8Array
      }
    }
    const dir = getMarketingDir()
    const dbPath = join(dir, 'marketing.db')
    const existing = existsSync(dbPath) ? readFileSync(dbPath) : undefined
    const raw = new SQL.Database(existing as Uint8Array | undefined)
    raw.exec(SCHEMA_SQL)
    db = wrap(raw, dbPath)
    dbReady = true
  })()
  await dbInitPromise
}

interface RawDatabase {
  exec(sql: string): void
  prepare(sql: string): Stmt
  close(): void
  export(): Uint8Array
}

function bindParams(stmt: Stmt, params: unknown[]): void {
  if (params.length === 0) return
  // sql.js Statement.bind 接受数组
  ;(stmt as unknown as { bind(p: unknown[]): unknown }).bind(params)
}

function wrap(raw: RawDatabase, dbPath: string): Compat {
  const prepareStmt = (sql: string): Stmt => raw.prepare(sql)
  return {
    prepare: prepareStmt,
    run(sql: string, ...params: unknown[]) {
      const stmt = prepareStmt(sql)
      try {
        bindParams(stmt, params)
        ;(stmt as unknown as { step(): boolean }).step()
      } finally {
        ;(stmt as unknown as { free(): void }).free()
      }
    },
    get(sql: string, ...params: unknown[]) {
      const stmt = prepareStmt(sql)
      try {
        bindParams(stmt, params)
        const has = (stmt as unknown as { step(): boolean }).step()
        if (!has) return undefined
        return camelizeRow((stmt as unknown as { getAsObject(): Row }).getAsObject())
      } finally {
        ;(stmt as unknown as { free(): void }).free()
      }
    },
    all(sql: string, ...params: unknown[]) {
      const stmt = prepareStmt(sql)
      const rows: Row[] = []
      try {
        bindParams(stmt, params)
        const s = stmt as unknown as { step(): boolean; getAsObject(): Row }
        while (s.step()) rows.push(camelizeRow(s.getAsObject()))
        return rows
      } finally {
        ;(stmt as unknown as { free(): void }).free()
      }
    },
    persist() {
      const data = raw.export()
      writeFileSync(dbPath, Buffer.from(data))
    },
    close() {
      raw.export()
      raw.close()
    },
    exec(sql: string) {
      raw.exec(sql)
    },
  }
}

/** 关闭营销数据库（测试/退出时调用） */
export function closeMarketingDb(): void {
  if (db) {
    db.persist()
    db.close()
    db = null
    dbReady = false
    dbInitPromise = null
  }
  sqlJsPromise = null
}

// ===== 建表 Schema =====

const SCHEMA_SQL = `
-- 共享素材：creative
CREATE TABLE IF NOT EXISTS creative_project (
  id TEXT PRIMARY KEY,
  client TEXT DEFAULT 'general',
  name TEXT NOT NULL,
  version TEXT,
  tags TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS creative_asset (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  media TEXT NOT NULL,
  platform TEXT,
  resolution TEXT,
  status TEXT DEFAULT 'ready',
  created_at TEXT DEFAULT (datetime('now'))
);

-- 达人包：influencer
CREATE TABLE IF NOT EXISTS influencer_talent (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  handle TEXT,
  region TEXT,
  tags TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS influencer_brief (
  id TEXT PRIMARY KEY,
  talent_id TEXT NOT NULL,
  version TEXT,
  product TEXT,
  direction TEXT,
  accept TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS influencer_draft (
  id TEXT PRIMARY KEY,
  brief_id TEXT NOT NULL,
  talent_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  draft_type TEXT NOT NULL,
  review_card TEXT DEFAULT 'green',
  review_detail TEXT,
  status TEXT DEFAULT 'submitted',
  reviewer TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 投放包：paid-media
CREATE TABLE IF NOT EXISTS paid_campaign (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  channel TEXT,
  region TEXT,
  platform TEXT,
  ad_type TEXT,
  deliver_target TEXT,
  budget_day REAL,
  budget_status TEXT DEFAULT 'pending',
  status TEXT DEFAULT 'draft',
  goal_roi REAL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS paid_control_action (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  detail TEXT,
  status TEXT DEFAULT 'pending',
  reviewer TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS paid_rule (
  id TEXT PRIMARY KEY,
  channel TEXT,
  kind TEXT DEFAULT 'business',
  name TEXT NOT NULL,
  params TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
`

// ===== 行→对象映射辅助 =====

/** snake_case 键 → camelCase（SQLite 列名 → TS 接口字段） */
function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_m, c) => c.toUpperCase()).replace(/^(.)/, (_m, c) => c.toLowerCase())
}

/** 把行的键名从 snake_case 转为 camelCase */
function camelizeRow(row: Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) out[snakeToCamel(k)] = v
  return out
}

function rowTo<T>(r: Row | undefined): T | null {
  return r ? (camelizeRow(r) as unknown as T) : null
}

// ============================================
// 1. 共享素材 Creative
// ============================================

export function listCreativeProjects(): CreativeProject[] {
  const d = getMarketingDb()
  return d.all('SELECT * FROM creative_project ORDER BY created_at DESC') as unknown as CreativeProject[]
}

export function createCreativeProject(input: Omit<CreativeProject, 'id' | 'createdAt' | 'updatedAt'>): CreativeProject {
  const d = getMarketingDb()
  const id = randomUUID()
  d.run(
    'INSERT INTO creative_project (id, client, name, version, tags) VALUES (?, ?, ?, ?, ?)',
    id,
    input.client,
    input.name,
    input.version ?? null,
    input.tags ? JSON.stringify(input.tags) : null
  )
  d.persist()
  const row = d.get('SELECT * FROM creative_project WHERE id = ?', id)
  return rowTo<CreativeProject>(row)!
}

export function listCreativeAssets(): CreativeAsset[] {
  const d = getMarketingDb()
  return d.all('SELECT * FROM creative_asset ORDER BY created_at DESC') as unknown as CreativeAsset[]
}

export function createCreativeAsset(input: Omit<CreativeAsset, 'id' | 'createdAt'>): CreativeAsset {
  const d = getMarketingDb()
  const id = randomUUID()
  d.run(
    'INSERT INTO creative_asset (id, project_id, media, platform, resolution, status) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    input.projectId ?? null,
    input.media,
    input.platform ?? null,
    input.resolution ?? null,
    input.status
  )
  d.persist()
  const row = d.get('SELECT * FROM creative_asset WHERE id = ?', id)
  return rowTo<CreativeAsset>(row)!
}

export function deleteCreativeAsset(id: string): void {
  const d = getMarketingDb()
  d.run('DELETE FROM creative_asset WHERE id = ?', id)
  d.persist()
}

export function renameCreativeAsset(id: string, name: string): void {
  // 素材成品以文件形式管理（M1 起接入视频库）；此处占位，随 M1 补全.
  void id
  void name
}

// ============================================
// 2. 达人 influencer
// ============================================

export function listInfluencerTalents(): InfluencerTalent[] {
  const d = getMarketingDb()
  return d.all('SELECT * FROM influencer_talent ORDER BY created_at DESC') as unknown as InfluencerTalent[]
}

export function getInfluencerTalent(id: string): InfluencerTalent | null {
  const d = getMarketingDb()
  const row = d.get('SELECT * FROM influencer_talent WHERE id = ?', id)
  return rowTo<InfluencerTalent>(row)
}

export function createInfluencerTalent(input: Omit<InfluencerTalent, 'id' | 'createdAt' | 'updatedAt'>): InfluencerTalent {
  const d = getMarketingDb()
  const id = randomUUID()
  d.run(
    'INSERT INTO influencer_talent (id, name, platform, handle, region, tags, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    input.name,
    input.platform,
    input.handle ?? null,
    input.region ?? null,
    input.tags ? JSON.stringify(input.tags) : null,
    input.status
  )
  d.persist()
  const row = d.get('SELECT * FROM influencer_talent WHERE id = ?', id)
  return rowTo<InfluencerTalent>(row)!
}

export function updateInfluencerTalent(id: string, patch: Partial<Omit<InfluencerTalent, 'id' | 'createdAt'>>): InfluencerTalent | null {
  const d = getMarketingDb()
  const existing = getInfluencerTalent(id)
  if (!existing) return null
  d.run(
    `UPDATE influencer_talent SET name=?, platform=?, handle=?, region=?, tags=?, status=?, updated_at=datetime('now') WHERE id=?`,
    patch.name ?? existing.name,
    patch.platform ?? existing.platform,
    patch.handle ?? existing.handle,
    patch.region ?? existing.region,
    patch.tags ? JSON.stringify(patch.tags) : JSON.stringify(existing.tags ?? []),
    patch.status ?? existing.status,
    id
  )
  d.persist()
  return getInfluencerTalent(id)
}

export function deleteInfluencerTalent(id: string): void {
  const d = getMarketingDb()
  d.run('DELETE FROM influencer_talent WHERE id = ?', id)
  d.persist()
}

// ===== 达人 brief =====

export function listInfluencerBriefs(): InfluencerBrief[] {
  const d = getMarketingDb()
  return d.all('SELECT * FROM influencer_brief ORDER BY created_at DESC') as unknown as InfluencerBrief[]
}

export function createInfluencerBrief(input: Omit<InfluencerBrief, 'id' | 'createdAt' | 'updatedAt'>): InfluencerBrief {
  const d = getMarketingDb()
  const id = randomUUID()
  d.run(
    'INSERT INTO influencer_brief (id, talent_id, version, product, direction, accept) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    input.talentId,
    input.version ?? null,
    input.product,
    input.direction ? JSON.stringify(input.direction) : null,
    input.accept
  )
  d.persist()
  const row = d.get('SELECT * FROM influencer_brief WHERE id = ?', id)
  return rowTo<InfluencerBrief>(row)!
}

// ===== 达人稿件（三态审核）=====

export function listInfluencerDrafts(): InfluencerDraft[] {
  const d = getMarketingDb()
  return d.all('SELECT * FROM influencer_draft ORDER BY created_at DESC') as unknown as InfluencerDraft[]
}

export function getInfluencerDraft(id: string): InfluencerDraft | null {
  const d = getMarketingDb()
  const row = d.get('SELECT * FROM influencer_draft WHERE id = ?', id)
  return rowTo<InfluencerDraft>(row)
}

export function createInfluencerDraft(input: Omit<InfluencerDraft, 'id' | 'createdAt' | 'updatedAt'>): InfluencerDraft {
  const d = getMarketingDb()
  const id = randomUUID()
  d.run(
    `INSERT INTO influencer_draft (id, brief_id, talent_id, source, source_ref, draft_type, review_card, review_detail, status, reviewer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.briefId,
    input.talentId,
    input.source,
    input.sourceRef ?? null,
    input.draftType,
    input.reviewCard,
    input.reviewDetail ? JSON.stringify(input.reviewDetail) : null,
    input.status,
    input.reviewer ?? null
  )
  d.persist()
  const row = d.get('SELECT * FROM influencer_draft WHERE id = ?', id)
  return rowTo<InfluencerDraft>(row)!
}

export function updateInfluencerDraft(id: string, patch: Partial<Omit<InfluencerDraft, 'id' | 'createdAt'>>): InfluencerDraft | null {
  const d = getMarketingDb()
  const existing = getInfluencerDraft(id)
  if (!existing) return null
  d.run(
    `UPDATE influencer_draft SET draft_type=?, review_card=?, status=?, reviewer=?, updated_at=datetime('now') WHERE id=?`,
    patch.draftType ?? existing.draftType,
    patch.reviewCard ?? existing.reviewCard,
    patch.status ?? existing.status,
    patch.reviewer ?? existing.reviewer,
    id
  )
  d.persist()
  return getInfluencerDraft(id)
}

export function deleteInfluencerDraft(id: string): void {
  const d = getMarketingDb()
  d.run('DELETE FROM influencer_draft WHERE id = ?', id)
  d.persist()
}

// ============================================
// 3. 广告投放 paid-media
// ============================================

export function listPaidCampaigns(): PaidCampaign[] {
  const d = getMarketingDb()
  return d.all('SELECT * FROM paid_campaign ORDER BY created_at DESC') as unknown as PaidCampaign[]
}

export function getPaidCampaign(id: string): PaidCampaign | null {
  const d = getMarketingDb()
  const row = d.get('SELECT * FROM paid_campaign WHERE id = ?', id)
  return rowTo<PaidCampaign>(row)
}

export function createPaidCampaign(input: Omit<PaidCampaign, 'id' | 'createdAt' | 'updatedAt'>): PaidCampaign {
  const d = getMarketingDb()
  const id = randomUUID()
  d.run(
    `INSERT INTO paid_campaign (id, name, channel, region, platform, ad_type, deliver_target, budget_day, budget_status, status, goal_roi)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name,
    input.channel ?? null,
    input.region ?? null,
    input.platform ?? null,
    input.adType ?? null,
    input.deliverTarget ?? null,
    input.budgetDay ?? null,
    input.budgetStatus,
    input.status,
    input.goalRoi ?? null
  )
  d.persist()
  const row = d.get('SELECT * FROM paid_campaign WHERE id = ?', id)
  return rowTo<PaidCampaign>(row)!
}

export function updatePaidCampaign(id: string, patch: Partial<Omit<PaidCampaign, 'id' | 'createdAt'>>): PaidCampaign | null {
  const d = getMarketingDb()
  const existing = getPaidCampaign(id)
  if (!existing) return null
  d.run(
    `UPDATE paid_campaign SET name=?, channel=?, region=?, platform=?, ad_type=?, deliver_target=?, budget_day=?, budget_status=?, status=?, goal_roi=?, updated_at=datetime('now') WHERE id=?`,
    patch.name ?? existing.name,
    patch.channel ?? existing.channel,
    patch.region ?? existing.region,
    patch.platform ?? existing.platform,
    patch.adType ?? existing.adType,
    patch.deliverTarget ?? existing.deliverTarget,
    patch.budgetDay ?? existing.budgetDay,
    patch.budgetStatus ?? existing.budgetStatus,
    patch.status ?? existing.status,
    patch.goalRoi ?? existing.goalRoi,
    id
  )
  d.persist()
  return getPaidCampaign(id)
}

export function deletePaidCampaign(id: string): void {
  const d = getMarketingDb()
  d.run('DELETE FROM paid_campaign WHERE id = ?', id)
  d.persist()
}

export function listPaidControlActions(): PaidControlAction[] {
  const d = getMarketingDb()
  return d.all('SELECT * FROM paid_control_action ORDER BY created_at DESC') as unknown as PaidControlAction[]
}

export function createPaidControlAction(input: Omit<PaidControlAction, 'id' | 'createdAt' | 'updatedAt'>): PaidControlAction {
  const d = getMarketingDb()
  const id = randomUUID()
  d.run(
    `INSERT INTO paid_control_action (id, campaign_id, action_type, detail, status, reviewer) VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    input.campaignId,
    input.actionType,
    input.detail ? JSON.stringify(input.detail) : null,
    input.status,
    input.reviewer ?? null
  )
  d.persist()
  const row = d.get('SELECT * FROM paid_control_action WHERE id = ?', id)
  return rowTo<PaidControlAction>(row)!
}

export function updatePaidControlAction(
  id: string,
  patch: Partial<Omit<PaidControlAction, 'id' | 'createdAt'>>,
): PaidControlAction | null {
  const d = getMarketingDb()
  const existing = d.get('SELECT * FROM paid_control_action WHERE id = ?', id)
  if (!existing) return null
  const cur = existing as unknown as PaidControlAction
  const nextStatus = (patch.status as PaidControlAction['status']) ?? cur.status
  const nextReviewer = patch.reviewer ?? cur.reviewer
  d.run(
    `UPDATE paid_control_action SET status=?, reviewer=?, updated_at=datetime('now') WHERE id=?`,
    nextStatus,
    nextReviewer,
    id
  )
  d.persist()
  const row = d.get('SELECT * FROM paid_control_action WHERE id = ?', id)
  return rowTo<PaidControlAction>(row)
}

export function listPaidRules(): PaidRule[] {
  const d = getMarketingDb()
  return d.all('SELECT * FROM paid_rule ORDER BY created_at') as unknown as PaidRule[]
}

export function createPaidRule(input: Omit<PaidRule, 'id' | 'updatedAt'>): PaidRule {
  const d = getMarketingDb()
  const id = randomUUID()
  d.run(
    'INSERT INTO paid_rule (id, channel, kind, name, params, enabled) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    input.channel ?? null,
    input.kind,
    input.name,
    input.params ? JSON.stringify(input.params) : null,
    input.enabled ? 1 : 0
  )
  d.persist()
  const row = d.get('SELECT * FROM paid_rule WHERE id = ?', id)
  return rowTo<PaidRule>(row)!
}

export function updatePaidRule(id: string, patch: Partial<Omit<PaidRule, 'id'>>): PaidRule | null {
  const d = getMarketingDb()
  d.run(
    `UPDATE paid_rule SET channel=?, kind=?, name=?, params=?, enabled=?, updated_at=datetime('now') WHERE id=?`,
    patch.channel ?? null,
    patch.kind ?? 'business',
    patch.name ?? '',
    patch.params ? JSON.stringify(patch.params) : null,
    patch.enabled === undefined ? 1 : patch.enabled ? 1 : 0,
    id
  )
  d.persist()
  const row = d.get('SELECT * FROM paid_rule WHERE id = ?', id)
  return rowTo<PaidRule>(row)!
}
