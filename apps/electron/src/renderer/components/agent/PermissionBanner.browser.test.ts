import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

declare global {
  interface Window {
    fixture: {
      calls: Array<{ requestId: string; behavior: 'allow' | 'deny'; alwaysAllow: boolean }>
      enqueue: () => void
    }
  }
}

const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'permission-banner-browser-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

/** Chromium + React交互，IPC由本地替身接收，不启动Electron或Provider。 */
browserTest('Given 两个Owner敏感动作待审批 When逐个拒绝/允许 Then准确出队且不出现白名单或批量选项', async () => {
  const entry = join(directory, 'entry.tsx')
  writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { allPendingPermissionRequestsAtom } from ${JSON.stringify(join(renderer, 'atoms/agent-atoms.ts'))};
import { PermissionBanner } from ${JSON.stringify(join(renderer, 'components/agent/PermissionBanner.tsx'))};
const store = createStore();
const requests = [
  { requestId: 'owner-deny', requiresPerActionApproval: true, sessionId: 'owner-session', toolName: 'Write', toolInput: { file_path: '/tmp/permission-deny.md', content: 'synthetic deny' }, description: '拒绝测试', dangerLevel: 'dangerous' },
  { requestId: 'owner-allow', requiresPerActionApproval: true, sessionId: 'owner-session', toolName: 'Edit', toolInput: { file_path: '/tmp/permission-allow.md', old_string: 'before', new_string: 'after' }, description: '允许测试', dangerLevel: 'dangerous' },
];
store.set(allPendingPermissionRequestsAtom, new Map());
window.fixture = { calls: [], enqueue: () => store.set(allPendingPermissionRequestsAtom, new Map([['owner-session', requests]])) };
Object.assign(window, { electronAPI: { respondPermission: async response => { window.fixture.calls.push(response); }, stopAgent: async () => {} } });
createRoot(document.getElementById('root')).render(<Provider store={store}><PermissionBanner sessionId="owner-session" /></Provider>);
`)
  await build({ entryPoints: [entry], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response('<!doctype html><html><body><div id="root"></div><script src="/entry.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } }) }, routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    const hookOrderErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('Rendered fewer hooks than expected')) {
        hookOrderErrors.push(message.text())
      }
    })
    await page.goto(`http://127.0.0.1:${server.port}`)
    expect(await page.locator('#root').textContent()).toBe('')
    await page.evaluate(() => window.fixture.enqueue())
    await page.getByText('/tmp/permission-deny.md').waitFor()
    expect(await page.getByText('始终允许', { exact: false }).count()).toBe(0)
    expect(await page.getByText('全部允许', { exact: false }).count()).toBe(0)

    await page.getByRole('button').filter({ hasText: '拒绝本次操作并继续' }).first().click()
    await page.getByText('/tmp/permission-allow.md').waitFor()
    expect(await page.getByText('/tmp/permission-deny.md').count()).toBe(0)
    expect(await page.evaluate(() => window.fixture.calls)).toEqual([{ requestId: 'owner-deny', behavior: 'deny', alwaysAllow: false }])

    await page.getByRole('button').filter({ hasText: '仅允许本次操作' }).first().click()
    await page.waitForFunction(() => window.fixture.calls.length === 2)
    await page.waitForFunction(() => document.querySelector('#root')?.textContent?.includes('Owner 动作需要逐次确认') !== true)
    expect(await page.evaluate(() => window.fixture.calls)).toEqual([
      { requestId: 'owner-deny', behavior: 'deny', alwaysAllow: false },
      { requestId: 'owner-allow', behavior: 'allow', alwaysAllow: false },
    ])
    expect(await page.locator('#root').textContent()).toBe('')
    expect(hookOrderErrors).toEqual([])
  } finally {
    await browser?.close()
    server.stop(true)
  }
}, 30000)
