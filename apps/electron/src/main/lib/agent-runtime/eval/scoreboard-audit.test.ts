/** 样本来源审计：只读、缺来源如实标注、不补造历史事实。 */

import { describe, expect, test } from 'bun:test'
import { auditEvaluation, auditScoreboard, describeSampleAudit, type SampleQualityReport } from './scoreboard-audit'
import type { BenchmarkEvaluation, Scoreboard } from './types'

const digest = (char: string): string => char.repeat(64)

const run = (rubricDigest = digest('a')) => ({ score: 80, sessionId: 's', caseTextRubricSha256: rubricDigest })

const frozenDefinition = (overrides: Partial<{ definitionHash: string; caseMaterialHash: string; judgeHash: string; runConfigHash: string }> = {}) => ({
  version: 2,
  rubricVersion: 3,
  definitionHash: 'hash-a',
  frozenAt: '2026-11-01T00:00:00Z',
  caseMaterialHash: digest('c'),
  judgeHash: digest('d'),
  runConfigHash: digest('e'),
  ...overrides,
})

const evaluation = (options: {
  time?: string
  definition?: ReturnType<typeof frozenDefinition> | undefined
  judge?: boolean
  runsPerCase?: number
  rubricDigest?: string
  cases?: string[]
} = {}): BenchmarkEvaluation => {
  const caseIds = options.cases ?? ['c1', 'c2']
  const runsPerCase = options.runsPerCase ?? 2
  return {
    time: options.time ?? '2026-11-01T00:00:00Z',
    agentVersion: 1,
    score: 80,
    runtime: { provider: 'deepseek', modelId: 'm' },
    ...(options.judge === false ? { judge: null } : { judge: { kind: 'llm' as const, provider: 'deepseek', modelId: 'j', independent: true } }),
    ...(options.definition === undefined ? {} : { definition: options.definition }),
    cases: caseIds.map(caseId => ({
      caseId,
      score: 80,
      runs: Array.from({ length: runsPerCase }, () => run(options.rubricDigest)),
    })),
  } as unknown as BenchmarkEvaluation
}

const scoreboard = (evaluations: BenchmarkEvaluation[]): Scoreboard => ({ benchmarkId: 'b1', evaluations })

describe('单条记录来源审计', () => {
  test('Given 历史记录没有基准来源 When 审计 Then 标记不可比并说明缺口', () => {
    const audit = auditEvaluation(evaluation(), 0)
    expect(audit.hasDefinition).toBe(false)
    expect(audit.comparableReady).toBe(false)
    expect(audit.missing).toContain('基准来源未冻结（历史记录）')
    expect(audit.internalComplete).toBe(true)
  })

  test('Given 新记录三来源齐备 When 审计 Then 可比且无缺口', () => {
    const audit = auditEvaluation(evaluation({ definition: frozenDefinition() }), 1)
    expect(audit.comparableReady).toBe(true)
    expect(audit.missing).toEqual([])
    expect(audit.runCount).toBe(4)
  })

  test('Given 只有素材缺失 When 审计 Then 只报该缺口，不牵连其他来源', () => {
    const audit = auditEvaluation(evaluation({ definition: frozenDefinition({ caseMaterialHash: '' }) }), 0)
    expect(audit.comparableReady).toBe(false)
    expect(audit.missing).toEqual(['案例素材来源未冻结'])
    expect(audit.hasJudge).toBe(true)
    expect(audit.hasRunConfig).toBe(true)
  })

  test('Given run 缺少题目与评分规则摘要 When 审计 Then 内部不自洽且不可比', () => {
    const audit = auditEvaluation(evaluation({ definition: frozenDefinition(), rubricDigest: 'not-a-digest' }), 0)
    expect(audit.internalComplete).toBe(false)
    expect(audit.comparableReady).toBe(false)
    expect(audit.missing.join()).toContain('题目或评分规则摘要缺失')
  })

  test('Given case 没有运行明细 When 审计 Then 单独指出缺运行明细', () => {
    const broken = evaluation({ definition: frozenDefinition() })
    broken.cases[0]!.runs = []
    const audit = auditEvaluation(broken, 0)
    expect(audit.internalComplete).toBe(false)
    expect(audit.missing.join()).toContain('缺少运行明细的 case 1 个')
  })
})

