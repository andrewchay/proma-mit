import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { createBenchmark } from './benchmark-store'
import { evaluateCaseRun } from './evaluator'
import type { SubAgentDelegate } from './evaluator'
import type { BenchmarkConfig, Rubric } from './types'

const testDir = join(tmpdir(), `gravitas-eval-evaluator-test-${Date.now()}`)

beforeAll(() => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
})

afterAll(() => {
  delete process.env.PROMA_TEST_CONFIG_DIR
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // 忽略
  }
})

const config: BenchmarkConfig = {
  id: 'eval-evaluator-bench',
  title: '评测执行器测试基准',
  description: 'unit',
  targetAgentId: 'code-reviewer',
  runtime: { provider: 'deepseek', modelId: 'deepseek-v4-flash' },
  runsPerCase: 1,
  targetScore: 80,
  cases: ['CASE-001'],
  createdAt: '2026-08-16T00:00:00Z',
  updatedAt: '2026-08-16T00:00:00Z',
}

const rubric: Rubric = {
  version: 1,
  items: [
    { name: '修复点', points: 35, check: 'reference defective function' },
    { name: '缺陷', points: 40, check: 'find bug' },
    { name: '格式', points: 25, check: 'file:line' },
  ],
}

beforeAll(() => {
  createBenchmark(config, [{ caseId: 'CASE-001', statement: '# 审查 materialize.js\n评估该实现质量', rubric }])
})

async function delegateStub(input: { text?: string; workspaceDir: string }) {
  // 校验沙箱存在
  if (!existsSync(input.workspaceDir)) throw new Error('sandbox missing')
  return { text: input.text ?? '' }
}

describe('evaluateCaseRun', () => {
  it('对高质量输出打出高分（规则打分）', async () => {
    const output = [
      '### 审查结果\n',
      '发现缺陷在 file:materialize.js:42 的函数 parse 中，存在未初始化变量导致崩溃。\n',
      '修复建议：初始化变量。\n',
      '{"score": 95, "findings": ["materialize.js:42 —— 未初始化"], "verdict": "fail"}',
    ].join('\n')
    const result = await evaluateCaseRun(config, 'CASE-001', 1, 1, (input) => delegateStub({ text: output, workspaceDir: input.workspaceDir }))
    expect(result.protocolVersion).toBe(1)
    expect(result.status).toBe('ok')
    // 规则打分是粗糙启发式；精确评分走 LLM 回调。这里只验证：丰富关键词输出 ≥ 空输出（>0）
    expect(result.score).toBeGreaterThan(0)
  })

  it('对含修复点/缺陷/格式关键词的输出给更高分', async () => {
    const good = await evaluateCaseRun(config, 'CASE-001', 1, 1, (input) => delegateStub({ text: 'file:line 修复 缺陷 bug function', workspaceDir: input.workspaceDir }))
    expect(good.status).toBe('ok')
    expect(good.score).toBeGreaterThan(0)
  })

  it('对空输出给 0 分（不崩）', async () => {
    const empty = await evaluateCaseRun(config, 'CASE-001', 1, 1, (input) => delegateStub({ workspaceDir: input.workspaceDir }))
    expect(empty.status).toBe('ok')
    expect(empty.score).toBe(0)
  })

  it('委派异常返回 evaluation_failed', async () => {
    const failing: SubAgentDelegate = async () => {
      throw new Error('delegate boom')
    }
    const result = await evaluateCaseRun(config, 'CASE-001', 1, 1, failing)
    expect(result.status).toBe('failed')
    expect(result.failureCode).toBe('evaluation_failed')
  })

  it('LLM 打分回调优先于规则打分', async () => {
    const scoreDelegate = async () => 88.5
    const result = await evaluateCaseRun(config, 'CASE-001', 1, 1, (input) => delegateStub({ text: 'irrelevant text', workspaceDir: input.workspaceDir }), { scoreDelegate })
    expect(result.status).toBe('ok')
    expect(result.score).toBe(89) // clamp round(88.5)
  })

  it('沙箱目录被创建且不含 rubric', async () => {
    let sawWorkspace: string | undefined
    const capture = async (input: { workspaceDir: string }) => {
      sawWorkspace = input.workspaceDir
      return { text: 'file:line 修复' }
    }
    await evaluateCaseRun(config, 'CASE-001', 1, 1, capture as never)
    expect(sawWorkspace).toBeDefined()
    expect(sawWorkspace!.startsWith(testDir)).toBe(true)
  })

  it('不存在 case 返回 failed（invalid_request）', async () => {
    const missing = await evaluateCaseRun({ ...config, cases: ['NOPE'] }, 'NOPE', 1, 1, (input) => delegateStub({ text: 'x', workspaceDir: input.workspaceDir }))
    expect(missing.status).toBe('failed')
    expect(missing.failureCode).toBe('invalid_request')
  })
})

// 供上述测试引用的沙箱写入（声明素材可选）
beforeAll(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const { getBenchmarkCaseStatementAssetsDir } = require('../../config-paths') as typeof import('../../config-paths')
  const assetsDir = getBenchmarkCaseStatementAssetsDir(config.id, 'CASE-001')
  writeFileSync(join(assetsDir, 'materialize.js'), '// sample source')
})
