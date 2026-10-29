import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../..'), directory = mkdtempSync(join(tmpdir(), 'shared-files-browser-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip
browserTest('Given 成员查看共享成果 When 翻页后权限撤销 Then 清除旧列表并显示错误', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react'; import { createRoot } from 'react-dom/client';
import { SharedFiles } from ${JSON.stringify(join(import.meta.dir, '../src/SharedFiles.tsx'))};
let calls=[], revoked=false, hold=false, released=false, release; const request=async path=>{calls.push(path);if(hold){hold=false;await new Promise(resolve=>{release=resolve});released=true}if(revoked)return Response.json({error:'工作区不存在或不可访问'},{status:404});if(path.endsWith('/files/a.txt'))return new Response('test content');return Response.json({files:[{path:path.includes('?after=')?'b.txt':'a.txt',sha256:'a'.repeat(64),size:12,publishedAt:1}],nextCursor:path.includes('?after=')?null:'a.txt'})};
const root=createRoot(document.getElementById('root'));window.fixture={calls:()=>calls,revoke:()=>{revoked=true},holdNext:()=>{hold=true},release:()=>release(),released:()=>released,switchIdentity:()=>root.render(<SharedFiles request={async path=>request(path)}/>)};root.render(<SharedFiles request={request}/>);
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/web/node_modules')], define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage()
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByLabel('所有者 ID').fill('owner')
    await page.getByLabel('工作区').fill('project')
    await page.getByRole('button', { name: '查看成果' }).click()
    await page.getByText('a.txt').waitFor()
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载' }).click()
    expect((await downloadPromise).suggestedFilename()).toBe('a.txt')
    await page.getByRole('button', { name: '加载更多' }).click()
    await page.getByText('b.txt').waitFor()
    expect(await page.evaluate<string[]>('window.fixture.calls()')).toEqual(['/agent/shared-workspaces/owner/project/files', '/agent/shared-workspaces/owner/project/files/a.txt', '/agent/shared-workspaces/owner/project/files?after=a.txt'])
    await page.evaluate('window.fixture.holdNext()')
    await page.getByRole('button', { name: '查看成果' }).click()
    await page.waitForFunction('window.fixture.calls().length === 4')
    await page.evaluate('window.fixture.switchIdentity()')
    await page.waitForFunction(() => !document.body.textContent?.includes('a.txt'))
    await page.evaluate('window.fixture.release()')
    await page.waitForFunction('window.fixture.released()')
    expect(await page.getByText('a.txt').count()).toBe(0)
    await page.getByRole('button', { name: '查看成果' }).click()
    await page.getByText('a.txt').waitFor()
    await page.evaluate('window.fixture.revoke()')
    await page.getByRole('button', { name: '查看成果' }).click()
    await page.getByRole('status').getByText('工作区不存在或不可访问').waitFor()
    expect(await page.getByText('a.txt').count()).toBe(0)
    expect(await page.getByText('b.txt').count()).toBe(0)
  } finally { await browser.close(); server.stop(true) }
}, 30000)
