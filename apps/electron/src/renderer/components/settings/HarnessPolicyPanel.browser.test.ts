import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const directory = mkdtempSync(join(tmpdir(), 'gravitas-harness-panel-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test('Given 当前并行 When 保存串行回滚 Then 显示下次启动生效且不误报当前状态', async () => {
  const root = resolve(import.meta.dir, '../../../../../..')
  writeFileSync(join(directory, 'entry.tsx'), `import React from 'react'; import {createRoot} from 'react-dom/client'; import {HarnessPolicyPanel} from ${JSON.stringify(join(import.meta.dir, 'HarnessPolicyPanel.tsx'))}; window.saved=[]; window.electronAPI={getHarnessPolicyState:async()=>({status:'missing',path:'local',policy:null,error:null,reasons:[],runtimeGaps:[],scheduler:{status:'default',parallel:true}}),setHarnessSchedulingOnRestart:async(value)=>{window.saved.push(value)}}; createRoot(document.getElementById('root')).render(<HarnessPolicyPanel/>);`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, alias: { '@': join(root, 'apps/electron/src/renderer') }, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => new Response(new URL(request.url).pathname === '/entry.js' ? readFileSync(join(directory, 'entry.js')) : '<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': new URL(request.url).pathname === '/entry.js' ? 'text/javascript' : 'text/html' } }) })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByText('本进程工具调度：并行').waitFor()
    await page.getByRole('button', { name: '下次启动使用串行' }).click()
    await page.getByText('已保存：下次启动使用串行调度。').waitFor()
    expect(await page.evaluate(() => (window as unknown as { saved: boolean[] }).saved)).toEqual([false])
    expect(await page.getByText('本进程工具调度：并行').isVisible()).toBe(true)
  } finally { await browser.close(); server.stop(true) }
}, 30000)
