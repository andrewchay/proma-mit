import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
const root = resolve(import.meta.dir, '../../../../../..'), renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'owner-understanding-browser-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip
browserTest('Given同框必要问题 When自然答复、确认理解、修订目标 Then表单可选且明确确认后才改变内容', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react';import {createRoot} from 'react-dom/client';import {Provider,createStore} from 'jotai';
import {OwnerManagementConversation} from ${JSON.stringify(join(renderer, 'components/projects/OwnerManagementConversation.tsx'))};
import {ownerGoalEditorsAtom,getOwnerGoalEditor} from ${JSON.stringify(join(renderer, 'atoms/project-owner-goal-atoms.ts'))};
const store=createStore(),ok=value=>({ok:true,value}),listeners=new Set();let goal={schemaVersion:1,revision:1,state:'draft',actor:'local-user',savedAt:1,goal:{projectId:'p',goalVersion:1,objective:'定位建议',constraints:['不得联网'],acceptanceCriteria:['包含依据']}};
const manager={schemaVersion:1,projectId:'p',ownerId:'owner',conversationId:'conversation',revision:1,status:'active',createdAt:1,updatedAt:1};
const question={id:'q'.repeat(64),projectId:'p',conversationId:'conversation',executionId:'e',receiptId:'r',planningTaskId:'t',goalRevision:1,contextFingerprint:'ctx',reason:'受众决定定位',questions:[{key:'audience',reasonType:'missing_information',question:'主要服务谁？',why:'决定定位',options:['现有用户','新用户'],recommended:'现有用户'}],state:'open'};
const messages=[],changes=[],calls=[];let applied=0,sendCount=0;
const emit=()=>listeners.forEach(cb=>cb({projectId:'p'}));
window.electronAPI={paa:{project:{getOwnerManagement:async()=>ok({manager,messages,questions:[question],changes,pendingEvents:0}),onOwnerManagementChanged:cb=>{listeners.add(cb);return()=>listeners.delete(cb)},getOwnerGoalDraft:async()=>ok(goal),getOwnerPlanDraft:async()=>ok(null),listOwnerPlanHistory:async()=>ok([]),getOwnerPlanningContext:async()=>ok({goal,sources:{project:{id:'p',title:'项目',description:''},roles:[]},fingerprint:'ctx'}),
sendOwnerManagementMessage:async input=>{sendCount++;const message={id:'m'+sendCount,projectId:'p',conversationId:'conversation',eventId:input.requestId,role:'user',kind:'conversation',goalRevision:goal.revision,content:input.content,createdAt:sendCount};messages.push(message);changes.push({id:String(sendCount).repeat(64),projectId:'p',conversationId:'conversation',messageId:message.id,goalRevision:goal.revision,summary:sendCount===1?'我理解受众是现有用户，请确认。':'改为客户定位；将移除原来的不得联网约束和依据标准，请确认。',change:sendCount===1?{kind:'clarification_answers',questionId:question.id,answers:{audience:'现有用户'}}:{kind:'goal_revision',goal:{objective:'客户定位建议',constraints:[],acceptanceCriteria:['有明确建议']}},currentGoal:structuredClone(goal.goal),questions:sendCount===1?[{key:'audience',question:'主要服务谁？'}]:[],previewHash:'a'.repeat(64),state:'pending'});return ok(message)},
decideOwnerConversationChange:async input=>{calls.push(input);const item=changes.find(c=>c.id===input.changeId);item.state=input.action==='apply'?'applied':'dismissed';if(input.action==='apply'){applied++;goal={...goal,revision:goal.revision+1,goal:{...goal.goal,goalVersion:goal.goal.goalVersion+1,...(item.change.kind==='goal_revision'?item.change.goal:{constraints:[...goal.goal.constraints,'受众：现有用户']})}};question.state='answered'}emit();if(applied===1)throw Error('模拟已提交后丢回包');return ok({changeId:item.id,action:input.action,...(input.action==='apply'?{goal}: {})})}
}}};
store.set(ownerGoalEditorsAtom,new Map([[JSON.stringify(['p',null]),{...getOwnerGoalEditor(new Map(),{projectId:'p'}),loaded:true,snapshot:goal}]]));window.understandingFixture={facts:()=>({goal,calls,applied,sendCount})};createRoot(document.getElementById('root')).render(<Provider store={store}><OwnerManagementConversation projectId="p"><p>当前项目</p></OwnerManagementConversation></Provider>);
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  page.setDefaultTimeout(5000)
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByText('直接在下方对话告诉我你的选择或想法，我会整理理解供你确认。', { exact: true }).waitFor()
    expect(await page.locator('textarea:visible').count()).toBe(1)
    expect(await page.getByRole('button', { name: '答复，让 Owner 继续', exact: true }).isVisible()).toBe(false)
    await page.getByLabel('给项目 Owner 的消息').fill('保留已有约束')
    await page.getByRole('button', { name: '现有用户', exact: true }).click()
    expect(await page.getByLabel('给项目 Owner 的消息').inputValue()).toBe('保留已有约束\n主要服务谁？：现有用户')
    await page.getByRole('button', { name: '发送给 Owner', exact: true }).click()
    await page.getByLabel('Owner理解待确认').getByText('我理解受众是现有用户，请确认。', { exact: true }).waitFor()
    expect(await page.evaluate<number>('window.understandingFixture.facts().goal.revision')).toBe(1)
    await page.getByRole('button', { name: '确认答复，继续规划', exact: true }).click()
    await page.getByText('此前内容确认', { exact: true }).waitFor()
    expect(await page.evaluate<number>('window.understandingFixture.facts().goal.revision')).toBe(2)
    expect(await page.evaluate<number>('window.understandingFixture.facts().calls.length')).toBe(1)
    await page.getByLabel('给项目 Owner 的消息').fill('改为客户定位，删除不得联网和包含依据的要求')
    await page.getByRole('button', { name: '发送给 Owner', exact: true }).click()
    await page.getByText('将移除的原约束：不得联网；受众：现有用户', { exact: true }).waitFor()
    await page.getByText('将移除的原完成标准：包含依据', { exact: true }).waitFor()
    expect(await page.evaluate<number>('window.understandingFixture.facts().goal.revision')).toBe(2)
    await page.getByRole('button', { name: '确认更新目标', exact: true }).click()
    await page.waitForFunction('window.understandingFixture.facts().goal.revision===3')
    expect(await page.evaluate<string>('window.understandingFixture.facts().goal.goal.objective')).toBe('客户定位建议')
    expect(errors).toEqual([])
  } finally { await browser.close(); server.stop(true) }
}, 30000)
