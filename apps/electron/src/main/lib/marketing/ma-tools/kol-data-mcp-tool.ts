/**
 * KOL 数据 MCP 工具注册（Chat 工具兼容层）
 *
 * 本工具仅在 Agent 模式下通过 MCP Server 形式提供服务（kol-data-mcp.ts）。
 * 此处注册是为了让工具状态管理（启用/禁用）和 UI 展示保持一致性。
 * Chat 模式下不实际提供功能。
 */

import type { ToolDefinition } from '@gravitas/core'
import type { ChatToolMeta } from '@gravitas/shared'

export const KOL_DATA_MCP_TOOL_META: ChatToolMeta = {
  id: 'ma-kol-data-mcp',
  name: 'KOL 数据 MCP',
  description: 'KOL 数据采集与分析的 MCP Server，提供搜索、详情、同步、分析等工具（Agent 模式专用）',
  params: [],
  icon: 'Users',
  category: 'builtin',
  executorType: 'builtin',
}

/** Chat 模式下不暴露实际工具定义 */
export const KOL_DATA_MCP_TOOL_DEFINITIONS: ToolDefinition[] = []

/** 本地 SQLite 数据库始终可用 */
export function isKOLDataMcpAvailable(): boolean {
  return true
}
