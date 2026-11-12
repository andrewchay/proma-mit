import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'onboarding-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

browserTest('Given 新用户 When 配置模型或跳过设置 Then 可返回并在保存成功后进入工作台', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react'; import {createRoot} from 'react-dom/client'; import {Provider} from 'jotai';
import {OnboardingView} from ${JSON.stringify(join(renderer, 'components/onboarding/OnboardingView.tsx'))};
window.failSave = true; window.completed = 0; window.saved = [];
window.electronAPI = { listChannels: async () => [], getSubscriptionEndpoint: async () => ({url: null}), updateSettings: async data => { if (window.failSave) throw Error('save failed'); window.saved.push(data) } };
createRoot(document.getElementById('root')).render(<Provider><OnboardingView onComplete={() => window.completed++}/></Provider>);
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByRole('button', { name: '开始设置' }).click()
    expect(await page.getByRole('heading', { name: '连接你的 AI 模型' }).count()).toBe(1)
    await page.getByRole('button', { name: /添加模型配置/ }).click()
    expect(await page.getByRole('heading', { name: '添加模型配置' }).count()).toBe(1)
    expect(await page.getByRole('button', { name: '跳过设置' }).isDisabled()).toBe(true)
    await page.getByRole('button').filter({ has: page.locator('svg.lucide-arrow-left') }).first().click()
    await page.getByRole('button', { name: '稍后配置' }).click()
    await page.getByRole('button', { name: '进入 Gravitas' }).click()
    await page.getByRole('alert').waitFor()
    expect(await page.evaluate('window.completed')).toBe(0)
    await page.evaluate('window.failSave = false')
    await page.getByRole('button', { name: '进入 Gravitas' }).click()
    await page.waitForFunction('window.completed === 1')
    expect(await page.evaluate('window.saved')).toEqual([{ onboardingCompleted: true }])
  } finally { await browser.close(); server.stop(true) }
}, 30000)
