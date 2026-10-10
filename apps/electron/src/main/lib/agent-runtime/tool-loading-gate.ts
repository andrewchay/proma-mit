/**
 * D03：独立工具加载门禁（opt-in）。
 *
 * 只在使用方显式传入 toolLoading spec 时生效；默认无行为变化（B15）。
 * - 发现选中集之外的 schema 不进入模型（上游按 loadedNames 过滤 toolSet）；
 * - 执行时校验工具参数哈希与加载时一致：目录/工具被修订后旧调用明确拒绝（schema_changed），
 *   绝不以旧 schema 执行；
 * - 未加载工具被拒绝（tool_not_loaded）；权限语义不变（只窄不宽，B06）。
 */

import { createHash } from 'node:crypto'
import { discoverToolsForQuery, type ToolDiscoveryResult } from './tool-discovery'
import type { CapabilityCatalog } from '@gravitas/shared'
import type { RuntimeToolDefinition } from './types'

export interface ToolLoadingSpec {
  readonly catalog: CapabilityCatalog
  readonly query: string
  readonly tokenBudget: number
  readonly requiredIds?: readonly string[]
}

export interface ToolLoadingPlan {
  readonly discovery: ToolDiscoveryResult
  /** 允许进入模型与执行的工具名集合。 */
  readonly loadedNames: ReadonlySet<string>
  /** 加载时的参数哈希快照（name → sha256(JSON.stringify(parameters))）。 */
  readonly schemaHashes: ReadonlyMap<string, string>
  /** 注入系统提示词的能力摘要。 */
  readonly summary: string
}

export type ToolLoadingRefusal = { ok: true } | { ok: false; reason: 'tool_not_loaded' | 'schema_changed' }

function schemaHashOf(tool: RuntimeToolDefinition): string {
  return createHash('sha256').update(JSON.stringify(tool.parameters)).digest('hex')
}

export function planToolLoading(spec: ToolLoadingSpec, tools: readonly RuntimeToolDefinition[]): ToolLoadingPlan {
  const discovery = discoverToolsForQuery({
    query: spec.query,
    catalog: spec.catalog,
    tokenBudget: spec.tokenBudget,
    requiredIds: spec.requiredIds,
  })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const hashes = new Map<string, string>()
  for (const id of discovery.selectedIds) {
    const descriptor = spec.catalog.descriptors.find((d) => d.id === id)
    const name = descriptor?.toolName
    if (!name) continue
    const tool = byName.get(name)
    if (tool) hashes.set(name, schemaHashOf(tool))
  }
  return {
    discovery,
    loadedNames: new Set(hashes.keys()),
    schemaHashes: hashes,
    summary: discovery.summary,
  }
}

/** 执行边界：未加载或 schema 已变更（目录修订/工具被替换）一律拒绝，不执行。 */
export function guardLoadedToolCall(plan: ToolLoadingPlan, tool: RuntimeToolDefinition): ToolLoadingRefusal {
  if (!plan.loadedNames.has(tool.name)) return { ok: false, reason: 'tool_not_loaded' }
  const fresh = schemaHashOf(tool)
  if (plan.schemaHashes.get(tool.name) !== fresh) return { ok: false, reason: 'schema_changed' }
  return { ok: true }
}
