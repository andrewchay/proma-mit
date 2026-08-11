import { describe, expect, test } from 'bun:test'
import { ServerMcpConnectionManager } from './agent-runtime-server-mcp-manager'

describe('服务端 MCP 连接池', () => {
  test('given same scoped server then it reuses only that connection and closes after final release', async () => {
    let connects = 0
    let closes = 0
    const manager = new ServerMcpConnectionManager({ allowedOrigins: ['https://mcp.example.com'], maxTimeoutMs: 5_000 }, {
      connect: async () => { connects += 1; return { close: async () => { closes += 1 } } },
    })
    const base = { tenantId: 'tenant-a', userId: 'user-a', workspaceSlug: 'main', serverName: 'github', entry: { type: 'http' as const, enabled: true, url: 'https://mcp.example.com/api' }, signal: new AbortController().signal }

    const first = await manager.acquire(base)
    const second = await manager.acquire(base)
    await first.release()
    expect(connects).toBe(1)
    expect(closes).toBe(0)
    await second.release()
    expect(closes).toBe(1)
  })

  test('given another tenant or workspace then it cannot reuse a connection', async () => {
    let connects = 0
    const manager = new ServerMcpConnectionManager({ allowedOrigins: ['https://mcp.example.com'], maxTimeoutMs: 5_000 }, {
      connect: async () => { connects += 1; return { close: async () => undefined } },
    })
    const entry = { type: 'http' as const, enabled: true, url: 'https://mcp.example.com/api' }
    const signal = new AbortController().signal
    const first = await manager.acquire({ tenantId: 'tenant-a', userId: 'user-a', workspaceSlug: 'main', serverName: 'github', entry, signal })
    const second = await manager.acquire({ tenantId: 'tenant-b', userId: 'user-a', workspaceSlug: 'main', serverName: 'github', entry, signal })
    expect(connects).toBe(2)
    await first.release()
    await second.release()
  })
})

