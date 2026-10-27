import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('用户数据路径仅在 package smoke 或显式隔离目录下被临时重定向', () => {
  const source = readFileSync(join(import.meta.dir, '../index.ts'), 'utf8')
  // 打包形态的隔离目录由 getPackagedTestConfigDir 统一推导，避免主入口散落判断。
  expect(source).toContain('getPackagedTestConfigDir(')
  expect(source).toContain("app.setPath('userData', join(dirname(packagedTestConfigDir), 'electron'))")
  // 非打包场景必须同时满足"package smoke 或显式允许多实例"，不能被普通开发启动误用。
  expect(source).toContain("process.env.GRAVITAS_PACKAGE_SMOKE === '1' || allowMultipleInstancesForTest")
  expect(source).toContain("app.setPath('userData', join(process.env.PROMA_TEST_CONFIG_DIR, 'electron'))")
  // 两者都不成立时回落到 Dev 默认目录，不触碰正式数据目录。
  expect(source).toContain('} else if (APP_IS_DEV) {')
  expect(source).toContain("join(app.getPath('appData'), APP_DEV_USER_DATA_DIR_NAME)")
})
