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
