import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'workflow-audit-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

browserTest('Given 切换 Run When 旧请求晚到 Then 不展示或切回旧 Run', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react'; import {createRoot} from 'react-dom/client'; import {Provider, createStore} from 'jotai';
import {WorkflowSidebarList} from ${JSON.stringify(join(renderer, 'components/workflow/WorkflowSidebarList.tsx'))};
import {workflowDraftAtom, selectedWorkflowIdAtom} from ${JSON.stringify(join(renderer, 'atoms/workflow-atoms.ts'))};
const draft={id:'wf',name:'测试',status:'published',version:'1',workspaceId:'ws'};
const runs=['old-run','new-run'].map((id,i)=>({id,status:'completed',updatedAt:i+1})); let releaseOld;
window.electronAPI={listWorkflowDefinitions:async()=>[draft],listWorkflowTemplates:async()=>[],listWorkflowRuns:async()=>runs,getWorkflowRun:async(_wf,id)=>{if(id==='old-run') await new Promise(resolve=>{releaseOld=resolve});return runs.find(r=>r.id===id)},listWorkflowRunEvents:async(_wf,id)=>[{id:id+'-event',runId:id,type:id+'-event',occurredAt:1}]};
window.releaseOld=()=>releaseOld(); const store=createStore(); store.set(workflowDraftAtom,draft);store.set(selectedWorkflowIdAtom,'wf');
createRoot(document.getElementById('root')).render(<Provider store={store}><WorkflowSidebarList/></Provider>);
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.webp': 'dataurl' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByRole('button', { name: /old-run/ }).click()
    await page.getByRole('button', { name: /new-run/ }).click()
    await page.getByText(/new-run-event/).waitFor()
    await page.evaluate('window.releaseOld()')
    await page.waitForTimeout(100)
    expect(await page.getByText(/new-run-event/).count()).toBe(1)
    expect(await page.getByText(/old-run-event/).count()).toBe(0)
  } finally { await browser.close(); server.stop(true) }
}, 30000)
