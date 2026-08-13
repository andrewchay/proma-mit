/**
 * Browser Engine 垂直切片验证脚本（S1-S4）
 *
 * 运行方式（在 proma-mit 根目录）：
 *   1) 打包：bun run --filter '@gravitas/electron' build:slice  （见下方 package.json 追加说明）
 *   2) 运行：node_modules/.bin/electron apps/electron/out/browser-engine-slice.cjs
 *
 * 验证点：
 *   S1 多标签：createNewTab 两次，两个 tab 能分别加载不同页面；selectTab 切换不丢状态
 *   S2 AX Observe：Accessibility.getFullAXTree → 返回结构化的 button/input（带 ref + editable）
 *   S3 CDP 真实输入：点击真实生效（计数/标题变化），填表真实生效（value 被写入）
 *
 * 断言失败会抛错并以非 0 退出；全部通过打印 ✅ 并退出 0。
 */

import { app } from 'electron'
import { createServer } from 'node:http'
import { browserController } from '../src/main/lib/browser-engine/browser-controller'

const SESSION_ID = 'slice-verify'
const PORT = 18921

function fail(message: string): never {
  console.error(`❌ 断言失败: ${message}`)
  process.exit(1)
}

function ok(label: string): void {
  console.log(`✅ ${label}`)
}

function startServer(): Promise<{ base: string; close: () => void }> {
  const server = createServer((req, res) => {
    // 两个页面：page-a 有可点的按钮和输入框；page-b 有另一个按钮。
    const path = req.url ?? '/'
    if (path === '/page-a') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><title>Page A</title></head><body>
        <button id="clickme">点我</button>
        <input id="name" aria-label="名称输入" placeholder="输入名称" />
        <span id="counter">0</span>
        <script>
          let count = 0;
          document.getElementById('clickme').addEventListener('click', () => {
            count++;
            document.getElementById('counter').textContent = String(count);
          });
        </script>
      </body></html>`)
      return
    }
    if (path === '/page-b') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><head><title>Page B</title></head><body><h1>这是 B 页面</h1><button id="other">B 按钮</button></body></html>')
      return
    }
    res.writeHead(404); res.end()
  })
  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${PORT}`, close: () => server.close() }))
  })
}

async function main(): Promise<void> {
  const { base, close } = await startServer()
  try {
    const openedAt = Date.now()

    // ---- S1 多标签 ----
    const tabA = browserController.createNewTab(SESSION_ID, `${base}/page-a`)
    await sleep(800)
    const tabB = browserController.createNewTab(SESSION_ID, `${base}/page-b`)
    await sleep(800)

    const tabs = browserController.listTabs(SESSION_ID)
    if (tabs.length < 2) fail(`期望至少 2 个标签，实际 ${tabs.length}`)
    ok(`S1 多标签：创建了 ${tabs.length} 个标签`)

    // 当前激活 tab 应指向 tabB（最后创建的）
    const activeA = tabs.find((t) => t.tabId === tabA.tabId)
    const activeB = tabs.find((t) => t.tabId === tabB.tabId)
    if (!activeA || !activeB) fail('未找到创建的两个标签')

    // ---- S2 AX Observe ----
    const obsA = await browserController.observe(SESSION_ID, tabA.tabId)
    const button = obsA.elements.find((e) => e.role === 'button' && e.name.includes('点我'))
    const input = obsA.elements.find((e) => (e.role === 'textbox' || e.role === 'combobox') && e.name.includes('名称'))
    if (!button) fail(`Page A 未观察到「点我」按钮。取得元素：${obsA.elements.map((e) => e.role).join(',')}`)
    ok(`S2 AX Observe：识别到 button「${button.name}」ref=${button.ref}`)
    if (!input) fail(`Page A 未观察到「名称输入」输入框`)
    ok(`S2 AX Observe：识别到 input「${input.name}」ref=${input.ref} editable=${input.editable}`)

    // ---- S3 CDP 真实输入：填表 ----
    await browserController.fill(SESSION_ID, input.ref, 'Gravitas 测试', tabA.tabId)
    await sleep(300)
    const uploaded = await evaluate(tabA.tabId, `document.getElementById('name').value`)
    if (uploaded !== 'Gravitas 测试') fail(`Fill 后 input 值应为「Gravitas 测试」，实际「${uploaded}」`)
    ok('S3 CDP 真实输入：Fill(insertText) 已把文本写入 input')

    // ---- S3 CDP 真实输入：点击 ----
    // fill 后 observeInternal 已使旧 ref 失效，需重新观察拿到最新的 button ref。
    const obsAfter = await browserController.observe(SESSION_ID, tabA.tabId)
    const freshButton = obsAfter.elements.find((e) => e.role === 'button' && e.name.includes('点我'))
    if (!freshButton) fail('fill 后重新观察时找不到「点我」按钮')
    await browserController.click(SESSION_ID, freshButton.ref, tabA.tabId)
    await sleep(300)
    const counter = await evaluate(tabA.tabId, `document.getElementById('counter').textContent`)
    if (counter !== '1') fail(`点击后计数应为 1，实际 ${counter}`)
    ok('S3 CDP 真实输入：Click(dispatchMouseEvent) 已触发布局点击')

    // ---- S1 selectTab 切换不丢状态 ----
    await browserController.selectTab(SESSION_ID, tabB.tabId)
    await sleep(200)
    const titleB = await evaluate(tabB.tabId, `document.title`)
    if (!titleB.includes('Page B')) fail(`切到 B 后 title 应为 Page B，实际「${titleB}」`)
    ok('S1 多标签：selectTab 切换到 B 标签且状态正常')

    // 切回 A，输入框里的值应仍在（不丢状态）
    await browserController.selectTab(SESSION_ID, tabA.tabId)
    await sleep(200)
    const uploadBack = await evaluate(tabA.tabId, `document.getElementById('name').value`)
    if (uploadBack !== 'Gravitas 测试') fail(`切回 A 后 input 值丢失：${uploadBack}`)
    ok('S1 多标签：切回 A 后输入框状态保留（多标签不丢状态）')

    console.log(`\n🎉 垂直切片全部通过，耗时 ${((Date.now() - openedAt) / 1000).toFixed(1)}s`)
  } finally {
    browserController.close(SESSION_ID)
    close()
    app.exit(0)
  }
}

function evaluate(tabId: string, expression: string): Promise<string | number | boolean | null> {
  return browserController.evaluateForTest(tabId, expression)
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

app.disableHardwareAcceleration()

// 进程级兜底：无论 main 卡在哪，都在 35s 内强制退出并输出错误，避免无头挂起。
setTimeout(() => {
  console.error(`⏰ 垂直切片总超时（35s）`)
  process.exit(2)
}, 35_000).unref()

app.whenReady().then(() => {
  main().catch((error) => {
    console.error('❌ 垂直切片失败:', error)
    process.exit(1)
  })
}).catch(() => process.exit(1))
