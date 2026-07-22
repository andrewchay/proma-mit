import type { McpServerEntry } from '../types/agent'
import type { AgentRuntimeScope } from './agent-runtime-server'
import type { ServerMcpEgressPolicy, ValidatedServerMcpConfig } from './agent-runtime-server-mcp-policy'
import { validateServerMcpConfig } from './agent-runtime-server-mcp-policy'

export interface ServerMcpConnection {
  close(): Promise<void>
}

export interface ServerMcpConnectionFactoryInput {
  config: ValidatedServerMcpConfig
  scope: AgentRuntimeScope
  workspaceSlug: string
  serverName: string
  entry: McpServerEntry
  signal: AbortSignal
}

export interface ServerMcpConnectionFactory {
  connect(input: ServerMcpConnectionFactoryInput): Promise<ServerMcpConnection>
}

export interface AcquireServerMcpConnectionInput extends AgentRuntimeScope {
  workspaceSlug: string
  serverName: string
  entry: McpServerEntry
  signal: AbortSignal
}

interface CachedConnection {
  connection: ServerMcpConnection
  refCount: number
}

/**
 * 仅在同一 tenant/user/workspace/server 内复用的服务端 MCP 连接池。
 * 不接受 stdio transport；该 transport 必须留给独立执行 worker。
 */
export class ServerMcpConnectionManager {
  private readonly connections = new Map<string, CachedConnection>()

  constructor(
    private readonly policy: ServerMcpEgressPolicy,
    private readonly factory: ServerMcpConnectionFactory,
  ) {}

  async acquire(input: AcquireServerMcpConnectionInput): Promise<{ connection: ServerMcpConnection; release: () => Promise<void> }> {
    const config = validateServerMcpConfig(input.serverName, input.entry, this.policy)
    const key = connectionKey(input)
    const existing = this.connections.get(key)
    if (existing) {
      existing.refCount += 1
      return { connection: existing.connection, release: () => this.release(key) }
    }
    const connection = await this.factory.connect({
      config,
      scope: { tenantId: input.tenantId, userId: input.userId },
      workspaceSlug: input.workspaceSlug,
      serverName: input.serverName,
      entry: input.entry,
      signal: input.signal,
    })
    this.connections.set(key, { connection, refCount: 1 })
    return { connection, release: () => this.release(key) }
  }

  async closeAll(): Promise<void> {
    const entries = [...this.connections.values()]
    this.connections.clear()
    await Promise.all(entries.map(({ connection }) => connection.close()))
  }

  private async release(key: string): Promise<void> {
    const cached = this.connections.get(key)
    if (!cached) return
    cached.refCount -= 1
    if (cached.refCount > 0) return
    this.connections.delete(key)
    await cached.connection.close()
  }
}

function connectionKey(input: Pick<AcquireServerMcpConnectionInput, 'tenantId' | 'userId' | 'workspaceSlug' | 'serverName'>): string {
  return JSON.stringify([input.tenantId, input.userId, input.workspaceSlug, input.serverName])
}
