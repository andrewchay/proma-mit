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

test('普通启动在注册 IPC 前对账遗留动作，显式多实例模式跳过主动对账', () => {
  const source = readFileSync(join(import.meta.dir, '../index.ts'), 'utf8')
  const bootstrap = source.slice(source.indexOf('async function bootstrap()'))
  const smokeReturn = bootstrap.indexOf('return\n  }')
  const reconcile = bootstrap.indexOf("await safeAwait('reconcileUnknownActionsAfterRestart'")
  expect(smokeReturn).toBeGreaterThanOrEqual(0)
  expect(reconcile).toBeGreaterThan(smokeReturn)
  expect(bootstrap.slice(smokeReturn, reconcile)).toContain('if (!allowMultipleInstancesForTest)')
  expect(reconcile).toBeLessThan(bootstrap.indexOf('await registerIpcHandlers()'))
})
