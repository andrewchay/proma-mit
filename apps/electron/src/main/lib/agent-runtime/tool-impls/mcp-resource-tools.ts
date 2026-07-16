/**
 * MCP Resource 工具
 *
 * 让 Agent 能够发现并使用已连接 MCP 服务器提供的资源（resources）。
 * 这些工具只读，默认在 safe / plan 模式下放行。
 */

import type { ToolResult } from '@proma/core'
import type { RuntimeToolDefinition } from '../types'

export const LIST_MCP_RESOURCES_TOOL_NAME = 'ListMcpResourcesTool'
export const READ_MCP_RESOURCE_TOOL_NAME = 'ReadMcpResourceTool'

export function createListMcpResourcesToolDefinition(): RuntimeToolDefinition {
  return {
    name: LIST_MCP_RESOURCES_TOOL_NAME,
    description: '列出所有已连接 MCP 服务器提供的资源（resources）及其 URI，可用于后续读取。',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: executeListMcpResourcesTool,
  }
}

export function createReadMcpResourceToolDefinition(): RuntimeToolDefinition {
  return {
    name: READ_MCP_RESOURCE_TOOL_NAME,
    description: '读取指定 URI 的 MCP 资源内容。URI 通常由 ListMcpResourcesTool 返回。',
    parameters: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: '要读取的资源 URI' },
      },
      required: ['uri'],
    },
    execute: executeReadMcpResourceTool,
  }
}

async function executeListMcpResourcesTool(_input: unknown, ctx: { mcpManager?: import('../mcp-client').McpClientManager; abortSignal?: AbortSignal }): Promise<ToolResult> {
  if (!ctx.mcpManager) {
    return { content: '当前没有可用的 MCP 客户端', isError: true, toolCallId: '' }
  }
  try {
    const result = await ctx.mcpManager.listAllResources(ctx.abortSignal)
    return { content: JSON.stringify(result, null, 2), isError: false, toolCallId: '' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: `列出 MCP 资源失败: ${message}`, isError: true, toolCallId: '' }
  }
}

async function executeReadMcpResourceTool(input: unknown, ctx: { mcpManager?: import('../mcp-client').McpClientManager; abortSignal?: AbortSignal }): Promise<ToolResult> {
  if (!ctx.mcpManager) {
    return { content: '当前没有可用的 MCP 客户端', isError: true, toolCallId: '' }
  }
  const args = input as Record<string, unknown>
  const uri = typeof args.uri === 'string' ? args.uri : ''
  if (!uri) {
    return { content: '缺少资源 URI', isError: true, toolCallId: '' }
  }
  try {
    const result = await ctx.mcpManager.readResource(uri, ctx.abortSignal)
    if (!result) {
      return { content: `未找到可读取的资源: ${uri}`, isError: true, toolCallId: '' }
    }
    return { content: JSON.stringify(result, null, 2), isError: false, toolCallId: '' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: `读取 MCP 资源失败: ${message}`, isError: true, toolCallId: '' }
  }
}
