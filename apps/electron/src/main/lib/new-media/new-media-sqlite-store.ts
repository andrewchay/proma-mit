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

let database: RawDatabase | null = null
let databasePath = ''
let initialization: Promise<void> | null = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nm_schema_version (
  version INTEGER NOT NULL
);
INSERT INTO nm_schema_version (version)
SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM nm_schema_version);
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

export async function initNewMediaDb(): Promise<void> {
  if (database) return
  if (initialization) return initialization
  initialization = (async () => {
    const SQL = await initSqlJs({ locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`) })
    databasePath = join(getNewMediaDir(), 'new-media.db')
    const existing = existsSync(databasePath) ? readFileSync(databasePath) : undefined
    database = new SQL.Database(existing ? new Uint8Array(existing) : undefined) as unknown as RawDatabase
    database.exec(SCHEMA)
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
    `INSERT OR REPLACE INTO nm_record (kind, id, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [kind, value.id, JSON.stringify(value), existing ? readRecordCreatedAt(kind, value.id) : now, now],
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
        'INSERT OR REPLACE INTO nm_record (kind, id, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [kind, value.id, JSON.stringify(value), createdAt, now],
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
