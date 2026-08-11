import { jsonSchema, tool } from 'ai'
import type { ToolSet } from 'ai'
import type { McpServerEntry } from '@gravitas/shared'
import type { AgentRuntimeMcpToolDefinition, AgentRuntimeWebAgentTurnInput } from '@gravitas/shared/utils'
import type { ServerMcpConnectionManager } from '@gravitas/shared/utils/node'
import type { ServerMcpClientConnection } from './server-mcp-client.ts'

/**
 * 在任务生命周期内取得 MCP 工具，并在任务结束时释放连接引用。
 *
 * 「重度懒连接」（对齐 OpenAI Codex #37970）：
 * - 工具目录定义优先从进程级缓存读取——命中时任务无需建立任何 MCP 连接。
 * - 连接仅在真正调用某服务器的某个工具时才懒建立；同一任务内同一服务器
 *   的后续工具调用复用该连接（Promise 缓存做并发去重），任务结束统一释放。
 * - 重名工具不会覆盖先注册的服务，避免模型调用被静默路由到另一台服务器。
 */
export async function acquireServerMcpTools(
  input: AgentRuntimeWebAgentTurnInput,
  manager: ServerMcpConnectionManager,
): Promise<{ tools: AgentRuntimeMcpToolDefinition[]; release(): Promise<void> }> {
  const tools: AgentRuntimeMcpToolDefinition[] = []
  const names = new Set<string>()
  const scopeKey = JSON.stringify([input.scope.tenantId, input.scope.userId, input.workspace.workspaceSlug])

  // 任务级懒连接状态：serverName -> 尚未解析的连接、已解析连接、已 acquire 的 handle。
  const lazyConnections = new Map<string, ServerMcpClientConnection>()
  const lazyPromises = new Map<string, Promise<ServerMcpClientConnection>>()
  const lazyHandles: Array<{ release(): Promise<void> }> = []

  const ensureConnected = (serverName: string, entry: McpServerEntry) => {
    const cached = lazyConnections.get(serverName)
    if (cached) return Promise.resolve(cached)
    const pending = lazyPromises.get(serverName)
    if (pending) return pending
    const connecting = (async (): Promise<ServerMcpClientConnection> => {
      const handle = await manager.acquire({
        ...input.scope,
        workspaceSlug: input.workspace.workspaceSlug,
        serverName,
        entry,
        signal: input.signal,
      })
      if (!isServerMcpClientConnection(handle.connection)) {
        await handle.release()
        throw new Error(`MCP ${serverName} 未提供服务端工具调用能力`)
      }
      lazyHandles.push(handle)
      lazyConnections.set(serverName, handle.connection)
      return handle.connection
    })().finally(() => lazyPromises.delete(serverName))
    lazyPromises.set(serverName, connecting)
    return connecting
  }

  try {
    for (const [serverName, entry] of Object.entries(input.workspace.mcpServers)) {
      if (!entry.enabled || input.signal.aborted) continue
      const fingerprint = manager.catalogFingerprint(serverName, entry)
      // 工具目录从进程级缓存读取；未命中时懒建连接做一次 listTools 并写缓存。
      const { tools: definitions } = await manager.resolveToolCatalog(
        scopeKey,
        serverName,
        fingerprint,
        input.signal,
        async () => (await ensureConnected(serverName, entry)).listTools(input.signal),
      )
      for (const definition of definitions) {
        const name = sanitizeMcpToolName(`mcp__${serverName}__${definition.name}`)
        if (names.has(name)) throw new Error(`MCP 工具名冲突: ${name}`)
        names.add(name)
        tools.push({
          name,
          description: definition.description,
          inputSchema: definition.inputSchema,
          execute: async (argumentsValue, signal) => {
            const connection = await ensureConnected(serverName, entry)
            return connection.callTool(definition.name, argumentsValue, signal)
          },
        })
      }
    }
    // 仅释放本任务懒建立的连接；目录缓存（纯数据）持续跨任务复用。
    return { tools, release: () => releaseAll(lazyHandles) }
  } catch (error) {
    await releaseAll(lazyHandles)
    throw error
  }
}

/** 将已验证的 MCP 连接转换为 AI SDK 工具，并将每次调用交给权限服务。 */
export function createServerMcpToolSet(
  input: AgentRuntimeWebAgentTurnInput,
  definitions: AgentRuntimeMcpToolDefinition[],
  assertPermissionApproved: (toolName: string, toolInput: Record<string, unknown>, description: string) => Promise<void>,
): ToolSet {
  return Object.fromEntries(definitions.map((definition) => [definition.name, tool({
    description: definition.description,
    inputSchema: jsonSchema<Record<string, unknown>>(definition.inputSchema),
    execute: async (argumentsValue) => {
      const toolInput = isRecord(argumentsValue) ? argumentsValue : { value: argumentsValue }
      await assertPermissionApproved(definition.name, toolInput, `调用 MCP 工具 ${definition.name}`)
      return definition.execute(toolInput, input.signal)
    },
  })]))
}

function isServerMcpClientConnection(value: object): value is ServerMcpClientConnection {
  return 'listTools' in value && typeof value.listTools === 'function'
    && 'callTool' in value && typeof value.callTool === 'function'
}

async function releaseAll(handles: Array<{ release(): Promise<void> }>): Promise<void> {
  await Promise.all(handles.map((handle) => handle.release()))
}

function sanitizeMcpToolName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (sanitized.length <= 64) return sanitized
  const suffix = `_${Array.from(name).reduce((hash, character) => ((hash << 5) - hash + character.charCodeAt(0)) | 0, 0).toString(36).replace(/-/g, '0')}`
  return sanitized.slice(0, 64 - suffix.length) + suffix
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
