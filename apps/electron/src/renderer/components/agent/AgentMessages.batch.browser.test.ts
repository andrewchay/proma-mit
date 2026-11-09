import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'agent-batch-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

browserTest('Given 长会话 When 打开记录 Then 先显示最近消息并逐帧补齐历史', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react'; import {createRoot} from 'react-dom/client'; import {Provider} from 'jotai';
import {AgentMessages} from ${JSON.stringify(join(renderer, 'components/agent/AgentMessages.tsx'))};
let callbacks = new Map(), next = 0;
window.requestAnimationFrame = cb => { const id = ++next; callbacks.set(id, cb); return id };
window.cancelAnimationFrame = id => callbacks.delete(id);
window.tick = () => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(cb => cb(performance.now())) };
window.messageReads = 0;
const messages = Array.from({length: 60}, (_, i) => new Proxy({type:'user',uuid:'u'+i,message:{role:'user',content:[{type:'text',text:'历史消息 '+String(i).padStart(2,'0')}]}} , {get(target, key) { if (key === 'message') window.messageReads++; return Reflect.get(target, key) }}));
const root = createRoot(document.getElementById('root'));
function Fixture({id, records}) { const [draft, setDraft] = React.useState(''); return <><input aria-label="草稿" value={draft} onChange={e => setDraft(e.target.value)}/><AgentMessages sessionId={id} messagesLoaded={true} persistedSDKMessages={records} streaming={false}/></> }
window.show = (id, records) => root.render(<Provider><Fixture id={id} records={records}/></Provider>);
window.show('batch', messages);
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByText('历史消息 59', { exact: true }).waitFor({ state: 'attached' })
    expect(await page.getByText('历史消息 00', { exact: true }).count()).toBe(0)
    expect(await page.getByText('历史消息 39', { exact: true }).count()).toBe(0)
    await page.evaluate('window.tick()')
    await page.getByText('历史消息 39', { exact: true }).waitFor({ state: 'attached' })
    expect(await page.getByText('历史消息 00', { exact: true }).count()).toBe(0)
    const scroll = page.locator('[role="log"] > div').first()
    await scroll.evaluate(el => { (el.parentElement as HTMLElement).style.height = '200px'; el.style.overflow = 'auto'; el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); el.scrollTop = 120; el.dispatchEvent(new Event('scroll')) })
    const before = await page.getByText('历史消息 45', { exact: true }).evaluate(el => el.getBoundingClientRect().top)
    await page.evaluate('window.tick()')
    await page.getByText('历史消息 00', { exact: true }).waitFor({ state: 'attached' })
    const after = await page.getByText('历史消息 45', { exact: true }).evaluate(el => el.getBoundingClientRect().top)
    expect(Math.abs(after - before)).toBeLessThan(5)
    await page.evaluate('window.messageReads = 0')
    await page.getByLabel('草稿').fill('测试输入')
    expect(await page.evaluate<number>('window.messageReads')).toBe(0)
    expect(await page.getByText('历史消息 00', { exact: true }).count()).toBe(1)
    await page.evaluate(`window.show('next', [{type:'user',uuid:'next',message:{role:'user',content:[{type:'text',text:'新会话消息'}]}}])`)
    await page.getByText('新会话消息', { exact: true }).waitFor({ state: 'attached' })
    await page.evaluate('window.tick()')
    expect(await page.getByText('历史消息 59', { exact: true }).count()).toBe(0)
    expect(errors).toEqual([])
  } finally { await browser.close(); server.stop(true) }
}, 30000)

browserTest('Given 用户已滚到历史位置 When 切换并返回会话 Then 恢复相同的距底部位置', async () => {
  writeFileSync(join(directory, 'scroll-entry.tsx'), `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {Conversation, ConversationContent} from ${JSON.stringify(join(renderer, 'components/ai-elements/conversation.tsx'))};
import {ScrollPositionManager} from ${JSON.stringify(join(renderer, 'hooks/useScrollPositionMemory.ts'))};
function View({id}) { const [ready, setReady] = React.useState(false); React.useEffect(() => { setReady(true) }, []); return <Conversation style={{height: 200}}><ScrollPositionManager id={id} ready={ready}/><ConversationContent>{Array.from({length: 50}, (_, i) => <div key={i} style={{height: 30}}>消息 {i}</div>)}</ConversationContent></Conversation> }
const root = createRoot(document.getElementById('root')); window.show = id => root.render(<View key={id} id={id}/>); window.show('first');
`)
  await build({ entryPoints: [join(directory, 'scroll-entry.tsx')], outfile: join(directory, 'scroll-entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'scroll-entry.js'))) } })
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    const scroll = page.locator('[role="log"] > div')
    await page.getByText('消息 49', { exact: true }).waitFor()
    await page.waitForTimeout(100)
    const distance = await scroll.evaluate(el => { el.scrollTop = 300; el.dispatchEvent(new Event('scroll')); return el.scrollHeight - el.clientHeight - el.scrollTop })
    await page.evaluate("window.show('second')")
    await page.getByText('消息 49', { exact: true }).waitFor()
    await page.evaluate("window.show('first')")
    await page.getByText('消息 49', { exact: true }).waitFor()
    await page.waitForTimeout(100)
    expect(Math.abs(await scroll.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop) - distance)).toBeLessThan(5)
  } finally { await browser.close(); server.stop(true) }
}, 30000)
