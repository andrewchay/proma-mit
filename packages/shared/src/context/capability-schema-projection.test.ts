import { describe, expect, test } from 'bun:test'
import type { CapabilityDescriptor } from './capability'
import { createCapabilityCatalog } from './capability'
import { projectCapabilitySchemas } from './capability-schema-projection'

const readTool: CapabilityDescriptor = {
  version: 1,
  id: 'builtin:read',
  name: 'Read',
  summary: '读取文件',
  source: 'builtin',
  schemaRef: 'builtin:read:schema',
  access: 'read',
  dataClasses: ['workspace'],
  confirmation: 'never',
  parallelSafe: true,
}

const writeTool: CapabilityDescriptor = {
  ...readTool,
  id: 'builtin:heavy-write',
  name: 'HeavyWrite',
  summary: '写入文件',
  schemaRef: 'builtin:heavy-write:schema',
  access: 'write',
  confirmation: 'always',
  parallelSafe: false,
}

const brokenTool: CapabilityDescriptor = {
  ...readTool,
  id: 'builtin:broken',
  name: 'Broken',
  schemaRef: 'builtin:broken:schema',
}

const catalog = createCapabilityCatalog([readTool, writeTool, brokenTool])
const schemas: Record<string, unknown> = {
  'builtin:read:schema': { type: 'object', properties: { file_path: { type: 'string' } } },
  'builtin:heavy-write:schema': { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
}

describe('M4-03 on-demand schema projection', () => {
  test('loads schemas only for selected capabilities and records the rest', () => {
    const loaded: string[] = []
    const result = projectCapabilitySchemas({
      catalog,
      selectedIds: ['builtin:read'],
      resolveSchema: (schemaRef) => {
        loaded.push(schemaRef)
        return schemas[schemaRef]
      },
    })

    expect(loaded).toEqual(['builtin:read:schema'])
    expect(result.selected).toHaveLength(1)
    expect(result.selected[0]!.descriptor.id).toBe('builtin:read')
    expect(result.selected[0]!.schema).toEqual(schemas['builtin:read:schema'])
    expect(result.omitted).toHaveLength(0)
  })

  test('fails closed: unknown ids and resolver failures become auditable omissions', () => {
    const result = projectCapabilitySchemas({
      catalog,
      selectedIds: ['builtin:missing', 'builtin:heavy-write', 'builtin:broken'],
      resolveSchema: (schemaRef) => {
        if (schemaRef === 'builtin:broken:schema') throw new Error('disk error')
        return schemas[schemaRef]
      },
    })

    expect(result.selected.map((entry) => entry.descriptor.id)).toEqual(['builtin:heavy-write'])
    expect(result.omitted).toEqual([
      { id: 'builtin:missing', reason: 'unknown capability id' },
      { id: 'builtin:broken', reason: 'schema unavailable: disk error' },
    ])
  })
})
