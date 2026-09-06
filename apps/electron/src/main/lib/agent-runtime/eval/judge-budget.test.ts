/**
 * P1-1 单测：judge 预算隔离 + 方差报告（mean±std）
 * - meanStd 纯函数
 * - withJudgeBudget：maxCalls 短路 / maxPromptChars 截断 / 无预算透传
 * - runBaseline 集成：scoreboard 写入 Case 级与 Evaluation 级 scoreStd
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { meanStd, type ScoreDelegate, type SubAgentDelegate } from './evaluator'
import { withJudgeBudget } from './judge'
import { createBenchmark, readScoreboard } from './benchmark-store'
import { runBaseline } from './commands'
import type { BenchmarkConfig, Rubric } from './types'

const testDir = join(tmpdir(), `gravitas-eval-judge-budget-test-${Date.now()}`)

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

describe('meanStd', () => {
  it('空数组 → mean 0, std null', () => {
    expect(meanStd([])).toEqual({ mean: 0, std: null })
  })

  it('单值 → std null（单次观测无方差）', () => {
    expect(meanStd([75])).toEqual({ mean: 75, std: null })
  })

  it('[70, 90] → mean 80, 总体标准差 10', () => {
    const { mean, std } = meanStd([70, 90])
    expect(mean).toBe(80)
    expect(std).toBe(10)
  })

  it('相同值 → std 0', () => {
    expect(meanStd([60, 60, 60]).std).toBe(0)
  })
})

describe('withJudgeBudget', () => {
  const mkDelegate = (calls: number[]): ScoreDelegate => async () => {
    calls.push(1)
    return 88
  }

  it('无预算 → 原样透传', async () => {
    const calls: number[] = []
    const d = withJudgeBudget(mkDelegate(calls))
    expect(await d({ rubric: { version: 1, items: [] }, statement: 's', agentOutput: 'o' })).toBe(88)
    expect(calls.length).toBe(1)
  })

  it('maxCalls 用尽后短路返回 null，不再调用底层 delegate', async () => {
    const calls: number[] = []
    const d = withJudgeBudget(mkDelegate(calls), { maxCalls: 2 })
    const input = { rubric: { version: 1, items: [] }, statement: 's', agentOutput: 'o' }
    expect(await d(input)).toBe(88)
    expect(await d(input)).toBe(88)
    expect(await d(input)).toBeNull() // 第 3 次短路
    expect(await d(input)).toBeNull()
    expect(calls.length).toBe(2) // 底层只被调 2 次
  })

  it('maxPromptChars 截断被测输出', async () => {
    let seenLength = 0
    const probe: ScoreDelegate = async (input) => {
      seenLength = input.agentOutput.length
      return 50
    }
    const d = withJudgeBudget(probe, { maxPromptChars: 10 })
    await d({ rubric: { version: 1, items: [] }, statement: 's', agentOutput: 'x'.repeat(100) })
    // 10 字符 + 截断提示语
    expect(seenLength).toBeLessThan(100)
    expect(seenLength).toBeGreaterThan(10)
  })

  it('输出未超长时不截断', async () => {
    let seen = ''
    const probe: ScoreDelegate = async (input) => {
      seen = input.agentOutput
      return 50
    }
    const d = withJudgeBudget(probe, { maxPromptChars: 100 })
    await d({ rubric: { version: 1, items: [] }, statement: 's', agentOutput: '短输出' })
    expect(seen).toBe('短输出')
  })
})

describe('runBaseline 方差报告', () => {
  const rubric: Rubric = {
    version: 1,
    items: [{ name: '完整', points: 100, check: 'x' }],
  }
  const config: BenchmarkConfig = {
    id: 'variance-bench',
    title: 'variance test',
    description: 'unittest',
    targetAgentId: 'code-reviewer',
    runtime: { provider: 'deepseek', modelId: 'm' },
    runsPerCase: 2,
    targetScore: 80,
    cases: ['CASE-001'],
    createdAt: '',
    updatedAt: '',
  }
  const delegate: SubAgentDelegate = async () => ({ text: '任意输出' })

  it('多次 run 的分数写入 scoreStd（mean±std 可审计）', async () => {
    createBenchmark(config, [{ caseId: 'CASE-001', statement: '# 任务', rubric }])
    // scoreDelegate 两次调用返回 70 / 90 → mean 80, std 10
    const scores = [70, 90]
    let i = 0
    const scoreDelegate: ScoreDelegate = async () => scores[i++ % scores.length]!
    await runBaseline({ benchmark: config, delegate, scoreDelegate, agentVersion: 1 })

    const sc = readScoreboard(config.id)
    expect(sc.evaluations.length).toBe(1)
    const ev = sc.evaluations[0]!
    expect(ev.score).toBe(80)
    expect(ev.cases[0]!.scoreStd).toBe(10)
    // 单 Case 的 benchmark：跨 Case 标准差为 null
    expect(ev.scoreStd).toBeNull()
  })
})
