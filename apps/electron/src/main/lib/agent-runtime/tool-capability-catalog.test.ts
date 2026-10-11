/**
 * D01：从真实 Runtime 工具注册实例派生能力目录（不重复实现 catalog）。
 *
 * 数据源唯一：RuntimeToolDefinition[]（内置 + MCP 同名规则 mcp__<server>__<tool>），
 * 元数据来自 E01 tool-effects（真实注册实例绑定），失效 descriptor 明确省略并给原因。
 */

import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../testing/electron-mock'

const testDir = mkdtempSync(join(tmpdir(), 'gravitas-d01-catalog-'))
process.env.PROMA_TEST_CONFIG_DIR = testDir

mock.module('electron', () => buildElectronMock())
mock.module('../attachment-service', () => ({
  isImageAttachment: () => false,
  getMimeType: () => 'application/octet-stream',
  readAttachmentAsBase64: () => '',
  deleteAttachment: () => {},
  deleteConversationAttachments: () => {},
  saveAttachment: async () => ({ path: '/tmp/mock', fileName: 'mock', mimeType: 'text/plain', size: 0 }),
  openFileDialog: async () => null,
}))

const { buildToolCapabilityCatalog } = await import('./tool-capability-catalog')
const { bindCoreToolEffects } = await import('./tool-effects')
const { createReadToolDefinition, executeReadTool } = await import('./tool-impls/read-tool')
const { createWriteToolDefinition, executeWriteTool } = await import('./tool-impls/write-tool')
const { validateCapabilityDescriptor } = await import('@gravitas/shared')

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})

const readTool = bindCoreToolEffects({ ...createReadToolDefinition(), execute: executeReadTool })
const writeTool = bindCoreToolEffects({ ...createWriteToolDefinition(), execute: executeWriteTool })
const unknownMcp = bindCoreToolEffects({ name: 'mcp__srv1__query', description: 'MCP 查询工具', parameters: { type: 'object', properties: {} }, execute: async () => ({ toolCallId: '', content: '' }) })
const invalidTool = bindCoreToolEffects({ name: 'Broken', description: '', parameters: { type: 'object', properties: {} }, execute: async () => ({ toolCallId: '', content: '' }) })

describe('D01：工具能力目录派生', () => {
  test('effects 映射：读共享→read/never/可并行；写→write/on_demand/不可并行', () => {
    const { catalog, omitted } = buildToolCapabilityCatalog([readTool, writeTool])
    expect(omitted).toEqual([])
    const read = catalog.descriptors.find((d) => d.toolName === 'Read')!
    expect(read).toMatchObject({ source: 'builtin', access: 'read', confirmation: 'never', parallelSafe: true, schemaRef: 'builtin://Read' })
    const write = catalog.descriptors.find((d) => d.toolName === 'Write')!
    expect(write).toMatchObject({ source: 'builtin', access: 'write', confirmation: 'on_demand', parallelSafe: false, schemaRef: 'builtin://Write' })
  })

  test('MCP 工具按同名规则解析 server，unknown effects 保守映射为 external/always/不可并行', () => {
    const { catalog, omitted } = buildToolCapabilityCatalog([unknownMcp])
    expect(omitted).toEqual([])
    const descriptor = catalog.descriptors[0]!
    expect(descriptor).toMatchObject({
      source: 'mcp', serverName: 'srv1', toolName: 'mcp__srv1__query',
      access: 'external', confirmation: 'always', parallelSafe: false,
      id: 'mcp:srv1:query', schemaRef: 'mcp://srv1/query',
    })
    expect(validateCapabilityDescriptor(descriptor).valid).toBe(true)
  })

  test('失效 descriptor 明确省略并给原因，目录构建不崩溃', () => {
    const { catalog, omitted } = buildToolCapabilityCatalog([readTool, invalidTool])
    expect(catalog.descriptors.map((d) => d.toolName)).toEqual(['Read'])
    expect(omitted).toHaveLength(1)
    expect(omitted[0]!.toolName).toBe('Broken')
    expect(omitted[0]!.reason.length).toBeGreaterThan(0)
  })

  test('稳定 id：同 name 同 server 重复派生生成的 id 一致（版本兼容替换而非重复）', () => {
    const first = buildToolCapabilityCatalog([readTool, unknownMcp]).catalog
    const second = buildToolCapabilityCatalog([unknownMcp, readTool]).catalog
    const ids = (catalog: typeof first): string[] => catalog.descriptors.map((d) => d.id).sort()
    expect(ids(second)).toEqual(ids(first))
    // 同 id 重复注册时后者替换前者，不产生重复条目。
    const { catalog: replaced } = buildToolCapabilityCatalog([readTool, readTool])
    expect(replaced.descriptors.filter((d) => d.id === 'builtin:Read')).toHaveLength(1)
  })
})
