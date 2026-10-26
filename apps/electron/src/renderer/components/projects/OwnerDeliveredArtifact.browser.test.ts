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
  const html = '<!DOCTYPE html><html><body><script>window.deliveryRan=true</script>2048</body></html>'
  const content = `这是已有成果\n\n\`\`\`html\n${html}\n\`\`\``
  const item = { stepKey: 'game', title: '2048游戏', content, artifactHash: 'a'.repeat(64), acceptanceCriteria: ['可玩'], ownerDecision: '已验收', reviewerSummary: '静态检查' }
  writeFileSync(join(directory, 'entry.tsx'), `import React from 'react';import {createRoot} from 'react-dom/client';import {OwnerDeliveredArtifact} from ${JSON.stringify(join(import.meta.dir, 'OwnerDeliveredArtifact.tsx'))};createRoot(document.getElementById('root')).render(<OwnerDeliveredArtifact item={${JSON.stringify(item)}}/>);`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => new Response(new URL(request.url).pathname === '/entry.js' ? readFileSync(join(directory, 'entry.js')) : '<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': new URL(request.url).pathname === '/entry.js' ? 'text/javascript' : 'text/html' } }) })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ acceptDownloads: true })
    await page.goto(`http://127.0.0.1:${server.port}`)
    expect(await page.getByText(content, { exact: true }).isVisible()).toBe(true)
    expect(await page.evaluate('window.deliveryRan')).toBeUndefined()
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载 HTML', exact: true }).click()
    const result = await download
    expect(result.suggestedFilename()).toBe('2048游戏.html')
    expect(readFileSync((await result.path())!, 'utf8')).toBe(html)
    const originalDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载原文', exact: true }).click()
    expect(readFileSync((await (await originalDownload).path())!, 'utf8')).toBe(content)
  } finally { await browser.close(); server.stop(true) }
}, 30000)
