import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const directory = mkdtempSync(join(tmpdir(), 'owner-delivery-download-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
test('Given已交付代码 When直接查看并点击下载HTML Then不执行正文且下载字节与源码一致', async () => {
  const root = resolve(import.meta.dir, '../../../../../..')
  const html = '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=https://example.invalid/preview-redirect"></head><body><script>window.deliveryRan=true</script><img src="https://example.invalid/preview-probe"><h1>2048</h1><img alt="封面图" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></body></html>'
  const content = `这是已有成果\n\n\`\`\`html\n${html}\n\`\`\``
  const item = { stepKey: 'game', title: '2048游戏', content, artifactHash: 'a'.repeat(64), acceptanceCriteria: ['可玩'], ownerDecision: '已验收', reviewerSummary: '静态检查' }
  writeFileSync(join(directory, 'entry.tsx'), `import React from 'react';import {createRoot} from 'react-dom/client';import {OwnerDeliveredArtifact} from ${JSON.stringify(join(import.meta.dir, 'OwnerDeliveredArtifact.tsx'))};const root=createRoot(document.getElementById('root'));window.renderItem=(item)=>root.render(<OwnerDeliveredArtifact item={item} onRequestChanges={excerpt=>{window.lastExcerpt=excerpt}}/>);window.renderItem(${JSON.stringify(item)});`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => new Response(new URL(request.url).pathname === '/entry.js' ? readFileSync(join(directory, 'entry.js')) : '<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': new URL(request.url).pathname === '/entry.js' ? 'text/javascript' : 'text/html' } }) })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ acceptDownloads: true })
    const externalFailures: string[] = []
    page.on('requestfailed', request => { if (request.url().includes('preview-')) externalFailures.push(request.failure()?.errorText ?? '') })
    await page.goto(`http://127.0.0.1:${server.port}`)
    expect(await page.getByText(content, { exact: true }).isVisible()).toBe(true)
    expect(await page.evaluate('window.deliveryRan')).toBeUndefined()
    await page.getByRole('button', { name: '静态预览', exact: true }).click()
    expect(await page.getByText(`成果标识：${item.artifactHash}`, { exact: true }).isVisible()).toBe(true)
    const frame = page.frameLocator('iframe[title="2048游戏 静态预览"]')
    expect(await frame.getByText('2048', { exact: true }).isVisible()).toBe(true)
    expect(await page.getByRole('button', { name: '手机宽度' }).isVisible()).toBe(true)
    await page.getByRole('button', { name: '手机宽度' }).click()
    expect(await page.locator('iframe').evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(390)
    expect(await page.getByRole('button', { name: '手机宽度' }).getAttribute('aria-pressed')).toBe('true')
    await page.getByRole('button', { name: '自适应宽度' }).click()
    expect(await page.getByRole('button', { name: '自适应宽度' }).getAttribute('aria-pressed')).toBe('true')
    expect(await page.locator('iframe').getAttribute('sandbox')).toBe('allow-scripts')
    await page.evaluate(() => window.postMessage({ type: 'gravitas-design-selection', token: 'forged', tag: 'h1', text: '伪造内容' }, '*'))
    expect(await page.getByText('伪造内容', { exact: true }).count()).toBe(0)
    await frame.getByText('2048', { exact: true }).click()
    await page.getByText('已选中内容，可连同本成果版本提交修改意见。').waitFor()
    await page.getByRole('button', { name: '针对选中内容提出修改' }).click()
    expect(await page.evaluate<string>('window.lastExcerpt')).toBe('2048')
    await frame.getByAltText('封面图').click()
    await page.getByRole('button', { name: '针对选中内容提出修改' }).click()
    expect(await page.evaluate<string>('window.lastExcerpt')).toContain('视觉元素：封面图；预览位置（可能不唯一）：')
    const previewFrame = page.frames().find(candidate => candidate !== page.mainFrame())!
    expect(await previewFrame.evaluate('window.deliveryRan')).toBeUndefined()
    await page.waitForTimeout(100)
    expect(externalFailures).toEqual(['csp'])
    expect(await page.evaluate('window.deliveryRan')).toBeUndefined()
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载 HTML', exact: true }).click()
    const result = await download
    expect(result.suggestedFilename()).toBe('2048游戏.html')
    expect(readFileSync((await result.path())!, 'utf8')).toBe(html)
    const originalDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载原文', exact: true }).click()
    expect(readFileSync((await (await originalDownload).path())!, 'utf8')).toBe(content)
    await page.getByRole('button', { name: '手机宽度' }).click()
    await page.evaluate((next) => (window as unknown as { renderItem: (value: unknown) => void }).renderItem(next), { ...item, artifactHash: 'b'.repeat(64), title: '新版本' })
    await page.getByRole('heading', { name: '新版本', exact: true }).waitFor()
    expect(await page.locator('iframe').count()).toBe(0)
    expect(await page.getByRole('button', { name: '静态预览', exact: true }).isVisible()).toBe(true)
    await page.getByRole('button', { name: '静态预览', exact: true }).click()
    expect(await page.getByText(`成果标识：${'b'.repeat(64)}`, { exact: true }).isVisible()).toBe(true)
    expect(await page.getByRole('button', { name: '自适应宽度' }).getAttribute('aria-pressed')).toBe('true')
  } finally { await browser.close(); server.stop(true) }
}, 30000)
