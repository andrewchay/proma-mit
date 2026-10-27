import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

interface SessionSnapshot { session: string | null; workspace: string | null; view: string; reads: number; draft: string; sends: number }

const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'owner-employee-session-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

browserTest('Given 员工已在项目工作区执行 When 查看只读监控并反馈 Then 不进入员工聊天且问题仅进入Owner草稿', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react';import {createRoot} from 'react-dom/client';import {Provider,createStore} from 'jotai';
import {ProjectOwnerConversationProgress} from ${JSON.stringify(join(renderer, 'components/projects/ProjectOwnerConversationProgress.tsx'))};
import {ownerCommandProgressApiAtom} from ${JSON.stringify(join(renderer, 'atoms/owner-command-progress-atoms.ts'))};
import {currentAgentSessionIdAtom,currentAgentWorkspaceIdAtom,agentStreamingStatesAtom} from ${JSON.stringify(join(renderer, 'atoms/agent-atoms.ts'))};
import {activeViewAtom} from ${JSON.stringify(join(renderer, 'atoms/active-view.ts'))};
import {ownerMessageComposersAtom,getOwnerMessageComposer} from ${JSON.stringify(join(renderer, 'atoms/project-owner-management-atoms.ts'))};
const store=createStore(),subject={projectId:'p'},ok=value=>({ok:true,value});let wrongProject=false,reads=0,sends=0;
const command={commandId:'command',executionId:'execution',employeeId:'worker',taskId:'task',taskTitle:'项目调研',role:'executor',state:'running',updatedAt:1,acceptanceCriteria:[]};
store.set(ownerCommandProgressApiAtom,{listOwnerExecutionCommands:async()=>ok([command]),getOwnerAutonomousScheduleStatus:async()=>ok({projectId:'p',state:'running'})});
window.electronAPI={sendAgentMessage:async()=>{sends++},getAgentSessionSDKMessages:async()=>[{type:'user',uuid:'u1',message:{role:'user',content:[{type:'text',text:'员工冻结任务'}]}},{type:'assistant',uuid:'a1',message:{role:'assistant',content:[{type:'text',text:'正在核查资料与编写成果'}]}}],updateSettings:async()=>({}),listAgentSessions:async()=>[{id:'session',projectId:'p',workspaceId:'team-workspace',title:'调研员工会话'},{id:'unrelated',projectId:'other',workspaceId:'other-workspace',title:'无关会话'}],paa:{agentEmployees:{listExecutionsByEntity:async()=>{reads++;return [{id:'execution',projectId:wrongProject?'other':'p',entityType:'task',entityId:'task',agentId:'worker',sessionId:'session'}]}}}};
window.fixture={live:()=>store.set(agentStreamingStatesAtom,new Map([['session',{running:true,content:'实时核查第二份资料',toolActivities:[]}]])),corrupt:()=>{wrongProject=true},snapshot:()=>({session:store.get(currentAgentSessionIdAtom),workspace:store.get(currentAgentWorkspaceIdAtom),view:store.get(activeViewAtom),reads,draft:getOwnerMessageComposer(store.get(ownerMessageComposersAtom),subject).text,sends})};
createRoot(document.getElementById('root')).render(<Provider store={store}><ProjectOwnerConversationProgress subject={subject}/></Provider>);
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage()
  page.setDefaultTimeout(5000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    const before = await page.evaluate<SessionSnapshot>('window.fixture.snapshot()')
    await page.getByRole('button', { name: '查看工作记录（只读）' }).click()
    await page.getByText('正在核查资料与编写成果', { exact: true }).waitFor()
    expect(await page.getByRole('textbox').count()).toBe(0)
    expect(await page.getByRole('button', { name: '编辑并重发' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: '打开员工会话' }).count()).toBe(0)
    const monitored = await page.evaluate<SessionSnapshot>('window.fixture.snapshot()')
    expect(monitored.session).toBe(before.session)
    expect(monitored.workspace).toBe(before.workspace)
    expect(monitored.view).toBe(before.view)
    expect(monitored.reads).toBeGreaterThan(0)
    await page.evaluate('window.fixture.live()')
    await page.getByLabel('员工实时输出').getByText('实时核查第二份资料', { exact: true }).waitFor()
    await page.getByRole('button', { name: '向 Owner 反馈这项工作' }).click()
    const feedback = await page.evaluate<SessionSnapshot>('window.fixture.snapshot()')
    expect(feedback.draft).toContain('项目调研')
    expect(feedback.draft).toContain('执行标识：execution')
    expect(feedback.sends).toBe(0)
    await page.evaluate('window.fixture.corrupt()')
    await page.getByRole('alert').getByText('命令对应的执行会话尚不可用，请刷新后核对', { exact: true }).waitFor()
    expect(await page.getByText('正在核查资料与编写成果', { exact: true }).count()).toBe(0)
    expect(errors).toEqual([])
  } finally { await browser.close(); server.stop(true) }
}, 20000)
