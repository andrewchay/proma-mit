import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { selfEvolve, type CaseEval, type StateGuard } from './self-evolver'
import type { BenchmarkConfig, SelfEvolveChange } from './types'

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
