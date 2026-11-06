import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../../../../..'), renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'owner-acceptance-browser-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

browserTest('Given 准确绑定的已提交成果 When 人工核对并通过 Then 写入对应交付版本和依据', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react'; import {createRoot} from 'react-dom/client'; import {Provider,createStore} from 'jotai';
import {OwnerAcceptanceCard} from ${JSON.stringify(join(renderer, 'components/projects/OwnerAcceptanceCard.tsx'))};
const schedule={projectId:'p',grantId:'g',taskId:'t',reworkOrdinal:1,state:'waiting',nextAction:'await_business_acceptance'};
const commands=[{grantId:'g',taskId:'t',reworkOrdinal:1,role:'executor',state:'settled',executionStatus:'completed',executionId:'run'}];
const draft={id:'d',version:2,taskId:'t',executionId:'run',status:'submitted',title:'首页 v2',content:'首页标题需要更清晰',criteria:'范围正确',definitionOfDone:['首页可用'],responsibilities:{reviewerId:'local-user'}};
let chain={revision:3,drafts:[draft]}, calls=[], feedback=[], changed=0, lost=true;
window.electronAPI={paa:{project:{getChain:async()=>chain,decideOwnerChainDelivery:async request=>{calls.push(request);chain={...chain,revision:4,drafts:[{...draft,status:'accepted'}]};if(lost){lost=false;throw Error('回执丢失')}return {ok:true,value:chain}}}}};
const root=createRoot(document.getElementById('root')),store=createStore();let generation=0;
const render=()=>root.render(<Provider store={store}><OwnerAcceptanceCard key={++generation} projectId="p" schedule={schedule} commands={commands} onChanged={()=>changed++} onDiscuss={(item,excerpt,intent)=>feedback.push({id:item.id,version:item.version,excerpt,intent})}/></Provider>);
window.fixture={facts:()=>({calls,changed,feedback}),remount:render};render();
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage()
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByText('首页 v2，可以交付了吗？').waitFor()
    await page.getByRole('button', { name: '查看产物 / 点选反馈 ↗' }).click()
    await page.locator('pre').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
    await page.getByRole('button', { name: '针对选中内容提问' }).click()
    expect(await page.evaluate<unknown>('window.fixture.facts().feedback')).toEqual([{ id: 'd', version: 2, excerpt: '首页标题需要更清晰', intent: 'question' }])
    await page.getByText('通过这一版', { exact: true }).click()
    await page.getByLabel('验收依据').fill('逐项查看了首页')
    expect(await page.getByRole('button', { name: '提交决定' }).isDisabled()).toBe(true)
    await page.getByLabel('首页可用').check()
    await page.getByRole('button', { name: '提交决定' }).click()
    await page.getByRole('button', { name: '重试保存' }).waitFor()
    await page.evaluate('window.fixture.remount()')
    await page.getByRole('button', { name: '重试保存' }).click()
    await page.waitForFunction('window.fixture.facts().changed === 1')
    const calls = await page.evaluate<unknown[]>('window.fixture.facts().calls')
    expect(calls[0]).toEqual({ projectId: 'p', requestId: expect.any(String), grantId: 'g', taskId: 't', reworkOrdinal: 1, revision: 3, draftId: 'd', version: 2, choice: 'accept', comment: '逐项查看了首页', completedCriteria: ['首页可用'] })
    expect(calls[1]).toEqual(calls[0])
  } finally { await browser.close(); server.stop(true) }
}, 15000)
