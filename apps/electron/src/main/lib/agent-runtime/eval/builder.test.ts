import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { buildBuilderUserPrompt } from './builder-prompts'
import { selfEvolve, type StateGuard } from './self-evolver'
import type { CaseEval } from './self-evolver'
import type { BenchmarkConfig, SelfEvolveChange } from './types'

const testDir = join(tmpdir(), `gravitas-eval-builder-test-${Date.now()}`)

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
  id: 'builder-evolve',
  title: 'builder evolve test',
  description: 'unittest',
  targetAgentId: 'code-reviewer',
  runtime: { provider: 'deepseek', modelId: 'm' },
  runsPerCase: 1,
  targetScore: 80,
  cases: ['CASE-001', 'CASE-002'],
  createdAt: '',
  updatedAt: '',
}

describe('buildBuilderUserPrompt', () => {
  it('把 prompt 与 Case 得分填入模板', () => {
    const p = buildBuilderUserPrompt({
      benchmark: config,
      currentPrompt: '你是审查员…',
      caseScores: [
        { caseId: 'CASE-001', score: 55 },
        { caseId: 'CASE-002', score: null },
      ],
    })
    expect(p).toContain('你是审查员…')
    expect(p).toContain('CASE-001: 55.0 / 100')
    expect(p).toContain('CASE-002: 评测失败')
  })
})

describe('Builder 式 propose 接入 selfEvolve（无网络，mock 候选）', () => {
  it('有失分时产出候选；候选严格更高则接受', async () => {
    const prompts: string[] = ['基础指令']
    const state: StateGuard = {
      async snapshot() {},
      async apply(c: SelfEvolveChange) { prompts.push((c.afterState as { prompt?: string }).prompt ?? String(c.afterState)) },
      async restore() {},
      version: () => prompts.length,
    }
    // expose currentPrompt to the proposer via closure
    const currentPrompt = () => prompts[prompts.length - 1] ?? '基础指令'

    let call = 0
    const evaluate = async (def: unknown): Promise<CaseEval[]> => {
      const isCandidate = def !== undefined && typeof def === 'object'
      return [
        { caseId: 'CASE-001', score: isCandidate ? 95 : 60, sessionId: 's1' },
        { caseId: 'CASE-002', score: isCandidate ? 90 : 50, sessionId: 's2' },
      ]
    }
    const propose = async (input: { round: number }): Promise<SelfEvolveChange | null> => {
      if (call >= 1) return null
      call++
      if (currentPrompt().includes('加强版')) return null
      return {
        description: `round${input.round}: 加强`,
        target: 'code-reviewer',
        afterState: { prompt: '加强版指令' },
      }
    }

    const out = await selfEvolve({ benchmark: config, maxRounds: 2, propose, evaluate, state })
    expect(out.baseline.totalScore).toBe(55)
    // 候选平均 (95+90)/2=92.5 > 55 → 接受
    expect(out.rounds.some((r) => r.accepted)).toBe(true)
    expect(out.finalScore).toBeGreaterThan(out.baseline.totalScore)
  })
})
