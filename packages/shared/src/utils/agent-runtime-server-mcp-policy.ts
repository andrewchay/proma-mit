import type { McpServerEntry } from '../types/agent'

export interface ServerMcpEgressPolicy {
  /** 服务端仅允许 HTTP(S) MCP，stdio 必须交给隔离 worker。 */
  allowedOrigins: readonly string[]
  maxTimeoutMs: number
}

export interface ValidatedServerMcpConfig {
  name: string
  url: string
  timeoutMs: number
}

/**
 * 在创建任何 server-side MCP transport 前执行边界校验。
 * 这里刻意拒绝 stdio，避免 API worker 继承宿主机命令执行能力。
 */
export function validateServerMcpConfig(
  name: string,
  entry: McpServerEntry,
  policy: ServerMcpEgressPolicy,
): ValidatedServerMcpConfig {
  if (!entry.enabled) throw new Error(`MCP ${name} 未启用`)
  if (entry.type === 'stdio') throw new Error(`MCP ${name} 的 stdio transport 只能在隔离 worker 中运行`)
  if (entry.type !== 'http' && entry.type !== 'sse') throw new Error(`MCP ${name} transport 不受服务端支持`)
  if (!entry.url) throw new Error(`MCP ${name} 缺少 URL`)
  const url = new URL(entry.url)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`MCP ${name} 只能使用 HTTP(S)`)
  if (!policy.allowedOrigins.includes(url.origin)) throw new Error(`MCP ${name} 的目标不在 egress allowlist 中`)
  const configuredTimeoutMs = (entry.timeout ?? 30) * 1_000
  if (!Number.isSafeInteger(configuredTimeoutMs) || configuredTimeoutMs <= 0) throw new Error(`MCP ${name} timeout 不合法`)
  return { name, url: url.toString(), timeoutMs: Math.min(configuredTimeoutMs, policy.maxTimeoutMs) }
}
