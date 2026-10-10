/**
 * D01：从真实 Runtime 工具注册实例派生能力目录（单一数据源，不重复实现 catalog）。
 *
 * - 内置工具 id `builtin:<name>`；MCP 工具按 OpenAI function name 同名规则
 *   `mcp__<server>__<tool>` 解析 server，id `mcp:<server>:<tool>`；
 * - access/confirmation/parallelSafe 由 E01 tool-effects 真实实例绑定推导，
 *   unknown effects 保守映射 external/always/不可并行（B09）；
 * - 失效 descriptor 明确省略并给原因，构建不崩溃。
 */

import {
  createCapabilityCatalog,
  registerCapabilityDescriptor,
  validateCapabilityDescriptor,
  type CapabilityCatalog,
  type CapabilityDescriptor,
} from '@gravitas/shared'
import { getRegisteredToolEffects } from './tool-effects'
import type { RuntimeToolDefinition } from './types'

export interface OmittedCapabilityTool {
  readonly toolName: string
  readonly reason: string
}

export interface BuildToolCapabilityCatalogResult {
  readonly catalog: CapabilityCatalog
  readonly omitted: readonly OmittedCapabilityTool[]
}

interface ParsedMcpName {
  readonly serverName: string
  readonly toolName: string
}

/** OpenAI function name 清洗规则的同名解析：mcp__<server>__<tool>。 */
export function parseMcpToolName(name: string): ParsedMcpName | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const segments = name.split('__')
  if (segments.length < 3) return undefined
  const serverName = segments[1]!
  const toolName = segments.slice(2).join('__')
  if (!serverName || !toolName) return undefined
  return { serverName, toolName }
}

function summarize(description: string): string {
  const firstLine = description.split('\n')[0]!.trim()
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine
}

export function describeToolCapability(tool: RuntimeToolDefinition): CapabilityDescriptor {
  const effects = getRegisteredToolEffects(tool)
  const mcp = parseMcpToolName(tool.name)
  const hasWrite = effects.resources.some((r) => r.kind === 'filesystem' && r.mode === 'write')
  const hasUnknown = effects.resources.some((r) => r.kind === 'unknown')
  // B09：未知保守——external + always 确认 + 不可并行；文件写不可并行；纯幂等读可并行。
  const access: CapabilityDescriptor['access'] = hasUnknown ? 'external' : hasWrite ? 'write' : 'read'
  const confirmation: CapabilityDescriptor['confirmation'] = hasUnknown ? 'always' : hasWrite ? 'on_demand' : 'never'
  const parallelSafe = effects.replay === 'idempotent_read' && !hasWrite && !hasUnknown
  const dataClasses: CapabilityDescriptor['dataClasses'] = hasUnknown ? ['network'] : ['workspace']
  return {
    version: 1,
    id: mcp ? `mcp:${mcp.serverName}:${mcp.toolName}` : `builtin:${tool.name}`,
    name: mcp ? mcp.toolName : tool.name,
    summary: summarize(tool.description),
    source: mcp ? 'mcp' : 'builtin',
    schemaRef: mcp ? `mcp://${mcp.serverName}/${mcp.toolName}` : `builtin://${tool.name}`,
    access,
    dataClasses,
    confirmation,
    parallelSafe,
    toolName: tool.name,
    ...(mcp ? { serverName: mcp.serverName } : {}),
  }
}

/** 从工具注册实例派生目录；失效项省略并记录原因。 */
export function buildToolCapabilityCatalog(tools: readonly RuntimeToolDefinition[]): BuildToolCapabilityCatalogResult {
  const catalog = createCapabilityCatalog()
  const omitted: OmittedCapabilityTool[] = []
  for (const tool of tools) {
    let descriptor: CapabilityDescriptor
    try {
      descriptor = describeToolCapability(tool)
    } catch (error) {
      omitted.push({ toolName: tool.name, reason: `describe failed: ${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    const validation = validateCapabilityDescriptor(descriptor)
    if (!validation.valid) {
      omitted.push({ toolName: tool.name, reason: validation.reasons.join('; ') })
      continue
    }
    registerCapabilityDescriptor(catalog, descriptor)
  }
  return { catalog, omitted }
}
