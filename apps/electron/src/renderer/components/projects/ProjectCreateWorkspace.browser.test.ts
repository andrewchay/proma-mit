import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'project-create-workspace-'))
const servers: Array<{ stop: (closeConnections?: boolean) => void }> = []
afterAll(() => { for (const server of servers) server.stop(true); rmSync(directory, { recursive: true, force: true }) })
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

interface FixtureFacts { created: number; workspaceName: string | null; bindCalls: Array<{ projectId: string; workspaceId: string }> }

browserTest('Given 新建项目面板 When 默认创建 Then 创建 Owner 专用工作区并自动绑定', async () => {
  await renderFixture()
  const page = await openPage()
  try {
    await page.getByRole('button', { name: '+ 新建项目' }).click()
    await page.getByText('项目工作空间').waitFor()
    // 默认选中「创建新的 Owner 专用工作区」
    await page.getByRole('radio', { name: /创建新的 Owner 专用工作区/ }).waitFor()
    await page.getByPlaceholder('项目名称').fill('五年日记本')
    await page.getByRole('button', { name: '创建', exact: true }).click()
    await page.waitForFunction("window.fixture.facts().created === 1")
    const facts = await page.evaluate<FixtureFacts>('window.fixture.facts()')
    expect(facts.created).toBe(1)
    expect(facts.workspaceName).toMatch(/^Owner-p1-[0-9a-f]{6}$/)
    expect(facts.bindCalls).toEqual([{ projectId: 'p1', workspaceId: 'w-new' }])
  } finally { await page.context().browser()?.close() }
}, 30000)

browserTest('Given 新建项目面板 When 选择使用现有工作区 Then 不创建新工作区并绑定所选', async () => {
  await renderFixture()
  const page = await openPage()
  try {
    await page.getByRole('button', { name: '+ 新建项目' }).click()
    await page.getByRole('radio', { name: /使用现有工作区/ }).check()
    await page.locator('fieldset select').selectOption('w1')
    await page.getByPlaceholder('项目名称').fill('五年日记本')
    await page.getByRole('button', { name: '创建', exact: true }).click()
    await page.waitForFunction("window.fixture.facts().created === 1")
    const facts = await page.evaluate<FixtureFacts>('window.fixture.facts()')
    expect(facts.created).toBe(1)
    expect(facts.workspaceName).toBeNull()
    expect(facts.bindCalls).toEqual([{ projectId: 'p1', workspaceId: 'w1' }])
  } finally { await page.context().browser()?.close() }
}, 30000)

async function renderFixture(): Promise<void> {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react'; import {createRoot} from 'react-dom/client'; import {Provider,createStore} from 'jotai';
import {ProjectList} from ${JSON.stringify(join(renderer, 'components/projects/ProjectView.tsx'))};
const store=createStore();
let created=0, workspaceName=null, bindCalls=[];
window.electronAPI={
  listAgentWorkspaces:async()=>[{id:'w1',name:'研发',slug:'dev',rootPath:'/project'},{id:'w2',name:'托管空间',slug:'m',rootPath:null}],
  paa:{
    project:{
      createProject:async(input)=>{created++;return {id:'p1',title:input.title,description:input.description}},
      createOwnerDedicatedWorkspace:async({name})=>{workspaceName=name;return {ok:true,value:{id:'w-new',name,slug:name}}},
    },
    projectWorkspace:{bind:async(projectId,workspaceId)=>{bindCalls.push({projectId,workspaceId});return {projectId,workspaceId,createdAt:1}}},
  },
};
window.fixture={facts:()=>({created,workspaceName,bindCalls})};
createRoot(document.getElementById('root')).render(<Provider store={store}><ProjectList projects={[]} isLoading={false} onSelectProject={()=>{}} onProjectsChange={()=>{}}/></Provider>);
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, loader: { '.mp3': 'empty', '.css': 'empty', '.png': 'empty', '.svg': 'empty', '.woff2': 'empty' }, logLevel: 'silent' })
}

async function openPage() {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  servers.push(server)
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.port}`)
  return page
}
