import { describe, it, expect } from 'bun:test'
import { schemaChecksum, rawChecksum, stripSqlComments } from './migration-checksum.ts'

describe('migration-checksum', () => {
  const SQL_WITH_COMMENT = `
-- 这是注释
CREATE TABLE test (
  id TEXT PRIMARY KEY
);
`

  const SQL_SAME_SCHEMA_NO_COMMENT = `
CREATE TABLE test (
  id TEXT PRIMARY KEY
);
`

  const SQL_DIFFERENT = `
CREATE TABLE test (
  id INTEGER PRIMARY KEY
);
`

  it('schemaChecksum ignores comments and whitespace differences', () => {
    const a = schemaChecksum(SQL_WITH_COMMENT)
    const b = schemaChecksum(SQL_SAME_SCHEMA_NO_COMMENT)
    expect(a).toBe(b)
  })

  it('schemaChecksum detects schema changes', () => {
    const a = schemaChecksum(SQL_WITH_COMMENT)
    const b = schemaChecksum(SQL_DIFFERENT)
    expect(a).not.toBe(b)
  })

  it('rawChecksum is sensitive to comments', () => {
    const a = rawChecksum(SQL_WITH_COMMENT)
    const b = rawChecksum(SQL_SAME_SCHEMA_NO_COMMENT)
    expect(a).not.toBe(b)
  })

  it('stripSqlComments preserves string literals with comment-like content', () => {
    const sql = `SELECT '-- not a comment', "-- also not", '[-- bracket]'`
    const stripped = stripSqlComments(sql)
    expect(stripped).toContain("'-- not a comment'")
    expect(stripped).toContain('"-- also not"')
    expect(stripped).toContain('[-- bracket]')
  })

  it('stripSqlComments removes actual line comments', () => {
    const sql = `SELECT 1 -- real comment\nFROM t`
    const stripped = stripSqlComments(sql)
    expect(stripped).not.toContain('real comment')
    expect(stripped).toContain('SELECT 1')
    expect(stripped).toContain('FROM t')
  })

  it('stripSqlComments removes block comments', () => {
    const sql = `SELECT /* block */ 1`
    const stripped = stripSqlComments(sql)
    expect(stripped).not.toContain('block')
    expect(stripped).toContain('SELECT')
    expect(stripped).toContain('1')
  })

  it('schemaChecksum output is 32-char hex', () => {
    const hash = schemaChecksum(SQL_WITH_COMMENT)
    expect(hash).toMatch(/^[a-f0-9]{32}$/)
  })
})
