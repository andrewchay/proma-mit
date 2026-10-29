import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../..'), directory = mkdtempSync(join(tmpdir(), 'members-browser-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip
browserTest('Given 所有者管理成员 When 登记、撤销或遇到并发冲突 Then 显示明确结果', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react';import {createRoot} from 'react-dom/client';
import {WorkspaceMembers} from ${JSON.stringify(join(import.meta.dir, '../src/WorkspaceMembers.tsx'))};
let calls=[],conflict=false;const request=async(path,init={})=>{calls.push({path,method:init.method||'GET',body:init.body||''});if(!init.method)return Response.json({members:[{userId:'editor',role:'editor'}]});return new Response(null,{status:conflict?409:init.method==='DELETE'?204:200})};
window.fixture={calls:()=>calls,conflict:()=>{conflict=true}};createRoot(document.getElementById('root')).render(<WorkspaceMembers request={request}/>);
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/web/node_modules')], define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage()
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByLabel('自己的工作区').fill('project')
    await page.getByRole('button', { name: '读取成员' }).click()
    await page.getByText('editor', { exact: true }).waitFor()
    await page.getByLabel('成员 ID').fill('editor')
    await page.getByRole('button', { name: '登记只读成员' }).click()
    await page.getByRole('status').getByText('该成员已登记，请先核对现有角色。').waitFor()
    expect(await page.evaluate<unknown[]>('window.fixture.calls()')).toHaveLength(1)
    await page.getByLabel('成员 ID').fill('reader')
    await page.getByRole('button', { name: '登记只读成员' }).click()
    await page.getByRole('status').getByText('只读成员已登记，可访问已发布成果。').waitFor()
    const calls = await page.evaluate<Array<{ path: string; method: string; body: string }>>('window.fixture.calls()')
    expect(calls[1]!.path).toBe('/agent/workspaces/project/members/reader')
    expect(JSON.parse(calls[1]!.body)).toEqual({ role: 'viewer', createOnly: true })
    await page.getByRole('listitem').filter({ hasText: 'reader' }).getByRole('button', { name: '撤销成员' }).click()
    await page.getByRole('status').getByText('成员已撤销。').waitFor()
    expect(await page.getByText('reader', { exact: true }).count()).toBe(0)
    await page.evaluate('window.fixture.conflict()')
    await page.getByLabel('成员 ID').fill('new-reader')
    await page.getByRole('button', { name: '登记只读成员' }).click()
    await page.getByRole('status').getByText('成员已存在或工作区不可管理，请重新读取。').waitFor()
    expect(await page.getByLabel('成员 ID').count()).toBe(0)
  } finally { await browser.close(); server.stop(true) }
}, 30000)
