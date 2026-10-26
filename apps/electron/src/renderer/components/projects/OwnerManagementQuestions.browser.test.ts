import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'owner-question-browser-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip
browserTest('Given 启动时已有Owner问题 When 恢复提醒、重复推送并答复丢回包后重试 Then 保留输入、同请求幂等且不显示旧问题', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react';import {createRoot} from 'react-dom/client';import {Provider,createStore} from 'jotai';import {Toaster} from 'sonner';
import {OwnerManagementQuestions} from ${JSON.stringify(join(renderer, 'components/projects/OwnerManagementQuestions.tsx'))};
import {useGlobalOwnerManagementListeners} from ${JSON.stringify(join(renderer, 'hooks/useGlobalOwnerManagementListeners.ts'))};
import {OwnerConversationUpdates} from ${JSON.stringify(join(renderer, 'components/projects/OwnerConversationUpdates.tsx'))};
import {ownerConversationNavigationAtom} from ${JSON.stringify(join(renderer, 'atoms/project-owner-management-atoms.ts'))};
import {activeViewAtom} from ${JSON.stringify(join(renderer, 'atoms/active-view.ts'))};
import {notificationsEnabledAtom} from ${JSON.stringify(join(renderer, 'atoms/notifications.ts'))};
const store=createStore();store.set(notificationsEnabledAtom,true);
let listener,requests=[];const goal={schemaVersion:1,revision:2,state:'draft',actor:'local-user',savedAt:2,goal:{projectId:'p',goalVersion:2,objective:'产品定位',constraints:['受众为现有用户'],acceptanceCriteria:[]}};
const view={manager:{schemaVersion:1,projectId:'p',ownerId:'owner',conversationId:'conversation',revision:1,status:'active',createdAt:1,updatedAt:1},pendingEvents:0,messages:[{id:'message',projectId:'p',conversationId:'conversation',eventId:'e',role:'assistant',kind:'clarification',questionId:'q',content:'需要确认受众',createdAt:1}],questions:[{id:'q',projectId:'p',conversationId:'conversation',executionId:'run',receiptId:'receipt',planningTaskId:'planning',goalRevision:1,contextFingerprint:'f'.repeat(64),reason:'受众决定方案取舍',state:'open',questions:[{key:'audience',reasonType:'missing_information',question:'主要服务谁？',why:'决定定位范围',options:['新用户','现有用户'],recommended:'现有用户'}]}]};
window.electronAPI={sendSystemNotification:async()=>{},onSystemNotificationClicked:()=>()=>{},paa:{project:{
listProjects:async()=>[{id:'p'}],getOwnerManagement:async()=>({ok:true,value:structuredClone(view)}),onOwnerManagementChanged:cb=>{listener=cb;return()=>{listener=null}},
answerOwnerManagementQuestion:async input=>{requests.push(input);view.questions[0].state='answered';if(requests.length===1)throw Error('回包丢失，输入已保留');return {ok:true,value:goal}},
getOwnerGoalDraft:async()=>({ok:true,value:goal}),getOwnerPlanningContext:async()=>({ok:true,value:{goal,fingerprint:'next',sources:{project:{id:'p',title:'项目',description:''},roles:[]}}}),getOwnerPlanDraft:async()=>({ok:true,value:null}),listOwnerPlanHistory:async()=>({ok:true,value:[]})
}}};
window.fixture={push:()=>listener?.({projectId:'p',messageId:'message'}),facts:()=>({requests,navigation:store.get(ownerConversationNavigationAtom),activeView:store.get(activeViewAtom)})};
function Harness(){useGlobalOwnerManagementListeners();return <><OwnerConversationUpdates projects={[{id:'p',title:'定位项目'}]} onOpen={projectId=>{store.set(ownerConversationNavigationAtom,{projectId,at:Date.now()});store.set(activeViewAtom,'projects')}}/><OwnerManagementQuestions projectId="p"/><Toaster/></>}
createRoot(document.getElementById('root')).render(<Provider store={store}><Harness/></Provider>);
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.mp3': 'dataurl' }, absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByRole('heading', { name: '有件事需要和你确认' }).waitFor()
    await page.getByRole('region', { name: 'Owner 对话更新' }).getByRole('button', { name: /定位项目/ }).click()
    expect(await page.evaluate<string>('window.fixture.facts().navigation.projectId')).toBe('p')
    await page.getByRole('button', { name: '打开对话', exact: true }).waitFor()
    await page.evaluate('window.fixture.push()')
    expect(await page.getByRole('button', { name: '打开对话', exact: true }).count()).toBe(1)
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    expect(await page.evaluate<string>('window.fixture.facts().navigation.projectId')).toBe('p')
    expect(await page.evaluate<string>('window.fixture.facts().activeView')).toBe('projects')
    await page.getByRole('button', { name: '现有用户', exact: true }).click()
    expect(await page.getByLabel('主要服务谁？', { exact: true }).inputValue()).toBe('现有用户')
    await page.getByRole('button', { name: '答复，让 Owner 继续', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '回包丢失' }).waitFor()
    expect(await page.getByLabel('主要服务谁？', { exact: true }).inputValue()).toBe('现有用户')
    await page.getByRole('button', { name: '答复，让 Owner 继续', exact: true }).click()
    await page.waitForFunction('window.fixture.facts().requests.length===2 && !document.querySelector("form")')
    expect(await page.evaluate<boolean>('window.fixture.facts().requests[0].requestId===window.fixture.facts().requests[1].requestId')).toBe(true)
    expect(await page.locator('body').evaluate(element => element.scrollWidth <= window.innerWidth)).toBe(true)
    expect(errors).toEqual([])
  } finally { await browser.close(); server.stop(true) }
}, 30000)

