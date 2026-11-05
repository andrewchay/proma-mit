import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../../../../..'), renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'owner-delivery-decision-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

browserTest('Given 已交付成果 When 选择修改并提交 Then 保存准确版本决定且保留原对话草稿', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react'; import {createRoot} from 'react-dom/client'; import {Provider,createStore} from 'jotai';
import {OwnerDeliveredDecisionCard} from ${JSON.stringify(join(renderer, 'components/projects/OwnerDeliveredDecisionCard.tsx'))};
import {ownerGoalEditorsAtom,getOwnerGoalEditor} from ${JSON.stringify(join(renderer, 'atoms/project-owner-goal-atoms.ts'))};
import {ownerManagementEditorsAtom,ownerManagementApiAtom,ownerMessageComposersAtom,getOwnerMessageComposer,editOwnerMessageAtom} from ${JSON.stringify(join(renderer, 'atoms/project-owner-management-atoms.ts'))};
const store=createStore(),subject={projectId:'p'},key=JSON.stringify(['p',null]);let calls=[],lost=true,refreshFailed=false,blocker='验证证据已过期';
store.set(ownerGoalEditorsAtom,new Map([[key,{...getOwnerGoalEditor(new Map(),subject),loaded:true,snapshot:{revision:3}}]]));
store.set(ownerManagementEditorsAtom,new Map([['p',{view:{manager:{conversationId:'c'},messages:[],questions:[]},generation:0,loading:false,savingQuestionId:null,drafts:{},requestIds:{},error:''}]]));
store.set(ownerManagementApiAtom,{getOwnerManagement:async()=>{if(calls.at(-1)?.deliveryReviewDecision!=='deferred')return new Promise(()=>{});if(!refreshFailed){refreshFailed=true;return {ok:false,error:{message:'读取失败'}}}return {ok:true,value:{manager:{projectId:'p',conversationId:'c'},messages:[],questions:[]}}},answerOwnerManagementQuestion:async()=>({ok:false,error:{message:'unused'}}),sendOwnerManagementMessage:async input=>{calls.push(input);if(lost&&input.deliveryReviewDecision!=='deferred'){lost=false;throw new Error('回执丢失')}return {ok:true,value:{...input,id:'m',goalRevision:input.expectedGoalRevision,role:'user',kind:'conversation'}}}});
store.set(editOwnerMessageAtom,{subject,text:'原有草稿'});
const item={stepKey:'s',title:'官网首页 v2',artifactHash:'a'.repeat(64),acceptanceCriteria:['页面可用'],reviewerSummary:'已检查'};
const reference={messageId:'delivery',stepKey:'s',artifactHash:item.artifactHash};
const root=createRoot(document.getElementById('root'));let generation=0;
const render=()=>root.render(<Provider store={store}><OwnerDeliveredDecisionCard key={++generation} subject={subject} item={item} reference={reference} acceptanceBlocker={blocker} onOpen={()=>{}}/></Provider>);
window.fixture={facts:()=>({calls,draft:getOwnerMessageComposer(store.get(ownerMessageComposersAtom),subject).text}),remount:render,unblock:()=>{blocker='';render()}};render();
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage()
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    expect(await page.getByRole('radio', { name: /通过这一版/ }).isDisabled()).toBe(true)
    await page.getByText('验证证据已过期', { exact: false }).waitFor()
    await page.getByText('稍后决定', { exact: true }).click()
    await page.getByRole('button', { name: '提交决定' }).click()
    await page.waitForFunction('window.fixture.facts().calls.length === 1')
    expect(await page.evaluate<string>('window.fixture.facts().calls[0].deliveryReviewDecision')).toBe('deferred')
    await page.getByRole('button', { name: '重新读取' }).click()
    await page.getByText('决定已保存，正在更新对话记录。').waitFor({ state: 'detached' })
    await page.evaluate('window.fixture.unblock()')
    await page.getByText('需要修改', { exact: true }).click()
    expect(await page.getByRole('button', { name: '提交决定' }).isDisabled()).toBe(true)
    await page.getByLabel('修改意见').fill('调整标题')
    await page.getByRole('button', { name: '提交决定' }).click()
    await page.waitForFunction('window.fixture.facts().calls.length === 2')
    await page.getByRole('button', { name: '重试保存' }).waitFor()
    await page.evaluate('window.fixture.remount()')
    await page.getByRole('button', { name: '重试保存' }).click()
    await page.waitForFunction('window.fixture.facts().calls.length === 3')
    await page.getByText('决定已保存，正在更新对话记录。').waitFor()
    expect(await page.getByRole('button', { name: '已保存' }).isDisabled()).toBe(true)
    const facts = await page.evaluate<{ calls: Array<{ requestId: string; deliveryReference: { messageId: string; stepKey: string; artifactHash: string }; deliveryReviewDecision: string; content: string }>; draft: string }>('window.fixture.facts()')
    expect(facts.calls[2]).toEqual(facts.calls[1])
    expect(facts.calls[1]?.deliveryReference).toEqual({ messageId: 'delivery', stepKey: 's', artifactHash: 'a'.repeat(64) })
    expect(facts.calls[1]?.deliveryReviewDecision).toBe('changes_requested')
    expect(facts.calls[1]?.content).toContain('调整标题')
    expect(facts.draft).toBe('原有草稿')
  } finally { await browser.close(); server.stop(true) }
}, 15000)
