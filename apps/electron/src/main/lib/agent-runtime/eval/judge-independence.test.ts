/**
 * 评估器独立性（P0-1）单测：
 * - computeJudgeIndependence：评判渠道与被测/Builder 渠道的同源判定
 * - parseJudgeScore：LLM judge 输出解析
 * - selfEvolve：judge 身份写入 scoreboard 每条 evaluation
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { computeJudgeIndependence } from './eval-runner'
import { parseJudgeScore } from './judge'
import { selfEvolve, type CaseEval, type StateGuard } from './self-evolver'
import { readScoreboard } from './benchmark-store'
import type { BenchmarkConfig, JudgeIdentity } from './types'

const testDir = join(tmpdir(), `gravitas-eval-judge-test-${Date.now()}`)

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

describe('computeJudgeIndependence', () => {
  it('同渠道同模型 → 不独立', () => {
    expect(computeJudgeIndependence(
      { channelId: 'ch-1', modelId: 'm-1' },
      { channelId: 'ch-1', modelId: 'm-1' },
    )).toBe(false)
  })

  it('同渠道不同模型 → 独立', () => {
    expect(computeJudgeIndependence(
      { channelId: 'ch-1', modelId: 'm-1' },
      { channelId: 'ch-1', modelId: 'm-2' },
    )).toBe(true)
  })

  it('不同渠道同模型 → 独立', () => {
    expect(computeJudgeIndependence(
      { channelId: 'ch-1', modelId: 'm-1' },
      { channelId: 'ch-2', modelId: 'm-1' },
    )).toBe(true)
  })
})

describe('parseJudgeScore', () => {
  it('解析最后一行 JSON {"score": N}', () => {
    const text = '逐项评分：\n- 准确性 40/40\n- 完整性 30/50\n{"score": 70}'
    expect(parseJudgeScore(text)).toBe(70)
  })

  it('JSON 不在最后一行也能解析（从末尾向前找）', () => {
    const text = '{"score": 85}\n（以上为总分）'
    expect(parseJudgeScore(text)).toBe(85)
  })

  it('最后一行裸数字可解析', () => {
    expect(parseJudgeScore('评分过程略\n88')).toBe(88)
  })

  it('越界分数 clamp 到 0..100', () => {
    expect(parseJudgeScore('{"score": 250}')).toBe(100)
    expect(parseJudgeScore('{"score": -5}')).toBe(0)
  })

  it('小数四舍五入为整数', () => {
    expect(parseJudgeScore('{"score": 72.6}')).toBe(73)
  })

  it('无法解析返回 null', () => {
    expect(parseJudgeScore('我无法给出分数')).toBeNull()
    expect(parseJudgeScore('')).toBeNull()
  })
})

describe('selfEvolve 写入 judge 身份', () => {
  const mkBenchmark = (id: string): BenchmarkConfig => ({
    id,
    title: 'judge identity test',
    description: 'unittest',
    targetAgentId: 'code-reviewer',
    runtime: { provider: 'deepseek', modelId: 'm' },
    runsPerCase: 1,
    targetScore: 80,
    cases: ['CASE-001'],
    createdAt: '',
    updatedAt: '',
  })

  const state: StateGuard = {
    async snapshot() {},
    async apply() {},
    async restore() {},
    version: () => 1,
  }

  const evaluate = async (): Promise<CaseEval[]> => [{ caseId: 'CASE-001', score: 70, sessionId: 'sess-1' }]

  it('传入 judge 时写入每条 evaluation', async () => {
    const judge: JudgeIdentity = {
      kind: 'llm',
      provider: 'anthropic',
      modelId: 'claude-judge',
      channelId: 'ch-judge',
      independent: true,
    }
    await selfEvolve({
      benchmark: mkBenchmark('judge-test-with'),
      maxRounds: 0,
      propose: async () => null,
      evaluate,
      state,
      judge,
    })
    const sc = readScoreboard('judge-test-with')
    expect(sc.evaluations.length).toBe(1)
    expect(sc.evaluations[0]?.judge).toEqual(judge)
  })

  it('未传入 judge 时记录为 null', async () => {
    await selfEvolve({
      benchmark: mkBenchmark('judge-test-without'),
      maxRounds: 0,
      propose: async () => null,
      evaluate,
      state,
    })
    const sc = readScoreboard('judge-test-without')
    expect(sc.evaluations.length).toBe(1)
    expect(sc.evaluations[0]?.judge ?? null).toBeNull()
  })
})
