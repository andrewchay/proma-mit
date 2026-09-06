/**
 * P1-2 单测：held-out 迁移评估（综述 §8.1.1）
 * - createBenchmarkForUI：held-out 与训练集相交时报错
 * - runBaseline：includeHeldOut 时 held-out 分数独立落盘，不影响训练分
 * - runImprove：held-out 不参与优化（propose 只看到训练失分），被接受候选落盘 held-out 对照
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { createBenchmark, createBenchmarkForUI, readScoreboard } from './benchmark-store'
import { runBaseline, runImprove } from './commands'
import type { ScoreDelegate, SubAgentDelegate } from './evaluator'
import type { StateGuard } from './self-evolver'
import type { BenchmarkConfig, Rubric, SelfEvolveChange } from './types'

const testDir = join(tmpdir(), `gravitas-eval-heldout-test-${Date.now()}`)

const rubric: Rubric = {
  version: 1,
  items: [{ name: '完整', points: 100, check: 'x' }],
}

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

describe('createBenchmarkForUI held-out 校验', () => {
  it('held-out 与训练 Case 相交时抛错', () => {
    expect(() =>
      createBenchmarkForUI({
        id: 'heldout-overlap',
        title: 't', description: 'd', targetAgentId: 'code-reviewer',
        provider: 'deepseek', modelId: 'm', targetScore: 80,
        cases: [{ caseId: 'CASE-001', statement: 's', rubricItems: [{ name: 'a', points: 100, check: 'x' }] }],
        heldOutCases: [{ caseId: 'CASE-001', statement: 's', rubricItems: [{ name: 'a', points: 100, check: 'x' }] }],
      }),
    ).toThrow(/不相交/)
  })

  it('不相交时正常创建，heldOutCases 写入 config', () => {
    const cfg = createBenchmarkForUI({
      id: 'heldout-ok',
      title: 't', description: 'd', targetAgentId: 'code-reviewer',
      provider: 'deepseek', modelId: 'm', targetScore: 80,
      cases: [{ caseId: 'TRAIN-001', statement: 's', rubricItems: [{ name: 'a', points: 100, check: 'x' }] }],
      heldOutCases: [{ caseId: 'HELD-001', statement: 's2', rubricItems: [{ name: 'a', points: 100, check: 'x' }] }],
    })
    expect(cfg.cases).toEqual(['TRAIN-001'])
    expect(cfg.heldOutCases).toEqual(['HELD-001'])
  })
})

describe('runBaseline held-out 评测', () => {
  const config: BenchmarkConfig = {
    id: 'heldout-baseline',
    title: 'heldout baseline test',
    description: 'unittest',
    targetAgentId: 'code-reviewer',
    runtime: { provider: 'deepseek', modelId: 'm' },
    runsPerCase: 1,
    targetScore: 80,
    cases: ['TRAIN-001'],
    heldOutCases: ['HELD-001'],
    createdAt: '',
    updatedAt: '',
  }
  const delegate: SubAgentDelegate = async () => ({ text: '任意输出' })

  beforeAll(() => {
    createBenchmark(config, [
      { caseId: 'TRAIN-001', statement: '# 训练任务', rubric },
      { caseId: 'HELD-001', statement: '# 迁移任务', rubric },
    ])
  })

  it('includeHeldOut=true 时 held-out 分数独立落盘', async () => {
    // 训练 80、held-out 60（模拟迁移掉分）
    const byCaseId: Record<string, number> = { 'TRAIN-001': 80, 'HELD-001': 60 }
    const scoreDelegate: ScoreDelegate = async ({ statement }) =>
      statement.includes('迁移') ? byCaseId['HELD-001']! : byCaseId['TRAIN-001']!
    const summary = await runBaseline({
      benchmark: config, delegate, scoreDelegate, agentVersion: 1, includeHeldOut: true,
    })
    expect(summary.score).toBe(80)
    expect(summary.heldOutScore).toBe(60)

    const sc = readScoreboard(config.id)
    const ev = sc.evaluations[0]!
    expect(ev.score).toBe(80)
    expect(ev.heldOut?.score).toBe(60)
    expect(ev.heldOut?.cases[0]?.caseId).toBe('HELD-001')
  })

  it('includeHeldOut 缺省时 heldOut 为 null（省成本）', async () => {
    const summary = await runBaseline({ benchmark: config, delegate, agentVersion: 1 })
    expect(summary.heldOutScore).toBeUndefined()
    const sc = readScoreboard(config.id)
    expect(sc.evaluations[sc.evaluations.length - 1]!.heldOut ?? null).toBeNull()
  })
})

describe('runImprove held-out 不参与优化', () => {
  const config: BenchmarkConfig = {
    id: 'heldout-improve',
    title: 'heldout improve test',
    description: 'unittest',
    targetAgentId: 'code-reviewer',
    runtime: { provider: 'deepseek', modelId: 'm' },
    runsPerCase: 1,
    targetScore: 80,
    cases: ['TRAIN-001'],
    heldOutCases: ['HELD-001'],
    createdAt: '',
    updatedAt: '',
  }
  const delegate: SubAgentDelegate = async () => ({ text: '任意输出' })
  const state: StateGuard = {
    async snapshot() {},
    async apply() {},
    async restore() {},
    version: () => 1,
  }

  beforeAll(() => {
    createBenchmark(config, [
      { caseId: 'TRAIN-001', statement: '# 训练任务', rubric },
      { caseId: 'HELD-001', statement: '# 迁移任务', rubric },
    ])
  })

  it('propose 只看到训练失分；接受候选落盘 held-out 对照', async () => {
    const proposeSeenDeficit: Array<Array<{ caseId: string; score: number | null }>> = []
    // 训练分 70 → 90（候选提升）；held-out 始终 55（迁移不涨 = 过拟合信号）
    const scoreDelegate: ScoreDelegate = async ({ statement }) => {
      if (statement.includes('迁移')) return 55
      return currentTrainScore
    }
    let currentTrainScore = 70
    const propose = async ({ deficit }: { benchmark: BenchmarkConfig; deficit: Array<{ caseId: string; score: number | null }>; round: number }) => {
      proposeSeenDeficit.push(deficit)
      if (proposeSeenDeficit.length > 1) return null
      currentTrainScore = 90
      const change: SelfEvolveChange = { description: 'improve', target: 'code-reviewer', afterState: { prompt: 'better' } }
      return change
    }
    const summary = await runImprove({
      benchmark: config, delegate, scoreDelegate, state, maxRounds: 2, includeHeldOut: true, propose,
    })
    expect(summary.baselineScore).toBe(70)
    expect(summary.finalScore).toBe(90)
    // deficit 只含训练 Case
    expect(proposeSeenDeficit[0]!.map((d) => d.caseId)).toEqual(['TRAIN-001'])

    const sc = readScoreboard(config.id)
    // baseline + 被接受候选各有 held-out 对照
    expect(sc.evaluations.length).toBe(2)
    for (const ev of sc.evaluations) {
      expect(ev.heldOut?.score).toBe(55)
    }
  })
})
