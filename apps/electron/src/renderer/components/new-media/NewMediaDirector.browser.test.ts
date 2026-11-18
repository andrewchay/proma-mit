import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'nm-director-browser-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

browserTest('新媒体工作台可预览文案与封面，并直接建立总监会话', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react'; import {createRoot} from 'react-dom/client'; import {Provider,createStore} from 'jotai';
import {NewMediaModuleView} from ${JSON.stringify(join(renderer, 'components/new-media/NewMediaModuleView.tsx'))};
import {agentChannelIdAtom,agentModelIdAtom,agentSessionsAtom,agentSessionDraftsAtom,currentAgentWorkspaceIdAtom} from ${JSON.stringify(join(renderer, 'atoms/agent-atoms.ts'))};
import {activeViewAtom} from ${JSON.stringify(join(renderer, 'atoms/active-view.ts'))};
const store=createStore(); store.set(agentChannelIdAtom,'channel-1'); store.set(agentModelIdAtom,'model-1'); store.set(currentAgentWorkspaceIdAtom,'workspace-1');
const draft={id:'draft-1',directorPlanId:'plan-1',sourceText:'原文',platformCopies:{xiaohongshu:{title:'口语标题',body:'实际笔记正文',hashtags:['#英语口语']}},createdAt:1};
let settings={newMediaCapabilities:[]}, calls=[];const empty=async()=>[];
window.electronAPI={getSettings:async()=>settings,updateSettings:async patch=>{calls.push(['settings',patch]);settings={...settings,...patch}},createAgentSession:async(...args)=>{calls.push(['session',args]);return {id:'session-1',title:'新媒体总监',workspaceId:'workspace-1'}},paa:{newMedia:{content:{listDrafts:async()=>[draft],listPublicationJobs:empty,getDirectorDesignPreview:async()=> ({assetId:'asset-1',dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='})},controlledOutbound:{list:empty,listExecutors:empty},community:{listEngagements:empty},listening:{listQueries:empty,listMentions:empty},analytics:{listSnapshots:empty,listTrends:empty,getReport:async()=>null},xiaohongshuHandoff:{list:empty,prepare:async(...args)=>{calls.push(['prepare',args])}}}}};
window.fixture={state:()=>({calls,sessions:store.get(agentSessionsAtom),draft:store.get(agentSessionDraftsAtom).get('session-1'),view:store.get(activeViewAtom)})};
createRoot(document.getElementById('root')).render(<Provider store={store}><NewMediaModuleView/></Provider>);
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ path: join(directory, 'entry.js') })
    await page.getByText('口语标题').waitFor()
    await page.getByText('查看完整文案').click()
    expect(await page.getByText('实际笔记正文').isVisible()).toBe(true)
    expect(await page.getByAltText('待审核的封面设计').getAttribute('src')).toStartWith('data:image/png;base64,')
    await page.getByRole('button', { name: '准备官方发布交接' }).click()
    await page.getByRole('button', { name: '与总监对话' }).click()
    const state = await page.evaluate(() => (window as unknown as { fixture: { state: () => { calls: unknown[]; sessions: unknown[]; draft: string; view: string } } }).fixture.state())
    expect(state.calls).toEqual([['prepare', ['draft-1', 'asset-1']], ['settings', { newMediaCapabilities: ['content-operations'] }], ['session', ['新媒体总监', 'channel-1', 'workspace-1']]])
    expect(state.sessions).toHaveLength(1)
    expect(state.draft).toContain('先和我确认')
    expect(state.view).toBe('conversations')
  } finally { await browser.close() }
})
