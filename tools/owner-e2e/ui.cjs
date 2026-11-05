// Owner 场景 UI 驱动脚本（node 运行，勿用 bun——playwright-core 在 Bun 下 CDP 连接超时）
// 前提：测试实例以 --remote-debugging-port=9222 启动，渲染进程来自 Vite（localhost:5173）
// 用法: node tools/owner-e2e/ui.cjs <action> [args]
// actions: click <文本或selector> | fill <selector> <text> | shot <path> | text | eval <js> | aria [selector]
const { chromium } = require('playwright-core')

async function getPage(browser) {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (p.url().startsWith('http://localhost:5173/') && !p.url().includes('window=quick-task')) return p
    }
  }
  throw new Error('未找到主窗口页面')
}

async function main() {
  const [action, ...args] = process.argv.slice(2)
  const browser = await chromium.connectOverCDP('http://localhost:9222')
  const page = await getPage(browser)
  if (action === 'click') {
    const target = args[0]
    if (target.startsWith('css=') || target.startsWith('text=') || target.startsWith('#') || target.startsWith('[') || target.startsWith('.')) {
      await page.locator(target).first().click({ timeout: 5000 })
    } else {
      await page.getByText(target, { exact: false }).first().click({ timeout: 5000 })
    }
    console.log('clicked', target)
  } else if (action === 'fill') {
    await page.locator(args[0]).first().fill(args[1])
    console.log('filled', args[0])
  } else if (action === 'shot') {
    await page.screenshot({ path: args[0] })
    console.log('saved', args[0])
  } else if (action === 'text') {
    console.log((await page.locator('body').innerText()).slice(0, 6000))
  } else if (action === 'eval') {
    const result = await page.evaluate(args[0])
    console.log(JSON.stringify(result))
  } else if (action === 'aria') {
    console.log(await page.locator(args[0] || 'body').ariaSnapshot())
  }
  await browser.close()
}
main().catch(e => { console.error('ERR:', e.message.split('\n')[0]); process.exit(1) })
