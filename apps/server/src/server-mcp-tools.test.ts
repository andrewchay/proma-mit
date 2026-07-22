import { describe, expect, test } from 'bun:test'
import { AgentRuntimeEventReplayHub, ServerMcpConnectionManager } from '@proma/shared/utils'
import { acquireServerMcpTools } from './server-mcp-tools.ts'

describe('服务端 MCP 工具桥接', () => {
  test('given a scoped HTTP MCP then it exposes namespaced tools and releases its connection', async () => {
    let closed = 0
    const manager = new ServerMcpConnectionManager({ allowedOrigins: ['https://mcp.example.com'], maxTimeoutMs: 1_000 }, {
      connect: async () => ({
        close: async () => { closed += 1 },
        listTools: async () => [{ name: 'search', description: '搜索', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
        callTool: async (name: string, input: Record<string, unknown>) => `${name}:${input.query}`,
      }),
    })
    const controller = new AbortController()
    const events = new AgentRuntimeEventReplayHub()
    const acquired = await acquireServerMcpTools({
      scope: { tenantId: 'tenant-a', userId: 'user-a' },
      session: { tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', workspaceSlug: 'main', channelId: 'channel-a', modelId: 'model-a', runtime: 'ai-sdk', createdAt: 1, updatedAt: 1 },
      taskId: 'task-a', credential: { tenantId: 'tenant-a', userId: 'user-a', channelId: 'channel-a', provider: 'deepseek', apiKey: 'key', baseUrl: 'https://api.example.com' },
      workspace: { tenantId: 'tenant-a', userId: 'user-a', workspaceSlug: 'main', cwd: '/tmp', mcpServers: { docs: { type: 'http', enabled: true, url: 'https://mcp.example.com/mcp' } } },
      prompt: 'test', modelId: 'model-a', provider: 'deepseek', permissionMode: 'safe', historyMessages: [], signal: controller.signal,
      emit: (payload) => events.emit({ tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', payload }),
    }, manager)

    expect(acquired.tools).toHaveLength(1)
    expect(acquired.tools[0]?.name).toBe('mcp__docs__search')
    expect(await acquired.tools[0]?.execute({ query: 'hello' }, controller.signal)).toBe('search:hello')
    await acquired.release()
    expect(closed).toBe(1)
  })
})
