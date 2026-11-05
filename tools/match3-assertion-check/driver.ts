/**
 * 三消断言模板的受管浏览器校验驱动：对夹具执行 html.loads + match3.* 断言。
 * 用法（仓库根目录）：
 *   bunx esbuild tools/match3-assertion-check/driver.ts --bundle --platform=node --format=cjs \
 *     --external:electron --outfile=tools/match3-assertion-check/driver.cjs
 *   env -u ELECTRON_RUN_AS_NODE PROMA_TEST_CONFIG_DIR=$(mktemp -d) \
 *     node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
 *     tools/match3-assertion-check/driver.cjs tools/match3-assertion-check
 * 好夹具用 tools/match3-assertion-check，坏夹具用 tools/match3-assertion-check/bad。
 * 全部 passed 时退出码为 0。driver.cjs 为构建产物，不入库。
 */
import { app } from 'electron'
import { resolve } from 'node:path'
import { runOwnerRuntimeBrowserAssertions } from '../../apps/electron/src/main/lib/owner-runtime-browser-verifier'
import { OWNER_RUNTIME_ASSERTION_TEMPLATES } from '../../apps/electron/src/main/lib/owner-runtime-assertion-templates'

const workspaceRoot = process.argv[2] ? resolve(process.argv[2]) : ''
if (!workspaceRoot) throw new Error('用法：Electron match3-driver.cjs <夹具目录>')

app.whenReady().then(async () => {
  const templates = OWNER_RUNTIME_ASSERTION_TEMPLATES.filter(template => template.id === 'html.loads' || template.id.startsWith('match3.'))
  const result = await runOwnerRuntimeBrowserAssertions({ workspaceRoot, relativePath: 'match3.html', intents: [], templates, timeoutMs: 120_000 })
  console.log('MATCH3_CHECKS_BEGIN')
  console.log(JSON.stringify(result, null, 2))
  console.log('MATCH3_CHECKS_END')
  app.exit(result.checks.every(check => check.status === 'passed') ? 0 : 1)
}).catch((error) => {
  console.error('[match3-driver] 运行失败', error)
  app.exit(2)
})
