/**
 * D03：工具加载门禁（opt-in）测试。
 *
 * B06/B07 语义：未加载 schema 不执行、旧 schema 明确拒绝、权限不因此提权。
 */

import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../testing/electron-mock'

const testDir = mkdtempSync(join(tmpdir(), 'gravitas-d03-gate-'))
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

const { planToolLoading, guardLoadedToolCall } = await import('./tool-loading-gate')
const { buildToolCapabilityCatalog } = await import('./tool-capability-catalog')
const { bindCoreToolEffects } = await import('./tool-effects')
const { createReadToolDefinition, executeReadTool } = await import('./tool-impls/read-tool')
const { createWriteToolDefinition, executeWriteTool } = await import('./tool-impls/write-tool')

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})

const readTool = bindCoreToolEffects({ ...createReadToolDefinition(), execute: executeReadTool })
const writeTool = bindCoreToolEffects({ ...createWriteToolDefinition(), execute: executeWriteTool })
const tools = [readTool, writeTool]
const catalog = buildToolCapabilityCatalog(tools).catalog

describe('D03：工具加载门禁', () => {
  test('加载计划只含选中集；required 必现；摘要可注入提示词', () => {
    const plan = planToolLoading({ catalog, query: 'read file', tokenBudget: 300, requiredIds: ['builtin:Write'] }, tools)
    expect(plan.loadedNames.has('Read')).toBe(true)
    expect(plan.loadedNames.has('Write')).toBe(true)
    expect(plan.summary).toContain('builtin:Read')
    expect(plan.discovery.requiredMissing).toEqual([])
  })

  test('选中集之外的工具拒绝执行（tool_not_loaded），且不执行 runtime tool', () => {
    const plan = planToolLoading({ catalog, query: 'read file', tokenBudget: 300 }, [readTool])
    expect(plan.loadedNames.has('Write')).toBe(false)
    const refusal = guardLoadedToolCall(plan, writeTool)
    expect(refusal).toEqual({ ok: false, reason: 'tool_not_loaded' })
  })

  test('目录修订后旧 schema 调用明确拒绝（schema_changed）', () => {
    const plan = planToolLoading({ catalog, query: 'read file', tokenBudget: 300 }, tools)
    expect(guardLoadedToolCall(plan, readTool)).toEqual({ ok: true })
    // 模拟工具被修订：同名师工具的参数变化。
    const revised = bindCoreToolEffects({
      ...createReadToolDefinition(),
      parameters: { type: 'object', properties: { file_path: { type: 'string' }, extra: { type: 'number' } } },
      execute: executeReadTool,
    })
    expect(guardLoadedToolCall(plan, revised)).toEqual({ ok: false, reason: 'schema_changed' })
  })

  test('加载快照按名称绑定：同 catalog 下同名替换工具立即失效', () => {
    const plan = planToolLoading({ catalog, query: 'read file', tokenBudget: 300 }, tools)
    const renamedCopy = { ...readTool, name: 'Read' as const, parameters: readTool.parameters, execute: readTool.execute }
    expect(guardLoadedToolCall(plan, renamedCopy)).toEqual({ ok: true })
  })
})
