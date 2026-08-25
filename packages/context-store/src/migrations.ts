import { rawChecksum, schemaChecksum } from './migration-checksum.ts'

export interface Migration {
  version: number
  name: string
  sql: string
  /**
   * 这条迁移在历史上出现过的旧 `rawChecksum`，全部已确认「只改了注释」。
   *
   * 命中的库会被就地收敛到 `schemaChecksum`，而**没登记的值仍然报错**。
   */
  legacyChecksums?: readonly string[]
}

export interface AppliedMigration {
  version: number
  name: string
  appliedAt: string
}

/**
 * 迁移系统自带的元数据表。
 *
 * 由 runMigrations 在读取已应用迁移之前独立确保存在（不依赖业务迁移去建），
 * 这样全新的空数据库首次打开时，`readApplied` 查询 schema_migrations 不会因表还
 * 不存在抛 `no such table`。V1_INIT 里也重复建它（幂等），兼容旧逻辑。
 */
const SCHEMA_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`

const V1_INIT = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_entities (
  id            TEXT PRIMARY KEY,
  entity_type   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  source_type   TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  detail        TEXT,
  content       TEXT,
  occurred_at   INTEGER NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_entities_type_time ON context_entities(entity_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_entities_source ON context_entities(source_type, source_id);

CREATE TABLE IF NOT EXISTS context_edges (
  id              TEXT PRIMARY KEY,
  from_entity_id  TEXT NOT NULL REFERENCES context_entities(id) ON DELETE CASCADE,
  to_entity_id    TEXT NOT NULL REFERENCES context_entities(id) ON DELETE CASCADE,
  relation_type   TEXT NOT NULL,
  source_run_id   TEXT,
  confidence      REAL NOT NULL DEFAULT 1.0,
  occurred_at     INTEGER NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  UNIQUE(from_entity_id, to_entity_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON context_edges(from_entity_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_edges_to ON context_edges(to_entity_id, relation_type);

CREATE TABLE IF NOT EXISTS context_facts (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT NOT NULL REFERENCES context_entities(id) ON DELETE CASCADE,
  fact_type     TEXT NOT NULL,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  source_run_id TEXT,
  confidence    REAL NOT NULL DEFAULT 1.0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_facts_entity ON context_facts(entity_id, fact_type);
`

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', sql: V1_INIT },
]

/**
 * 读取已应用的迁移。
 */
export function readApplied(database: SqlJsDatabase): Map<number, AppliedMigration & { checksum: string }> {
  const rows = safeAll(
    database,
    `SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version`,
    [],
  ) as Array<{ version: number; name: string; checksum: string; applied_at: string }>
  return new Map(rows.map((row) => [row.version, { ...row, appliedAt: row.applied_at }]))
}

/** sql.js Database 的最小使用面 */
export interface SqlJsDatabase {
  exec(sql: string): void
  prepare(sql: string): SqlJsStatement
}

export interface SqlJsStatement {
  bind(values: (string | number | null)[]): boolean
  step(): boolean
  getAsObject(): Record<string, unknown>
  free(): void
}

export function safeAll(
  database: SqlJsDatabase,
  sql: string,
  params: (string | number | null)[],
): Record<string, unknown>[] {
  const stmt = database.prepare(sql)
  try {
    stmt.bind(params)
    const rows: Record<string, unknown>[] = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    return rows
  } finally {
    stmt.free()
  }
}

export function safeRun(
  database: SqlJsDatabase,
  sql: string,
  params: (string | number | null)[],
): { changes: number } {
  const stmt = database.prepare(sql)
  try {
    stmt.bind(params)
    stmt.step()
    // sql.js 没有直接提供 getRowsModified，调用方通过 db.getRowsModified 获取
    return { changes: 0 }
  } finally {
    stmt.free()
  }
}

