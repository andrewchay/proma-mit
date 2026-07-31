/** 构建 macOS 灵动岛原生 N-API 模块（island.node）。 */

import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const source = resolve(import.meta.dir, '../resources/dynamic-island/macos/island_addon.mm')
const output = resolve(import.meta.dir, '../resources/dynamic-island/macos/island.node')
// 与 computer-use 相同：复用已安装的 N-API C 头文件，只使用稳定 N-API ABI。
const napiHeaders = resolve(import.meta.dir, '../../../node_modules/node-addon-api/external-napi')

if (process.platform !== 'darwin') {
  console.log('[Dynamic Island] 非 macOS 平台跳过原生模块构建')
  process.exit(0)
}

await mkdir(dirname(output), { recursive: true })
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
