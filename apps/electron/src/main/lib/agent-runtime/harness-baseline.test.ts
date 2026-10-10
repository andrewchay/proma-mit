/**
 * H03/B15：无副作用基线钉板。
 *
 * - flags off 行为兼容：同版本离线安全基线在调度启用/禁用下结果一致；
 * - TCC 始终关闭：核心工具注册表不存在 TCC/context-compiler 工具（禁止借本升级复活）；
 * - retired Runtime 不恢复由 P03 一致性矩阵承担，这里不重复钉。
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../testing/electron-mock'

const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const testDir = mkdtempSync(join(tmpdir(), 'gravitas-h03-baseline-'))
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
mock.module('../document-parser', () => ({
  isDocumentAttachment: () => false,
  extractTextFromAttachment: async () => '',
}))

const { runHarnessBenchmark, buildHarnessBenchmarkTasks } = await import('./harness-benchmark/runner')
const { setToolSchedulerDisabled, runGuardedToolCall } = await import('./tool-scheduler-service')
const { createCoreTools } = await import('./tool-registry')
const { evaluateContextCompactionGoldenSet } = await import('./context-compaction-evaluator')
const { CONTEXT_COMPACTION_GOLDENS } = await import('./context-compaction-goldens')
const { containsSensitiveContent } = await import('../memory-plugin-service')
const { bindCoreToolEffects } = await import('./tool-effects')

beforeAll(() => setToolSchedulerDisabled(false))
afterAll(() => {
  setToolSchedulerDisabled(false)
  rmSync(testDir, { recursive: true, force: true })
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
})

function safetyBaseline() {
  const fakeTool = bindCoreToolEffects({ name: 'McpBaseline', description: 'x', parameters: { type: 'object', properties: {} }, execute: async () => ({ toolCallId: '', content: '' }) })
  return buildHarnessBenchmarkTasks({
    evaluateGoldenSet: () => evaluateContextCompactionGoldenSet(CONTEXT_COMPACTION_GOLDENS).passed,
    checkUnknownToolsSerialize: async () => {
      const log: string[] = []
      const ctx = { cwd: testDir, sessionId: 'h03-baseline' }
      const mk = (id: string, ms: number) => runGuardedToolCall({
        tool: fakeTool, args: {}, ctx,
        execute: async () => { log.push(`s:${id}`); await Bun.sleep(ms); log.push(`e:${id}`); return { content: id } },
      })
      await Promise.all([mk('a', 40), mk('b', 10)])
      return log.indexOf('e:a') < log.indexOf('s:b')
    },
    sensitiveFilterBlocks: () => containsSensitiveContent('sk-ABCDEFGHIJKLMNOP1234') && !containsSensitiveContent('普通文本'),
    // 预算闸 fail-closed 行为由既有 pilot 测试承担；这里以能力位存在性为基线信号。
    budgetGateThrows: (runtime) => runtime === 'proma' || runtime === 'pi',
  })
}

describe('H03/B15：无副作用基线与 flag 行为兼容', () => {
  test('flag off（调度禁用）与 flag on 的安全基线结果一致（B15 行为兼容）', async () => {
    setToolSchedulerDisabled(false)
    const onReport = await runHarnessBenchmark(safetyBaseline())
    setToolSchedulerDisabled(true)
    const offReport = await runHarnessBenchmark(safetyBaseline())
    setToolSchedulerDisabled(false)
    expect(onReport.safetyFailures).toEqual([])
    expect(offReport.safetyFailures).toEqual([])
    const onIds = onReport.results.map((r) => `${r.taskId}:${r.passed}`).sort()
    const offIds = offReport.results.map((r) => `${r.taskId}:${r.passed}`).sort()
    expect(offIds).toEqual(onIds)
  })

  test('TCC 始终关闭：核心工具注册表无 TCC/context-compiler 工具', () => {
    const tools = createCoreTools()
    const tccLike = tools.filter((tool) => /tcc|context.?compiler/i.test(tool.name))
    expect(tccLike).toEqual([])
  })
})