/**
 * 判定库里记的 checksum 与当前迁移的关系。
 *
 * 三级判据，从便宜到贵：
 *
 * ① `schemaChecksum` —— 新库写入的就是这个值，绝大多数情况在这里返回；
 * ② `rawChecksum`    —— 旧库记的是原文 hash，而原文一字未改（最常见的老库）；
 * ③ `legacyChecksums` —— 原文变过，但变的是注释。**只认显式登记过的值。**
 *
 * ③ 之所以必须是白名单而不是「算不出来就放行」：`rawChecksum` 不可逆，
 * 拿着库里那个值无法反推它当时对应的 schema。没登记 = 无从确认 = 报错。
 */
function verifyChecksum(recorded: string, migration: Migration): 'current' | 'legacy' | 'mismatch' {
  if (recorded === schemaChecksum(migration.sql)) return 'current'
  if (recorded === rawChecksum(migration.sql)) return 'legacy'
  if (migration.legacyChecksums?.includes(recorded) === true) return 'legacy'
  return 'mismatch'
}

export class MigrationError extends Error {
  public readonly version: number
  public readonly migrationName: string

  constructor(message: string, version: number, migrationName: string) {
    super(message)
    this.name = 'MigrationError'
    this.version = version
    this.migrationName = migrationName
  }
}

/**
 * 执行迁移。返回已应用的迁移列表（含本次新增）。
 * 幂等：已应用的迁移会被跳过，重复调用不产生变化。
 */
export function runMigrations(
  database: SqlJsDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
): AppliedMigration[] {
  // 确保迁移元数据表存在后再读取已应用版本（新库首次打开时表尚未建立，必须先建）。
  database.exec(SCHEMA_MIGRATIONS_TABLE)
  const applied = readApplied(database)

  // 先校验历史迁移未被篡改，再决定要不要写入。
  const converge: { version: number; name: string; from: string; to: string }[] = []
  for (const migration of migrations) {
    const record = applied.get(migration.version)
    if (record === undefined) continue
    const verdict = verifyChecksum(record.checksum, migration)
    if (verdict === 'current') continue
    if (verdict === 'legacy') {
      converge.push({
        version: migration.version,
        name: migration.name,
        from: record.checksum,
        to: schemaChecksum(migration.sql),
      })
      continue
    }
    throw new MigrationError(
      `迁移 v${migration.version}（${migration.name}）的内容与已应用版本不一致：` +
        `已发布的迁移不可修改，请追加新的迁移版本`,
      migration.version,
      migration.name,
    )
  }

  /**
   * 把仅差注释的旧记录收敛到 `schemaChecksum`。
   *
   * ★ 这不是「改库掩盖 drift」—— 能走到这里说明 schema 已被证明相同
   * （`verifyChecksum` 只对显式登记过的旧值返回 legacy）。收敛的目的是
   * 让记录落到当前判据上，否则每次启动都要再查一遍历史变体表；
   * 而真正的 drift 在上面那个 throw 就已经拦住了。
   */
  if (converge.length > 0) {
    for (const item of converge) {
      safeRun(database, `UPDATE schema_migrations SET checksum = ? WHERE version = ?`, [
        item.to,
        item.version,
      ])
    }
  }

  const pending = migrations.filter((migration) => !applied.has(migration.version))
  if (pending.length > 0) {
    database.exec('BEGIN')
    try {
      for (const migration of pending) {
        database.exec(migration.sql)
        safeRun(database, `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`, [
          migration.version,
          migration.name,
          schemaChecksum(migration.sql),
          new Date().toISOString(),
        ])
      }
      database.exec('COMMIT')
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // rollback 失败不掩盖原始错误
      }
      const detail = error instanceof Error ? error.message : String(error)
      throw new MigrationError(`数据库迁移失败：${detail}`, pending[0]?.version ?? 0, pending[0]?.name ?? '')
    }
  }

  return [...readApplied(database).entries()]
    .map(([version, record]) => ({ version, name: record.name, appliedAt: record.appliedAt }))
    .sort((left, right) => left.version - right.version)
}
