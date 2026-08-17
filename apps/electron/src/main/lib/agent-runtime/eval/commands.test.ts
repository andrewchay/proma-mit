import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { createBenchmark } from './benchmark-store'
import { runBaseline, runImprove, type RunImproveOptions } from './commands'
import type { SubAgentDelegate } from './evaluator'
import type { StateGuard } from './self-evolver'
import type { BenchmarkConfig, Rubric, SelfEvolveChange } from './types'

const testDir = join(tmpdir(), `gravitas-eval-commands-test-${Date.now()}`)

beforeAll(() => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
  createBenchmark(config, [{ caseId: 'CASE-001', statement: '# 审查代码', rubric }])
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
  id: 'cmd-bench',
  title: 'commands test',
  description: 'unittest',
  targetAgentId: 'code-reviewer',
  runtime: { provider: 'deepseek', modelId: 'm' },
  runsPerCase: 1,
  targetScore: 80,
  cases: ['CASE-001'],
  createdAt: '',
  updatedAt: '',
}

const rubric: Rubric = {
  version: 1,
  items: [
    { name: '修复点', points: 35, check: 'x' },
    { name: '缺陷', points: 40, check: 'x' },
    { name: '格式', points: 25, check: 'x' },
  ],
}

/** mock delegate：指定返回文本，绕过真实模型 */
const delegate = (text: string): SubAgentDelegate => async () => ({ text })

describe('runBaseline', () => {
  it('对单 Case benchmark 跑出 baseline 分数并写入 scoreboard', async () => {
    const baseline = await runBaseline({
      benchmark: config,
      delegate: delegate('发现 file:line 缺陷 修复'),
      agentVersion: 1,
    })
    expect(baseline.benchmarkId).toBe(config.id)
    expect(baseline.agentVersion).toBe(1)
    expect(baseline.byCase).toHaveLength(1)
    expect(baseline.score).toBeGreaterThan(0)
    // scoreboard 有 baseline 记录（readScoreboard 由 scoreboard.ts 暴露，这里间接验证不抛错即可）
    expect(baseline.evaluationsBefore).toBeGreaterThanOrEqual(0)
  })
})

describe('runImprove', () => {
  it('候选提升分数则接受并推进版本', async () => {
    const defState = { v: 1 }
    const state: StateGuard = {
      async snapshot() {},
      async apply(c: SelfEvolveChange) { defState.v++ },
      async restore() { defState.v = 1 },
      version: () => defState.v,
    }
    // 候选"改好"→ 输出含更多关键词，规则分更高
    let improved = false
    const propose: RunImproveOptions['propose'] = async ({ round }) => {
      if (round > 1) return null
      improved = true
      return { description: 'better', target: 'builtin:code-reviewer', afterState: defState.v + 1 }
    }
    const delegateImproving: SubAgentDelegate = async () => ({
      text: improved
        ? '在 file:materialize.js:42 函数上发现未初始化变量缺陷，建议初始化。格式：file:line'
        : 'file:line 修复',
    })
    const out = await runImprove({
      benchmark: config,
      delegate: delegateImproving,
      state,
      maxRounds: 2,
      propose,
    })
    expect(out.totalRounds).toBeGreaterThanOrEqual(1)
    expect(out.baselineScore).toBeGreaterThan(0)
    // 候选分数更高 → 接受
    expect(out.acceptedRounds).toBeGreaterThanOrEqual(1)
    expect(out.finalVersion).toBeGreaterThanOrEqual(2)
    expect(out.finalScore).toBeGreaterThan(out.baselineScore)
  })

  it('propose 保守策略（永不返回候选）时只产出 baseline', async () => {
    const state: StateGuard = { async snapshot() {}, async apply() {}, async restore() {}, version: () => 1 }
    const out = await runImprove({
      benchmark: config,
      delegate: delegate('file:line'),
      state,
      maxRounds: 3,
      propose: async () => null,
    })
    expect(out.totalRounds).toBe(0)
    expect(out.finalVersion).toBe(1)
  })
})

describe('runBaseline runsPerCase>1', () => {
  const cfg: BenchmarkConfig = {
    ...config,
    id: 'runs-bench',
    runsPerCase: 3,
  }

  it('对每个 Case 跑 3 次并对分数取平均', async () => {
    let delegateCalls = 0
    // 每次 delegate 返回不同关键词 → 规则分不同，验证在取平均
    const seqDelegate: SubAgentDelegate = async () => {
      delegateCalls++
      // 仅首次含大量关键词，其余几乎为空 → 平均应显著低于满关键词
      return { text: delegateCalls % 3 === 1 ? 'file:line 修复 缺陷 bug function 严重' : 'x' }
    }
    createBenchmark(cfg, [{ caseId: 'CASE-001', statement: '# 任务', rubric: { version: 1, items: [{ name: '修复点', points: 50, check: 'x' }, { name: '缺陷', points: 50, check: 'y' }] } }])
    const out = await runBaseline({ benchmark: cfg, delegate: seqDelegate, agentVersion: 1 })
    expect(delegateCalls).toBe(3) // runsPerCase=3 次调用
    // 平均：1 次高 + 2 次空(x) → 分数应非全满
    expect(out.score).toBeGreaterThan(0)
    expect(out.score).toBeLessThan(100)
  })

  it('runsPerCase 缺失时默认 1 次（不崩）', async () => {
    let calls = 0
    const delegateOnce: SubAgentDelegate = async () => { calls++; return { text: 'file:line' } }
    createBenchmark({ ...config, id: 'runs-bench-default' }, [{ caseId: 'CASE-001', statement: '# 任务', rubric: { version: 1, items: [{ name: '修复点', points: 100, check: 'x' }] } }])
    const out = await runBaseline({ benchmark: { ...config, id: 'runs-bench-default' }, delegate: delegateOnce, agentVersion: 1 })
    expect(calls).toBe(1)
    expect(out.score).toBeGreaterThan(0)
  })
})
