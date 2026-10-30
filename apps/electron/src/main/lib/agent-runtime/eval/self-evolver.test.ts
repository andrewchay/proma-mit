import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync } from 'node:fs'
import { getBenchmarkScoreboardPath } from '../../config-paths'
import { selfEvolve, type CaseEval, type StateGuard } from './self-evolver'
import type { BenchmarkConfig, SelfEvolveChange } from './types'
import { readScoreboard } from './benchmark-store'

const testDir = join(tmpdir(), `gravitas-eval-selfevolve-test-${Date.now()}`)

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
  id: 'selftest',
  title: 'self-evolve test',
  description: 'unittest',
  targetAgentId: 'code-reviewer',
  runtime: { provider: 'deepseek', modelId: 'm' },
  runsPerCase: 1,
  targetScore: 80,
  cases: ['CASE-001'],
  createdAt: '',
  updatedAt: '',
}

function mkState(sourceVersion: () => number, applyFns: { apply?: (c: SelfEvolveChange) => void; rollback?: () => void } = {}): StateGuard {
  let version = sourceVersion()
  return {
    async snapshot() {},
    async apply(c: SelfEvolveChange) {
      version = (typeof c.afterState === 'number' ? c.afterState as number : version + 1)
      applyFns.apply?.(c)
    },
    async restore() {
      version = sourceVersion()
      applyFns.rollback?.()
    },
    version: () => version,
  }
}

function evaluateScored(baseScore: number, candidateScore?: number) {
  return async (def: unknown): Promise<CaseEval[]> => {
    // def 为候选时用 candidateScore；undefined = baseline
    const s = def === undefined ? baseScore : (candidateScore ?? baseScore)
    return [{ caseId: 'CASE-001', score: s, sessionId: 'sess-1' }]
  }
}

