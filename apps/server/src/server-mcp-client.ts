import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerEntry } from '@proma/shared'
import type {
  ServerMcpConnection,
  ServerMcpConnectionFactory,
  ServerMcpConnectionFactoryInput,
  TenantMcpOAuthTokens,
  TenantRuntimeStore,
} from '@proma/shared/utils'

const MAX_MCP_RESULT_BYTES = 256 * 1024
const OAUTH_REFRESH_SKEW_MS = 30_000

export interface ServerMcpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ServerMcpClientConnection extends ServerMcpConnection {
  listTools(signal: AbortSignal): Promise<ServerMcpToolDefinition[]>
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>
}

/**
 * API 进程专用的 HTTP(S) MCP 工厂。
 *
 * 不支持 stdio；网络目标已由连接池在创建 transport 前执行 allowlist 校验。
 * OAuth access token 仅在当前租户/用户/工作区/服务器范围内读取与刷新。
 */
export class HttpServerMcpConnectionFactory implements ServerMcpConnectionFactory {
  constructor(private readonly store: TenantRuntimeStore) {}

  async connect(input: ServerMcpConnectionFactoryInput): Promise<ServerMcpClientConnection> {
    const headers = await createMcpHeaders(this.store, input)
    const transport = createTransport(input.config.url, input.entry, headers)
    const client = new Client({ name: 'proma-server', version: '0.1.0' }, { capabilities: {} })
    await withTimeout(client.connect(transport, { signal: input.signal }), input.config.timeoutMs, input.signal)
    return new HttpServerMcpClientConnection(client, transport, input.config.timeoutMs)
  }
}

class HttpServerMcpClientConnection implements ServerMcpClientConnection {
  constructor(
    private readonly client: Client,
    private readonly transport: Transport,
    private readonly timeoutMs: number,
  ) {}

  async listTools(signal: AbortSignal): Promise<ServerMcpToolDefinition[]> {
    const result = await withTimeout(this.client.listTools(undefined, { signal }), this.timeoutMs, signal)
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? `MCP 工具 ${tool.name}`,
      inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
    }))
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const result = await withTimeout(this.client.callTool({ name, arguments: args }, undefined, { signal }), this.timeoutMs, signal)
    return serializeMcpResult(result)
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}

function createTransport(url: string, entry: McpServerEntry, headers: Record<string, string>): Transport {
  const requestInit: RequestInit = { headers }
  if (entry.type === 'sse') return new SSEClientTransport(new URL(url), { requestInit })
  return new StreamableHTTPClientTransport(new URL(url), { requestInit })
}

async function createMcpHeaders(store: TenantRuntimeStore, input: ServerMcpConnectionFactoryInput): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...(input.entry.headers ?? {}) }
  const auth = input.entry.auth
  if (auth?.type === 'bearer' && auth.bearerToken) {
    headers.Authorization = `Bearer ${auth.bearerToken}`
    return headers
  }
  if (auth?.type !== 'oauthAuthorizationCode' && auth?.type !== 'oauthClientCredentials') return headers

  const token = await getUsableOAuthToken(store, input)
  if (!token?.accessToken) throw new Error(`MCP ${input.serverName} 尚未完成 OAuth 授权`)
  headers.Authorization = `Bearer ${token.accessToken}`
  return headers
}

async function getUsableOAuthToken(store: TenantRuntimeStore, input: ServerMcpConnectionFactoryInput): Promise<TenantMcpOAuthTokens | undefined> {
  const current = await store.getMcpOAuthTokens(input.scope, input.workspaceSlug, input.serverName)
  if (!current || !shouldRefreshToken(current)) return current
  const auth = input.entry.auth
  if (!auth?.tokenEndpoint) throw new Error(`MCP ${input.serverName} 的 OAuth token 已过期且未配置 tokenEndpoint`)

  const clientSecret = await store.getMcpClientSecret(input.scope, input.workspaceSlug, input.serverName)
  const form = new URLSearchParams()
  form.set('client_id', auth.clientId ?? '')
  if (auth.type === 'oauthClientCredentials') {
    form.set('grant_type', 'client_credentials')
    if (auth.scope) form.set('scope', auth.scope)
  } else {
    if (!current.refreshToken) throw new Error(`MCP ${input.serverName} 的 OAuth refresh token 不存在`)
    form.set('grant_type', 'refresh_token')
    form.set('refresh_token', current.refreshToken)
  }
  if (clientSecret) form.set('client_secret', clientSecret)
  const response = await withTimeout(fetch(auth.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: input.signal,
  }), input.config.timeoutMs, input.signal)
  if (!response.ok) throw new Error(`MCP ${input.serverName} OAuth 刷新失败: HTTP ${response.status}`)
  const body = await response.json() as unknown
  if (!isRecord(body) || typeof body.access_token !== 'string') throw new Error(`MCP ${input.serverName} OAuth 刷新响应无 access_token`)
  const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in * 1_000 : undefined
  const refreshed: TenantMcpOAuthTokens = {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : current.refreshToken,
    expiresAt: expiresIn ? Date.now() + expiresIn : undefined,
    raw: body,
  }
  await store.setMcpOAuthTokens(input.scope, input.workspaceSlug, input.serverName, refreshed)
  return refreshed
}

function shouldRefreshToken(tokens: TenantMcpOAuthTokens): boolean {
  return !tokens.accessToken || (tokens.expiresAt != null && tokens.expiresAt <= Date.now() + OAUTH_REFRESH_SKEW_MS)
}

function serializeMcpResult(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_MCP_RESULT_BYTES) return serialized
  return `${Buffer.from(serialized).subarray(0, MAX_MCP_RESULT_BYTES).toString('utf8')}\n[MCP 结果已按 ${MAX_MCP_RESULT_BYTES} 字节截断]`
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('MCP 操作已取消'))
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`MCP 操作超过 ${timeoutMs}ms 超时`)), timeoutMs)
    const abort = () => reject(new Error('MCP 操作已取消'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
