import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../../../../..')
const directory = mkdtempSync(join(tmpdir(), 'owner-details-placement-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

browserTest('Given 成果草稿 When 切换视图及 Owner 目标编辑时宿主消失 Then 表单内容和讨论草稿保持不变', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ProjectDetailsPlacement} from ${JSON.stringify(join(import.meta.dir, 'ProjectDetailsPlacement.tsx'))};
function App(){const [host,setHost]=useState(null),[owner,setOwner]=useState(false),[editing,setEditing]=useState(false);
 return <><button onClick={()=>setOwner(!owner)}>切换视图</button><button onClick={()=>setEditing(!editing)}>编辑目标</button>
 {!editing&&<div ref={setHost} hidden={owner} aria-label="工作台主栏"/>}<input aria-label="讨论草稿" defaultValue="原对话"/>
 <ProjectDetailsPlacement target={host} visible={!owner}><input aria-label="成果草稿" defaultValue=""/></ProjectDetailsPlacement></>}
createRoot(document.getElementById('root')).render(<App/>);
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules')], define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage()
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByLabel('成果草稿').fill('未提交的内容')
    await page.getByLabel('讨论草稿').fill('尚未发送的讨论')
    await page.getByRole('button', { name: '切换视图' }).click()
    expect(await page.getByLabel('成果草稿').isVisible()).toBe(false)
    await page.getByRole('button', { name: '编辑目标' }).click()
    await page.getByRole('button', { name: '切换视图' }).click()
    expect(await page.getByLabel('成果草稿').inputValue()).toBe('未提交的内容')
    await page.getByRole('button', { name: '编辑目标' }).click()
    expect(await page.getByLabel('成果草稿').inputValue()).toBe('未提交的内容')
    expect(await page.getByLabel('讨论草稿').inputValue()).toBe('尚未发送的讨论')
  } finally { await browser.close(); server.stop(true) }
}, 15000)
