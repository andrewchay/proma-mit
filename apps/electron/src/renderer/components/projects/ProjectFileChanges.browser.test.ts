import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'project-file-change-browser-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

browserTest('Given 绑定工作区有变化 When 用户查看并加入草稿 Then 保留原草稿且不会自动发送', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react'; import {createRoot} from 'react-dom/client'; import {Provider,createStore} from 'jotai';
import {ProjectWorkspacesPanel} from ${JSON.stringify(join(renderer, 'components/projects/ProjectWorkspacesPanel.tsx'))};
import {editOwnerMessageAtom, ownerMessageComposersAtom, getOwnerMessageComposer, ownerConversationNavigationAtom} from ${JSON.stringify(join(renderer, 'atoms/project-owner-management-atoms.ts'))};
const store=createStore(), subject={projectId:'p'}; store.set(editOwnerMessageAtom,{subject,text:'已有草稿'});
let calls=0, sends=0, policyCalls=[];
window.electronAPI={listAgentWorkspaces:async()=>[{id:'w',name:'研发',slug:'dev',rootPath:'/project'}],paa:{projectWorkspace:{listByProject:async()=>[{projectId:'p',workspaceId:'w',createdAt:1}],bind:async()=>null,unbind:async()=>true,listFileChanges:async()=>{calls++;return {changes:[{path:'src/file.ts',kind:'modified',observedAt:1000}],lastScannedAt:1000,scanError:null,watching:true}},getGitDiff:async()=>({status:'available',text:'+updated'}),getFileChangePolicy:async()=>null,setFileChangePolicy:async(p,w,enabled)=>{policyCalls.push(enabled);return enabled?{revision:'r',enabledAt:1}:null}},project:{sendOwnerManagementMessage:async()=>{sends++}}}};
window.fixture={facts:()=>({calls,sends,policyCalls,composer:getOwnerMessageComposer(store.get(ownerMessageComposersAtom),subject),navigation:store.get(ownerConversationNavigationAtom)})};
createRoot(document.getElementById('root')).render(<Provider store={store}><ProjectWorkspacesPanel projectId="p"/></Provider>);
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    const toggle = page.getByRole('checkbox', { name: /允许 Owner 自动分析/ })
    await toggle.check()
    await toggle.uncheck()
    await page.getByRole('button', { name: '查看文件变化' }).click()
    await page.getByText(/src\/file.ts/).waitFor()
    await page.getByRole('button', { name: '查看当前 Git 差异' }).click()
    await page.getByText('+updated', { exact: true }).waitFor()
    await page.getByRole('button', { name: '将最近 20 条加入 Owner 消息草稿' }).click()
    const facts = await page.evaluate<{ calls: number; sends: number; policyCalls: boolean[]; composer: { text: string }; navigation: { projectId: string } }>('window.fixture.facts()')
    expect(facts.calls).toBe(1)
    expect(facts.sends).toBe(0)
    expect(facts.policyCalls).toEqual([true, false])
    expect(facts.composer.text).toContain('已有草稿')
    expect(facts.composer.text).toContain('src/file.ts')
    expect(facts.navigation.projectId).toBe('p')
  } finally { await browser.close(); server.stop(true) }
}, 30000)
