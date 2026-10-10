/**
 * D04：独立工具选择 benchmark（离线确定性）。
 *
 * 覆盖 D01→D02→D03 全链的多步场景与恢复非劣：
 * - 统计 schema token：全量 schema 基线 vs 摘要+选中（复用 shared token benchmark）；
 * - 统计失败：tool_not_loaded / schema_changed 拒绝、required 缺失；
 * - 恢复非劣：步骤间目录修订后，旧调用被拒绝、重规划成功（不劣于单步基线）；
 * - 时延仅记录机制耗时（发现+计划+门禁），不含模型；模型质量评测需 Provider 授权，不在本文件。
 *
 * 不拿历史 M4 单轮结果作 PASS：本 benchmark 独立运行、独立断言。
 */

import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../../testing/electron-mock'

const testDir = mkdtempSync(join(tmpdir(), 'gravitas-d04-bench-'))
process.env.PROMA_TEST_CONFIG_DIR = testDir

mock.module('electron', () => buildElectronMock())
mock.module('../../../attachment-service', () => ({
  isImageAttachment: () => false,
  getMimeType: () => 'application/octet-stream',
  readAttachmentAsBase64: () => '',
  deleteAttachment: () => {},
  deleteConversationAttachments: () => {},
  saveAttachment: async () => ({ path: '/tmp/mock', fileName: 'mock', mimeType: 'text/plain', size: 0 }),
  openFileDialog: async () => null,
}))

const { runToolSelectionBenchmark, TOOL_SELECTION_BENCHMARK_ID } = await import('./tool-selection-benchmark')
const { bindCoreToolEffects } = await import('../tool-effects')
const { createReadToolDefinition, executeReadTool } = await import('../tool-impls/read-tool')
const { createWriteToolDefinition, executeWriteTool } = await import('../tool-impls/write-tool')

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})

const readTool = bindCoreToolEffects({ ...createReadToolDefinition(), execute: executeReadTool })
const writeTool = bindCoreToolEffects({ ...createWriteToolDefinition(), execute: executeWriteTool })
const mcpTools = Array.from({ length: 40 }, (_, i) => bindCoreToolEffects({
  name: `mcp__corp__api${String(i).padStart(2, '0')}`,
  description: `corporate api tool ${i}`,
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ toolCallId: '', content: '' }),
}))

describe('D04：工具选择 benchmark（离线确定性）', () => {
  test('多步场景：步骤2目录修订后旧调用被拒（schema_changed），重规划恢复成功', () => {
    const report = runToolSelectionBenchmark({
      id: 'multi-step-revision',
      steps: [
        { query: 'read file', requiredIds: ['builtin:Read'], attemptTool: 'Read' },
        {
          query: 'read file then write',
          requiredIds: ['builtin:Write'],
          attemptTool: 'Read',
          revise: (tools) => tools.map((tool) => tool.name === 'Read'
            ? { ...tool, parameters: { ...tool.parameters, properties: { ...tool.parameters.properties, extra: { type: 'number' } } } }
            : tool),
        },
        { query: 'read file then write', requiredIds: ['builtin:Write'], attemptTool: 'Write' },
      ],
      seedTools: [readTool, writeTool],
      tokenBudget: 120,
    })
    expect(report.scenarioId).toBe('multi-step-revision')
    expect(report.steps).toHaveLength(3)
    // 步骤 2：Read 的 schema 已修订，旧调用必须被拒绝且不执行。
    expect(report.steps[1]!.attemptRefusal).toBe('schema_changed')
    // 步骤 3：以修订后目录重规划，Write 正常加载执行。
    expect(report.steps[2]!.attemptRefusal).toBeUndefined()
    expect(report.steps[2]!.loadedNames).toContain('Write')
    // 恢复非劣：重规划后无未解释失败。
    expect(report.unresolvedFailures).toEqual([])
  })

  test('未加载调用拒绝与 required 缺失都被如实统计', () => {
    const report = runToolSelectionBenchmark({
      id: 'refusals-and-missing',
      steps: [
        { query: 'read', requiredIds: ['builtin:Ghost'], attemptTool: 'Write' },
      ],
      seedTools: [readTool, writeTool],
      tokenBudget: 45,
    })
    expect(report.steps[0]!.attemptRefusal).toBe('tool_not_loaded')
    expect(report.steps[0]!.requiredMissing).toEqual(['builtin:Ghost'])
    expect(report.refusals.toolNotLoaded).toBe(1)
    expect(report.refusals.schemaChanged).toBe(0)
    expect(report.requiredMissingTotal).toBe(1)
  })

  test('schema token：大目录下摘要+选中的优化体积严格小于全量基线', () => {
    const report = runToolSelectionBenchmark({
      id: 'token-savings',
      steps: [{ query: 'read file', requiredIds: ['builtin:Read'], attemptTool: 'Read' }],
      seedTools: [readTool, writeTool, ...mcpTools],
      tokenBudget: 150,
    })
    expect(report.tokens.toolCount).toBe(42)
    expect(report.tokens.optimizedTokens).toBeLessThan(report.tokens.baselineTokens)
    expect(report.tokens.savingsRate).toBeGreaterThan(0)
  })

  test('报告可 JSON 序列化且不含工具参数正文（只含统计）', () => {
    const report = runToolSelectionBenchmark({
      id: 'serializable',
      steps: [{ query: 'read', attemptTool: 'Read' }],
      seedTools: [readTool, writeTool],
      tokenBudget: 200,
    })
    const serialized = JSON.stringify(report)
    expect(JSON.parse(serialized).benchmarkId).toBe(TOOL_SELECTION_BENCHMARK_ID)
    expect(serialized).not.toContain('file_path')
    expect(report.wallTimeMs).toBeGreaterThanOrEqual(0)
  })
})
