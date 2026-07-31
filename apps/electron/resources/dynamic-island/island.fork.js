// 灵动岛渲染子进程 —— 纯胶水。
//
// 生命周期由主进程（dynamic-island-service.ts 的 RendererProcess）控制：
//   主进程 spawn 本脚本（优先 Electron-as-node / bun，回退 PATH node）
//   主进程 --stdin(JSON\n)--> 本脚本 --require--> island.node 原生窗口
//   island.node --stdout(JSON\n)--> 本脚本 --stdout--> 主进程
//
// 尺寸可被 ISLAND_WIDTH / ISLAND_HEIGHT 环境变量覆盖。
// 注意：本文件位于 type: module 包内，必须使用 ESM 语法。

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const islandDir = path.dirname(fileURLToPath(import.meta.url))
const nativePath = path.join(islandDir, 'macos', 'island.node')

let native
try {
  native = require(nativePath)
} catch (err) {
  process.stderr.write(`[island.fork] 无法加载 native 模块: ${String(err)}\n`)
  process.exit(1)
}

const width = Number(process.env.ISLAND_WIDTH ?? 260)
const height = Number(process.env.ISLAND_HEIGHT ?? 40)

try {
  native.start({ width, height })
} catch (err) {
  process.stderr.write(`[island.fork] native.start 失败: ${String(err)}\n`)
  process.exit(1)
}

// native.start 之后由原生模块接管 stdin/stdout；这里保持进程存活，
// 直到原生模块读到 stdin EOF 自行退出。
process.stdin.resume()
setInterval(() => {}, 1 << 30)
