import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, renameSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProjectDb, getProjectDb, closeProjectDb } from './project-sqlite-store'
import { initMarketingDb, getMarketingDb, closeMarketingDb } from './marketing/marketing-sqlite-store'

for (const store of [
  { name: 'project', init: initProjectDb, get: getProjectDb, close: closeProjectDb, file: 'projects/paa.db', read: () => getProjectDb().prepare('SELECT value FROM diagnostic_probe').get() },
  { name: 'marketing', init: initMarketingDb, get: getMarketingDb, close: closeMarketingDb, file: 'marketing/marketing.db', read: () => getMarketingDb().get('SELECT value FROM diagnostic_probe') },
]) {
  test('Given ' + store.name + ' 已持久化 When 目标不能替换 Then 报错且原文件完整，恢复后可重开', async () => {
    const original = process.env.PROMA_TEST_CONFIG_DIR
    const directory = mkdtempSync(join(tmpdir(), 'gravitas-store-recovery-'))
    process.env.PROMA_TEST_CONFIG_DIR = directory
    try {
      await store.init()
      const db = store.get()
      db.exec('CREATE TABLE diagnostic_probe(value TEXT); INSERT INTO diagnostic_probe VALUES ("durable")')
      db.persist()
      const target = join(directory, store.file)
      const backup = target + '.before'
      const bytes = readFileSync(target)
      renameSync(target, backup)
      mkdirSync(target)
      try {
        expect(() => db.persist()).toThrow()
        expect(readFileSync(backup)).toEqual(bytes)
      } finally {
        rmSync(target, { recursive: true })
        renameSync(backup, target)
      }
      store.close()
      await store.init()
      expect(store.read()).toEqual({ value: 'durable' })
    } finally {
      store.close()
      if (original === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
      else process.env.PROMA_TEST_CONFIG_DIR = original
      rmSync(directory, { recursive: true, force: true })
    }
  })
}