browserTest('Given Owner在后台产生实质进展 When 全局监听收到新消息 Then 主动提醒并直达项目对话且重复推送去重', async () => {
  writeFileSync(join(directory, 'progress-entry.tsx'), `
import React from 'react';import {createRoot} from 'react-dom/client';import {Provider,createStore} from 'jotai';import {Toaster} from 'sonner';
import {useGlobalOwnerManagementListeners} from ${JSON.stringify(join(renderer, 'hooks/useGlobalOwnerManagementListeners.ts'))};
import {ownerConversationNavigationAtom,ownerConversationNoticesAtom} from ${JSON.stringify(join(renderer, 'atoms/project-owner-management-atoms.ts'))};
import {activeViewAtom} from ${JSON.stringify(join(renderer, 'atoms/active-view.ts'))};
import {notificationsEnabledAtom} from ${JSON.stringify(join(renderer, 'atoms/notifications.ts'))};
const store=createStore();store.set(notificationsEnabledAtom,true);let listener,desktopNotifications=0,reads=0;const view={manager:{schemaVersion:1,projectId:'p',ownerId:'owner',conversationId:'conversation',revision:1,status:'active',createdAt:1,updatedAt:1},pendingEvents:0,messages:[],questions:[]};
window.electronAPI={sendSystemNotification:async()=>{desktopNotifications++},onSystemNotificationClicked:()=>()=>{},paa:{project:{listProjects:async()=>[],getOwnerManagement:async()=>{reads++;return {ok:true,value:structuredClone(view)}},onOwnerManagementChanged:cb=>{listener=cb;return()=>{listener=null}}}}};
window.fixture={disableNotifications:()=>store.set(notificationsEnabledAtom,false),push:message=>{if(message.id!=='not-persisted')view.messages.push(message);listener?.({projectId:'p',messageId:message.id})},pushInternal:message=>{if(message)view.messages.push(message);listener?.({projectId:'p'})},resetNavigation:()=>{store.set(activeViewAtom,'settings');store.set(ownerConversationNavigationAtom,{projectId:'other',at:Date.now()})},facts:()=>({navigation:store.get(ownerConversationNavigationAtom),activeView:store.get(activeViewAtom),notices:[...store.get(ownerConversationNoticesAtom)],desktopNotifications,reads})};
function Harness(){useGlobalOwnerManagementListeners();return <Toaster/>}createRoot(document.getElementById('root')).render(<Provider store={store}><Harness/></Provider>);
`)
  await build({ entryPoints: [join(directory, 'progress-entry.tsx')], outfile: join(directory, 'progress-entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.mp3': 'dataurl' }, absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'progress-entry.js'))) } })
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    const routineProgress = { id: 'routine-1', projectId: 'p', conversationId: 'conversation', eventId: 'event-routine', role: 'assistant', kind: 'management_progress', content: '我正在按授权范围准备团队安排。', createdAt: 1 }
    await page.evaluate(message => (window as unknown as { fixture: { push: (value: unknown) => void } }).fixture.push(message), routineProgress)
    expect(await page.getByRole('button', { name: '打开对话', exact: true }).count()).toBe(0)
    expect(await page.evaluate<number>('window.fixture.facts().desktopNotifications')).toBe(0)
    const message = { id: 'progress-1', projectId: 'p', conversationId: 'conversation', eventId: 'event-1', role: 'assistant', kind: 'management_progress', content: '员工已完成第一步，我正在检查成果。', createdAt: 2 }
    await page.evaluate(message => (window as unknown as { fixture: { push: (value: unknown) => void } }).fixture.push(message), message)
    await page.getByText('项目进度有更新', { exact: true }).waitFor()
    await page.evaluate(message => (window as unknown as { fixture: { push: (value: unknown) => void } }).fixture.push(message), message)
    expect(await page.getByText('项目进度有更新', { exact: true }).count()).toBe(1)
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    expect(await page.evaluate<string>('window.fixture.facts().navigation.projectId')).toBe('p')
    expect(await page.evaluate<string>('window.fixture.facts().activeView')).toBe('projects')
    const delivery = { ...message, id: 'delivery-1', eventId: 'event-2', kind: 'delivery', content: '交付内容不放进通知正文。' }
    await page.evaluate(message => (window as unknown as { fixture: { push: (value: unknown) => void } }).fixture.push(message), delivery)
    await page.getByText('项目成果已交付', { exact: true }).waitFor()
    await page.evaluate(message => (window as unknown as { fixture: { push: (value: unknown) => void } }).fixture.push(message), delivery)
    expect(await page.getByText('项目成果已交付', { exact: true }).count()).toBe(1)
    await page.evaluate(() => (window as unknown as { fixture: { resetNavigation: () => void } }).fixture.resetNavigation())
    await page.getByRole('button', { name: '打开对话', exact: true }).last().click()
    expect(await page.evaluate<string>('window.fixture.facts().navigation.projectId')).toBe('p')
    expect(await page.evaluate<string>('window.fixture.facts().activeView')).toBe('projects')
    // 消息尚未写入本地视图时，红点也必须能把用户带回项目对话，而不是静默丢弃。
    await page.evaluate(() => (window as unknown as { fixture: { resetNavigation: () => void } }).fixture.resetNavigation())
    await page.evaluate(() => (window as unknown as { fixture: { push: (value: unknown) => void } }).fixture.push({ id: 'not-persisted', projectId: 'p', conversationId: 'conversation', eventId: 'event-3', role: 'assistant', kind: 'reply', content: '这条还没写入本地视图', createdAt: 3 }))
    await page.getByText('项目 Owner 有新的进展', { exact: true }).waitFor()
    await page.getByRole('button', { name: '打开对话', exact: true }).last().click()
    expect(await page.evaluate<string>('window.fixture.facts().navigation.projectId')).toBe('p')
    expect(await page.evaluate<string>('window.fixture.facts().activeView')).toBe('projects')
    const desktopCount = await page.evaluate<number>('window.fixture.facts().desktopNotifications')
    await page.evaluate('window.fixture.disableNotifications()')
    const taskProgress = { ...message, id: 'task-progress', taskId: 'task-1', createdAt: 4 }
    await page.evaluate(message => (window as unknown as { fixture: { push: (value: unknown) => void } }).fixture.push(message), taskProgress)
    await page.getByText('项目进度有更新', { exact: true }).waitFor()
    await page.getByRole('button', { name: '打开对话', exact: true }).last().click()
    expect(await page.evaluate<string>('window.fixture.facts().navigation.taskId')).toBe('task-1')
    expect(await page.evaluate<string>('window.fixture.facts().notices[0][1].taskId')).toBe('task-1')
    expect(await page.evaluate<number>('window.fixture.facts().desktopNotifications')).toBe(desktopCount)
    const internal = { ...message, id: 'internal-observation', kind: 'execution_observation', createdAt: 5 }
    const readsBeforeInternal = await page.evaluate<number>('window.fixture.facts().reads')
    const genericNoticesBeforeInternal = await page.getByText('项目 Owner 有新的进展', { exact: true }).count()
    await page.evaluate(message => (window as unknown as { fixture: { pushInternal: (value: unknown) => void } }).fixture.pushInternal(message), internal)
    await page.waitForFunction(reads => (window as unknown as { fixture: { facts: () => { reads: number } } }).fixture.facts().reads > reads, readsBeforeInternal)
    expect(await page.getByText('项目 Owner 有新的进展', { exact: true }).count()).toBe(genericNoticesBeforeInternal)
    expect(await page.evaluate<string>('window.fixture.facts().notices[0][1].messageId')).toBe('task-progress')
    // 下一次刷新完成后内部观察仍不能替换可见更新入口。
    await page.evaluate(message => (window as unknown as { fixture: { push: (value: unknown) => void } }).fixture.push(message), taskProgress)
    expect(await page.evaluate<string>('window.fixture.facts().notices[0][1].messageId')).toBe('task-progress')
  } finally { await browser.close(); server.stop(true) }
}, 30000)
