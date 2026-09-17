import initSqlJs from 'sql.js'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from '@gravitas/shared/utils/node'
import { getNewMediaDir } from '../config-paths'

interface RawDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    bind(params: unknown[]): void
    step(): boolean
    getAsObject(): Record<string, unknown>
    free(): void
  }
  export(): Uint8Array
  close(): void
}

/**
 * 新媒体领域记录类型注册表。
 *
 * 该常量是「代码与数据库一致的唯一事实来源」：既用于写入时推导记录所属域，
 * 也用于把已知 kind 播种到 nm_kind_registry 供诊断比对。
 */
export interface NewMediaKindDefinition {
  kind: string
  domain: NewMediaRecordDomain
  description: string
}

export type NewMediaRecordDomain =
  | 'content'
  | 'community'
  | 'analytics'
  | 'governance'
  | 'account'
  | 'handoff'
  | 'import'
  | 'media'
  | 'audit'
  | 'unknown'

export const NEW_MEDIA_KIND_REGISTRY: readonly NewMediaKindDefinition[] = [
  { kind: 'content-draft', domain: 'content', description: '内容草稿' },
  { kind: 'publication-job', domain: 'content', description: '发布排程任务' },
  { kind: 'engagement', domain: 'community', description: '互动条目' },
  { kind: 'reply-draft', domain: 'community', description: '回复草稿' },
  { kind: 'listening-query', domain: 'community', description: '聆听任务' },
  { kind: 'mention', domain: 'community', description: '提及记录' },
  { kind: 'metric-snapshot', domain: 'analytics', description: '指标快照' },
  { kind: 'trend-item', domain: 'analytics', description: '热点条目' },
  { kind: 'controlled-action', domain: 'governance', description: '受控外发动作' },
  { kind: 'controlled-action-audit', domain: 'audit', description: '受控外发审计' },
  { kind: 'connected-account', domain: 'account', description: '已连接账号元数据' },
  { kind: 'account-audit', domain: 'audit', description: '账号授权审计' },
  { kind: 'xiaohongshu-handoff', domain: 'handoff', description: '小红书发布交接' },
  { kind: 'xiaohongshu-handoff-audit', domain: 'audit', description: '小红书交接审计（历史）' },
  { kind: 'new-media-audit', domain: 'audit', description: '统一审计事件' },
  { kind: 'report-import-batch', domain: 'import', description: '报表导入批次' },
  { kind: 'report-import-row', domain: 'import', description: '报表导入明细行' },
  { kind: 'wechat-media-asset', domain: 'media', description: '微信公众号素材资产' },
  { kind: 'wechat-draft', domain: 'content', description: '微信公众号草稿映射' },
]

const KIND_TO_DOMAIN = new Map(NEW_MEDIA_KIND_REGISTRY.map((entry) => [entry.kind, entry.domain]))

export function resolveNewMediaRecordDomain(kind: string): NewMediaRecordDomain {
  return KIND_TO_DOMAIN.get(kind) ?? 'unknown'
}

/** 迁移定义：up 正向升级，down 用于回滚到上一版本。 */
interface NewMediaMigration {
  version: number
  description: string
  up: string[]
  down: string[]
}

const BASE_RECORD_TABLE = `
CREATE TABLE IF NOT EXISTS nm_record (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS idx_nm_record_kind_created
ON nm_record(kind, created_at DESC);
`

const KIND_REGISTRY_SEED = NEW_MEDIA_KIND_REGISTRY
  .map((entry) => `INSERT OR REPLACE INTO nm_kind_registry (kind, domain, description) VALUES ('${entry.kind}', '${entry.domain}', '${entry.description}');`)
  .join('\n')

