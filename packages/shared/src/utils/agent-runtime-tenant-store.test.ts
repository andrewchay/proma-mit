import { describe, expect, test } from 'bun:test'
import { InMemoryTenantRuntimeStore, ServerMcpOAuthCallbackHandler } from './agent-runtime-tenant-store'
import type { SDKMessage } from '../types/agent'

const scopeA = { tenantId: 'tenant-a', userId: 'user-a' }
const scopeB = { tenantId: 'tenant-b', userId: 'user-a' }

describe('InMemoryTenantRuntimeStore', () => {
  test('given credentials and workspaces from different tenants then reads are isolated', () => {
    const store = new InMemoryTenantRuntimeStore()
    store.setCredential({
      ...scopeA,
      channelId: 'deepseek',
      provider: 'deepseek',
      apiKey: 'key-a',
      baseUrl: 'https://a.example.com',
    })
    store.setCredential({
      ...scopeB,
      channelId: 'deepseek',
      provider: 'deepseek',
      apiKey: 'key-b',
      baseUrl: 'https://b.example.com',
    })
    store.setWorkspace({
      ...scopeA,
      workspaceSlug: 'main',
      cwd: '/tmp/a',
      mcpServers: { fs: { type: 'stdio', enabled: true, command: 'node', args: [] } },
    })

    expect(store.getCredential(scopeA, 'deepseek')?.apiKey).toBe('key-a')
    expect(store.getCredential(scopeB, 'deepseek')?.apiKey).toBe('key-b')
    expect(store.getWorkspace(scopeB, 'main')).toBeUndefined()
  })

  test('given session messages then truncate keeps messages up to uuid within tenant scope', () => {
    const store = new InMemoryTenantRuntimeStore()
    const messages = [
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'a1' },
      { type: 'user', uuid: 'u2' },
    ] as unknown as SDKMessage[]

    store.appendSessionMessages(scopeA, 'session-1', messages)
    store.appendSessionMessages(scopeB, 'session-1', [{ type: 'user', uuid: 'other' }] as unknown as SDKMessage[])

    expect(store.truncateSessionMessages(scopeA, 'session-1', 'a1').map((message) => (message as { uuid?: string }).uuid)).toEqual(['u1', 'a1'])
    expect(store.getSessionMessages(scopeB, 'session-1').map((message) => (message as { uuid?: string }).uuid)).toEqual(['other'])
  })

  test('given ids contain separators then tenant store keys do not collide', () => {
    const store = new InMemoryTenantRuntimeStore()
    const scopeWithSeparator = { tenantId: 'tenant:a', userId: 'user' }
    const otherScope = { tenantId: 'tenant', userId: 'a:user' }
    store.setMcpOAuthTokens(scopeWithSeparator, 'main:workspace', 'github', { accessToken: 'first' })
    store.setMcpOAuthTokens(otherScope, 'main', 'workspace:github', { accessToken: 'second' })

    expect(store.getMcpOAuthTokens(scopeWithSeparator, 'main:workspace', 'github')?.accessToken).toBe('first')
    expect(store.getMcpOAuthTokens(otherScope, 'main', 'workspace:github')?.accessToken).toBe('second')
  })

  test('given caller mutates returned values then store state remains unchanged', () => {
    const store = new InMemoryTenantRuntimeStore()
    const messages = [
      { type: 'user', uuid: 'u1', message: { content: 'hello' } },
    ] as unknown as SDKMessage[]
    store.appendSessionMessages(scopeA, 'session-1', messages)
    messages[0] = { type: 'user', uuid: 'mutated' } as unknown as SDKMessage

    const loaded = store.getSessionMessages(scopeA, 'session-1')
    ;(loaded[0] as { uuid?: string }).uuid = 'changed-after-read'

    expect(store.getSessionMessages(scopeA, 'session-1').map((message) => (message as { uuid?: string }).uuid)).toEqual(['u1'])
  })

  test('given a session permission decision then it is isolated and removed after expiry', () => {
    const store = new InMemoryTenantRuntimeStore()
    store.setPermissionDecision({ ...scopeA, sessionId: 'session-1', fingerprint: 'write:a.txt', expiresAt: 2_000 })

    expect(store.getPermissionDecision(scopeA, 'session-1', 'write:a.txt', 1_000)).toMatchObject({ sessionId: 'session-1' })
    expect(store.getPermissionDecision(scopeB, 'session-1', 'write:a.txt', 1_000)).toBeUndefined()
    expect(store.getPermissionDecision(scopeA, 'session-2', 'write:a.txt', 1_000)).toBeUndefined()
    expect(store.getPermissionDecision(scopeA, 'session-1', 'write:a.txt', 2_000)).toBeUndefined()
  })
})

describe('ServerMcpOAuthCallbackHandler', () => {
  test('given valid callback then finishAuth runs and tokens are stored under matching tenant scope', async () => {
    const store = new InMemoryTenantRuntimeStore()
    const handler = new ServerMcpOAuthCallbackHandler(store)
    let codeSeen = ''
    const registered = handler.registerPending({
      ...scopeA,
      workspaceSlug: 'main',
      serverName: 'github',
      callbackBaseUrl: 'https://proma.example.com/api/mcp/oauth/callback',
      state: 'state-a',
      finishAuth: async (code) => {
        codeSeen = code
        return { accessToken: 'access-a', raw: { ok: true } }
      },
    })
    const callbackUrl = `${registered.callbackUrl}&code=code-a`

    const result = await handler.handleCallbackUrl(callbackUrl)

    expect(result).toMatchObject({ ok: true, tenantId: 'tenant-a', workspaceSlug: 'main', serverName: 'github' })
    expect(codeSeen).toBe('code-a')
    expect(store.getMcpOAuthTokens(scopeA, 'main', 'github')?.accessToken).toBe('access-a')
    expect(store.getMcpOAuthTokens(scopeB, 'main', 'github')).toBeUndefined()
  })

  test('given callback scope mismatch then pending auth is rejected', async () => {
    const store = new InMemoryTenantRuntimeStore()
    const handler = new ServerMcpOAuthCallbackHandler(store)
    const registered = handler.registerPending({
      ...scopeA,
      workspaceSlug: 'main',
      serverName: 'github',
      callbackBaseUrl: 'https://proma.example.com/api/mcp/oauth/callback',
      state: 'state-a',
      finishAuth: async () => ({ accessToken: 'should-not-store' }),
    })
    const url = new URL(registered.callbackUrl)
    url.searchParams.set('tenant', 'tenant-b')
    url.searchParams.set('code', 'code-a')

    const result = await handler.handleCallbackUrl(url.toString())

    expect(result.ok).toBe(false)
    expect(result.error).toContain('scope')
    expect(store.getMcpOAuthTokens(scopeA, 'main', 'github')).toBeUndefined()
  })
})
