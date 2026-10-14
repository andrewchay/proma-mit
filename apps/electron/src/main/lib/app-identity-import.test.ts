import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

test('Bun 无 Electron mock 也能导入配置和缓存路径工具', () => {
  const identity = resolve(import.meta.dir, 'app-identity.ts')
  const config = resolve(import.meta.dir, 'config-paths.ts')
  const cache = resolve(import.meta.dir, 'app-temp-paths.ts')
  const result = Bun.spawnSync([process.execPath, '-e',
    `const m = await import(${JSON.stringify(identity)}); await import(${JSON.stringify(config)}); await import(${JSON.stringify(cache)}); if(m.APP_CHANNEL !== 'dev') process.exit(1);`],
    { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
})
