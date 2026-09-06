import { createRequire } from 'node:module'
/** Bun 测试与 Electron 共用同步 SQLite 合同，Electron 使用内置 node:sqlite。 */
export type SqlValue = string | number | bigint | Uint8Array | null
export interface SqliteStatement {
  get(...params: SqlValue[]): unknown
  all(...params: SqlValue[]): unknown[]
  run(...params: SqlValue[]): { changes: number | bigint }
}
export interface NativeSqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}
interface SqliteEngine { Database: new (path: string) => NativeSqliteDatabase }

/** 不依赖外置 native addon，打包后仍由 Electron 自带的 Node SQLite 提供能力。 */
export function openNativeSqlite(path: string): NativeSqliteDatabase {
  if (typeof Bun !== 'undefined') {
    const engine = createRequire(process.cwd() + '/package.json')('bun:sqlite') as SqliteEngine
    const database = new engine.Database(path)
    database.exec('PRAGMA foreign_keys=ON')
    return database
  }
  const engine = require('node:sqlite') as { DatabaseSync: new (path: string, options: { enableDoubleQuotedStringLiterals: boolean; enableForeignKeyConstraints: boolean }) => NativeSqliteDatabase }
  // 兼容已有 schema/查询中的双引号字符串，不改写老用户数据库。
  return new engine.DatabaseSync(path, { enableDoubleQuotedStringLiterals: true, enableForeignKeyConstraints: true })
}
