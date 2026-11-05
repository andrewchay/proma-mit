import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

interface SessionSnapshot { session: string | null; workspace: string | null; view: string; reads: number; draft: string; sends: number; stops: string[] }

const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'owner-employee-session-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

browserTest('Given 员工已在项目工作区执行 When 查看只读监控并反馈或打开后台规划会话 Then 普通监控保留且后台回复引导至项目', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react';import {createRoot} from 'react-dom/client';import {Provider,createStore} from 'jotai';
import {AgentView} from ${JSON.stringify(join(renderer, 'components/agent/AgentView.tsx'))};
import {ProjectOwnerConversationProgress} from ${JSON.stringify(join(renderer, 'components/projects/ProjectOwnerConversationProgress.tsx'))};
import {ownerCommandProgressApiAtom,loadOwnerCommandProgressAtom} from ${JSON.stringify(join(renderer, 'atoms/owner-command-progress-atoms.ts'))};
import {currentAgentSessionIdAtom,currentAgentWorkspaceIdAtom,agentStreamingStatesAtom,liveMessagesMapAtom} from ${JSON.stringify(join(renderer, 'atoms/agent-atoms.ts'))};
import {activeViewAtom} from ${JSON.stringify(join(renderer, 'atoms/active-view.ts'))};
import {ownerConversationNavigationAtom,ownerMessageComposersAtom,getOwnerMessageComposer,ownerManagementEditorsAtom} from ${JSON.stringify(join(renderer, 'atoms/project-owner-management-atoms.ts'))};
const store=createStore(),subject={projectId:'p'},ok=value=>({ok:true,value});let wrongProject=false,reads=0,sends=0,carrierReads=0,stops=[],history=[];
const command={commandId:'command',executionId:'execution',employeeId:'worker',taskId:'task',taskTitle:'项目调研',role:'executor',state:'running',executionStatus:'running',updatedAt:1,acceptanceCriteria:[]};
store.set(ownerCommandProgressApiAtom,{listOwnerExecutionCommands:async()=>ok([command,...history]),getOwnerAutonomousScheduleStatus:async()=>ok({projectId:'p',state:'running'})});
window.electronAPI={sendAgentMessage:async()=>{sends++},getAgentSessionSDKMessages:async id=>id==='carrier'?(carrierReads++,[{type:'assistant',message:{content:[{type:'text',text:'{"kind":"conversation_reply","binding":{"contextFingerprint":"internal"},"message":"回复"}'},{type:'text',text:'{"schemaVersion":1,"selectedStepKeys":["step-1"]}'},{type:'text',text:'**svg**'}]}}]):[{type:'user',uuid:'u1',message:{role:'user',content:[{type:'text',text:'员工冻结任务'}]}},{type:'assistant',uuid:'a1',message:{role:'assistant',content:[{type:'text',text:'正在核查资料与编写成果，**重点**'}]}}],updateSettings:async()=>({}),listAgentSessions:async()=>[{id:'carrier',ownerPlanningProjectId:'p',ownerReadOnly:false},{id:'session',projectId:'p',workspaceId:'team-workspace',title:'调研员工会话'},{id:'unrelated',projectId:'other',workspaceId:'other-workspace',title:'无关会话'}],paa:{agentEmployees:{cancelExecution:async id=>{stops.push(id);return {id,status:'running',stopRequested:true,stopped:false,processTermination:'NOT_VERIFIED'}},listExecutionsByEntity:async()=>{reads++;return [{id:'execution',projectId:wrongProject?'other':'p',entityType:'task',entityId:'task',agentId:'worker',sessionId:'session',status:'running'}]}}}};
window.fixture={overlap:()=>store.set(liveMessagesMapAtom,new Map([['session',[{type:'assistant',uuid:'a1',message:{role:'assistant',content:[{type:'text',text:'正在核查资料与编写成果，**重点**'}]}}]]])),live:()=>{store.set(liveMessagesMapAtom,new Map());store.set(agentStreamingStatesAtom,new Map([['session',{running:true,content:'实时核查第二份资料',toolActivities:[]}]]))},corrupt:()=>{wrongProject=true},snapshot:()=>({session:store.get(currentAgentSessionIdAtom),workspace:store.get(currentAgentWorkspaceIdAtom),view:store.get(activeViewAtom),reads,draft:getOwnerMessageComposer(store.get(ownerMessageComposersAtom),subject).text,sends,stops})};
window.fixture.completeStop=async()=>{command.state='cancelled';command.executionStatus='cancelled';command.updatedAt=1000;await store.set(loadOwnerCommandProgressAtom,subject)};
window.fixture.attention=enabled=>store.set(ownerManagementEditorsAtom,enabled?new Map([['p',{view:{messages:[{projectId:'p',role:'assistant',kind:'attention',content:'内部核对问题',createdAt:1}]}}]]):new Map());
window.fixture.addHistory=async()=>{history=Array.from({length:8},(_,i)=>({...command,commandId:'history-'+i,executionId:'history-execution-'+i,taskId:'history-task-'+i,taskTitle:'旧任务 '+i,state:'settled',executionStatus:'completed',updatedAt:100+i}));await store.set(loadOwnerCommandProgressAtom,subject)};
const root=createRoot(document.getElementById('root'));
window.fixture.openCarrier=()=>root.render(<Provider store={store}><AgentView sessionId="carrier"/></Provider>);
window.fixture.carrierFacts=()=>({carrierReads,navigation:store.get(ownerConversationNavigationAtom),view:store.get(activeViewAtom)});
root.render(<Provider store={store}><ProjectOwnerConversationProgress subject={subject}/></Provider>);
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage()
  page.setDefaultTimeout(5000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.evaluate('window.fixture.attention(true)')
    await page.getByText('Owner 提出需要关注的事项，请查看最新说明。', { exact: true }).waitFor()
    expect(await page.getByText('Owner 正在等你处理一项待确认内容。', { exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: '回复 Owner', exact: true }).count()).toBe(0)
    await page.evaluate('window.fixture.attention(false)')
    await page.evaluate('window.fixture.addHistory()')
    const before = await page.evaluate<SessionSnapshot>('window.fixture.snapshot()')
    await page.getByRole('button', { name: '停止此执行', exact: true }).click()
    await page.getByText('已发送停止请求，等待运行结束；尚未确认底层操作终止。', { exact: true }).waitFor()
    expect((await page.evaluate<SessionSnapshot>('window.fixture.snapshot()')).stops).toEqual(['execution'])
    await page.evaluate('window.fixture.completeStop()')
    await page.getByText('执行记录已更新为cancelled；底层操作与费用以执行证据为准。', { exact: true }).waitFor()
    await page.getByLabel('员工会话进度').locator('article').filter({ hasText: '项目调研' }).getByRole('button', { name: '查看工作记录（只读）' }).click()
    await page.getByText('正在核查资料与编写成果，', { exact: false }).first().waitFor()
    expect(await page.locator('strong').getByText('重点', { exact: true }).count()).toBe(1)
    await page.evaluate('window.fixture.overlap()')
    expect(await page.locator('strong').getByText('重点', { exact: true }).count()).toBe(1)
    expect(await page.getByRole('textbox').count()).toBe(0)
    expect(await page.getByRole('button', { name: '编辑并重发' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: '打开员工会话' }).count()).toBe(0)
    const monitored = await page.evaluate<SessionSnapshot>('window.fixture.snapshot()')
    expect(monitored.session).toBe(before.session)
    expect(monitored.workspace).toBe(before.workspace)
    expect(monitored.view).toBe(before.view)
    expect(monitored.reads).toBeGreaterThan(0)
    await page.evaluate('window.fixture.live()')
    await page.getByLabel('员工只读执行记录').getByText('实时核查第二份资料', { exact: true }).waitFor()
    await page.getByRole('button', { name: '向 Owner 反馈这项工作' }).click()
    const feedback = await page.evaluate<SessionSnapshot>('window.fixture.snapshot()')
    expect(feedback.draft).toContain('项目调研')
    expect(feedback.draft).toContain('执行标识：execution')
    expect(feedback.sends).toBe(0)
    await page.evaluate('window.fixture.corrupt()')
    await page.getByRole('alert').getByText('命令对应的执行会话尚不可用，请刷新后核对', { exact: true }).waitFor()
    expect(await page.getByText('正在核查资料与编写成果', { exact: false }).count()).toBe(0)
    await page.evaluate('window.fixture.openCarrier()')
    await page.getByRole('heading', { name: '在项目对话中查看 Owner 回复' }).waitFor()
    expect(await page.getByText(/contextFingerprint|selectedStepKeys|svg/).count()).toBe(0)
    await page.getByRole('button', { name: '打开 Owner 项目对话' }).click()
    expect(await page.evaluate('window.fixture.carrierFacts()')).toMatchObject({
      carrierReads: 0, navigation: { projectId: 'p' }, view: 'projects',
    })
    expect(errors).toEqual([])
  } finally { await browser.close(); server.stop(true) }
}, 20000)
