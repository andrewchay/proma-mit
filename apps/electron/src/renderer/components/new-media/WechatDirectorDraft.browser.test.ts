import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'nm-wechat-ui-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

browserTest('公众号草稿同步前检查封面和账号，未知结果须先核对', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {WechatDirectorDraft} from ${JSON.stringify(join(renderer, 'components/new-media/WechatDirectorDraft.tsx'))};
let calls=[], status='creating'; window.fixture=()=>calls;
window.electronAPI={paa:{newMedia:{accounts:{list:async()=>[{id:'account',displayName:'测试公众号',platform:'wechat-official-account',status:'connected',credentialProtection:'encrypted'}]},content:{getDirectorDesignPreview:async()=>({assetId:'asset',dataUrl:'data:image/png;base64,AA=='}),getWechatSyncStatus:async()=>status,confirmWechatNotCreated:async input=>{calls.push(['confirm',input]);status='not_created'},syncWechatDraft:async input=>{calls.push(['sync',input]);status='synced';return {status:'synced',platformMediaId:'media'}}}}}};
createRoot(document.getElementById('root')).render(<WechatDirectorDraft draftId="draft"/>);
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ path: join(directory, 'entry.js') })
    await page.getByRole('combobox').selectOption('account')
    await page.getByText('上次草稿提交结果不明。请先在公众号草稿箱检查，避免重复创建。').waitFor()
    expect(await page.getByRole('button', { name: '核对后同步到公众号草稿箱' }).isDisabled()).toBe(true)
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: '记录核对并允许重试' }).click()
    await page.getByRole('button', { name: '核对后同步到公众号草稿箱' }).click()
    await page.getByText('已同步到公众号草稿箱，尚未发布。请在公众号后台检查后确认发布。').waitFor()
    const calls = await page.evaluate(() => (window as unknown as { fixture: () => unknown[] }).fixture())
    expect(calls).toEqual([['confirm', { draftId: 'draft', accountId: 'account', confirmed: true }], ['sync', { draftId: 'draft', accountId: 'account', assetId: 'asset' }]])
  } finally { await browser.close() }
})
