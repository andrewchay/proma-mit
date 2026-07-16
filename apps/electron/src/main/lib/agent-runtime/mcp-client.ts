/**
 * MCP 客户端管理器（Provider-Agnostic Runtime）
 *
 * 负责为工作区中启用的 MCP 服务器建立连接、列出工具并执行工具调用。
 * 每个服务器独立一个 Client + Transport，工具名按 `${serverName}__${toolName}`
 * 命名空间化，避免不同服务器之间重名。
 */

import type { McpServerEntry } from '@proma/shared'
import type { ToolResult } from '@proma/core'
import type { RuntimeToolDefinition, ToolContext } from './types'
import { McpOAuthProvider } from './mcp-oauth-provider'
import { registerPendingMcpOAuth } from './mcp-oauth-pending'

interface ConnectedServer {
  name: string
  client: import('@modelcontextprotocol/sdk/client/index.js').Client
  transport: import('@modelcontextprotocol/sdk/shared/transport.js').Transport
}

/** MCP 工具执行结果 */
export interface McpToolResult extends ToolResult {}

export interface McpAuthRequiredPayload {
  workspaceSlug: string
  serverName: string
}

export class McpClientManager {
  private servers: ConnectedServer[] = []
  private abortSignal?: AbortSignal
  private disconnected = false

  constructor(
    private readonly configs: Record<string, McpServerEntry>,
    private readonly cwd: string,
    private readonly options?: {
      abortSignal?: AbortSignal
      workspaceSlug?: string
      onMcpAuthRequired?: (payload: McpAuthRequiredPayload) => void
      /** 是否在 session abort 时自动断开连接（跨 session 缓存时应设为 false） */
      disconnectOnAbort?: boolean
    },
  ) {
    this.abortSignal = options?.abortSignal
    if (options?.disconnectOnAbort !== false) {
      this.abortSignal?.addEventListener('abort', () => this.disconnect(), { once: true })
    }
  }

  /**
   * 连接所有启用的 MCP 服务器
   *
   * 单个服务器连接失败不会影响其他服务器，失败信息会打印到日志。
   * 已连接过的实例会跳过，支持跨 session 缓存复用。
   */
  async connectAll(): Promise<void> {
    const entries = Object.entries(this.configs).filter(([, entry]) => entry.enabled)
    if (entries.length === 0) return
    if (this.servers.length > 0) {
      // 已连接，仅检查配置是否变化；简单复用当前连接
      return
    }

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')

    for (const [name, entry] of entries) {
      if (this.abortSignal?.aborted) break
      let transport: import('@modelcontextprotocol/sdk/shared/transport.js').Transport | undefined
      try {
        transport = await this.createTransport(name, entry)
        const client = new Client(
          { name: `proma-runtime-${name}`, version: '0.1.0' },
          { capabilities: {} },
        )
        await client.connect(transport)
        this.servers.push({ name, client, transport })
        console.log(`[MCP 客户端] 已连接服务器: ${name}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (err instanceof Error && err.name === 'UnauthorizedError') {
          console.warn(`[MCP 客户端] 服务器 ${name} 需要 OAuth 授权:`, message)
          if (transport && 'finishAuth' in transport && typeof transport.finishAuth === 'function') {
            const finishTransport = transport
            registerPendingMcpOAuth(
              this.options?.workspaceSlug ?? '',
              name,
              async (code: string) => {
                await (finishTransport as unknown as { finishAuth: (code: string) => Promise<void> }).finishAuth(code)
              },
            )
          }
          this.options?.onMcpAuthRequired?.({ workspaceSlug: this.options?.workspaceSlug ?? '', serverName: name })
          continue
        }
        console.error(`[MCP 客户端] 连接服务器 ${name} 失败:`, message)
      }
    }
  }

  /**
   * 列出所有已连接服务器的工具，并转换为 RuntimeToolDefinition
   */
  async listAllTools(abortSignal?: AbortSignal): Promise<RuntimeToolDefinition[]> {
    const tools: RuntimeToolDefinition[] = []
    for (const server of this.servers) {
      if ((abortSignal ?? this.abortSignal)?.aborted) break
      try {
        const result = await server.client.listTools()
        for (const tool of result.tools) {
          const namespacedName = sanitizeMcpToolName(`mcp__${server.name}__${tool.name}`)
          tools.push({
            name: namespacedName,
            description: tool.description ?? `${server.name} 的 ${tool.name} 工具`,
            parameters: (tool.inputSchema as RuntimeToolDefinition['parameters']) ?? {
              type: 'object',
              properties: {},
            },
            execute: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
              return this.executeTool(server.name, tool.name, input, ctx)
            },
          })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[MCP 客户端] 列出服务器 ${server.name} 工具失败:`, message)
      }
    }
    return tools
  }

  /**
   * 执行指定 MCP 工具
   *
   * @param serverName 服务器名称（命名空间前缀）
   * @param toolName 原始工具名
   * @param args 工具参数
   * @param ctx 工具执行上下文
   */
  async executeTool(
    serverName: string,
    toolName: string,
    args: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    if (ctx.abortSignal?.aborted) {
      return { content: '操作已中止', isError: true, toolCallId: '' }
    }

    const server = this.servers.find((s) => s.name === serverName)
    if (!server) {
      return { content: `MCP 服务器未连接: ${serverName}`, isError: true, toolCallId: '' }
    }

    try {
      const result = await server.client.callTool(
        { name: toolName, arguments: args as Record<string, unknown> },
        undefined,
        { signal: ctx.abortSignal },
      )
      return { content: this.serializeResult(result), isError: false, toolCallId: '' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: `MCP 工具调用失败: ${message}`, isError: true, toolCallId: '' }
    }
  }