describe('selfEvolve', () => {
  it('Given 相同版本已评测 When 再次运行基线 Then 两次真实结果均被保存', async () => {
    const benchmark = { ...config, id: 'repeat-baseline' }
    for (const score of [65, 85]) {
      await selfEvolve({ benchmark, maxRounds: 1, state: mkState(() => 7), evaluate: evaluateScored(score), propose: async () => null })
    }
    const records = readScoreboard(benchmark.id).evaluations
    expect(records.map(item => item.agentVersion)).toEqual([7, 7])
    expect(records.map(item => item.score)).toEqual([65, 85])
  })

  it('baseline + 候选分数严格更高则接受', async () => {
    const defState = { v: 1 }
    const state = mkState(() => defState.v, {
      apply: () => { defState.v++ },
      rollback: () => { defState.v = 1 },
    })
    const propose: Parameters<typeof selfEvolve>[0]['propose'] = async () => {
      if (defState.v > 3) return null
      return { description: 'improve', target: 'builtin:code-reviewer', afterState: defState.v + 1 }
    }
    const out = await selfEvolve({
      benchmark: config,
      maxRounds: 3,
      propose,
      evaluate: evaluateScored(70, 90),
      state,
    })
    expect(out.baseline.totalScore).toBe(70)
    expect(out.rounds.length).toBeGreaterThanOrEqual(1)
    // 至少有一轮接受（90 > 70）
    expect(out.rounds.some((r) => r.accepted)).toBe(true)
    expect(out.finalScore).toBe(90)
  })

  it('候选分数不高于 Reference 则回滚，不改 Reference', async () => {
    const histories: number[] = []
    const state = mkState(() => 1, {
      apply: () => { histories.push(2) },
      rollback: () => { histories.push(1) },
    })
    const propose: Parameters<typeof selfEvolve>[0]['propose'] = async () => ({ description: 'worse', target: 'x', afterState: 2 })
    const out = await selfEvolve({
      benchmark: config,
      maxRounds: 2,
      propose,
      evaluate: evaluateScored(80, 50),
      state,
    })
    expect(out.rounds[0]!.accepted).toBe(false)
    expect(out.rounds[0]!.rolledBack).toBe(true)
    expect(out.finalScore).toBe(80) // Reference 保持
  })

  it('propose 返回 null 时停止（无候选不崩）', async () => {
    const state = mkState(() => 5)
    const propose: Parameters<typeof selfEvolve>[0]['propose'] = async () => null
    const out = await selfEvolve({
      benchmark: config,
      maxRounds: 5,
      propose,
      evaluate: evaluateScored(88),
      state,
    })
    expect(out.rounds).toHaveLength(0)
    expect(out.finalScore).toBe(88)
  })

  it('训练集提升但 held-out 下降时回滚', async () => {
    const state = mkState(() => 1)
    const propose: Parameters<typeof selfEvolve>[0]['propose'] = async () => ({ description: 'overfit', target: 'x', afterState: 2 })
    const out = await selfEvolve({
      benchmark: config,
      maxRounds: 1,
      propose,
      evaluate: evaluateScored(70, 90),
      evaluateHeldOut: (() => {
        let calls = 0
        return async () => [{ caseId: 'HELD-001', score: ++calls === 1 ? 80 : 60, sessionId: 'held-s' }]
      })(),
      state,
    })
    expect(out.rounds[0]!.accepted).toBe(false)
    expect(out.rounds[0]!.rolledBack).toBe(true)
    expect(out.rounds[0]!.reason).toContain('held-out')
  })

  it('训练集缺失 case 时基线停止或候选回滚', async () => {
    const benchmark = { ...config, id: 'training-missing', cases: ['CASE-001', 'CASE-002'] }
    let proposed = false
    const partial = async () => [{ caseId: 'CASE-001', score: 80 }]
    await expect(selfEvolve({ benchmark, state: mkState(() => 1), maxRounds: 1, evaluate: partial, propose: async () => { proposed = true; return null } })).rejects.toThrow('训练集基线评测不完整')
    expect(proposed).toBe(false)
    const out = await selfEvolve({ benchmark, state: mkState(() => 1), maxRounds: 1,
      propose: async () => ({ description: 'candidate', target: 'x', afterState: 2 }),
      evaluate: async (def) => def === undefined ? [{ caseId: 'CASE-001', score: 60 }, { caseId: 'CASE-002', score: 60 }] : partial(),
    })
    expect(out.rounds[0]!.accepted).toBe(false)
    expect(out.rounds[0]!.rolledBack).toBe(true)
  })

  it('held-out 基线或候选缺失 case 时回滚，不把缺失记录成零分', async () => {
    for (const missingBaseline of [true, false]) {
      const benchmark = { ...config, id: 'held-out-missing-' + String(missingBaseline), heldOutCases: ['HELD-1', 'HELD-2'] }
      const out = await selfEvolve({
        benchmark, maxRounds: 1, state: mkState(() => 1),
        propose: async () => ({ description: 'candidate', target: 'x', afterState: 2 }),
        evaluate: evaluateScored(70, 90),
        evaluateHeldOut: async (def) => {
          const incomplete = (def === undefined) === missingBaseline
          return [{ caseId: 'HELD-1', score: 80, sessionId: 'one' }, { caseId: 'HELD-2', score: incomplete ? null : 80, sessionId: 'two' }]
        },
      })
      expect(out.rounds[0]!.accepted).toBe(false)
      expect(out.rounds[0]!.rolledBack).toBe(true)
      expect(out.rounds[0]!.reason).toContain('不完整')
      const records = readScoreboard(benchmark.id).evaluations
      expect(records).toHaveLength(1)
      if (missingBaseline) expect(records[0]!.heldOut).toBeNull()
    }
  })

  it('held-out case 完整且不回退时保留候选和真实分数', async () => {
    const benchmark = { ...config, id: 'held-out-complete', heldOutCases: ['HELD-1', 'HELD-2'] }
    const out = await selfEvolve({ benchmark, maxRounds: 1, state: mkState(() => 1),
      propose: async () => ({ description: 'candidate', target: 'x', afterState: 2 }),
      evaluate: evaluateScored(70, 90),
      evaluateHeldOut: async (def) => [{ caseId: 'HELD-1', score: def === undefined ? 70 : 80 }, { caseId: 'HELD-2', score: 90 }],
    })
    expect(out.rounds[0]!.accepted).toBe(true)
    expect(readScoreboard(benchmark.id).evaluations.map(item => item.heldOut?.score)).toEqual([80, 85])
  })

  it('Given 候选评测通过但历史写入失败 When 回滚 Then 不报告接受', async () => {
    const benchmark = { ...config, id: 'candidate-write-failure' }
    const state = mkState(() => 1)
    const out = await selfEvolve({
      benchmark, maxRounds: 1, state,
      propose: async () => ({ description: 'candidate', target: 'x', afterState: 2 }),
      evaluate: async (def) => {
        if (def !== undefined) mkdirSync(`${getBenchmarkScoreboardPath(benchmark.id)}.tmp`)
        return [{ caseId: 'CASE-001', score: def === undefined ? 60 : 90 }]
      },
    })
    expect(out.rounds[0]!.accepted).toBe(false)
    expect(out.rounds[0]!.rolledBack).toBe(true)
    expect(out.rounds[0]!.reason).toContain('异常')
    expect(out.finalAcceptedVersion).toBe(1)
    expect(out.finalScore).toBe(60)
    expect(state.version()).toBe(1)
    expect(readScoreboard(benchmark.id).evaluations.map(item => item.score)).toEqual([60])
  })

  it('候选评测异常时回滚并在 round 中记录失败', async () => {
    const state = mkState(() => 1)
    const propose: Parameters<typeof selfEvolve>[0]['propose'] = async () => ({ description: 'boom', target: 'x', afterState: 2 })
    const evaluate = async (def: unknown): Promise<CaseEval[]> => {
      if (def !== undefined) throw new Error('eval crash')
      return [{ caseId: 'CASE-001', score: 60, sessionId: 's1' }]
    }
    const out = await selfEvolve({ benchmark: config, maxRounds: 2, propose, evaluate, state })
    expect(out.rounds[0]!.accepted).toBe(false)
    expect(out.rounds[0]!.rolledBack).toBe(true)
    expect(out.rounds[0]!.reason).toContain('异常')
  })
})
