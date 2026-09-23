/** M4-04 离线 token 回归：对比「全量 schema 进 prompt」与「summary + 按需 schema」的体积。 */
import type { CapabilityCatalog } from './capability'
import { renderCapabilitySummary } from './capability-summary'

export interface CapabilityTokenScoreboard {
  version: 1
  benchmarkId: 'capability-catalog-token'
  toolCount: number
  selectedCount: number
  /** baseline：全部工具的完整 schema + 描述都进入 prompt。 */
  baselineTokens: number
  /** 优化：常驻 summary + 选中工具的 schema。 */
  optimizedTokens: number
  savingsRate: number
}

export function estimateCapabilityTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

export function runCapabilityTokenBenchmark(input: {
  catalog: CapabilityCatalog
  /** schemaRef → 完整参数 schema 正文（JSON 序列化后的文本）。 */
  schemas: Readonly<Record<string, string>>
  selectedIds: readonly string[]
}): CapabilityTokenScoreboard {
  const baselineParts: string[] = []
  for (const descriptor of input.catalog.descriptors) {
    const schema = input.schemas[descriptor.schemaRef]
    if (schema === undefined) throw new Error(`missing schema body for ${descriptor.schemaRef}`)
    baselineParts.push(`${descriptor.name}: ${descriptor.summary}\n${schema}`)
  }
  const baselineTokens = estimateCapabilityTokens(baselineParts.join('\n\n'))

  const optimizedParts: string[] = [renderCapabilitySummary(input.catalog)]
  for (const id of input.selectedIds) {
    const descriptor = input.catalog.descriptors.find((candidate) => candidate.id === id)
    if (!descriptor) continue
    const schema = input.schemas[descriptor.schemaRef]
    if (schema === undefined) throw new Error(`missing schema body for ${descriptor.schemaRef}`)
    optimizedParts.push(schema)
  }
  const optimizedTokens = estimateCapabilityTokens(optimizedParts.join('\n\n'))

  const savingsRate = baselineTokens === 0 ? 0 : 1 - optimizedTokens / baselineTokens
  return {
    version: 1,
    benchmarkId: 'capability-catalog-token',
    toolCount: input.catalog.descriptors.length,
    selectedCount: input.selectedIds.length,
    baselineTokens,
    optimizedTokens,
    savingsRate,
  }
}
