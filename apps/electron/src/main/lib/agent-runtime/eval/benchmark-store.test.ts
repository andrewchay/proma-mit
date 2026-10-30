import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import {
  appendEvaluation,
  assertRubricTotals100,
  createBenchmark,
  readBenchmark,
  readCaseRubric,
  readCaseStatement,
  readScoreboard,
  listBenchmarks,
} from './benchmark-store'
import { getBenchmarkConfigPath, getBenchmarkCaseRubricPath, getBenchmarkScoreboardPath, getEvalDir } from '../../config-paths'
import type { BenchmarkConfig, BenchmarkEvaluation, Rubric } from './types'

const testDir = join(tmpdir(), `gravitas-eval-test-${Date.now()}`)

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
  id: 'subagent-code-review',
  title: '内置 code-reviewer 审查能力',
  description: '衡量 code-reviewer 找出注入缺陷的能力',
  targetAgentId: 'code-reviewer',
  runtime: { provider: 'deepseek', modelId: 'deepseek-v4-flash' },
  runsPerCase: 1,
  targetScore: 80,
  cases: ['CASE-001-injected-bug'],
  createdAt: '2026-08-16T00:00:00Z',
  updatedAt: '2026-08-16T00:00:00Z',
}

const rubric: Rubric = {
  version: 1,
  items: [
    { name: '定位修复点', points: 35, check: 'must reference exact defective function' },
    { name: '正确修复建议', points: 40, check: 'fix resolves the injected bug' },
    { name: '格式可执行性', points: 25, check: 'findings map to file:line' },
  ],
}

describe('benchmark-store', () => {
  it('createBenchmark 建立目录 / config / rubric / scoreboard', () => {
    const created = createBenchmark(config, [{ caseId: 'CASE-001-injected-bug', statement: '# 任务\n审查这段代码', rubric }])
    expect(created.id).toBe(config.id)

    const reread = readBenchmark(config.id)
    expect(reread?.targetAgentId).toBe('code-reviewer')

    const statement = readCaseStatement(config.id, 'CASE-001-injected-bug')
    expect(statement).toContain('审查这段代码')

    const storedRubric = readCaseRubric(config.id, 'CASE-001-injected-bug')
    expect(storedRubric?.items.reduce((s, i) => s + i.points, 0)).toBe(100)

    const scoreboard = readScoreboard(config.id)
    expect(scoreboard.evaluations).toHaveLength(0)
  })

  it('重复创建同一 benchmark 抛错（不覆盖）', () => {
    expect(() => createBenchmark(config, [{ caseId: 'CASE-001-injected-bug', statement: 'x', rubric }])).toThrow()
  })

  it('appendEvaluation 追加一条版本化成绩流水', () => {
    const evaluation: BenchmarkEvaluation = {
      time: '2026-08-16T01:00:00Z',
      agentVersion: 1,
      score: 74.4,
      costUsd: 0.0021,
      durationMs: 12000,
      runtime: { provider: 'deepseek', modelId: 'deepseek-v4-flash' },
      cases: [
        {
          caseId: 'CASE-001-injected-bug',
          score: 74.4,
          runs: [{ score: 74.4, sessionId: 'sub-xxx' }],
        },
      ],
    }
    appendEvaluation(config.id, evaluation)
    const scoreboard = readScoreboard(config.id)
    expect(scoreboard.evaluations).toHaveLength(1)
    expect(scoreboard.evaluations[0]!.agentVersion).toBe(1)
    expect(scoreboard.evaluations[0]!.score).toBe(74.4)
  })

  it('Given 历史文件损坏或结构不合法 When 追加 Then 拒绝且原文件与恢复文件不变', () => {
    const evaluation: BenchmarkEvaluation = { time: '', agentVersion: 1, score: 80, runtime: config.runtime, cases: [] }
    for (const [index, contents] of ['{broken', '{}', '{"benchmarkId":"other","evaluations":[]}', '{"benchmarkId":"bad-3","evaluations":{}}'].entries()) {
      const id = `bad-${index}`
      const path = getBenchmarkScoreboardPath(id)
      const backup = JSON.stringify({ benchmarkId: id, evaluations: [] })
      writeFileSync(path, contents)
      writeFileSync(`${path}.bak`, backup)
      expect(() => appendEvaluation(id, evaluation)).toThrow()
      expect(readFileSync(path, 'utf8')).toBe(contents)
      expect(readFileSync(`${path}.bak`, 'utf8')).toBe(backup)
    }
  })

  it('Given 主文件缺失但存在恢复文件 When 追加 Then 不覆盖恢复文件', () => {
    const id = 'backup-only'
    const path = getBenchmarkScoreboardPath(id)
    const backup = JSON.stringify({ benchmarkId: id, evaluations: [] })
    writeFileSync(`${path}.bak`, backup)
    expect(() => appendEvaluation(id, { time: '', agentVersion: 1, score: 80, runtime: config.runtime, cases: [] })).toThrow()
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe(backup)
  })

  it('Given 未完成写入文件 When 追加 Then 保留主文件和临时文件', () => {
    const id = 'pending-write'
    const path = getBenchmarkScoreboardPath(id)
    const previous = JSON.stringify({ benchmarkId: id, evaluations: [] })
    const pending = '{pending'
    writeFileSync(path, previous)
    writeFileSync(`${path}.tmp`, pending)
    expect(() => appendEvaluation(id, { time: '', agentVersion: 1, score: 80, runtime: config.runtime, cases: [] })).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(previous)
    expect(readFileSync(`${path}.tmp`, 'utf8')).toBe(pending)
  })

  it('Given 孤立评测历史 When 新建基准 Then 不覆盖已有数据', () => {
    const orphan = { ...config, id: 'orphan-history' }
    const path = getBenchmarkScoreboardPath(orphan.id)
    writeFileSync(path, '{orphan')
    expect(() => createBenchmark(orphan, [])).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{orphan')
  })

  it('Given 已损坏历史 When 列出基准 Then 不自动覆盖原文件', () => {
    const broken = { ...config, id: 'broken-list' }
    createBenchmark(broken, [])
    const path = getBenchmarkScoreboardPath(broken.id)
    writeFileSync(path, '{broken')
    expect(() => listBenchmarks()).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{broken')
  })

  it('assertRubricTotals100 对总分非 100 抛错', () => {
    expect(() => assertRubricTotals100({ version: 1, items: [{ name: 'a', points: 99, check: 'x' }] })).toThrow()
    expect(() => assertRubricTotals100(rubric)).not.toThrow()
  })

  it('path helpers 可用且隔离到测试目录', () => {
    expect(getEvalDir().startsWith(testDir)).toBe(true)
    expect(getBenchmarkConfigPath(config.id).startsWith(testDir)).toBe(true)
    expect(getBenchmarkCaseRubricPath(config.id, 'CASE-001-injected-bug').startsWith(testDir)).toBe(true)
  })
})
