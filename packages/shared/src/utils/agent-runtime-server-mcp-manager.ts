import { createHash } from 'node:crypto'
import type { McpServerEntry } from '../types/agent'
import type { AgentRuntimeScope } from './agent-runtime-server'
import type { ServerMcpEgressPolicy, ValidatedServerMcpConfig } from './agent-runtime-server-mcp-policy'
import { validateServerMcpConfig } from './agent-runtime-server-mcp-policy'

export interface ServerMcpConnection {
  close(): Promise<void>
}

/** 纯数据形式的 MCP 工具定义，可安全跨任务缓存（不含连接/授权态）。 */
export interface McpCatalogToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
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

interface CachedToolCatalog {
  tools: McpCatalogToolDefinition[]
  fetchedAt: number
}

const DEFAULT_CATALOG_TTL_MS = 60_000

/**
 * 仅在同一 tenant/user/workspace/server 内复用的服务端 MCP 连接池，并附带工具目录缓存。
 *
 * - 连接级复用：同 scope 下按引用计数共享 transport，refCount 归零才关闭。
 * - 工具目录缓存：在连接之上追加一层按「channel 身份 + 条目指纹」的记忆化缓存，
 *   命中时跳过 listTools 网络往返（对齐 OpenAI Codex #37970 的设计）。
 * - 不接受 stdio transport；该 transport 必须留给独立执行 worker。
 */
export class ServerMcpConnectionManager {
  private readonly connections = new Map<string, CachedConnection>()
  private readonly toolCatalogs = new Map<string, CachedToolCatalog>()

  constructor(
    private readonly policy: ServerMcpEgressPolicy,
    private readonly factory: ServerMcpConnectionFactory,
    private readonly catalogTtlMs: number = DEFAULT_CATALOG_TTL_MS,
  ) {}

  /**
   * 计算工具目录缓存指纹。
   *
   * 仅对「认证身份可由静态配置安全推导」的条目生成可复用指纹：
   * - `none` / `bearer`：静态 bearer token 纳入指纹，跨身份不串缓存。
   * - OAuth（authorization code / client credentials）：token 为动态凭证，
   *   与 Codex 一致不进入共享目录缓存，返回 `null`。
   */
  catalogFingerprint(serverName: string, entry: McpServerEntry): string | null {
    const config = validateServerMcpConfig(serverName, entry, this.policy)
    if (entry.auth?.type === 'oauthAuthorizationCode' || entry.auth?.type === 'oauthClientCredentials') {
      return null
    }
    const fingerprint = JSON.stringify([
      config.url,
      entry.type,
      entry.auth?.type ?? 'none',
      entry.auth?.type === 'bearer' ? (entry.auth.bearerToken ?? '') : '',
      normalizeHeaders(entry.headers),
      config.timeoutMs,
    ])
    return createHash('sha256').update(fingerprint).digest('hex')
  }

  /**
   * 工具目录记忆化读取：同指纹 + 未过期命中时跳过 `fetchTools` 网络往返。
   *
   * @param scopeKey    连接身份（tenant/user/workspace/server）组成的缓存键。
   * @param serverName  用于隔离的服务器名。
   * @param fingerprint catalogFingerprint 的返回值；为 null 时强制每次拉取（OAuth）。
   * @param signal      用于 listTools 的取消信号。
   * @param fetchTools  未命中时的真实目录拉取回调（连接 + listTools）。
   */
  async resolveToolCatalog(
    scopeKey: string,
    serverName: string,
    fingerprint: string | null,
    signal: AbortSignal,
    fetchTools: () => Promise<McpCatalogToolDefinition[]>,
  ): Promise<{ tools: McpCatalogToolDefinition[]; fromCache: boolean }> {
    if (fingerprint !== null && this.catalogTtlMs > 0 && !signal.aborted) {
      const key = this.catalogKey(scopeKey, serverName, fingerprint)
      const cached = this.toolCatalogs.get(key)
      if (cached && Date.now() - cached.fetchedAt <= this.catalogTtlMs) {
        return { tools: cached.tools, fromCache: true }
      }
      const tools = await fetchTools()
      if (!signal.aborted) this.toolCatalogs.set(key, { tools, fetchedAt: Date.now() })
      return { tools, fromCache: false }
    }
    return { tools: await fetchTools(), fromCache: false }
  }

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

  /** 清空工具目录缓存（连接缓存不受影响）。 */
  clearToolCatalogs(): void {
    this.toolCatalogs.clear()
  }

  /** 当前工具目录缓存的条目数；主要用于指标与测试断言。 */
  get toolCatalogCount(): number {
    return this.toolCatalogs.size
  }

  private catalogKey(scopeKey: string, serverName: string, fingerprint: string): string {
    return `${scopeKey}::${serverName}::${fingerprint}`
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

/** 静态请求头规范化：key 排序 + 值参与指纹，避免无关顺序/空白差异引发缓存抖动。 */
function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {}
  const normalized: Array<[string, string]> = Object.entries(headers)
    .map(([key, value]) => [key.trim().toLowerCase(), value] as [string, string])
  normalized.sort(([left], [right]) => left.localeCompare(right))
  return Object.fromEntries(normalized)
}
