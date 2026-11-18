import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'nm-wechat-credentials-ui-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

browserTest('公众号连接只传账号档案给主进程，不向界面录入密钥', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {WechatConnectionGuide} from ${JSON.stringify(join(renderer, 'components/new-media/WechatConnectionGuide.tsx'))};
let calls=[];window.fixture=()=>calls;
window.electronAPI={paa:{newMedia:{accounts:{importCredential:async input=>{calls.push(input);return {canceled:false}},connect:async()=>({status:'connected'})}}}};
createRoot(document.getElementById('root')).render(<WechatConnectionGuide accountId="account" profile={null} capabilities={[]} credentialProtection="none" status="disconnected" onRefresh={async()=>{}}/>);
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ path: join(directory, 'entry.js') })
    await page.getByRole('button', { name: '选择凭据文件' }).click()
    await page.getByText(/凭据已加密保存/).waitFor()
    const calls = await page.evaluate(() => (window as unknown as { fixture: () => unknown[] }).fixture())
    expect(calls).toEqual([{ accountId: 'account', accountType: 'service', verificationStatus: 'unverified', ipWhitelistConfigured: false }])
    expect(await page.locator('input[type=password]').count()).toBe(0)
  } finally { await browser.close() }
})
