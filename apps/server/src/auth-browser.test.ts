import { expect, test } from 'bun:test'
import { chromium } from '@playwright/test'
import type { AgentRuntimePostgresClient } from '@gravitas/shared/utils'
import { createPromaWebServerApplication, type PromaWebServerConfig } from './app.ts'

test('Given 本机同源浏览器 When 表单登录 Then 可正常取得会话并跳转', async () => {
  const postgres: AgentRuntimePostgresClient = { query: async () => ({ rows: [] }) }
  const config: PromaWebServerConfig = { databaseUrl: 'postgres://unused', redisUrl: 'redis://unused', s3: { bucket: 'unused', region: 'auto', maxUploadBytes: 1024 }, envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test', trustedHeaderAuth: false, authMode: 'local', localAdmin: { username: 'admin', tenantId: 'tenant', password: 'test-password' }, workspaceRoot: '/tmp/proma-web-test', workerId: 'test', taskLeaseMs: 30000 }
  const app = createPromaWebServerApplication(config, { postgres })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch })
  config.publicBaseUrl = `http://127.0.0.1:${server.port}`
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(`${config.publicBaseUrl}/auth/login`)
    await page.locator('input[name=username]').fill('admin')
    await page.locator('input[name=password]').fill('test-password')
    await page.getByRole('button', { name: '登录' }).click()
    await page.waitForURL('**/agent/ui')
    expect((await page.context().cookies()).some(cookie => cookie.name === 'proma_session' && cookie.httpOnly)).toBe(true)
  } finally { await browser.close(); server.stop(true) }
}, 30000)