describe('工具目录缓存', () => {
  const policy = { allowedOrigins: ['https://mcp.example.com'], maxTimeoutMs: 5_000 }
  const factory = { connect: async () => ({ close: async () => undefined }) }
  const baseScopeKey = JSON.stringify(['tenant-a', 'user-a', 'main'])

  test('given same scope + same entry then second resolve reuses cached tools (skips fetch)', async () => {
    const manager = new ServerMcpConnectionManager(policy, factory, 60_000)
    let fetches = 0
    const mcpEntry = { type: 'http' as const, enabled: true, url: 'https://mcp.example.com/api' }
    const fingerprint = manager.catalogFingerprint('github', mcpEntry)
    expect(fingerprint).not.toBeNull()
    const fetchTools = () => { fetches += 1; return Promise.resolve([{ name: 'tool-a', description: 'd', inputSchema: { type: 'object' } }]) }

    const first = await manager.resolveToolCatalog(baseScopeKey, 'github', fingerprint, new AbortController().signal, fetchTools)
    expect(first.fromCache).toBe(false)
    const second = await manager.resolveToolCatalog(baseScopeKey, 'github', fingerprint, new AbortController().signal, fetchTools)
    expect(second.fromCache).toBe(true)
    expect(fetches).toBe(1)
    expect(second.tools[0]?.name).toBe('tool-a')
  })

  test('given different scope then it cannot reuse catalog entry', async () => {
    const manager = new ServerMcpConnectionManager(policy, factory, 60_000)
    let fetches = 0
    const mcpEntry = { type: 'http' as const, enabled: true, url: 'https://mcp.example.com/api' }
    const fingerprint = manager.catalogFingerprint('github', mcpEntry)!
    const fetchTools = () => { fetches += 1; return Promise.resolve([{ name: 'tool-a', description: 'd', inputSchema: {} }]) }

    await manager.resolveToolCatalog(JSON.stringify(['tenant-a', 'user-a', 'main']), 'github', fingerprint, new AbortController().signal, fetchTools)
    await manager.resolveToolCatalog(JSON.stringify(['tenant-b', 'user-a', 'main']), 'github', fingerprint, new AbortController().signal, fetchTools)
    expect(fetches).toBe(2)
  })

  test('given TTL expiry then it refetches', async () => {
    const manager = new ServerMcpConnectionManager(policy, factory, 1_000)
    let fetches = 0
    const mcpEntry = { type: 'http' as const, enabled: true, url: 'https://mcp.example.com/api' }
    const fingerprint = manager.catalogFingerprint('github', mcpEntry)!
    const fetchTools = () => { fetches += 1; return Promise.resolve([{ name: 'tool-a', description: 'd', inputSchema: {} }]) }

    await manager.resolveToolCatalog(baseScopeKey, 'github', fingerprint, new AbortController().signal, fetchTools)
    await manager.resolveToolCatalog(baseScopeKey, 'github', fingerprint, new AbortController().signal, fetchTools)
    expect(fetches).toBe(1)
    await Bun.sleep(1_100)
    await manager.resolveToolCatalog(baseScopeKey, 'github', fingerprint, new AbortController().signal, fetchTools)
    expect(fetches).toBe(2)
  })

  test('given changed static headers then fingerprint changes and catalog is rebuilt', async () => {
    const manager = new ServerMcpConnectionManager(policy, factory, 60_000)
    let fetches = 0
    const base = { type: 'http' as const, enabled: true, url: 'https://mcp.example.com/api' }
    const fetchTools = () => { fetches += 1; return Promise.resolve([{ name: 'tool-a', description: 'd', inputSchema: {} }]) }

    const fp1 = manager.catalogFingerprint('github', { ...base, headers: { 'X-Api-Key': 'k1' } })!
    const fp2 = manager.catalogFingerprint('github', { ...base, headers: { 'X-Api-Key': 'k2' } })!
    expect(fp1).not.toBe(fp2)

    await manager.resolveToolCatalog(baseScopeKey, 'github', fp1, new AbortController().signal, fetchTools)
    await manager.resolveToolCatalog(baseScopeKey, 'github', fp2, new AbortController().signal, fetchTools)
    expect(fetches).toBe(2)
  })

  test('given OAuth auth then fingerprint is null and catalog is never cached', async () => {
    const manager = new ServerMcpConnectionManager(policy, factory, 60_000)
    let fetches = 0
    const mcpEntry = {
      type: 'http' as const,
      enabled: true,
      url: 'https://mcp.example.com/api',
      auth: { type: 'oauthAuthorizationCode' as const, clientId: 'c' },
    }
    const fingerprint = manager.catalogFingerprint('github', mcpEntry)
    expect(fingerprint).toBeNull()
    const fetchTools = () => { fetches += 1; return Promise.resolve([{ name: 'tool-a', description: 'd', inputSchema: {} }]) }

    await manager.resolveToolCatalog(baseScopeKey, 'github', fingerprint, new AbortController().signal, fetchTools)
    await manager.resolveToolCatalog(baseScopeKey, 'github', fingerprint, new AbortController().signal, fetchTools)
    expect(fetches).toBe(2)
    expect(manager.toolCatalogCount).toBe(0)
  })

  test('given catalogCacheTtlMs=0 then caching is disabled', async () => {
    const manager = new ServerMcpConnectionManager(policy, factory, 0)
    let fetches = 0
    const mcpEntry = { type: 'http' as const, enabled: true, url: 'https://mcp.example.com/api' }
    const fingerprint = manager.catalogFingerprint('github', mcpEntry)!
    const fetchTools = () => { fetches += 1; return Promise.resolve([{ name: 'tool-a', description: 'd', inputSchema: {} }]) }

    await manager.resolveToolCatalog(baseScopeKey, 'github', fingerprint, new AbortController().signal, fetchTools)
    await manager.resolveToolCatalog(baseScopeKey, 'github', fingerprint, new AbortController().signal, fetchTools)
    expect(fetches).toBe(2)
  })
})