  /** 断开所有 MCP 服务器连接 */
  async disconnect(): Promise<void> {
    if (this.disconnected) return
    this.disconnected = true
    for (const server of this.servers) {
      try {
        await server.client.close()
      } catch (err) {
        console.warn(`[MCP 客户端] 断开服务器 ${server.name} 时出错:`, err)
      }
    }
    this.servers = []
  }

  /**
   * 列出所有已连接服务器提供的资源
   */
  async listAllResources(abortSignal?: AbortSignal): Promise<Array<{ server: string; resources: unknown[] }>> {
    const result: Array<{ server: string; resources: unknown[] }> = []
    for (const server of this.servers) {
      if ((abortSignal ?? this.abortSignal)?.aborted) break
      try {
        const response = await server.client.listResources()
        result.push({ server: server.name, resources: response.resources as unknown[] })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[MCP 客户端] 列出服务器 ${server.name} 资源失败:`, message)
      }
    }
    return result
  }

  /**
   * 读取指定 URI 的资源，按服务器顺序尝试直到成功
   */
  async readResource(uri: string, abortSignal?: AbortSignal): Promise<{ server: string; content: string; mimeType?: string } | undefined> {
    for (const server of this.servers) {
      if ((abortSignal ?? this.abortSignal)?.aborted) break
      try {
        const response = await server.client.readResource({ uri })
        const contents = (response.contents ?? []) as Array<unknown>
        for (const item of contents) {
          if (item && typeof item === 'object') {
            const obj = item as Record<string, unknown>
            if (typeof obj.text === 'string') {
              return { server: server.name, content: obj.text, mimeType: typeof obj.mimeType === 'string' ? obj.mimeType : undefined }
            }
            if (typeof obj.blob === 'string') {
              return { server: server.name, content: obj.blob, mimeType: typeof obj.mimeType === 'string' ? obj.mimeType : 'application/octet-stream' }
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`[MCP 客户端] 从服务器 ${server.name} 读取资源 ${uri} 失败:`, message)
      }
    }
    return undefined
  }

  /** 当前是否已连接任意服务器 */
  get isConnected(): boolean {
    return this.servers.length > 0
  }

  /** 根据配置创建对应传输层 */
  private async createTransport(
    name: string,
    entry: McpServerEntry,
  ): Promise<import('@modelcontextprotocol/sdk/shared/transport.js').Transport> {
    if (entry.type === 'stdio') {
      if (!entry.command) throw new Error(`MCP 服务器 ${name} 缺少 command`)
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
      return new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        env: entry.env,
        cwd: this.cwd,
        stderr: 'pipe',
      })
    }

    if (entry.type === 'sse') {
      if (!entry.url) throw new Error(`MCP 服务器 ${name} 缺少 url`)
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
      const url = new URL(entry.url)
      return new SSEClientTransport(url, {
        authProvider: this.createAuthProvider(name, entry),
        requestInit: { headers: this.buildHeaders(entry) },
      })
    }

    if (entry.type === 'http') {
      if (!entry.url) throw new Error(`MCP 服务器 ${name} 缺少 url`)
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      const url = new URL(entry.url)
      return new StreamableHTTPClientTransport(url, {
        authProvider: this.createAuthProvider(name, entry),
        requestInit: { headers: this.buildHeaders(entry) },
      })
    }

    throw new Error(`不支持的 MCP 传输类型: ${(entry as { type: string }).type}`)
  }

  /** 为 http/sse 传输创建 OAuth provider */
  private createAuthProvider(name: string, entry: McpServerEntry): McpOAuthProvider | undefined {
    if (!this.options?.workspaceSlug) return undefined
    const auth = entry.auth
    if (!auth) return undefined
    if (auth.type === 'oauthAuthorizationCode' || auth.type === 'oauthClientCredentials') {
      return new McpOAuthProvider({
        workspaceSlug: this.options.workspaceSlug,
        serverName: name,
        auth,
      })
    }
    return undefined
  }

  /** 构建请求头，支持静态 Bearer Token */
  private buildHeaders(entry: McpServerEntry): Record<string, string> {
    const headers: Record<string, string> = { ...(entry.headers ?? {}) }
    if (entry.auth?.type === 'bearer' && entry.auth.bearerToken) {
      headers['Authorization'] = `Bearer ${entry.auth.bearerToken}`
    }
    return headers
  }

  /** 将 MCP 工具结果序列化为文本 */
  private serializeResult(result: unknown): string {
    if (!result || typeof result !== 'object') return String(result ?? '')
    const content = (result as { content?: unknown }).content
    if (!content) return JSON.stringify(result, null, 2)

    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (item && typeof item === 'object' && 'text' in item) return String((item as { text: unknown }).text)
          return JSON.stringify(item)
        })
        .join('\n')
    }

    return JSON.stringify(content, null, 2)
  }
}

/**
 * 规范化 MCP 工具名，使其符合 OpenAI function name 规则。
 *
 * OpenAI/DeepSeek 要求 function name 只能包含 [a-zA-Z0-9_-]，且长度不超过 64。
 * 这里把非法字符替换为下划线，并截断超长部分。
 *
 * 注意：不合并连续下划线，以保证 `mcp__${server}__${tool}` 命名空间前缀
 * （`mcp__`）在清洗后仍然可被识别。
 */
export function sanitizeMcpToolName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (sanitized.length <= 64) return sanitized
  // 超长时保留前缀和尾部，中间用哈希摘要避免碰撞
  const hash = Array.from(name)
    .reduce((acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0, 0)
    .toString(36)
    .replace(/-/g, '0')
  const suffix = `_${hash}`
  return sanitized.slice(0, 64 - suffix.length) + suffix
}
