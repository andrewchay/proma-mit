import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../..'), directory = mkdtempSync(join(tmpdir(), 'published-files-browser-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip
browserTest('Given 已发布版本变化 When 按旧版本撤销 Then 提示冲突且保留新版本', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react';import {createRoot} from 'react-dom/client';
import {PublishedFiles} from ${JSON.stringify(join(import.meta.dir, '../src/PublishedFiles.tsx'))};
let calls=[],current='a'.repeat(32);const request=async(path,init={})=>{calls.push({path,method:init.method||'GET'});if(init.method==='DELETE')return new Response(null,{status:path.endsWith(current)?204:409});return Response.json({files:[{path:'report.md',sha256:'b'.repeat(64),size:12,publicationId:current}],nextCursor:null})};
window.fixture={calls:()=>calls,republish:()=>{current='c'.repeat(32)}};createRoot(document.getElementById('root')).render(<PublishedFiles request={request}/>);
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/web/node_modules')], define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage()
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByLabel('自己的工作区').fill('project')
    await page.getByRole('button', { name: '读取已发布成果' }).click()
    await page.getByText('report.md').waitFor()
    await page.evaluate('window.fixture.republish()')
    await page.getByRole('button', { name: '撤销发布' }).click()
    await page.getByRole('status').getByText('发布版本已变化或不存在，请重新读取。').waitFor()
    expect(await page.getByText('report.md').count()).toBe(0)
    await page.getByRole('button', { name: '读取已发布成果' }).click()
    await page.getByText('report.md').waitFor()
    await page.getByRole('button', { name: '撤销发布' }).click()
    await page.getByRole('status').getByText('已撤销：report.md').waitFor()
    const calls = await page.evaluate<Array<{ path: string; method: string }>>('window.fixture.calls()')
    expect(calls[1]!.path).toContain('publicationId=' + 'a'.repeat(32))
    expect(calls[3]!.path).toContain('publicationId=' + 'c'.repeat(32))
    expect(calls[3]!.method).toBe('DELETE')
  } finally { await browser.close(); server.stop(true) }
}, 30000)
