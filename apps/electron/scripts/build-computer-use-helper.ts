/** 构建在 Electron 主进程内运行的 macOS Computer Use N-API 模块。 */

import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const source = resolve(import.meta.dir, '../resources/computer-use/macos/computer_use_addon.mm')
const output = resolve(import.meta.dir, '../resources/computer-use/macos/computer_use.node')
// Electron 未随 npm 包分发完整 Node 头文件；复用已安装的 N-API C 头文件即可，
// 模块只使用稳定 N-API ABI，不链接 Node/Electron 私有符号。
const napiHeaders = resolve(import.meta.dir, '../../../node_modules/node-addon-api/external-napi')

if (process.platform !== 'darwin') {
  console.log('[Computer Use] 非 macOS 平台跳过原生辅助程序构建')
  process.exit(0)
}

await mkdir(dirname(output), { recursive: true })
const proc = Bun.spawn([
  '/usr/bin/xcrun', '--sdk', 'macosx', 'clang++', '-fobjc-arc', '-O', '-dynamiclib', '-undefined', 'dynamic_lookup', source,
  '-I', napiHeaders,
  '-framework', 'Cocoa', '-framework', 'ApplicationServices', '-o', output,
], {
  stdout: 'inherit',
  stderr: 'inherit',
  env: { ...process.env, CLANG_MODULE_CACHE_PATH: '/tmp/proma-clang-module-cache' },
})

if (await proc.exited !== 0) {
  throw new Error('Computer Use 原生辅助程序构建失败')
}

console.log('[Computer Use] macOS 原生辅助程序构建完成')
