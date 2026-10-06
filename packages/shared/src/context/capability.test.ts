import { describe, expect, test } from 'bun:test'
import type { CapabilityDescriptor } from './capability'
import { createCapabilityCatalog, getCapabilityDescriptor, parseCapabilityDescriptor, registerCapabilityDescriptor, validateCapabilityDescriptor } from './capability'

const builtin: CapabilityDescriptor = {
  version: 1,
  id: 'builtin:read',
  name: 'Read',
  summary: '读取工作区文件内容',
  source: 'builtin',
  schemaRef: 'builtin:read:v1',
  access: 'read',
  dataClasses: ['workspace'],
  confirmation: 'never',
  parallelSafe: true,
  toolName: 'Read',
}

describe('M4-01 capability descriptor', () => {
  test('accepts a builtin descriptor without loading its full schema', () => {
    expect(validateCapabilityDescriptor(builtin)).toEqual({ valid: true, reasons: [] })
    expect(parseCapabilityDescriptor(builtin)).toMatchObject(builtin)
  })

  test('requires server identity for MCP and rejects misplaced fields', () => {
    expect(validateCapabilityDescriptor({ ...builtin, source: 'mcp' }).reasons).toContain('mcp descriptor requires serverName')
    expect(validateCapabilityDescriptor({ ...builtin, serverName: 'github' }).reasons).toContain('serverName is only valid for mcp descriptors')
  })

  test('fails closed for invalid access, data class, and unsafe shape', () => {
    const result = validateCapabilityDescriptor({ ...builtin, access: 'admin', dataClasses: ['secret'], parallelSafe: 'yes' })
    expect(result.valid).toBe(false)
    expect(result.reasons).toEqual(expect.arrayContaining(['access is invalid', 'dataClasses must contain valid values', 'parallelSafe must be boolean']))
    expect(() => parseCapabilityDescriptor({ ...builtin, version: 2 })).toThrow('version must be 1')
  })

  test('deduplicates catalog ids and returns defensive copies', () => {
    const catalog = createCapabilityCatalog([builtin])
    registerCapabilityDescriptor(catalog, { ...builtin, summary: '更新后的摘要', dataClasses: ['public'] })
    expect(catalog.descriptors).toHaveLength(1)
    expect(getCapabilityDescriptor(catalog, 'builtin:read')?.summary).toBe('更新后的摘要')
    const copy = getCapabilityDescriptor(catalog, 'builtin:read')!
    copy.dataClasses.push('workspace')
    expect(getCapabilityDescriptor(catalog, 'builtin:read')?.dataClasses).toEqual(['public'])
  })

  test('returns a defensive clone so callers cannot mutate the parsed contract', () => {
    const parsed = parseCapabilityDescriptor(builtin)
    parsed.dataClasses.push('public')
    expect(builtin.dataClasses).toEqual(['workspace'])
  })
})
