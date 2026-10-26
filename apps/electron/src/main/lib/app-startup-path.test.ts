import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('用户数据路径仅在 package smoke 或显式隔离目录下被临时重定向', () => {
  const source = readFileSync(join(import.meta.dir, '../index.ts'), 'utf8')
  expect(source).toContain("process.env.PROMA_TEST_CONFIG_DIR")
  expect(source).toContain("process.env.GRAVITAS_PACKAGE_SMOKE === '1' || process.env.PROMA_ALLOW_MULTI_INSTANCE === '1'")
  expect(source).toContain("app.setPath('userData', join(process.env.PROMA_TEST_CONFIG_DIR, 'electron'))")
  expect(source).toContain("} else if (APP_IS_DEV) {")
  expect(source).toContain("join(app.getPath('appData'), APP_DEV_USER_DATA_DIR_NAME)")
})
