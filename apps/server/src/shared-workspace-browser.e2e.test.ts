import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import { createAgentRuntimeWorkspaceObjectKey, InMemoryAgentRuntimeObjectStore, PostgresTenantRuntimeStore } from '@gravitas/shared/utils'
import { createPromaWebServerApplication } from './app'
import { PostgresWorkspaceMembershipStore } from './workspace-membership-store'
import { PostgresSharedFileStore } from './workspace-shared-file'
import { PostgresAuditLog } from './audit'

const databaseUrl = process.env.PROMA_MEMBERSHIP_TEST_DATABASE_URL
const root = resolve(import.meta.dir, '../../..'), directory = mkdtempSync(join(tmpdir(), 'shared-workspace-ui-e2e-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = databaseUrl && existsSync(chromium.executablePath()) ? test : test.skip
browserTest('Given 所有者与成员 When 登记、发布、下载和撤销 Then 本地服务完整闭环', async () => {
  const sql = new Bun.SQL(databaseUrl!)
  const client = {
    query: <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[] = []) => sql.unsafe<Row[]>(statement, [...params]).then(rows => ({ rows })),
    transaction: async (run: (tx: import('@gravitas/shared/utils').AgentRuntimePostgresClient) => Promise<void>) => { await sql.begin(async transaction => { await run({ query: (statement, params = []) => transaction.unsafe(statement, [...params]).then(rows => ({ rows })) }) }) },
  }
  const tenantId = `browser-share-${crypto.randomUUID()}`, owner = { tenantId, userId: 'owner' }
  const workspaces = new PostgresTenantRuntimeStore(client), members = new PostgresWorkspaceMembershipStore(client), shared = new PostgresSharedFileStore(client), audit = new PostgresAuditLog(client)
  const objects = new InMemoryAgentRuntimeObjectStore()
  await workspaces.initializeSchema(); await members.initializeSchema(); await shared.initializeSchema(); await audit.initializeSchema()
  await workspaces.setWorkspace({ ...owner, workspaceSlug: 'project', cwd: '/ignored', mcpServers: {} })
  const body = new TextEncoder().encode('已核对的项目报告')
  await objects.putObject({ key: createAgentRuntimeWorkspaceObjectKey({ ...owner, workspaceSlug: 'project', relativePath: 'reports/summary.txt' }), body, contentType: 'text/plain' })
  const app = createPromaWebServerApplication({ databaseUrl: databaseUrl!, redisUrl: 'redis://unused', s3: { bucket: 'unused', region: 'auto', maxUploadBytes: 1024 }, envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test', trustedHeaderAuth: false, workspaceRoot: '/tmp/browser-share-test', workerId: 'test', taskLeaseMs: 30000 }, { postgres: client, objectStore: objects, auth: ({ request }) => ({ tenantId, userId: request.headers.get('x-test-user') ?? 'reader', roles: [request.headers.get('x-test-user') === 'owner' ? 'operator' : 'viewer'] }) })
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react';import {createRoot} from 'react-dom/client';
import {WorkspaceMembers} from ${JSON.stringify(join(root, 'apps/web/src/WorkspaceMembers.tsx'))};
import {PublishSharedFile} from ${JSON.stringify(join(root, 'apps/web/src/PublishSharedFile.tsx'))};
import {PublishedFiles} from ${JSON.stringify(join(root, 'apps/web/src/PublishedFiles.tsx'))};
import {SharedFiles} from ${JSON.stringify(join(root, 'apps/web/src/SharedFiles.tsx'))};
const root=createRoot(document.getElementById('root'));const owner=(path,init={})=>fetch(path,{...init,headers:{...init.headers,'x-test-user':'owner'}});const reader=(path,init={})=>fetch(path,{...init,headers:{...init.headers,'x-test-user':'reader'}});
window.fixture={owner:()=>root.render(<><WorkspaceMembers request={owner}/><PublishSharedFile request={owner}/><PublishedFiles request={owner}/></>),reader:()=>root.render(<SharedFiles request={reader}/>)};window.fixture.owner();
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/web/node_modules')], define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => new URL(request.url).pathname === '/' ? new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }) : new URL(request.url).pathname === '/entry.js' ? new Response(Bun.file(join(directory, 'entry.js'))) : app.fetch(request) })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage()
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    const memberPanel = page.getByLabel('工作区成员')
    await memberPanel.getByLabel('自己的工作区').fill('project')
    await memberPanel.getByRole('button', { name: '读取成员' }).click()
    await memberPanel.getByLabel('成员 ID').fill('reader')
    await memberPanel.getByRole('button', { name: '登记只读成员' }).click()
    await memberPanel.getByText('只读成员已登记，可访问已发布成果。').waitFor()
    const publisher = page.getByLabel('发布共享成果')
    await publisher.getByLabel('自己的工作区').fill('project')
    await publisher.getByLabel('相对文件路径').fill('reports/summary.txt')
    await publisher.getByRole('button', { name: '读取并核对' }).click()
    await publisher.getByText('已核对的项目报告', { exact: true }).waitFor()
    await publisher.getByRole('button', { name: '确认发布此版本' }).click()
    await publisher.getByText('已发布；当前登记的成员可读取此版本。').waitFor()
    await page.evaluate('window.fixture.reader()')
    const sharedPanel = page.getByLabel('共享成果')
    await sharedPanel.getByLabel('所有者 ID').fill('owner')
    await sharedPanel.getByLabel('工作区').fill('project')
    await sharedPanel.getByRole('button', { name: '查看成果' }).click()
    await sharedPanel.getByText('reports/summary.txt').waitFor()
    const downloadPromise = page.waitForEvent('download')
    await sharedPanel.getByRole('button', { name: '下载' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('summary.txt')
    const downloadPath = join(directory, 'summary.txt')
    await download.saveAs(downloadPath)
    expect(readFileSync(downloadPath, 'utf8')).toBe('已核对的项目报告')
    await page.evaluate('window.fixture.owner()')
    const published = page.getByLabel('已发布成果')
    await published.getByLabel('自己的工作区').fill('project')
    await published.getByRole('button', { name: '读取已发布成果' }).click()
    await published.getByText('reports/summary.txt').waitFor()
    await published.getByRole('button', { name: '撤销发布' }).click()
    await published.getByText('已撤销：reports/summary.txt').waitFor()
    await page.evaluate('window.fixture.reader()')
    await sharedPanel.getByLabel('所有者 ID').fill('owner')
    await sharedPanel.getByLabel('工作区').fill('project')
    await sharedPanel.getByRole('button', { name: '查看成果' }).click()
    await sharedPanel.getByText('当前没有已发布的成果。').waitFor()
  } finally {
    await browser.close(); server.stop(true)
    await sql.unsafe('DELETE FROM proma_runtime_workspaces WHERE tenant_id=$1', [tenantId])
    await sql.unsafe('DELETE FROM proma_runtime_audit_log WHERE tenant_id=$1', [tenantId])
    await sql.close()
  }
}, 30000)
