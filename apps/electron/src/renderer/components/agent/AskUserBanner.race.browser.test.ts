import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'ask-user-race-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

browserTest('选择选项后立即按回车不会跳过第二个问题', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react'; import {createRoot} from 'react-dom/client'; import {Provider,createStore} from 'jotai';
import {AskUserBanner} from ${JSON.stringify(join(renderer, 'components/agent/AskUserBanner.tsx'))};
import {allPendingAskUserRequestsAtom} from ${JSON.stringify(join(renderer, 'atoms/agent-atoms.ts'))};
const store=createStore(); store.set(allPendingAskUserRequestsAtom,new Map([['s',[{sessionId:'s',requestId:'r',questions:[{header:'方向',question:'选择方向',options:[{label:'场景帖'}]},{header:'风格',question:'选择风格',options:[{label:'清爽'}]},{header:'渠道',question:'选择渠道',options:[{label:'小红书'}]}],toolInput:{}}]]]));
window.electronAPI={respondAskUser:async value=>{window.answer=value},stopAgent:async()=>{}};
createRoot(document.getElementById('root')).render(<Provider store={store}><AskUserBanner sessionId="s"/></Provider>);
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ path: join(directory, 'entry.js') })
    await page.getByRole('button', { name: /场景帖/ }).waitFor()
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')]
      buttons.find(item => item.textContent?.includes('场景帖'))?.click()
      buttons.find(item => item.textContent?.includes('其他'))?.click()
    })
    await page.waitForTimeout(250)
    expect(await page.getByText('选择方向').isVisible()).toBe(true)
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(item => item.textContent?.includes('场景帖'))
      button?.click()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await page.waitForTimeout(250)
    expect(await page.getByText('选择风格').isVisible()).toBe(true)
    await page.getByRole('button', { name: /清爽/ }).click()
    await page.getByText('选择渠道').waitFor()
    await page.getByRole('button', { name: /小红书/ }).click()
    await page.getByRole('button', { name: '提交' }).click()
    const answer = await page.evaluate(() => (window as unknown as { answer: { answers: Record<string, string> } }).answer)
    expect(answer.answers).toEqual({ '选择方向': '场景帖', '选择风格': '清爽', '选择渠道': '小红书' })
  } finally { await browser.close() }
})
