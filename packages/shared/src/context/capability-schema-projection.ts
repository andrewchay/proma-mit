/** M4-03 按需 schema 投影：只有被选中的能力才解析完整参数 schema。 */
import type { CapabilityCatalog, CapabilityDescriptor } from './capability'

export interface ProjectedCapabilitySchema {
  descriptor: CapabilityDescriptor
  schema: unknown
}

export interface OmittedCapabilitySchema {
  id: string
  reason: string
}

export interface ProjectCapabilitySchemasResult {
  selected: ProjectedCapabilitySchema[]
  omitted: OmittedCapabilitySchema[]
}

export type CapabilitySchemaResolver = (schemaRef: string) => unknown

export function projectCapabilitySchemas(input: {
  catalog: CapabilityCatalog
  selectedIds: readonly string[]
  resolveSchema: CapabilitySchemaResolver
}): ProjectCapabilitySchemasResult {
  const selected: ProjectedCapabilitySchema[] = []
  const omitted: OmittedCapabilitySchema[] = []
  for (const id of input.selectedIds) {
    const descriptor = input.catalog.descriptors.find((candidate) => candidate.id === id)
    if (!descriptor) {
      omitted.push({ id, reason: 'unknown capability id' })
      continue
    }
    try {
      selected.push({ descriptor, schema: input.resolveSchema(descriptor.schemaRef) })
    } catch (error) {
      // fail-closed：加载失败的 schema 不进入 prompt，也不假装能力可用。
      omitted.push({ id, reason: `schema unavailable: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  return { selected, omitted }
}
