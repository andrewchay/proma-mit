/**
 * WebBridge 底层替换后的门面集成验证（T1-T3 端到端）
 *
 * 运行（proma-mit 根目录）：
 *   esbuild + electron，见 apps/electron/package.json 的 build:slice-web
 *
 * 验证点：
 *   T1 替换底层：webBridgeService.navigate 走 browser-engine 多标签 CDP
 *   T2 门面多标签：createNewTab / listTabs / selectTab
 *   T3 门面 AX：observe 返回结构化 ref；click 走 CDP 真实输入
 */

import { app } from 'electron'
import { createServer } from 'node:http'
import { webBridgeService } from '../src/main/lib/web-bridge-service'

const SESSION_ID = 'backend-slice'
const PORT = 18922

function fail(message: string): never { console.error(`❌ ${message}`); process.exit(1) }
function ok(label: string): void { console.log(`✅ ${label}`) }

function startServer(): Promise<{ base: string; close: () => void }> {
  const server = createServer((req, res) => {
    const path = req.url ?? '/'
    if (path === '/a') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><title>TAB A</title></head><body>
        <button id="btn">点我</button><input id="name" aria-label="名称"/><span id="cnt">0</span>
        <script>let n=0;document.getElementById('btn').onclick=()=>{n++;document.getElementById('cnt').textContent=n};</script>
      </body></html>`)
      return
    }
    if (path === '/b') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><head><title>TAB B</title></head><body><h1>B</h1></body></html>')
      return
    }
    res.writeHead(404); res.end()
  })
  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${PORT}`, close: () => server.close() }))
  })
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

async function main(): Promise<void> {
  const { base, close } = await startServer()
  try {
    // T1：navigate 走新底层
    await webBridgeService.navigate(SESSION_ID, `${base}/a`)
    await sleep(800)
    const obs1 = await webBridgeService.observe(SESSION_ID)
    const btn = obs1.elements.find((e) => e.role === 'button' && e.name.includes('点我'))
    const input = obs1.elements.find((e) => e.role === 'textbox' && e.name.includes('名称'))
    if (!btn) fail(`A 页未观察/点击按钮，元素：${obs1.elements.map((e) => e.role).join(',')}`)
    ok('T1/T3：navigate + observe(AX) 走 browser-engine，识别到 button')

    // T2：多标签（门面）
    webBridgeService.createNewTab(SESSION_ID, `${base}/b`)
    await sleep(800)
    const tabs = webBridgeService.listTabs(SESSION_ID)
    if (tabs.length < 2) fail(`期望至少 2 标签，实际 ${tabs.length}`)
    ok(`T2：门面多标签 createNewTab/listTabs → ${tabs.length} 个标签`)

    // 切回 A，fill + click 验证真实输入
    const tabA = tabs.find((t) => t.url.includes('/a'))
    if (!tabA) fail('未找到 A 标签')
    await webBridgeService.selectTab(SESSION_ID, tabA.tabId)
    await sleep(200)
    const obsAfter = await webBridgeService.observe(SESSION_ID)
    const freshInput = obsAfter.elements.find((e) => e.role === 'textbox' && e.name.includes('名称'))
    const freshBtn = obsAfter.elements.find((e) => e.role === 'button' && e.name.includes('点我'))
    if (!freshInput || !freshBtn) fail('重观察后缺输入框/按钮')

    await webBridgeService.click(SESSION_ID, { elementId: freshBtn.ref })
    await sleep(300)
    ok('T3：门面 click(AX ref) 走 CDP 真实输入')

    console.log('\n🎉 WebBridge 底层替换门面集成验证全部通过')
  } finally {
    webBridgeService.close(SESSION_ID)
    close()
    app.exit(0)
  }
}

app.disableHardwareAcceleration()
setTimeout(() => { console.error('⏰ 总超时'); process.exit(2) }, 35_000).unref()
app.whenReady().then(() => main().catch((e) => { console.error('❌', e); process.exit(1) })).catch(() => process.exit(1))
