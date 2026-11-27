import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'owner-navigation-browser-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = test

browserTest('Given 项目 Owner 在后台发出进展 When 用户点击应用内打开对话 Then 打开准确项目的 Owner 对话', async () => {
  const entry = join(directory, 'entry.tsx')
  writeFileSync(entry, `
import React from 'react';import {createRoot} from 'react-dom/client';import {Provider,createStore,useAtomValue} from 'jotai';
import {Toaster} from ${JSON.stringify(join(renderer, 'components/ui/sonner.tsx'))};
import {ProjectView} from ${JSON.stringify(join(renderer, 'components/projects/ProjectView.tsx'))};
import {useGlobalOwnerManagementListeners} from ${JSON.stringify(join(renderer, 'hooks/useGlobalOwnerManagementListeners.ts'))};
import {activeViewAtom} from ${JSON.stringify(join(renderer, 'atoms/active-view.ts'))};
const store=createStore(),project={id:'project-a',title:'准确目标项目',description:'测试项目'};let listener,ready=false;const messages=[];
const manager={schemaVersion:1,projectId:project.id,ownerId:'owner-a',conversationId:'conversation-a',revision:1,status:'active',createdAt:1,updatedAt:1};
const view=()=>({manager,pendingEvents:0,messages:[...messages],questions:[],changes:[]});
const api={listProjects:async()=>[project],getProject:async id=>id===project.id?project:null,getOwnerManagement:async input=>input.projectId===project.id?{ok:true,value:view()}:{ok:false,error:{message:'项目不匹配'}},onOwnerManagementChanged:callback=>{listener=callback;ready=true;return()=>{listener=null;ready=false}},getOwnerGoalDraft:async()=>({ok:false,error:{message:'目标未建立'}}),getOwnerRuntimeBinding:async()=>({ok:true,value:null}),getOwnerManagementDelegation:async()=>({ok:true,value:{delegation:null,state:'none',usedRequests:0,reservedCostMicros:0}})};
window.electronAPI={getSettings:async()=>({}),listChannels:async()=>[],listAgentWorkspaces:async()=>[],paa:{project:api,projectWorkspace:{listByProject:async()=>[]},agentEmployees:{list:async()=>[]}},sendSystemNotification:async()=>{},onSystemNotificationClicked:()=>()=>{}};
window.fixture={isReady:()=>ready,push:message=>{messages.push(message);listener?.({projectId:project.id,messageId:message.id})},facts:()=>({activeView:store.get(activeViewAtom),title:document.querySelector('h1')?.textContent,owner:document.querySelector('[aria-label="Owner 项目对话"]')?.getAttribute('data-project-id')})};
function Harness(){useGlobalOwnerManagementListeners();const activeView=useAtomValue(activeViewAtom);return <>{activeView==='projects'?<ProjectView/>:<main>其他页面</main>}<Toaster/></>}
createRoot(document.getElementById('root')).render(<Provider store={store}><Harness/></Provider>);
`)
  await build({ entryPoints: [entry], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.mp3': 'dataurl', '.png': 'dataurl' }, absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    page.setDefaultTimeout(5000)
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.waitForFunction(() => (window as unknown as { fixture: { isReady: () => boolean } }).fixture.isReady())
    await page.evaluate(() => (window as unknown as { fixture: { push: (message: unknown) => void } }).fixture.push({ id: 'message-1', projectId: 'project-a', conversationId: 'conversation-a', eventId: 'event-1', role: 'assistant', kind: 'management_progress', content: '员工已完成第一步，我正在检查成果。', createdAt: 2 }))
    await page.getByRole('button', { name: '打开对话', exact: true }).waitFor()
    const openButton = page.getByRole('button', { name: '打开对话', exact: true })
    expect(await openButton.getAttribute('class')).toContain('titlebar-no-drag')
    await openButton.click()
    await page.getByRole('heading', { name: '准确目标项目', level: 1 }).waitFor()
    await page.getByLabel('Owner 项目对话').waitFor()
    expect(await page.evaluate(() => (window as unknown as { fixture: { facts: () => { activeView: string; title?: string; owner?: string } } }).fixture.facts())).toMatchObject({ activeView: 'projects', title: '准确目标项目', owner: 'project-a' })
    expect(errors).toEqual([])
  } finally { await browser.close(); server.stop(true) }
}, 30000)

browserTest('Given 项目列表保持打开 When 任务级问题出现、答复或读取失败 Then 更新对应状态并保留准确任务入口', async () => {
  const entry = join(directory, 'status.tsx'), output = join(directory, 'status.js')
  writeFileSync(entry, `
import React from 'react';import {createRoot} from 'react-dom/client';
import {ProjectView} from ${JSON.stringify(join(renderer, 'components/projects/ProjectView.tsx'))};
const projects=[{id:'a',title:'A 进行中的项目',description:''},{id:'b',title:'Z 服务台项目',description:''}];
const listeners=new Set(),reads=[],subjects=[];
let releaseInitial,waiting=false,failed=false;
const taskId='shift-task';
const ok=value=>({ok:true,value});
const manager={schemaVersion:1,projectId:'b',ownerId:'owner',conversationId:'c',revision:1,status:'active',createdAt:1,updatedAt:1};
const questions=[{id:'q',projectId:'b',taskId,conversationId:'c',executionId:'run',receiptId:'receipt',planningTaskId:'planning',goalRevision:1,contextFingerprint:'f'.repeat(64),reason:'时段决定交接安排',state:'open',questions:[{key:'shift',reasonType:'missing_information',question:'选择甲时段还是乙时段？',why:'决定交接范围',options:['甲时段','乙时段']}]}];
const state=projectId=>({ok:true,value:{projectId,state:projectId==='a'?'running':'no_grant',reason:'',reservedCostMicros:0,committedCostMicros:0,runReservations:0,...(projectId==='b'&&waiting?{waitingQuestion:{taskId:'shift-task'}}:{})}});
const loadStatus=async({projectId})=>{
  reads.push(projectId);
  const snapshot=state(projectId);
  if(projectId==='b'&&reads.filter(id=>id==='b').length===1) return new Promise(resolve=>{releaseInitial=()=>resolve(snapshot)});
  return failed&&projectId==='b'?{ok:false,error:{message:'状态服务不可用'}}:snapshot;
};
window.electronAPI={getSettings:async()=>({}),listChannels:async()=>[],listAgentWorkspaces:async()=>[],paa:{project:{
  listProjects:async()=>projects,getProject:async id=>projects.find(project=>project.id===id),getOwnerAutonomousScheduleStatus:loadStatus,
  onOwnerManagementChanged:callback=>{listeners.add(callback);return()=>listeners.delete(callback)},
  getOwnerManagement:async ({projectId})=>ok({manager:projectId==='b'?manager:null,messages:[],questions:projectId==='b'?questions:[],changes:[],pendingEvents:0}),
  getOwnerGoalDraft:async subject=>{subjects.push(subject);return ok(subject.projectId==='b'?{schemaVersion:1,revision:1,state:'draft',actor:'local-user',savedAt:1,goal:{...subject,goalVersion:1,objective:'准备服务台交接',constraints:[],acceptanceCriteria:[]}}:null)},
  getOwnerPlanDraft:async()=>ok(null), getOwnerRuntimeBinding:async()=>ok(null), getOwnerManagementDelegation:async()=>ok({delegation:null,state:'none',usedRequests:0,reservedCostMicros:0})
},projectWorkspace:{listByProject:async()=>[]},agentEmployees:{list:async()=>[]}}};
window.fixture={ready:()=>!!releaseInitial&&listeners.size>0,change:(open,error)=>{waiting=open;failed=error;for(const listener of listeners)listener({projectId:'b'})},release:()=>releaseInitial(),facts:()=>({reads,subjects})};
createRoot(document.getElementById('root')).render(<ProjectView/>);
`)
  await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.mp3': 'dataurl', '.png': 'dataurl' }, absWorkingDir: root, alias: { '@': renderer }, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/status.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/status.js': () => new Response(Bun.file(output)) } })
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  type FixtureWindow = Window & { fixture: { ready(): boolean; change(open: boolean, error: boolean): void; release(): void; facts(): { reads: string[]; subjects: Array<{ projectId: string; taskId?: string }> } } }
  try {
    page.setDefaultTimeout(5000)
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture.ready())
    await page.evaluate(() => {
      const { fixture } = window as unknown as FixtureWindow
      fixture.change(true, false)
      fixture.release()
    })
    const section = page.getByRole('region', { name: '项目状态' }), rows = section.getByRole('button')
    const waiting = section.getByRole('button', { name: /Z 服务台项目.*等待你.*在 Owner 对话回答问题/ })
    await waiting.waitFor()
    expect(await rows.first().innerText()).toContain('Z 服务台项目')
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.facts().reads)).toEqual(['a', 'b', 'b'])
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.change(false, false))
    await section.getByRole('button', { name: /Z 服务台项目.*未开始/ }).waitFor()
    expect(await rows.first().innerText()).toContain('A 进行中的项目')
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.change(false, true))
    await section.getByText('读取失败：状态服务不可用').waitFor()
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.facts().reads)).toEqual(['a', 'b', 'b', 'b', 'b'])
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.change(true, false))
    await waiting.click()
    await page.getByRole('heading', { name: 'Z 服务台项目', level: 1 }).waitFor()
    await page.getByRole('radio', { name: '乙时段' }).waitFor()
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.facts().subjects))
      .toContainEqual({ projectId: 'b', taskId: 'shift-task' })
    await page.getByRole('button', { name: '返回项目 Owner' }).click()
    await page.getByRole('radio', { name: '乙时段' }).waitFor({ state: 'hidden' })
  } finally { await browser.close(); server.stop(true) }
}, 30000)