const MIGRATIONS: readonly NewMediaMigration[] = [
  {
    version: 1,
    description: '基础记录表与 kind 查询索引',
    up: [BASE_RECORD_TABLE],
    // v1 是最早发布的结构，回滚到 v0 等价于清空领域数据，因此不再提供破坏性 down。
    down: [],
  },
  {
    version: 2,
    description: '引入域列、kind 注册表与域级索引',
    up: [
      `ALTER TABLE nm_record ADD COLUMN domain TEXT NOT NULL DEFAULT 'unknown';`,
      `CREATE TABLE IF NOT EXISTS nm_kind_registry (
        kind TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        description TEXT NOT NULL
      );`,
      KIND_REGISTRY_SEED,
      `UPDATE nm_record SET domain = COALESCE(
        (SELECT domain FROM nm_kind_registry WHERE nm_kind_registry.kind = nm_record.kind),
        'unknown'
      );`,
      `CREATE INDEX IF NOT EXISTS idx_nm_record_kind_updated ON nm_record(kind, updated_at DESC);`,
      `CREATE INDEX IF NOT EXISTS idx_nm_record_domain_created ON nm_record(domain, created_at DESC);`,
    ],
    down: [
      `DROP INDEX IF EXISTS idx_nm_record_domain_created;`,
      `DROP INDEX IF EXISTS idx_nm_record_kind_updated;`,
      `DROP TABLE IF EXISTS nm_kind_registry;`,
      // SQLite 早期版本不支持 DROP COLUMN，改用重建表并保留业务数据。
      `CREATE TABLE nm_record_v1 (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (kind, id)
      );`,
      `INSERT INTO nm_record_v1 (kind, id, payload, created_at, updated_at)
        SELECT kind, id, payload, created_at, updated_at FROM nm_record;`,
      `DROP TABLE nm_record;`,
      `ALTER TABLE nm_record_v1 RENAME TO nm_record;`,
      `CREATE INDEX IF NOT EXISTS idx_nm_record_kind_created ON nm_record(kind, created_at DESC);`,
    ],
  },
  {
    version: 3,
    description: '同步 kind 注册表以纳入报表导入记录（后续同步改由 syncKindRegistry 派生）',
    up: [
      `DELETE FROM nm_kind_registry;`,
      KIND_REGISTRY_SEED,
      `UPDATE nm_record SET domain = COALESCE(
        (SELECT domain FROM nm_kind_registry WHERE nm_kind_registry.kind = nm_record.kind),
        'unknown'
      );`,
    ],
    down: [
      `DELETE FROM nm_kind_registry WHERE kind IN ('report-import-batch', 'report-import-row', 'new-media-audit');`,
      `UPDATE nm_record SET domain = 'unknown' WHERE domain = 'import';`,
    ],
  },
]

export const CURRENT_NEW_MEDIA_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 1

const FRAMEWORK_SCHEMA = `
CREATE TABLE IF NOT EXISTS nm_schema_version (
  version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nm_migration_log (
  version INTEGER NOT NULL,
  direction TEXT NOT NULL,
  description TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (version, direction, applied_at)
);
`

let database: RawDatabase | null = null
let databasePath = ''
let initialization: Promise<void> | null = null

function ensureFrameworkTables(db: RawDatabase): void {
  db.exec(FRAMEWORK_SCHEMA)
  const statement = db.prepare('SELECT COUNT(*) AS total FROM nm_schema_version')
  let total = 0
  try {
    if (statement.step()) total = Number(statement.getAsObject().total)
  } finally {
    statement.free()
  }
  if (total === 0) {
    db.exec('INSERT INTO nm_schema_version (version) VALUES (0);')
    return
  }
  // 历史实现可能写入多行版本号，这里收敛为单行最大值。
  const maxStatement = db.prepare('SELECT MAX(version) AS version FROM nm_schema_version')
  let version = 0
  try {
    if (maxStatement.step()) version = Number(maxStatement.getAsObject().version)
  } finally {
    maxStatement.free()
  }
  db.exec('DELETE FROM nm_schema_version;')
  db.exec(`INSERT INTO nm_schema_version (version) VALUES (${version});`)
}

