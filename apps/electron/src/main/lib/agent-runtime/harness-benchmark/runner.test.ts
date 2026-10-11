import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../../testing/electron-mock'

const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const configDir = mkdtempSync(join(tmpdir(), 'gravitas-benchmark-'))
process.env.PROMA_TEST_CONFIG_DIR = configDir
mock.module('electron', () => buildElectronMock())

const { runHarnessBenchmark, buildHarnessBenchmarkTasks } = await import('./runner')
const { evaluateContextCompactionGoldenSet } = await import('../context-compaction-evaluator')
const { CONTEXT_COMPACTION_GOLDENS } = await import('../context-compaction-goldens')
const { containsSensitiveContent } = await import('../../memory-plugin-service')
const { resolveRuntimeBudgetLimitUsd } = await import('../../project-pilot-runtime-budget')
const { runGuardedToolCall } = await import('../tool-scheduler-service')
const { bindCoreToolEffects } = await import('../tool-effects')

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

const fakeTool = bindCoreToolEffects({ name: 'McpBench', description: 'x', parameters: { type: 'object', properties: {} }, execute: async () => ({ toolCallId: '', content: '' }) })

const deps = {
  evaluateGoldenSet: () => evaluateContextCompactionGoldenSet(CONTEXT_COMPACTION_GOLDENS).passed,
  checkUnknownToolsSerialize: async () => {
    const log: string[] = []
    const ctx = { cwd: configDir, sessionId: 'bench' }
    const mk = (id: string, ms: number) => runGuardedToolCall({ tool: fakeTool, args: {}, ctx, execute: async () => { log.push(`s:${id}`); await Bun.sleep(ms); log.push(`e:${id}`); return { content: id } } })
    await Promise.all([mk('a', 40), mk('b', 10)])
    return log.indexOf('e:a') < log.indexOf('s:b')
  },
  sensitiveFilterBlocks: () => containsSensitiveContent('sk-ABCDEFGHIJKLMNOP1234') && !containsSensitiveContent('普通文本'),
  budgetGateThrows: (runtime: 'claude' | 'proma' | 'pi' | 'ai-sdk') => {
    try {
      resolveRuntimeBudgetLimitUsd(runtime, 5, undefined)
      return false
    } catch {
      return true
    }
  },
}

describe('R01 held-out 离线基准', () => {
  test('内置任务集全绿；矩阵覆盖全部 runtime；费用恒为 unknown', async () => {
    const report = await runHarnessBenchmark(buildHarnessBenchmarkTasks(deps))
    expect(report.safetyFailures).toEqual([])
    expect(report.failed).toBe(0)
    // 矩阵：policy-default 与 budget-gate 各 4 行 + 三个单例行
    expect(report.total).toBe(4 + 4 + 1 + 1 + 1 + 1)
    expect(report.results.every((r) => r.cost === 'unknown')).toBe(true)
    // 报告可序列化落盘（基线追踪）
    const file = join(configDir, 'benchmark-report.json')
    writeFileSync(file, JSON.stringify(report, null, 2))
    expect(JSON.parse(readFileSync(file, 'utf8')).failed).toBe(0)
  })
  test('安全断言失败零容忍：单个失败即出现在 safetyFailures', async () => {
    const report = await runHarnessBenchmark([{ id: 'safety-x', description: 'x', safety: true, run: async () => ({ passed: false, detail: 'boom' }) }])
    expect(report.safetyFailures).toEqual(['safety-x'])
    expect(report.failed).toBe(1)
  })
  test('非安全任务失败不记入 safetyFailures；异常视为失败', async () => {
    const report = await runHarnessBenchmark([
      { id: 'quality-x', description: 'x', safety: false, run: async () => ({ passed: false }) },
      { id: 'throws', description: 'x', safety: true, run: async () => { throw new Error('运行时错误') } },
    ])
    expect(report.safetyFailures).toEqual(['throws'])
    expect(report.results.find((r) => r.taskId === 'throws')?.detail).toBe('运行时错误')
  })
})
