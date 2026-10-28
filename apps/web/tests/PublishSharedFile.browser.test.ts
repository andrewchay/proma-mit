import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../..'), directory = mkdtempSync(join(tmpdir(), 'publish-shared-browser-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip
browserTest('Given 所有者核对文件 When 明确发布或文件已变化 Then 只发送对应哈希并如实提示', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {PublishSharedFile} from ${JSON.stringify(join(import.meta.dir, '../src/PublishSharedFile.tsx'))};
let calls=[],conflict=false;const request=async(path,init={})=>{calls.push({path,method:init.method||'GET',body:init.body||''});if(init.method==='PUT')return new Response('',{status:conflict?409:200});return new Response('abc',{headers:{'content-type':'text/plain'}})};
window.fixture={calls:()=>calls,conflict:()=>{conflict=true}};createRoot(document.getElementById('root')).render(<PublishSharedFile request={request}/>);
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/web/node_modules')], define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage()
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByLabel('自己的工作区').fill('project')
    await page.getByLabel('相对文件路径').fill('../secret')
    await page.getByRole('button', { name: '读取并核对' }).click()
    await page.getByRole('status').getByText('请输入工作区和有效的相对文件路径。').waitFor()
    expect(await page.evaluate<unknown[]>('window.fixture.calls()')).toHaveLength(0)
    await page.getByLabel('相对文件路径').fill('reports/报告.md')
    await page.getByRole('button', { name: '读取并核对' }).click()
    await page.getByText('abc', { exact: true }).waitFor()
    expect(await page.getByText('SHA-256 ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad').count()).toBe(1)
    expect(await page.evaluate<unknown[]>('window.fixture.calls()')).toHaveLength(1)
    await page.getByLabel('相对文件路径').fill('other.md')
    expect(await page.getByRole('button', { name: '确认发布此版本' }).count()).toBe(0)
    await page.getByLabel('相对文件路径').fill('reports/报告.md')
    await page.getByRole('button', { name: '读取并核对' }).click()
    await page.getByText('abc', { exact: true }).waitFor()
    await page.getByRole('button', { name: '确认发布此版本' }).click()
    await page.getByRole('status').getByText('已发布；当前登记的成员可读取此版本。').waitFor()
    const calls = await page.evaluate<Array<{ path: string; method: string; body: string }>>('window.fixture.calls()')
    expect(calls[0]!.path).toBe('/agent/workspaces/project/files/reports/%E6%8A%A5%E5%91%8A.md')
    expect(calls[2]!.path).toBe('/agent/workspaces/project/shared-files/reports/%E6%8A%A5%E5%91%8A.md')
    expect(JSON.parse(calls[2]!.body).expectedSha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    await page.getByRole('button', { name: '读取并核对' }).click()
    await page.getByText('abc', { exact: true }).waitFor()
    await page.evaluate('window.fixture.conflict()')
    await page.getByRole('button', { name: '确认发布此版本' }).click()
    await page.getByRole('status').getByText('文件已变化，请重新读取并核对。').waitFor()
    expect(await page.getByRole('button', { name: '确认发布此版本' }).count()).toBe(0)
  } finally { await browser.close(); server.stop(true) }
}, 30000)