function tableExists(db: RawDatabase, name: string): boolean {
  const escaped = name.replace(/'/g, "''")
  const statement = db.prepare(`SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = '${escaped}'`)
  try {
    return statement.step() ? Number(statement.getAsObject().total) > 0 : false
  } finally {
    statement.free()
  }
}

function readSchemaVersion(db: RawDatabase): number {
  const statement = db.prepare('SELECT version FROM nm_schema_version LIMIT 1')
  try {
    return statement.step() ? Number(statement.getAsObject().version) : 0
  } finally {
    statement.free()
  }
}

function writeSchemaVersion(db: RawDatabase, version: number): void {
  db.exec('DELETE FROM nm_schema_version;')
  db.exec(`INSERT INTO nm_schema_version (version) VALUES (${version});`)
}

function logMigration(db: RawDatabase, migration: NewMediaMigration, direction: 'up' | 'down'): void {
  const escaped = migration.description.replace(/'/g, "''")
  db.exec(`INSERT INTO nm_migration_log (version, direction, description, applied_at) VALUES (${migration.version}, '${direction}', '${escaped}', ${Date.now()});`)
}

/**
 * 同步 kind 注册表。
 *
 * 注册表只描述「某个 kind 属于哪个域」，是从代码常量派生的数据，不是结构变更。
 * 因此它在每次打开数据库时重新同步，新增记录类型不需要再发一次迁移；
 * schema 版本只跟踪表结构、列与索引的变化。
 */
function syncKindRegistry(db: RawDatabase): void {
  db.exec('BEGIN IMMEDIATE;')
  try {
    db.exec('DELETE FROM nm_kind_registry;')
    db.exec(KIND_REGISTRY_SEED)
    // 回填域：未登记的 kind 归入 unknown，便于诊断而不是静默丢弃。
    db.exec(`UPDATE nm_record SET domain = COALESCE(
      (SELECT domain FROM nm_kind_registry WHERE nm_kind_registry.kind = nm_record.kind),
      'unknown'
    );`)
    db.exec('COMMIT;')
  } catch (error) {
    db.exec('ROLLBACK;')
    throw new Error(`新媒体 kind 注册表同步失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 执行升/降级迁移，每个版本在独立事务内完成，失败即整体回滚。
 * 返回实际执行过的迁移版本列表。
 */
export function migrateNewMediaDb(targetVersion: number = CURRENT_NEW_MEDIA_SCHEMA_VERSION): number[] {
  const db = requireDb()
  const current = readSchemaVersion(db)
  const executed: number[] = []

  if (targetVersion > current) {
    for (const migration of MIGRATIONS) {
      if (migration.version <= current || migration.version > targetVersion) continue
      db.exec('BEGIN IMMEDIATE;')
      try {
        for (const sql of migration.up) db.exec(sql)
        logMigration(db, migration, 'up')
        writeSchemaVersion(db, migration.version)
        db.exec('COMMIT;')
      } catch (error) {
        db.exec('ROLLBACK;')
        throw new Error(`新媒体数据库迁移到 v${migration.version} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
      executed.push(migration.version)
    }
  } else if (targetVersion < current) {
    for (const migration of [...MIGRATIONS].reverse()) {
      if (migration.version <= targetVersion || migration.version > current) continue
      if (migration.down.length === 0) throw new Error(`新媒体数据库 v${migration.version} 未提供回滚语句，拒绝降级`)
      db.exec('BEGIN IMMEDIATE;')
      try {
        for (const sql of migration.down) db.exec(sql)
        logMigration(db, migration, 'down')
        writeSchemaVersion(db, migration.version - 1)
        db.exec('COMMIT;')
      } catch (error) {
        db.exec('ROLLBACK;')
        throw new Error(`新媒体数据库回滚到 v${migration.version - 1} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
      executed.push(migration.version)
    }
  }

  if (executed.length > 0) persist()
  return executed
}

export interface NewMediaSchemaInfo {
  version: number
  currentVersion: number
  rollbackAvailable: boolean
  appliedMigrations: Array<{ version: number; direction: string; description: string; appliedAt: number }>
  registeredKinds: Array<{ kind: string; domain: string; description: string }>
  unknownKinds: string[]
}

export async function getNewMediaSchemaInfo(): Promise<NewMediaSchemaInfo> {
  await initNewMediaDb()
  const db = requireDb()
  const applied: NewMediaSchemaInfo['appliedMigrations'] = []
  const logStatement = db.prepare('SELECT version, direction, description, applied_at FROM nm_migration_log ORDER BY applied_at ASC')
  try {
    while (logStatement.step()) {
      const row = logStatement.getAsObject()
      applied.push({
        version: Number(row.version),
        direction: String(row.direction),
        description: String(row.description),
        appliedAt: Number(row.applied_at),
      })
    }
  } finally {
    logStatement.free()
  }

  const registered: NewMediaSchemaInfo['registeredKinds'] = []
  // 回滚到 v1 时注册表尚不存在，此处必须容忍旧版本结构。
  if (tableExists(db, 'nm_kind_registry')) {
    const kindStatement = db.prepare('SELECT kind, domain, description FROM nm_kind_registry ORDER BY kind ASC')
    try {
      while (kindStatement.step()) {
        const row = kindStatement.getAsObject()
        registered.push({ kind: String(row.kind), domain: String(row.domain), description: String(row.description) })
      }
    } finally {
      kindStatement.free()
    }
  }

  const unknown: string[] = []
  if (tableExists(db, 'nm_kind_registry') && tableExists(db, 'nm_record')) {
    const unknownStatement = db.prepare(
      `SELECT DISTINCT kind FROM nm_record
       WHERE kind NOT IN (SELECT kind FROM nm_kind_registry)
       ORDER BY kind ASC`,
    )
    try {
      while (unknownStatement.step()) unknown.push(String(unknownStatement.getAsObject().kind))
    } finally {
      unknownStatement.free()
    }
  }

  const version = readSchemaVersion(db)
  return {
    version,
    currentVersion: CURRENT_NEW_MEDIA_SCHEMA_VERSION,
    rollbackAvailable: MIGRATIONS.some((migration) => migration.version <= version && migration.down.length > 0),
    appliedMigrations: applied,
    registeredKinds: registered,
    unknownKinds: unknown,
  }
}

export async function initNewMediaDb(): Promise<void> {
  if (database) return
  if (initialization) return initialization
  initialization = (async () => {
    const SQL = await initSqlJs({ locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`) })
    databasePath = join(getNewMediaDir(), 'new-media.db')
    const existing = existsSync(databasePath) ? readFileSync(databasePath) : undefined
    database = new SQL.Database(existing ? new Uint8Array(existing) : undefined) as unknown as RawDatabase
    ensureFrameworkTables(database)
    migrateNewMediaDb()
    syncKindRegistry(database)
    persist()
  })()
  try {
    await initialization
  } catch (error) {
    initialization = null
    database = null
    throw error
  }
}

function requireDb(): RawDatabase {
  if (!database) throw new Error('新媒体数据库未初始化')
  return database
}

function persist(): void {
  if (!database || !databasePath) return
  writeFileAtomic(databasePath, database.export())
}

function run(sql: string, params: unknown[]): void {
  const statement = requireDb().prepare(sql)
  try {
    statement.bind(params)
    statement.step()
  } finally {
    statement.free()
  }
}

export async function putNewMediaRecord<T extends { id: string }>(kind: string, value: T): Promise<T> {
  await initNewMediaDb()
  const now = Date.now()
  const existing = await getNewMediaRecord<T>(kind, value.id)
  run(
    `INSERT OR REPLACE INTO nm_record (kind, id, payload, created_at, updated_at, domain) VALUES (?, ?, ?, ?, ?, ?)`,
    [kind, value.id, JSON.stringify(value), existing ? readRecordCreatedAt(kind, value.id) : now, now, resolveNewMediaRecordDomain(kind)],
  )
  persist()
  return value
}

function readRecordCreatedAt(kind: string, id: string): number {
  const statement = requireDb().prepare('SELECT created_at FROM nm_record WHERE kind = ? AND id = ?')
  try {
    statement.bind([kind, id])
    return statement.step() ? Number(statement.getAsObject().created_at) : Date.now()
  } finally {
    statement.free()
  }
}

export async function putNewMediaRecords(records: Array<{ kind: string; value: { id: string } }>): Promise<void> {
  await initNewMediaDb()
  const db = requireDb()
  const now = Date.now()
  db.exec('BEGIN IMMEDIATE;')
  try {
    for (const { kind, value } of records) {
      const createdAt = readRecordCreatedAt(kind, value.id)
      run(
        'INSERT OR REPLACE INTO nm_record (kind, id, payload, created_at, updated_at, domain) VALUES (?, ?, ?, ?, ?, ?)',
        [kind, value.id, JSON.stringify(value), createdAt, now, resolveNewMediaRecordDomain(kind)],
      )
    }
    db.exec('COMMIT;')
    persist()
  } catch (error) {
    db.exec('ROLLBACK;')
    throw error
  }
}

export async function getNewMediaRecord<T>(kind: string, id: string): Promise<T | undefined> {
  await initNewMediaDb()
  const statement = requireDb().prepare('SELECT payload FROM nm_record WHERE kind = ? AND id = ?')
  try {
    statement.bind([kind, id])
    if (!statement.step()) return undefined
    return JSON.parse(String(statement.getAsObject().payload)) as T
  } finally {
    statement.free()
  }
}

export async function listNewMediaRecords<T>(kind: string): Promise<T[]> {
  await initNewMediaDb()
  const statement = requireDb().prepare('SELECT payload FROM nm_record WHERE kind = ? ORDER BY created_at DESC')
  const values: T[] = []
  try {
    statement.bind([kind])
    while (statement.step()) values.push(JSON.parse(String(statement.getAsObject().payload)) as T)
    return values
  } finally {
    statement.free()
  }
}

export async function listNewMediaRecordsByDomain<T>(domain: NewMediaRecordDomain): Promise<T[]> {
  await initNewMediaDb()
  const statement = requireDb().prepare('SELECT payload FROM nm_record WHERE domain = ? ORDER BY created_at DESC')
  const values: T[] = []
  try {
    statement.bind([domain])
    while (statement.step()) values.push(JSON.parse(String(statement.getAsObject().payload)) as T)
    return values
  } finally {
    statement.free()
  }
}

export async function deleteNewMediaRecord(kind: string, id: string): Promise<boolean> {
  await initNewMediaDb()
  const existing = await getNewMediaRecord(kind, id)
  if (!existing) return false
  run('DELETE FROM nm_record WHERE kind = ? AND id = ?', [kind, id])
  persist()
  return true
}

export async function clearNewMediaRecordsForTests(): Promise<void> {
  await initNewMediaDb()
  requireDb().exec('DELETE FROM nm_record;')
  persist()
}

export function closeNewMediaDb(): void {
  if (database) {
    persist()
    database.close()
  }
  database = null
  databasePath = ''
  initialization = null
}
