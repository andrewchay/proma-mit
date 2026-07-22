/**
 * Agent runtime MCP 服务边界。
 *
 * 默认实现复用 Electron 本地 MCP 客户端缓存；服务端 Web 可以替换为多租户连接池、
 * 远端 token store 或无状态 MCP 网关。
 */

import type { McpServerEntry } from '@proma/shared'
import { acquireMcpClientManager } from './mcp-client-cache'
import type { McpAuthRequiredPayload, McpClientManager } from './mcp-client'

export interface RuntimeMcpAcquireInput {
  workspaceSlug: string
  mcpServers: Record<string, McpServerEntry>
  cwd: string
  onMcpAuthRequired?: (payload: McpAuthRequiredPayload) => void
}

export interface RuntimeMcpLease {
  manager: McpClientManager
  release: () => void
}

export type RuntimeMcpAcquireFn = (
  workspaceSlug: string,
  configs: Record<string, McpServerEntry>,
  cwd: string,
  options: { onMcpAuthRequired?: (payload: McpAuthRequiredPayload) => void },
) => Promise<RuntimeMcpLease>

export interface RuntimeMcpService {
  acquireClientManager(input: RuntimeMcpAcquireInput): Promise<RuntimeMcpLease>
}

export class ElectronRuntimeMcpService implements RuntimeMcpService {
  constructor(private readonly acquire: RuntimeMcpAcquireFn = acquireMcpClientManager) {}

  async acquireClientManager(input: RuntimeMcpAcquireInput): Promise<RuntimeMcpLease> {
    return this.acquire(input.workspaceSlug, input.mcpServers, input.cwd, {
      onMcpAuthRequired: input.onMcpAuthRequired,
    })
  }
}