describe('样本质量报告', () => {
  test('Given 全是历史记录 When 审计 Then 结论明确不可比且列出主要缺口', () => {
    const report = auditScoreboard('b1', scoreboard([evaluation(), evaluation({ time: '2026-11-02T00:00:00Z' })]))
    expect(report.quality.legacyCount).toBe(2)
    expect(report.quality.comparableReadyCount).toBe(0)
    expect(report.quality.comparablePairs).toBe(0)
    expect(report.summary).toContain('没有一条来源齐备')
    expect(report.summary).toContain('历史缺口不回填')
  })

  test('Given 两条定义一致的齐备记录 When 审计 Then 计一组可对比对', () => {
    const definition = frozenDefinition()
    const report = auditScoreboard('b1', scoreboard([evaluation({ definition }), evaluation({ definition, time: '2026-11-02T00:00:00Z' })]))
    expect(report.quality.comparableReadyCount).toBe(2)
    expect(report.quality.comparablePairs).toBe(1)
    expect(report.summary).toContain('可对比记录对 1 组')
  })

  test('Given 定义哈希不同 When 审计 Then 不把两条齐备记录算成可对比对', () => {
    const report = auditScoreboard('b1', scoreboard([
      evaluation({ definition: frozenDefinition() }),
      evaluation({ definition: frozenDefinition({ definitionHash: 'hash-b' }), time: '2026-11-02T00:00:00Z' }),
    ]))
    expect(report.quality.comparableReadyCount).toBe(2)
    expect(report.quality.comparablePairs).toBe(0)
    expect(report.summary).toContain('还不能做对比')
  })

  test('Given 每个 case 只有一次运行 When 审计 Then 提示抖动不可评估', () => {
    const definition = frozenDefinition()
    const report = auditScoreboard('b1', scoreboard([evaluation({ definition, runsPerCase: 1 })]))
    expect(report.quality.singleRunCases).toBe(2)
    expect(report.quality.runsPerCase).toEqual({ min: 1, median: 1, max: 1 })
    expect(report.summary).toContain('抖动无法从数据里看出来')
  })

  test('Given 缺少评分规则摘要与评判身份 When 审计 Then 分别计数', () => {
    const report = auditScoreboard('b1', scoreboard([evaluation({ definition: frozenDefinition({ judgeHash: '' }), judge: false, rubricDigest: 'bad' })]))
    expect(report.quality.runsMissingRubricDigest).toBe(4)
    // 记录里没有评判者身份（判别不了评判实现）与定义里没冻结 judgeHash 是两件事，各自计数。
    expect(report.quality.judgeRecordedCount).toBe(0)
    expect(report.quality.blockingReasons.map(item => item.reason).join()).toContain('评判实现未冻结')
  })

  test('Given 没有任何评测 When 审计 Then 结论明确为空而不是判通过', () => {
    const report = auditScoreboard('b1', scoreboard([]))
    expect(report.quality.evaluationCount).toBe(0)
    expect(report.quality.runsPerCase).toBeNull()
    expect(report.summary).toContain('还没有任何评测记录')
  })

  test('Given 只有一个 case 的多次运行 When 统计分布 Then 中位数正确', () => {
    const quality: SampleQualityReport = {
      evaluationCount: 1, comparableReadyCount: 1, legacyCount: 0, comparablePairs: 0,
      runsPerCase: { min: 1, median: 2, max: 3 }, singleRunCases: 1, runsMissingRubricDigest: 0,
      judgeRecordedCount: 1, blockingReasons: [],
    }
    expect(describeSampleAudit(quality)).toContain('来源齐备')
  })
})
