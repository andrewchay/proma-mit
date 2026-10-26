import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'project-owner-entry-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

browserTest('Given 项目管理模式 When 用户浏览项目并打开项目 Then 界面只呈现项目Owner对话', async () => {
  const entry = join(directory, 'entry.tsx')
  writeFileSync(entry, `
import React from 'react';import {createRoot} from 'react-dom/client';
import {Provider,createStore} from 'jotai';
import {ProjectView} from ${JSON.stringify(join(renderer, 'components/projects/ProjectView.tsx'))};
window.electronAPI={paa:{project:{listProjects:async()=>[{id:'p',title:'产品定位',description:'形成建议',status:'planning',createdAt:1,updatedAt:1}],getOwnerGoalDraft:async()=>({ok:true,value:null}),getOwnerManagement:async()=>({ok:true,value:{messages:[]}}),getOwnerManagementDelegation:async()=>({ok:true,value:null})}},getSettings:async()=>({})};
createRoot(document.getElementById('root')).render(<Provider store={createStore()}><ProjectView/></Provider>);
`)
  await build({ entryPoints: [entry], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.mp3': 'dataurl' }, absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.port}`)
    const entryButton = page.getByRole('button', { name: '与 产品定位 的 Owner 对话', exact: true })
    await entryButton.waitFor()
    for (const label of ['我的工作', '看板', '团队', '日程管家', '风险正常', '任务 0/0', '进度']) expect(await page.getByText(label, { exact: true }).count()).toBe(0)
    await entryButton.click()
    await page.getByRole('heading', { name: '项目 Owner' }).waitFor()
    await page.getByLabel('希望达成的目标').waitFor()
    expect(await page.getByText('项目管理详情（高级）', { exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: '我的工作', exact: true }).count()).toBe(0)
  } finally { await browser.close(); server.stop(true) }
}, 30000)
