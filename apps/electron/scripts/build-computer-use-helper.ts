/** 构建在 Electron 主进程内运行的 macOS Computer Use N-API 模块。 */

import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const source = resolve(import.meta.dir, '../resources/computer-use/macos/computer_use_addon.mm')
const output = resolve(import.meta.dir, '../resources/computer-use/macos/computer_use.node')
// 模块只使用稳定 N-API ABI，不链接 Node/Electron 私有符号。CI 的 setup-node
// 提供完整 Node 头文件；本机若已有 node-addon-api 则保留其 N-API 头文件回退。
const bundledNapiHeaders = resolve(import.meta.dir, '../../../node_modules/node-addon-api/external-napi')
const nodeExecutable = Bun.which('node')
const nodeHeaders = nodeExecutable ? resolve(dirname(nodeExecutable), '../include/node') : ''
const napiHeaders = existsSync(join(bundledNapiHeaders, 'node_api.h'))
  ? bundledNapiHeaders
  : nodeHeaders

if (process.platform !== 'darwin') {
  console.log('[Computer Use] 非 macOS 平台跳过原生辅助程序构建')
  process.exit(0)
}

await mkdir(dirname(output), { recursive: true })
if (!napiHeaders || !existsSync(join(napiHeaders, 'node_api.h'))) {
  throw new Error('未找到 N-API 头文件；请安装 Node.js 开发头文件')
}
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
