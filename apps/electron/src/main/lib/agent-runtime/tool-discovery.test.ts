/**
 * D02：词法/规则工具发现（无模型），按 token 预算从能力目录选择摘要子集。
 *
 * - 目录修订生效：每次调用基于传入 catalog 现算，无缓存；
 * - requiredIds 必须出现在结果；目录中不存在时明确报告（不静默丢失）；
 * - 大型目录在预算内按相关度截断，被截断项明确记录；
 * - CJK 查询按子串匹配目录中的 CJK 文本；同名工具按稳定 id 区分不串项。
 */

import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../testing/electron-mock'

const testDir = mkdtempSync(join(tmpdir(), 'gravitas-d02-discovery-'))
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
const { discoverToolsForQuery } = await import('./tool-discovery')
const { bindCoreToolEffects } = await import('./tool-effects')
const { createReadToolDefinition, executeReadTool } = await import('./tool-impls/read-tool')
const { createWriteToolDefinition, executeWriteTool } = await import('./tool-impls/write-tool')

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})

const readTool = bindCoreToolEffects({ ...createReadToolDefinition(), execute: executeReadTool })
const writeTool = bindCoreToolEffects({ ...createWriteToolDefinition(), execute: executeWriteTool })
const grepTool = bindCoreToolEffects({ name: 'Grep', description: 'Search file contents by pattern. 按模式搜索文件内容。', parameters: { type: 'object', properties: {} }, execute: async () => ({ toolCallId: '', content: '' }) })
const webSearch = bindCoreToolEffects({ name: 'mcp__tavily__search', description: 'Search the web for current information', parameters: { type: 'object', properties: {} }, execute: async () => ({ toolCallId: '', content: '' }) })
const catalog = buildToolCapabilityCatalog([readTool, writeTool, grepTool, webSearch]).catalog

describe('D02：工具发现与预算选择', () => {
  test('关键词匹配选中相关能力并给出可注入摘要', () => {
    const result = discoverToolsForQuery({ query: 'search files for pattern', catalog, tokenBudget: 400 })
    expect(result.selectedIds).toContain('builtin:Grep')
    expect(result.summary).toContain('builtin:Grep')
    expect(result.summary).toContain('方向性描述')
    expect(result.requiredMissing).toEqual([])
  })

  test('requiredIds 必现；目录缺失时明确报告不静默丢失', () => {
    const ok = discoverToolsForQuery({ query: 'unrelated words', catalog, tokenBudget: 400, requiredIds: ['builtin:Write'] })
    expect(ok.selectedIds).toContain('builtin:Write')
    const missing = discoverToolsForQuery({ query: 'unrelated words', catalog, tokenBudget: 400, requiredIds: ['builtin:NotExist'] })
    expect(missing.requiredMissing).toEqual(['builtin:NotExist'])
    expect(missing.selectedIds).not.toContain('builtin:NotExist')
  })

  test('预算截断：大型目录按预算选择，截断项明确记录且 required 仍保留', () => {
    const many = Array.from({ length: 60 }, (_, i) => bindCoreToolEffects({
      name: `mcp__big__tool${String(i).padStart(2, '0')}`,
      description: `big directory tool ${i}`,
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ toolCallId: '', content: '' }),
    }))
    const bigCatalog = buildToolCapabilityCatalog(many).catalog
    const requiredId = bigCatalog.descriptors[7]!.id
    const result = discoverToolsForQuery({ query: 'big', catalog: bigCatalog, tokenBudget: 120, requiredIds: [requiredId] })
    expect(result.selectedIds).toContain(requiredId)
    // required 超出预算也保留：预算只约束非 required 行，溢出以单行上界为限。
    expect(result.tokensUsed).toBeLessThanOrEqual(150)
    expect(result.omittedByBudget.length).toBeGreaterThan(0)
    expect(result.selectedIds.length + result.omittedByBudget.length).toBe(bigCatalog.descriptors.length)
  })

  test('CJK 子串匹配与同名区分：MCP search 与内置 Grep 不串项', () => {
    const cjk = discoverToolsForQuery({ query: '搜索文件内容', catalog, tokenBudget: 400 })
    expect(cjk.selectedIds).toContain('builtin:Grep')
    const byId = discoverToolsForQuery({ query: 'search web current information', catalog, tokenBudget: 400 })
    expect(byId.selectedIds).toContain('mcp:tavily:search')
    // 'search' 同时命中内置 Grep（合法相关）；同名工具按稳定 id 区分不串项。
    expect(new Set(byId.selectedIds).size).toBe(byId.selectedIds.length)
    expect(byId.selectedIds).toContain('builtin:Grep')
  })

  test('目录修订生效：新 catalog 替换旧目录后同一查询结果跟随新目录', () => {
    const before = discoverToolsForQuery({ query: 'search', catalog, tokenBudget: 400 })
    const reduced = buildToolCapabilityCatalog([readTool, grepTool]).catalog
    const after = discoverToolsForQuery({ query: 'search', catalog: reduced, tokenBudget: 400 })
    expect(after.selectedIds).not.toContain('mcp:tavily:search')
    expect(after.selectedIds.length).toBeLessThanOrEqual(before.selectedIds.length)
  })
})
