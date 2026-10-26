import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

interface SessionSnapshot { session: string; workspace: string; view: string; reads: number }

const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'owner-employee-session-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

browserTest('Given 员工已在项目工作区执行 When 打开员工会话 Then 定位准确会话且拒绝跨项目记录', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react';import {createRoot} from 'react-dom/client';import {Provider,createStore} from 'jotai';
import {ProjectOwnerConversationProgress} from ${JSON.stringify(join(renderer, 'components/projects/ProjectOwnerConversationProgress.tsx'))};
import {ownerCommandProgressApiAtom} from ${JSON.stringify(join(renderer, 'atoms/owner-command-progress-atoms.ts'))};
import {currentAgentSessionIdAtom,currentAgentWorkspaceIdAtom} from ${JSON.stringify(join(renderer, 'atoms/agent-atoms.ts'))};
import {activeViewAtom} from ${JSON.stringify(join(renderer, 'atoms/active-view.ts'))};
const store=createStore(),subject={projectId:'p'},ok=value=>({ok:true,value});let wrongProject=false,reads=0;
const command={commandId:'command',executionId:'execution',employeeId:'worker',taskId:'task',taskTitle:'项目调研',role:'executor',state:'running',updatedAt:1,acceptanceCriteria:[]};
store.set(ownerCommandProgressApiAtom,{listOwnerExecutionCommands:async()=>ok([command]),getOwnerAutonomousScheduleStatus:async()=>ok({projectId:'p',state:'running'})});
window.electronAPI={updateSettings:async()=>({}),listAgentSessions:async()=>[{id:'session',projectId:'p',workspaceId:'team-workspace',title:'调研员工会话'},{id:'unrelated',projectId:'other',workspaceId:'other-workspace',title:'无关会话'}],paa:{agentEmployees:{listExecutionsByEntity:async()=>{reads++;return [{id:'execution',projectId:wrongProject?'other':'p',entityType:'task',entityId:'task',agentId:'worker',sessionId:'session'}]}}}};
window.fixture={corrupt:()=>{wrongProject=true},snapshot:()=>({session:store.get(currentAgentSessionIdAtom),workspace:store.get(currentAgentWorkspaceIdAtom),view:store.get(activeViewAtom),reads})};
createRoot(document.getElementById('root')).render(<Provider store={store}><ProjectOwnerConversationProgress subject={subject}/></Provider>);
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage()
  page.setDefaultTimeout(5000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByRole('button', { name: '打开员工会话' }).click()
    await page.waitForFunction('window.fixture.snapshot().session === "session"')
    expect(await page.evaluate<SessionSnapshot>('window.fixture.snapshot()')).toEqual({ session: 'session', workspace: 'team-workspace', view: 'conversations', reads: 1 })
    await page.evaluate('window.fixture.corrupt()')
    await page.getByRole('button', { name: '打开员工会话' }).click()
    await page.getByRole('alert').getByText('命令对应的执行会话尚不可用，请刷新后核对', { exact: true }).waitFor()
    expect(await page.evaluate<SessionSnapshot>('window.fixture.snapshot()')).toEqual({ session: 'session', workspace: 'team-workspace', view: 'conversations', reads: 2 })
    expect(errors).toEqual([])
  } finally { await browser.close(); server.stop(true) }
}, 20000)
