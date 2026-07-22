import { jsonSchema, tool } from 'ai'
import type { ToolSet } from 'ai'
import type { AgentRuntimeMcpToolDefinition, AgentRuntimeWebAgentTurnInput } from '@proma/shared/utils'
import { ServerMcpConnectionManager } from '@proma/shared/utils'
import type { ServerMcpClientConnection } from './server-mcp-client.ts'

/**
 * 在任务生命周期内取得 MCP 工具，并在任务结束时释放连接引用。
 * 重名工具不会覆盖先注册的服务，避免模型调用被静默路由到另一台服务器。
 */
export async function acquireServerMcpTools(
  input: AgentRuntimeWebAgentTurnInput,
  manager: ServerMcpConnectionManager,
): Promise<{ tools: AgentRuntimeMcpToolDefinition[]; release(): Promise<void> }> {
  const acquired: Array<{ release(): Promise<void>; connection: ServerMcpClientConnection; serverName: string }> = []
  const tools: AgentRuntimeMcpToolDefinition[] = []
  const names = new Set<string>()
  try {
    for (const [serverName, entry] of Object.entries(input.workspace.mcpServers)) {
      if (!entry.enabled || input.signal.aborted) continue
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
      const connection = handle.connection
      acquired.push({ ...handle, connection, serverName })
      for (const definition of await connection.listTools(input.signal)) {
        const name = sanitizeMcpToolName(`mcp__${serverName}__${definition.name}`)
        if (names.has(name)) throw new Error(`MCP 工具名冲突: ${name}`)
        names.add(name)
        tools.push({
          name,
          description: definition.description,
          inputSchema: definition.inputSchema,
          execute: (argumentsValue, signal) => connection.callTool(definition.name, argumentsValue, signal),
        })
      }
    }
    return { tools, release: () => releaseAll(acquired) }
  } catch (error) {
    await releaseAll(acquired)
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
