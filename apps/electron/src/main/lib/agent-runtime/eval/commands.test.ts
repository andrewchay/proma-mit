import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { createBenchmark, readScoreboard } from './benchmark-store'
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
  it('Given 多次运行中一次失败 When 建立基线 Then 不写入虚假的零分记录', async () => {
    for (const failingHeldOut of [false, true]) {
      const benchmark = { ...config, id: 'baseline-fail-' + String(failingHeldOut), heldOutCases: ['HELD-1'], runsPerCase: 2 }
      createBenchmark(benchmark, [{ caseId: 'CASE-001', statement: 'train task', rubric }, { caseId: 'HELD-1', statement: 'held task', rubric }])
      let calls = 0
      const progress: Array<{ phase: string; score?: number }> = []
      const delegate: SubAgentDelegate = async ({ task }) => {
        if (task.includes(failingHeldOut ? 'held task' : 'train task') && ++calls === 2) throw new Error('provider failed')
        return { text: 'file:line 修复' }
      }
      await expect(runBaseline({ benchmark, delegate, agentVersion: 1, includeHeldOut: true, onProgress: value => progress.push(value) })).rejects.toThrow('评测不完整')
      expect(readScoreboard(benchmark.id).evaluations).toHaveLength(0)
      if (!failingHeldOut) expect(progress.find(item => item.phase === 'case_complete')?.score).toBeUndefined()
    }
  })

  it('Given 指定模型评判失败 When 建立基线 Then 不用规则分冒充模型分', async () => {
    const benchmark = { ...config, id: 'baseline-judge-unavailable' }
    createBenchmark(benchmark, [{ caseId: 'CASE-001', statement: 'train task', rubric }])
    await expect(runBaseline({ benchmark, agentVersion: 1, delegate: delegate('file:line 修复 缺陷'), scoreDelegate: async () => null })).rejects.toThrow('评测不完整')
    expect(readScoreboard(benchmark.id).evaluations).toHaveLength(0)
  })

  it('Given 训练和 held-out 重叠 When 评测 Then 不调用模型', async () => {
    let calls = 0
    const benchmark = { ...config, heldOutCases: ['CASE-001'] }
    await expect(runBaseline({ benchmark, agentVersion: 1, includeHeldOut: true, delegate: async () => { calls++; return { text: 'x' } } })).rejects.toThrow('重叠')
    expect(calls).toBe(0)
  })

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
    const runs = readScoreboard(config.id).evaluations.at(-1)!.cases[0]!.runs
    expect(runs[0]!.caseTextRubricSha256).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('runImprove', () => {
  it('Given 每个案例运行两次 When 自演化保存基线与候选 Then 保留每次真实分数与会话', async () => {
    const benchmark = { ...config, id: 'improve-multiple-runs', runsPerCase: 2, heldOutCases: ['HELD-1'] }
    createBenchmark(benchmark, [{ caseId: 'CASE-001', statement: 'train', rubric }, { caseId: 'HELD-1', statement: 'held', rubric }])
    let count = 0
    const scores = [10, 30, 50, 70, 60, 80, 80, 90]
    let version = 1
    const state: StateGuard = { async snapshot() {}, async apply() { version = 2 }, async restore() { version = 1 }, version: () => version }
    await runImprove({ benchmark, state, includeHeldOut: true, maxRounds: 1, propose: async () => ({ description: 'better', target: 'x', afterState: { prompt: 'new' } }),
      delegate: delegate('result'), scoreDelegate: async () => scores[count++]!,
    })
    const record = readScoreboard(benchmark.id).evaluations[0]!
    expect(record.cases[0]!.score).toBe(20)
    expect(record.cases[0]!.runs.map(run => run.score)).toEqual([10, 30])
    expect(record.cases[0]!.runs[0]!.caseTextRubricSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(record.cases[0]!.runs[1]!.caseTextRubricSha256).toBe(record.cases[0]!.runs[0]!.caseTextRubricSha256)
    expect(record.heldOut!.cases[0]!.runs.map(run => run.score)).toEqual([50, 70])
    const candidate = readScoreboard(benchmark.id).evaluations[1]!
    expect(candidate.cases[0]!.runs.map(run => run.score)).toEqual([60, 80])
    expect(candidate.heldOut!.cases[0]!.runs.map(run => run.score)).toEqual([80, 90])
    expect(candidate.heldOut!.cases[0]!.runs[0]!.caseTextRubricSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(candidate.heldOut!.cases[0]!.runs[0]!.caseTextRubricSha256).not.toBe(record.cases[0]!.runs[0]!.caseTextRubricSha256)
    for (const item of [record.cases[0]!, record.heldOut!.cases[0]!, candidate.cases[0]!, candidate.heldOut!.cases[0]!]) {
      expect(item.runs.every(run => run.sessionId.length > 0)).toBe(true)
      expect(new Set(item.runs.map(run => run.sessionId)).size).toBe(2)
    }
  })

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
    const phases: string[] = []
    const out = await runImprove({
      benchmark: config,
      delegate: delegateImproving,
      onProgress: (progress) => phases.push(progress.phase),
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
    expect(phases).toContain("case_start")
    expect(phases).toContain("case_complete")
    // 每轮都要给出与 Reference 的对比报告，而不是只有总分。
    expect(out.rounds.length).toBe(out.totalRounds)
    expect(out.rounds[0]!.comparable).toBe(true)
    expect(out.rounds[0]!.verdict).toBe('candidate_better')
    expect(out.rounds[0]!.meanDelta).toBeGreaterThan(0)
    expect(out.rounds[0]!.summary).toContain('更好')
  })

  it('Given 配置成本门禁但评测未记录成本 When 生成报告 Then 门禁标注未核验而不是通过', async () => {
    const state: StateGuard = {
      async snapshot() {},
      async apply() {},
      async restore() {},
      version: () => 1,
    }
    const out = await runImprove({
      benchmark: config,
      delegate: async () => ({ text: 'file:line 修复' }),
      state,
      maxRounds: 1,
      propose: async () => ({ description: 'noop', target: 'builtin:code-reviewer', afterState: 2 }),
      maxCostIncreaseRatio: 0.2,
    })
    expect(out.rounds[0]!.gate).toBe('unverified')
  })

  it('Given held-out 实际调用失败 When 训练分数上升 Then 拒绝候选且不伪造零分', async () => {
    const benchmark = { ...config, id: 'held-out-run-failure', heldOutCases: ['HELD-001'], runsPerCase: 2 }
    createBenchmark(benchmark, [{ caseId: 'CASE-001', statement: 'train task', rubric }, { caseId: 'HELD-001', statement: 'held task', rubric }])
    let version = 1
    let heldCalls = 0
    const state: StateGuard = { async snapshot() {}, async apply() { version = 2 }, async restore() { version = 1 }, version: () => version }
    const out = await runImprove({ benchmark, state, includeHeldOut: true, maxRounds: 1,
      propose: async () => ({ description: 'better', target: 'x', afterState: { prompt: 'new' } }),
      delegate: async ({ task }) => { if (task.includes('held task') && ++heldCalls === 2) throw new Error('provider failed'); return { text: version === 1 ? 'file:line 修复' : '发现 file:line 缺陷 修复' } },
    })
    expect(out.acceptedRounds).toBe(0)
    expect(version).toBe(1)
    expect(readScoreboard(benchmark.id).evaluations[0]?.heldOut).toBeNull()
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
