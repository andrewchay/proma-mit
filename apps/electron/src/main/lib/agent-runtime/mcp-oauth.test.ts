/**
 * MCP OAuth 支持单元测试
 *
 * 覆盖 token 存储、OAuth provider 元数据、pending 注册表。
 */

process.env.PROMA_DEV = '1'

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadMcpOAuthTokens, saveMcpOAuthTokens, removeMcpOAuthTokens } from './mcp-oauth-store'
import { McpOAuthProvider } from './mcp-oauth-provider'
import { registerPendingMcpOAuth, takePendingMcpOAuth, hasPendingMcpOAuth } from './mcp-oauth-pending'
import { setRuntimeSecretCodecForTesting, type RuntimeSecretCodec } from './runtime-secret-codec'

let tempDir: string
let originalTestConfigDir: string | undefined
let openedUrls: string[] = []

beforeEach(() => {
  originalTestConfigDir = process.env.PROMA_TEST_CONFIG_DIR
  tempDir = mkdtempSync(join(tmpdir(), 'proma-mcp-oauth-test-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
  openedUrls = []
  setRuntimeSecretCodecForTesting()
})

afterEach(() => {
  setRuntimeSecretCodecForTesting()
  if (originalTestConfigDir === undefined) {
    delete process.env.PROMA_TEST_CONFIG_DIR
  } else {
    process.env.PROMA_TEST_CONFIG_DIR = originalTestConfigDir
  }
  rmSync(tempDir, { recursive: true, force: true })
})

class PrefixRuntimeSecretCodec implements RuntimeSecretCodec {
  encode(plain: string, scope: string): string {
    return Buffer.from(`${scope}:${plain}`).toString('base64')
  }

  decode(encoded: string, scope: string): string {
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8')
    const prefix = `${scope}:`
    if (!decoded.startsWith(prefix)) {
      throw new Error(`scope mismatch: ${scope}`)
    }
    return decoded.slice(prefix.length)
  }
}

describe('MCP OAuth token 存储', () => {
  test('保存并读取 token', async () => {
    await saveMcpOAuthTokens('ws1', {
      github: { accessToken: 'gh_token', refreshToken: 'refresh', expiresAt: 1_000_000_000, scope: 'read' },
    })

    const tokens = await loadMcpOAuthTokens('ws1')
    expect(tokens.github).toEqual({
      accessToken: 'gh_token',
      refreshToken: 'refresh',
      expiresAt: 1_000_000_000,
      scope: 'read',
    })
  })

  test('读取不存在的工作区返回空对象', async () => {
    const tokens = await loadMcpOAuthTokens('non-existent-workspace')
    expect(tokens).toEqual({})
  })

  test('删除指定服务器的 token', async () => {
    await saveMcpOAuthTokens('ws2', {
      a: { accessToken: 'a' },
      b: { accessToken: 'b' },
    })
    await removeMcpOAuthTokens('ws2', 'a')
    const tokens = await loadMcpOAuthTokens('ws2')
    expect(tokens).toEqual({ b: { accessToken: 'b' } })
  })

  test('可注入 runtime secret codec，服务端 Web 可替换 Electron safeStorage', async () => {
    setRuntimeSecretCodecForTesting(new PrefixRuntimeSecretCodec())
    await saveMcpOAuthTokens('ws-codec', {
      github: { accessToken: 'secret-token' },
    })

    const encoded = readFileSync(join(tempDir, 'agent-workspaces', 'ws-codec', 'mcp-oauth-tokens.enc'), 'utf-8')
    expect(Buffer.from(encoded, 'base64').toString('utf-8').startsWith('MCP OAuth:')).toBe(true)
    expect(encoded).not.toContain('secret-token')

    const tokens = await loadMcpOAuthTokens('ws-codec')
    expect(tokens.github?.accessToken).toBe('secret-token')
  })
})

describe('MCP OAuth Provider', () => {
  test('client_credentials 元数据正确', () => {
    const provider = new McpOAuthProvider({
      workspaceSlug: 'ws',
      serverName: 'srv',
      auth: { type: 'oauthClientCredentials', clientId: 'id', clientSecret: 'secret', scope: 'read' },
    })

    expect(provider.clientMetadata.client_name).toBe('proma-mit')
    expect(provider.clientMetadata.grant_types).toEqual(['client_credentials'])
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('client_secret_basic')
    expect(provider.clientInformation()).toEqual({ client_id: 'id', client_secret: 'secret' })
    expect(String(provider.redirectUrl)).toContain('proma-mit://mcp-auth')
    expect(String(provider.redirectUrl)).toContain('workspace=ws')
    expect(String(provider.redirectUrl)).toContain('server=srv')
  })

  test('authorization_code 元数据正确', () => {
    const provider = new McpOAuthProvider({
      workspaceSlug: 'ws',
      serverName: 'srv',
      auth: { type: 'oauthAuthorizationCode', clientId: 'id', scope: 'read write' },
    })

    expect(provider.clientMetadata.grant_types).toEqual(['authorization_code'])
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('none')
    expect(provider.clientInformation()).toEqual({ client_id: 'id' })
  })

  test('prepareTokenRequest 为 client_credentials 设置 grant_type', async () => {
    const provider = new McpOAuthProvider({
      workspaceSlug: 'ws',
      serverName: 'srv',
      auth: { type: 'oauthClientCredentials', clientId: 'id', clientSecret: 'secret', scope: 'read' },
    })

    const params = await provider.prepareTokenRequest()
    expect(params).toBeInstanceOf(URLSearchParams)
    expect(params?.get('grant_type')).toBe('client_credentials')
    expect(params?.get('scope')).toBe('read')
  })

  test('prepareTokenRequest 对 authorization_code 返回 undefined', () => {
    const provider = new McpOAuthProvider({
      workspaceSlug: 'ws',
      serverName: 'srv',
      auth: { type: 'oauthAuthorizationCode', clientId: 'id' },
    })

    expect(provider.prepareTokenRequest()).toBeUndefined()
  })

  test('保存和加载 OAuthTokens', async () => {
    const provider = new McpOAuthProvider({
      workspaceSlug: 'ws3',
      serverName: 'srv',
      auth: { type: 'oauthClientCredentials', clientId: 'id', clientSecret: 'secret' },
    })

    await provider.saveTokens({
      access_token: 'access',
      token_type: 'Bearer',
      refresh_token: 'refresh',
      expires_in: 3600,
      scope: 'read',
    })

    const loaded = await provider.tokens()
    expect(loaded?.access_token).toBe('access')
    expect(loaded?.refresh_token).toBe('refresh')
    expect(loaded?.token_type).toBe('Bearer')
    expect(loaded?.scope).toBe('read')
    expect(typeof loaded?.expires_in).toBe('number')
  })

  test('打开授权页会调用 openExternal 回调', async () => {
    const provider = new McpOAuthProvider({
      workspaceSlug: 'ws',
      serverName: 'srv',
      auth: { type: 'oauthAuthorizationCode', clientId: 'id' },
      openExternal: (url: string) => {
        openedUrls.push(url)
      },
    })

    await provider.redirectToAuthorization(new URL('https://example.com/authorize?client_id=id'))
    expect(openedUrls).toHaveLength(1)
    expect(openedUrls[0]).toContain('https://example.com/authorize')
  })
})

describe('MCP OAuth pending 注册表', () => {
  test('注册、查询、取出 pending 会话', () => {
    registerPendingMcpOAuth('ws', 'srv', async (code: string) => {
      expect(code).toBe('authcode')
    })

    expect(hasPendingMcpOAuth('ws', 'srv')).toBe(true)
    const pending = takePendingMcpOAuth('ws', 'srv')
    expect(pending).toBeDefined()
    expect(pending?.workspaceSlug).toBe('ws')
    expect(pending?.serverName).toBe('srv')
    expect(hasPendingMcpOAuth('ws', 'srv')).toBe(false)
  })
})
