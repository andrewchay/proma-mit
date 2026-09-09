/** 构建 macOS 灵动岛原生 N-API 模块（island.node）。 */

import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { resolveNapiHeaders } from './resolve-napi-headers'

const source = resolve(import.meta.dir, '../resources/dynamic-island/macos/island_addon.mm')
const output = resolve(import.meta.dir, '../resources/dynamic-island/macos/island.node')
// 与 computer-use 相同：只使用稳定 N-API ABI，优先使用 CI 的 Node 开发头文件。
const napiHeaders = resolveNapiHeaders(import.meta.dir)

if (process.platform !== 'darwin') {
  console.log('[Dynamic Island] 非 macOS 平台跳过原生模块构建')
  process.exit(0)
}

await mkdir(dirname(output), { recursive: true })
if (!napiHeaders || !existsSync(join(napiHeaders, 'node_api.h'))) {
  throw new Error('未找到 N-API 头文件；请安装 Node.js 开发头文件')
}
const proc = Bun.spawn([
  '/usr/bin/xcrun', '--sdk', 'macosx', 'clang++', '-fobjc-arc', '-O', '-dynamiclib', '-undefined', 'dynamic_lookup', source,
  '-I', napiHeaders,
  '-framework', 'Cocoa', '-framework', 'AppKit', '-framework', 'Foundation', '-o', output,
], {
  stdout: 'inherit',
  stderr: 'inherit',
  env: { ...process.env, CLANG_MODULE_CACHE_PATH: '/tmp/proma-clang-module-cache' },
})

if (await proc.exited !== 0) {
  throw new Error('Dynamic Island 原生模块构建失败')
}

console.log('[Dynamic Island] macOS 原生模块构建完成')
