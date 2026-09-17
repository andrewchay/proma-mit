import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import initSqlJs from 'sql.js'
import {
  CURRENT_NEW_MEDIA_SCHEMA_VERSION,
  clearNewMediaRecordsForTests,
  closeNewMediaDb,
  getNewMediaRecord,
  getNewMediaSchemaInfo,
  initNewMediaDb,
  listNewMediaRecordsByDomain,
  putNewMediaRecord,
  migrateNewMediaDb,
  resolveNewMediaRecordDomain,
} from './new-media-sqlite-store'

let testDir = ''
const dbPath = (): string => join(testDir, 'new-media', 'new-media.db')

beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-nm-schema-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { await clearNewMediaRecordsForTests() })
afterAll(() => { closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

/** 构造一个仅含 v1 结构的历史数据库。 */
async function writeLegacyV1Database(): Promise<void> {
  closeNewMediaDb()
  mkdirSync(join(testDir, 'new-media'), { recursive: true })
  const SQL = await initSqlJs({ locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`) })
  const db = new SQL.Database()
  db.exec(`
    CREATE TABLE nm_schema_version (version INTEGER NOT NULL);
    INSERT INTO nm_schema_version (version) VALUES (1);
    CREATE TABLE nm_record (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (kind, id)
    );
    CREATE INDEX idx_nm_record_kind_created ON nm_record(kind, created_at DESC);
  `)
  db.run(
    'INSERT INTO nm_record (kind, id, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['content-draft', 'legacy-1', JSON.stringify({ id: 'legacy-1', sourceText: '历史草稿' }), 1000, 1000],
  )
  db.run(
    'INSERT INTO nm_record (kind, id, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['legacy-unknown-kind', 'legacy-2', JSON.stringify({ id: 'legacy-2' }), 2000, 2000],
  )
  writeFileSync(dbPath(), Buffer.from(db.export()))
  db.close()
}

describe('新媒体数据库版本化 Schema', () => {
  test('历史 v1 数据库可读取并自动迁移到当前版本', async () => {
    await writeLegacyV1Database()
    await initNewMediaDb()
    const info = await getNewMediaSchemaInfo()
    expect(info.version).toBe(CURRENT_NEW_MEDIA_SCHEMA_VERSION)
    expect(info.appliedMigrations.map((entry) => entry.version)).toEqual([2, 3])

    const legacy = await getNewMediaRecord<{ sourceText: string }>('content-draft', 'legacy-1')
    expect(legacy?.sourceText).toBe('历史草稿')
  })

  test('迁移按注册表回填域，未注册 kind 归入 unknown 并可诊断', async () => {
    await writeLegacyV1Database()
    await initNewMediaDb()
    const info = await getNewMediaSchemaInfo()
    expect(info.unknownKinds).toEqual(['legacy-unknown-kind'])
    expect(info.registeredKinds.length).toBeGreaterThan(10)

    expect((await listNewMediaRecordsByDomain<{ id: string }>('content')).map((item) => item.id)).toEqual(['legacy-1'])
    expect((await listNewMediaRecordsByDomain<{ id: string }>('unknown')).map((item) => item.id)).toEqual(['legacy-2'])
  })

  test('降级到 v1 保留业务数据并可再次升级', async () => {
    await writeLegacyV1Database()
    await initNewMediaDb()
    expect(migrateNewMediaDb(1)).toEqual([3, 2])
    persistDb()
    expect((await getNewMediaSchemaInfo()).version).toBe(1)

    const legacy = await getNewMediaRecord<{ sourceText: string }>('content-draft', 'legacy-1')
    expect(legacy?.sourceText).toBe('历史草稿')

    // 回滚后的库仍是合法 SQLite，可重新打开并再次升级。
    closeNewMediaDb()
    await initNewMediaDb()
    expect((await getNewMediaSchemaInfo()).version).toBe(CURRENT_NEW_MEDIA_SCHEMA_VERSION)
  })

  test('新写入记录按 kind 推导域，跨版本重启后可读', async () => {
    await initNewMediaDb()
    await putNewMediaRecord('xiaohongshu-handoff', { id: 'h-1', draftId: 'd-1' })
    expect(resolveNewMediaRecordDomain('xiaohongshu-handoff')).toBe('handoff')
    expect(resolveNewMediaRecordDomain('不存在的 kind')).toBe('unknown')

    closeNewMediaDb()
    await initNewMediaDb()
    expect((await listNewMediaRecordsByDomain<{ id: string }>('handoff')).map((item) => item.id)).toEqual(['h-1'])
  })

  test('未提供回滚语句的基线版本拒绝降级到 v0', async () => {
    await writeLegacyV1Database()
    await initNewMediaDb()
    expect(migrateNewMediaDb(1)).toEqual([3, 2])
    expect(() => migrateNewMediaDb(0)).toThrow('未提供回滚语句')
    closeNewMediaDb()
    await initNewMediaDb()
    expect((await getNewMediaSchemaInfo()).version).toBe(CURRENT_NEW_MEDIA_SCHEMA_VERSION)
  })
})

function persistDb(): void {
  expect(readFileSync(dbPath()).length).toBeGreaterThan(0)
}
