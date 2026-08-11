import { describe, expect, test } from 'bun:test'
import { AgentRuntimeEventReplayHub, ServerMcpConnectionManager } from '@gravitas/shared/utils'
import type { AgentRuntimeWebAgentTurnInput } from '@gravitas/shared/utils'
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

  test('given a catalog hit then it lazily opens one connection only on first tool call and releases it once', async () => {
    let connects = 0
    let closes = 0
    let listCalls = 0
    const manager = new ServerMcpConnectionManager({ allowedOrigins: ['https://mcp.example.com'], maxTimeoutMs: 1_000 }, {
      connect: async () => {
        connects += 1
        return {
          close: async () => { closes += 1 },
          listTools: async () => { listCalls += 1; return [{ name: 'search', description: '搜索', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] },
          callTool: async (name: string, input: Record<string, unknown>) => `${name}:${input.query}`,
        }
      },
    })
    const controller = new AbortController()
    const events = new AgentRuntimeEventReplayHub()

    // 第一次任务：目录 miss，触发一次连接 + listTools；同一连接再被工具执行复用。
    const first = await acquireServerMcpTools(buildTurnInput(controller, events), manager)
    expect(connects).toBe(1)
    expect(listCalls).toBe(1)
    await first.tools[0]?.execute({ query: 'a' }, controller.signal)
    await first.tools[0]?.execute({ query: 'b' }, controller.signal)
    expect(connects).toBe(1)
    await first.release()
    expect(closes).toBe(1)

    // 第二次任务（同 scope + 同指纹）：目录命中，获取阶段零连接、零 listTools。
    const second = await acquireServerMcpTools(buildTurnInput(controller, events), manager)
    expect(connects).toBe(1)
    expect(listCalls).toBe(1)
    expect(second.tools).toHaveLength(1)

    // 真正调用工具时才懒建连接（第二次任务自己的连接），同任务内复用。
    await second.tools[0]?.execute({ query: 'c' }, controller.signal)
    await second.tools[0]?.execute({ query: 'd' }, controller.signal)
    expect(connects).toBe(2)
    await second.release()
    expect(closes).toBe(2)
  })
})

function buildTurnInput(controller: AbortController, events: AgentRuntimeEventReplayHub): AgentRuntimeWebAgentTurnInput {
  return {
    scope: { tenantId: 'tenant-a', userId: 'user-a' },
    session: { tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', workspaceSlug: 'main', channelId: 'channel-a', modelId: 'model-a', runtime: 'ai-sdk', createdAt: 1, updatedAt: 1 },
    taskId: 'task-a', credential: { tenantId: 'tenant-a', userId: 'user-a', channelId: 'channel-a', provider: 'deepseek', apiKey: 'key', baseUrl: 'https://api.example.com' },
    workspace: { tenantId: 'tenant-a', userId: 'user-a', workspaceSlug: 'main', cwd: '/tmp', mcpServers: { docs: { type: 'http', enabled: true, url: 'https://mcp.example.com/mcp' } } },
    prompt: 'test', modelId: 'model-a', provider: 'deepseek', permissionMode: 'safe', historyMessages: [], signal: controller.signal,
    emit: (payload) => events.emit({ tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', payload: payload as never }),
  }
}
