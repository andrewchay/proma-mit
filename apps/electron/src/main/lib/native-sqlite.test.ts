import { expect, test } from 'bun:test'
import { openNativeSqlite } from './native-sqlite'

test('Given SQLite 外键 When 写入孤儿记录 Then Bun 与 Electron 合同一致地拒绝', () => {
  const database = openNativeSqlite(':memory:')
  try {
    database.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id))')
    expect(() => database.exec('INSERT INTO child VALUES (99)')).toThrow()
  } finally { database.close() }
})
